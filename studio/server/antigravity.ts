import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";

import { PythonBridge } from "./python.js";
import { StudioStore } from "./store.js";
import type { AgentJob, JobEvent } from "./types.js";

const AUTH_PATTERN = /authentication|required login|sign in|unauthorized|forbidden|not authenticated|请登录|需要登录|认证失败/i;
const REGION_PATTERN = /location is not supported|unsupported (?:country|region)|地区不支持|区域不支持/i;
const PERMISSION_PATTERN = /permission check failed|user denied permission|permission denied|权限(?:检查)?失败|拒绝.*权限/i;
const READY_MARKER = "TOMOTA_AGY_READY";
const PLANNING_STAGES = new Set(["planning_new_book", "planning_book", "planning_volume", "planning_chapter"]);

function planningSchema(stage: string): Record<string, unknown> {
  if (stage === "planning_new_book") return {
    stage, proposal: {
      title: "作品标题", genre: "题材与标签", synopsis: "面向读者的作品简介",
      premise: "故事核心", core_conflict: "全书主冲突", ending_direction: "结局方向或未锁定", major_beats: ["关键节点"],
      volumes: [{volume_id: "volume-1", title: "卷名", objective: "本卷目标", main_conflict: "本卷主冲突", character_change: "人物变化", foreshadowing: "伏笔推进或兑现", ending: "卷末落点与下一卷入口"}],
    }, rationale: ["规划依据"], warnings: ["仍需作者决定的事项"],
  };
  if (stage === "planning_book") return {
    stage, proposal: {
      synopsis: "面向读者的作品简介", genre: "题材与标签", premise: "故事核心",
      core_conflict: "全书主冲突", ending_direction: "结局方向或未锁定",
      major_beats: ["关键节点"],
      volumes: [{volume_id: "volume-1", title: "卷名", objective: "本卷目标", main_conflict: "本卷主冲突", character_change: "人物变化", foreshadowing: "伏笔推进或兑现", ending: "卷末落点与下一卷入口"}],
    }, rationale: ["规划依据"], warnings: ["仍需作者决定的事项"],
  };
  if (stage === "planning_volume") return {
    stage, proposal: {volume_id: "保持输入中的卷编号", title: "卷名", objective: "本卷目标", main_conflict: "本卷主冲突", character_change: "人物变化", foreshadowing: "伏笔推进或兑现", ending: "卷末落点与下一卷入口"},
    rationale: ["规划依据"], warnings: ["仍需作者决定的事项"],
  };
  return {
    stage, proposal: {
      chapter_number: 1, volume_id: "保持输入中的卷编号", title: "章节标题", objective: "本章目标", obstacle: "阻碍", change: "本章变化",
      new_information: "新增信息", chapter_hook: "章末钩子", next_first_beat: "下一章第一拍", current_character_goal: "当前人物目标",
      relationship_state: "关系状态", body_information_state: "身体与信息状态", unresolved_foreshadowing: "未解决伏笔", ending_type: "结尾类型",
      target_word_count: 2800, problem_tags: ["设计关注点"],
    }, rationale: ["规划依据"], warnings: ["仍需作者决定的事项"],
  };
}

function validatePlanningArtifact(stage: string, value: Record<string, unknown>): void {
  if (!PLANNING_STAGES.has(stage)) throw new Error("未知规划层级");
  const proposal = value.proposal;
  if (!proposal || Array.isArray(proposal) || typeof proposal !== "object") throw new Error("规划产物缺少 proposal 对象");
  const item = proposal as Record<string, unknown>;
  const stringFields = stage === "planning_new_book"
    ? ["title", "genre", "synopsis", "premise", "core_conflict", "ending_direction"]
    : stage === "planning_book"
    ? ["synopsis", "genre", "premise", "core_conflict", "ending_direction"]
    : stage === "planning_volume"
      ? ["volume_id", "title", "objective", "main_conflict", "character_change", "foreshadowing", "ending"]
      : ["volume_id", "title", "objective", "obstacle", "change", "new_information", "chapter_hook", "next_first_beat", "current_character_goal", "relationship_state", "body_information_state", "unresolved_foreshadowing", "ending_type"];
  for (const field of stringFields) {
    if (typeof item[field] !== "string" || !String(item[field]).trim()) throw new Error(`规划字段 ${field} 不能为空`);
  }
  if (["planning_new_book", "planning_book"].includes(stage)) {
    if (!Array.isArray(item.major_beats) || !item.major_beats.length || item.major_beats.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error("全书关键节点必须是非空文本数组");
    if (!Array.isArray(item.volumes) || !item.volumes.length) throw new Error("全书规划至少需要一卷候选卷纲");
    for (const volume of item.volumes) {
      if (!volume || Array.isArray(volume) || typeof volume !== "object") throw new Error("候选卷纲格式无效");
      for (const field of ["volume_id", "title", "objective", "main_conflict", "character_change", "foreshadowing", "ending"]) {
        if (typeof (volume as Record<string, unknown>)[field] !== "string" || !String((volume as Record<string, unknown>)[field]).trim()) throw new Error(`候选卷纲字段 ${field} 不能为空`);
      }
    }
  }
  if (stage === "planning_chapter") {
    if (!Number.isInteger(Number(item.chapter_number)) || Number(item.chapter_number) < 1) throw new Error("章节号无效");
    if (!Number.isInteger(Number(item.target_word_count)) || Number(item.target_word_count) < 500 || Number(item.target_word_count) > 10000) throw new Error("目标字数必须在 500—10000 之间");
    if (!Array.isArray(item.problem_tags)) throw new Error("problem_tags 必须是数组");
  }
  if (!Array.isArray(value.rationale) || !value.rationale.length) throw new Error("规划产物必须给出可见规划依据");
  if (!Array.isArray(value.warnings)) throw new Error("warnings 必须是数组");
}

function resolveExecutable(explicit?: string): string | null {
  if (explicit) return explicit;
  const local = process.platform === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe") : null;
  if (local && existsSync(local)) return local;
  const command = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(command, ["agy"], { encoding: "utf8", windowsHide: true });
  const first = String(result.stdout || "").split(/\r?\n/).find(Boolean);
  return first ? first.trim() : null;
}

function desktopExecutable(): string | null {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return null;
  const value = join(process.env.LOCALAPPDATA, "Programs", "antigravity", "Antigravity.exe");
  return existsSync(value) ? value : null;
}

type AgyDiagnostic = {
  auth: "authenticated" | "required" | "unknown";
  execution: "ready" | "blocked" | "unknown";
  reason: "ready" | "unsupported_region" | "auth_required" | "permission_denied" | "unknown";
  message: string;
};

function classifyDiagnostic(text: string): AgyDiagnostic {
  if (REGION_PATTERN.test(text)) return {auth: /authenticated successfully|silent auth succeeded/i.test(text) ? "authenticated" : "unknown", execution: "blocked", reason: "unsupported_region", message: "本地连接和账号认证正常，但 Google 服务端拒绝当前网络地区；桌面端与 CLI 都无法生成"};
  if (PERMISSION_PATTERN.test(text)) return {auth: "authenticated", execution: "blocked", reason: "permission_denied", message: "Antigravity 已登录，但任务工作区权限配置不完整"};
  if (AUTH_PATTERN.test(text)) return {auth: "required", execution: "blocked", reason: "auth_required", message: "AGY CLI 需要登录 Antigravity"};
  if (text.includes(READY_MARKER)) return {auth: "authenticated", execution: "ready", reason: "ready", message: "AGY CLI 已连接并可执行任务"};
  return {auth: "unknown", execution: "unknown", reason: "unknown", message: "AGY CLI 已安装，尚未完成运行检测"};
}

export class AntigravityRunner extends EventEmitter {
  private readonly root: string;
  private readonly store: StudioStore;
  private readonly python: PythonBridge;
  private readonly executable: string | null;
  private readonly prefixArgs: string[];
  private readonly processes = new Map<string, ChildProcessByStdio<null, Readable, Readable>>();
  private readonly streamBuffers = new Map<string, {stdout: string; stderr: string}>();
  private readonly diagnosticLogs = new Map<string, string>();
  private readonly pausedRuns = new Set<string>();
  private readonly autoCorrectionRetries: number;

  constructor(root: string, store: StudioStore, python: PythonBridge, options: {executable?: string; prefixArgs?: string[]; autoCorrectionRetries?: number} = {}) {
    super();
    this.root = resolve(root);
    this.store = store;
    this.python = python;
    this.executable = resolveExecutable(options.executable || process.env.TOMOTA_AGY_EXECUTABLE);
    this.prefixArgs = options.prefixArgs || [];
    this.autoCorrectionRetries = Math.max(0, Math.min(3, options.autoCorrectionRetries ?? 2));
  }

  status(): {installed: boolean; executable: string | null; version: string; desktopInstalled: boolean; desktopExecutable: string | null; auth: "authenticated" | "required" | "unknown"; execution: "ready" | "blocked" | "unknown"; reason: AgyDiagnostic["reason"]; message: string; recovery: string; productionFallback: "disabled"} {
    const versionResult = this.executable ? spawnSync(this.executable, ["--version"], {encoding: "utf8", windowsHide: true, timeout: 5_000}) : null;
    const version = String(versionResult?.stdout || versionResult?.stderr || "").trim().split(/\r?\n/)[0] || "";
    const stored = this.store.getMeta("antigravity_probe");
    let probe: {executable?: string; auth?: "authenticated" | "required" | "unknown"; execution?: "ready" | "blocked" | "unknown"; reason?: AgyDiagnostic["reason"]; message?: string} = {};
    try { probe = stored ? JSON.parse(stored) : {}; } catch { probe = {}; }
    const current = probe.executable === this.executable ? probe : {};
    const desktop = desktopExecutable();
    const reason = current.reason || "unknown";
    return { installed: Boolean(this.executable), executable: this.executable, version, desktopInstalled: Boolean(desktop), desktopExecutable: desktop, auth: current.auth || "unknown", execution: current.execution || "unknown", reason, message: current.message || (this.executable ? "AGY CLI 已安装，点击检测连接确认账号与运行环境" : desktop ? "已找到 Antigravity 桌面端，但自动化所需的 AGY CLI 尚未安装" : "未找到 Antigravity"), recovery: reason === "unsupported_region" ? "请在 Antigravity 官方支持的网络地区重新检测；Studio 会原地恢复，不会推进当前工作流" : reason === "auth_required" ? "请通过官方方式完成登录后重新检测" : reason === "permission_denied" ? "Studio 会重新挂载作品目录和任务输出目录；无需重新登录" : "", productionFallback: "disabled" };
  }

  async probe(): Promise<ReturnType<AntigravityRunner["status"]>> {
    if (!this.executable) return this.status();
    const logPath = join(this.store.dataDir, `agy-probe-${Date.now()}.log`);
    const output = await new Promise<{stdout: string; stderr: string; code: number | null}>((resolveResult) => {
      const child = spawn(this.executable!, ["-p", `Respond with exactly ${READY_MARKER} and do not modify any files.`, "--output-format", "json", "--log-file", logPath], {cwd: this.root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {...process.env, NO_COLOR: "1"}});
      let stdout = ""; let stderr = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), 45_000);
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout = (stdout + String(chunk)).slice(-40_000); });
      child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-40_000); });
      child.once("error", (error) => { clearTimeout(timer); resolveResult({stdout, stderr: `${stderr}\n${error.message}`, code: 1}); });
      child.once("close", (code) => { clearTimeout(timer); resolveResult({stdout, stderr, code}); });
    });
    const hiddenLog = await readFile(logPath, "utf8").catch(() => "");
    await unlink(logPath).catch(() => undefined);
    const diagnostic = classifyDiagnostic(`${output.stdout}\n${output.stderr}\n${hiddenLog}`);
    if (output.code === 0 && output.stdout.includes(READY_MARKER)) Object.assign(diagnostic, {auth: "authenticated", execution: "ready", reason: "ready", message: "AGY CLI 已连接并可执行任务"});
    this.store.setMeta("antigravity_probe", JSON.stringify({...diagnostic, executable: this.executable, checkedAt: new Date().toISOString()}));
    return this.status();
  }

  async startPlanning(value: {bookId: string; scope: "new_book" | "book" | "volume" | "chapter"; mode: "fill" | "rewrite"; instruction: string; context: Record<string, unknown>}): Promise<{job: AgentJob}> {
    const stage = `planning_${value.scope}`;
    if (!PLANNING_STAGES.has(stage)) throw new Error("规划层级无效");
    const bookDir = resolve(this.root, "books", value.bookId);
    if (value.scope !== "new_book" && !existsSync(bookDir)) throw new Error("作品目录不存在");
    const active = this.store.activeJobForBook(value.bookId);
    if (active) throw new Error("同一本书已有 Antigravity 任务正在运行，请等待或先取消");
    const taskId = `planning-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const promptDir = join(this.store.dataDir, "planning");
    await mkdir(promptDir, {recursive: true});
    const promptPath = join(promptDir, `${taskId}.prompt.md`);
    const schema = planningSchema(stage);
    const prompt = [
      "# Tomota 三级大纲 AI 规划任务",
      "",
      `规划层级：${value.scope === "new_book" ? "新书创意" : value.scope === "book" ? "全书" : value.scope === "volume" ? "当前分卷" : "当前章节"}`,
      `处理方式：${value.mode === "fill" ? "补全空白并保留已有明确设定" : "重做当前层，但不得擅自改动其他层"}`,
      value.instruction ? `作者补充要求：${value.instruction}` : "作者补充要求：无",
      "",
      "## 规划标准",
      "- 全书层必须明确故事核、主冲突、阶段升级、人物变化、伏笔推进与可延展性。",
      "- 分卷层必须有独立目标、主冲突、人物变化、伏笔动作、卷末兑现和下一卷入口。",
      "- 章节层必须给出目标、阻碍、选择或变化、具体章末钩子与下一章第一拍，不能用空泛悬念冒充伏笔。",
      "- 保持现有人物全称、知识边界、术语、Canon 与已写章节事实；发现冲突写入 warnings，不要自行抹除旧事实。",
      "- 开放式连载的已规划章数只是滚动窗口，不得推断为全书完结章数。",
      "- 语言具体、可执行，避免模板话、同义反复和 AI 式空泛概括。",
      "",
      "## 当前编辑器状态",
      "```json",
      JSON.stringify(value.context, null, 2),
      "```",
      "",
      "## 唯一输出 Schema",
      "```json",
      JSON.stringify(schema, null, 2),
      "```",
    ].join("\n");
    await writeFile(promptPath, prompt, "utf8");
    const draft = this.store.createJob({
      runId: taskId, bookId: value.bookId,
      chapter: value.scope === "chapter" ? Number((value.context.selected as Record<string, unknown> | undefined)?.chapter_number || 0) || null : null,
      stage, status: "queued", promptPath,
      promptHash: createHash("sha256").update(prompt).digest("hex"), outputPath: "pending", retryOf: null,
    });
    const outputPath = join(this.store.dataDir, "jobs", `${draft.id}.json`);
    this.store.db.prepare("UPDATE agent_jobs SET output_path=? WHERE id=?").run(outputPath, draft.id);
    const job = this.store.getJob(draft.id)!;
    if (!this.executable) {
      const failed = this.store.updateJob(job.id, {status: "failed", error: "未检测到 AGY CLI。请先在设置页完成连接。", finishedAt: new Date().toISOString()});
      this.event(failed.id, "error", failed.error);
      return {job: failed};
    }
    this.launch(job, {output_schema: schema, planning: true});
    return {job: this.store.getJob(job.id)!};
  }

  async planningResult(jobId: string): Promise<{job: AgentJob; events: JobEvent[]; artifact: Record<string, unknown> | null}> {
    const source = this.store.getJob(jobId);
    if (!source || !PLANNING_STAGES.has(source.stage)) throw new Error("AI 规划任务不存在");
    const job = this.store.listJobs(source.runId, 1)[0] || source;
    let artifact: Record<string, unknown> | null = null;
    if (job.status === "succeeded" && existsSync(job.outputPath)) {
      const parsed = JSON.parse(await readFile(job.outputPath, "utf8")) as Record<string, unknown>;
      validatePlanningArtifact(job.stage, parsed);
      artifact = parsed;
    }
    return {job, events: this.store.listEvents(jobId, 0), artifact};
  }

  async startContinuous(runId: string, retryOf: string | null = null): Promise<{job: AgentJob | null; workflow: Record<string, unknown>}> {
    this.pausedRuns.delete(runId);
    const workflow = (await this.python.workflowStatus(runId)).value;
    if (workflow.status !== "running") return { job: null, workflow };
    const action = (await this.python.nextAction(runId)).value;
    const bookId = String(action.book_id || workflow.book_id || "");
    if (!bookId) throw new Error("工作流没有返回 book_id");
    const active = this.store.activeJobForBook(bookId);
    if (active) return { job: active, workflow };
    const promptPath = resolve(String(action.prompt_path || ""));
    if (!existsSync(promptPath)) throw new Error("当前阶段 Prompt 文件不存在");
    const prompt = await readFile(promptPath, "utf8");
    const draftJob = this.store.createJob({
      runId,
      bookId,
      chapter: action.chapter === null || action.chapter === undefined ? null : Number(action.chapter),
      stage: String(action.stage),
      status: "queued",
      promptPath,
      promptHash: createHash("sha256").update(prompt).digest("hex"),
      outputPath: "pending",
      retryOf,
    });
    const outputPath = join(this.store.dataDir, "jobs", `${draftJob.id}.json`);
    const job = this.store.updateJob(draftJob.id, { error: "" });
    this.store.db.prepare("UPDATE agent_jobs SET output_path=? WHERE id=?").run(outputPath, job.id);
    const hydrated = this.store.getJob(job.id)!;
    if (!this.executable) {
      const failed = this.store.updateJob(job.id, { status: "failed", error: "未检测到 AGY CLI。请在设置页按官方方式安装并登录。", finishedAt: new Date().toISOString() });
      this.event(failed.id, "error", failed.error);
      return { job: failed, workflow };
    }
    this.launch(hydrated, action);
    return { job: this.store.getJob(job.id)!, workflow };
  }

  private launch(job: AgentJob, action: Record<string, unknown>): void {
    const planning = PLANNING_STAGES.has(job.stage);
    const bookDir = planning ? dirname(job.promptPath) : resolve(this.root, "books", job.bookId);
    const feedback = planning ? [] : this.store.pendingWorkflowFeedback(job.runId, job.stage, job.chapter);
    const priorError = job.retryOf ? this.store.getJob(job.retryOf)?.error.trim() : "";
    const instruction = [
      planning ? "你正在执行 Tomota Studio 的三级大纲规划任务。" : "你正在执行 Tomota 严格写作状态机中的一个独立阶段。",
      `完整读取任务文件：${job.promptPath}`,
      "任务文件已经包含当前阶段所需的全部上下文。除该任务文件外，不得读取、搜索或引用任何其他文件。",
      "尤其禁止读取其他书籍目录、其他 workflow、旧 Canon、旧审查产物或历史范例；不得用旧产物代替本轮独立生成。",
      `当前阶段：${job.stage}；章节：${job.chapter ?? "全书"}。`,
      planning ? "只能生成候选规划，不得修改正文、大纲、Canon、workflow、发布状态或任何现有项目文件。" : "只能根据任务文件执行当前阶段，不得跳过审查、直接批准章节、修改 Canon、修改 workflow state 或准备发布。",
      `把唯一产物写成 UTF-8 JSON 到：${job.outputPath}`,
      "JSON 顶层必须是对象，stage 必须与当前阶段完全一致，结构必须严格符合任务文件中的输出约束。",
      "不要在 JSON 外写解释，不要创建其他稿件或提示包。完成写入后退出。",
      "只使用文件读取与写入工具完成任务；不要使用 run_command、PowerShell、shell、terminal 或任何终端命令。",
      `写入指定 JSON 后不要重新读取或验证该文件，立即结束本轮。Tomota 会独立完成${planning ? "规划 Schema" : "格式与质量"}校验。`,
      ...(priorError ? [`上一次产物被拒绝，必须修复：${priorError}`] : []),
      ...(feedback.length ? ["用户对当前阶段的修改反馈（必须执行，但不得借此跳过输出 Schema 或质量闸门）：", ...feedback.map((item, index) => `${index + 1}. ${item.content}`)] : []),
      `输出结构提示：${JSON.stringify(action.output_schema || {})}`,
    ].join("\n");
    const logPath = join(this.store.dataDir, "jobs", `${job.id}.agy.log`);
    this.diagnosticLogs.set(job.id, logPath);
    const args = [
      ...this.prefixArgs,
      "--new-project",
      "--add-dir", bookDir,
      "--add-dir", dirname(job.outputPath),
      "--effort", planning || ["story_foundation", "chapter_design", "draft", "revise_logic", "revise_voice", "revise_continuity", "revise_cold"].includes(job.stage) ? "high" : "medium",
      "-p", instruction,
      "--output-format", "stream-json",
      "--mode", "accept-edits",
      "--log-file", logPath,
    ];
    const child = spawn(this.executable!, args, { cwd: bookDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
    this.processes.set(job.id, child);
    this.store.updateJob(job.id, { status: "running", pid: child.pid ?? null, startedAt: new Date().toISOString() });
    this.store.markWorkflowFeedbackApplied(feedback.map((item) => item.id), job.id);
    this.event(job.id, "info", `已隔离装载当前作品、阶段 Prompt 与输出目录`);
    this.event(job.id, "info", `Antigravity 已领取 ${job.stage} 阶段，正在分析输入`);
    if (feedback.length) this.event(job.id, "info", `已带入 ${feedback.length} 条用户修改反馈`);
    this.streamBuffers.set(job.id, {stdout: "", stderr: ""});
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleCliChunk(job.id, "stdout", String(chunk)));
    child.stderr.on("data", (chunk) => this.handleCliChunk(job.id, "stderr", String(chunk)));
    child.once("error", (error) => {
      this.processes.delete(job.id);
      this.flushCliStream(job.id);
      const status = AUTH_PATTERN.test(error.message) ? "auth_required" : "failed";
      this.store.updateJob(job.id, { status, error: error.message, finishedAt: new Date().toISOString() });
      this.event(job.id, "error", error.message);
    });
    child.once("close", (code, signal) => void this.finish(job.id, code, signal));
  }

  private async finish(jobId: string, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    this.processes.delete(jobId);
    this.flushCliStream(jobId);
    const logPath = this.diagnosticLogs.get(jobId);
    this.diagnosticLogs.delete(jobId);
    const hiddenLog = logPath ? await readFile(logPath, "utf8").catch(() => "") : "";
    if (logPath) await unlink(logPath).catch(() => undefined);
    const job = this.store.getJob(jobId);
    if (!job || job.status === "cancelled") return;
    const events = this.store.listEvents(jobId, 0);
    const combined = `${events.map((item) => item.message).join("\n")}\n${hiddenLog}`;
    if (code !== 0) {
      const diagnostic = classifyDiagnostic(combined);
      const status = diagnostic.reason === "auth_required" ? "auth_required" : "failed";
      const error = signal ? `Antigravity 被信号 ${signal} 终止` : diagnostic.execution === "blocked" ? diagnostic.message : `Antigravity 退出码 ${code ?? 1}`;
      this.store.setMeta("antigravity_probe", JSON.stringify({...diagnostic, executable: this.executable, checkedAt: new Date().toISOString()}));
      this.store.updateJob(jobId, { status, exitCode: code, error, finishedAt: new Date().toISOString() });
      this.event(jobId, "error", error);
      return;
    }
    if (!existsSync(job.outputPath)) {
      const error = "Antigravity 已退出，但没有生成指定 JSON 产物；工作流保持在原阶段";
      this.store.updateJob(jobId, { status: "failed", exitCode: code, error, finishedAt: new Date().toISOString() });
      this.event(jobId, "error", error);
      this.scheduleCorrectionRetry(jobId);
      return;
    }
    let output: string;
    let parsed: Record<string, unknown>;
    try {
      this.event(jobId, "info", "Antigravity 已结束生成，正在检查 JSON 格式与阶段标识");
      output = await readFile(job.outputPath, "utf8");
      parsed = JSON.parse(output) as Record<string, unknown>;
      if (!parsed || Array.isArray(parsed) || parsed.stage !== job.stage) throw new Error("JSON stage 与当前阶段不一致");
      if (PLANNING_STAGES.has(job.stage)) validatePlanningArtifact(job.stage, parsed);
    } catch (error) {
      const message = `Antigravity 产物无效：${error instanceof Error ? error.message : String(error)}；${PLANNING_STAGES.has(job.stage) ? "候选规划未应用" : "工作流未推进"}`;
      this.store.updateJob(jobId, { status: "failed", exitCode: code, error: message, finishedAt: new Date().toISOString() });
      this.event(jobId, "error", message);
      this.scheduleCorrectionRetry(jobId);
      return;
    }
    if (PLANNING_STAGES.has(job.stage)) {
      const outputHash = createHash("sha256").update(output).digest("hex");
      this.store.setMeta("antigravity_probe", JSON.stringify({
        auth: "authenticated", execution: "ready", reason: "ready", message: "AGY CLI 已连接并可执行任务",
        executable: this.executable, checkedAt: new Date().toISOString(),
      }));
      this.store.updateJob(jobId, {status: "succeeded", exitCode: code, outputHash, finishedAt: new Date().toISOString()});
      this.event(jobId, "info", "候选规划已通过 Schema 校验；等待用户预览并应用，未修改项目文件");
      return;
    }
    try {
      this.event(jobId, "info", "结构校验通过，正在交给 Tomota 执行质量闸门");
      const submitted = await this.python.submit(job.runId, job.outputPath);
      const submittedStatus = String(submitted.value.status || "error");
      if (!["running", "completed"].includes(submittedStatus)) {
        const detail = String(submitted.value.message || submitted.value.error || "产物未通过当前阶段字段与质量校验");
        const message = `Tomota 校验拒绝：${detail}`;
        this.store.updateJob(jobId, { status: "failed", exitCode: code, error: message, finishedAt: new Date().toISOString() });
        this.event(jobId, "error", message);
        this.scheduleCorrectionRetry(jobId);
        return;
      }
      const outputHash = createHash("sha256").update(output).digest("hex");
      this.store.setMeta("antigravity_probe", JSON.stringify({
        auth: "authenticated", execution: "ready", reason: "ready",
        message: "AGY CLI 已连接并可执行任务", executable: this.executable,
        checkedAt: new Date().toISOString(),
      }));
      this.store.updateJob(jobId, { status: "succeeded", exitCode: code, outputHash, finishedAt: new Date().toISOString() });
      this.event(jobId, "info", `Tomota 已校验产物；工作流状态：${String(submitted.value.status || "unknown")}`);
      if (submitted.value.status === "running" && !this.pausedRuns.has(job.runId)) {
        setTimeout(() => void this.startContinuous(job.runId).catch((error) => this.event(jobId, "error", error instanceof Error ? error.message : String(error))), 150);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateJob(jobId, { status: "failed", exitCode: code, error: `Tomota 校验拒绝：${message}`, finishedAt: new Date().toISOString() });
      this.event(jobId, "error", `Tomota 校验拒绝：${message}`);
    }
  }

  cancel(jobId: string): AgentJob {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error("任务不存在");
    this.pausedRuns.add(job.runId);
    const child = this.processes.get(jobId);
    if (child && !child.killed) child.kill("SIGTERM");
    this.processes.delete(jobId);
    this.flushCliStream(jobId);
    const cancelled = this.store.updateJob(jobId, { status: "cancelled", error: "用户取消；工作流未推进", finishedAt: new Date().toISOString() });
    this.event(jobId, "info", "任务已取消；工作流保持在当前阶段");
    return cancelled;
  }

  async retry(jobId: string): Promise<{job: AgentJob | null; workflow: Record<string, unknown>}> {
    const prior = this.store.getJob(jobId);
    if (!prior) throw new Error("原任务不存在");
    if (["queued", "running"].includes(prior.status)) throw new Error("运行中的任务不能重复重试");
    if (PLANNING_STAGES.has(prior.stage)) return {job: await this.retryPlanning(prior), workflow: {status: "planning", stage: prior.stage}};
    const current = (await this.python.workflowStatus(prior.runId)).value;
    if (existsSync(prior.outputPath) && current.status === "running" && current.current_stage === prior.stage) {
      try {
        const output = await readFile(prior.outputPath, "utf8");
        const parsed = JSON.parse(output) as Record<string, unknown>;
        if (parsed.stage === prior.stage) {
          const submitted = await this.python.submit(prior.runId, prior.outputPath);
          if (["running", "completed"].includes(String(submitted.value.status || ""))) {
            const recovered = this.store.updateJob(prior.id, {
              status: "succeeded", outputHash: createHash("sha256").update(output).digest("hex"),
              error: "已复用中断前生成的有效产物，没有重复调用 Antigravity", finishedAt: new Date().toISOString(),
            });
            this.event(prior.id, "info", "中断产物已通过 Tomota 校验，跳过重复生成");
            if (submitted.value.status === "running") setTimeout(() => void this.startContinuous(prior.runId), 150);
            return { job: recovered, workflow: submitted.value };
          }
          this.event(prior.id, "info", `已有产物被 Tomota 拒绝：${String(submitted.value.message || "字段或质量校验失败")}；将重新生成当前阶段`);
        }
      } catch {
        this.event(prior.id, "info", "已有中断产物不可复用，将为当前阶段创建新任务");
      }
    }
    return this.startContinuous(prior.runId, prior.id);
  }

  private event(jobId: string, level: JobEvent["level"], message: string): void {
    const event = this.store.appendEvent(jobId, level, message);
    this.emit("job-event", event);
  }

  private structuredEvent(jobId: string, kind: JobEvent["kind"], message: string, payload: Record<string, unknown>): void {
    const event = this.store.appendEvent(jobId, "stdout", message, kind, payload);
    this.emit("job-event", event);
  }

  private handleCliChunk(jobId: string, channel: "stdout" | "stderr", chunk: string): void {
    const buffers = this.streamBuffers.get(jobId) || {stdout: "", stderr: ""};
    buffers[channel] += chunk;
    const lines = buffers[channel].split(/\r?\n/);
    buffers[channel] = lines.pop() || "";
    this.streamBuffers.set(jobId, buffers);
    for (const line of lines) this.emitCliLine(jobId, channel, line);
  }

  private flushCliStream(jobId: string): void {
    const buffers = this.streamBuffers.get(jobId);
    if (!buffers) return;
    if (buffers.stdout.trim()) this.emitCliLine(jobId, "stdout", buffers.stdout);
    if (buffers.stderr.trim()) this.emitCliLine(jobId, "stderr", buffers.stderr);
    this.streamBuffers.delete(jobId);
  }

  private emitCliLine(jobId: string, channel: "stdout" | "stderr", rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;
    if (channel === "stderr") {
      this.event(jobId, "stderr", line.slice(0, 8_000));
      return;
    }
    try {
      const payload = JSON.parse(line) as Record<string, any>;
      const eventName = String(payload.event || payload.type || "event");
      if (eventName === "init") {
        const init = payload.init || {};
        const conversation = String(payload.conversation_id || init.conversation_id || "").slice(0, 12);
        const cwd = String(init.cwd || "");
        this.structuredEvent(jobId, "status", `CLI 会话已建立${conversation ? ` · ${conversation}` : ""}${cwd ? ` · ${cwd}` : ""}`, {
          status: "session_started", conversationId: conversation, cwd,
        });
        return;
      }
      if (eventName === "step_update") {
        const step = payload.step_update || {};
        const type = String(step.step_type || step.type || "step");
        const labels: Record<string, string> = {
          user_input: "接收任务", checkpoint: "建立检查点", agent_response: "正在思考",
          tool_call: "调用工具", tool_result: "工具返回", file_read: "读取文件", file_write: "写入产物",
        };
        const textDelta = String(step.text_delta || step.content || step.message || "");
        const toolName = String(step.tool_name || step.name || step.tool?.name || "");
        const path = String(step.path || step.file_path || step.tool?.path || "");
        const duration = Number(step.duration_seconds);
        // Emit a compact metadata line for every step so the user sees progress.
        const metaParts = [labels[type] || type, toolName, path, Number.isFinite(duration) ? `${duration.toFixed(1)}秒` : "", step.state && step.state !== "DONE" ? String(step.state) : ""].filter(Boolean);
        const stepPayload: Record<string, unknown> = {
          stepIndex: Number.isFinite(Number(step.step_index)) ? Number(step.step_index) : undefined,
          stepType: type,
          state: step.state ? String(step.state) : undefined,
          durationSeconds: Number.isFinite(duration) ? duration : undefined,
        };
        if (toolName) stepPayload.toolName = toolName;
        if (path) stepPayload.path = path;
        if (textDelta) stepPayload.textDelta = textDelta.slice(0, 12_000);
        if (metaParts.length) {
          this.structuredEvent(jobId, type === "agent_response" ? "status" : "tool_event", metaParts.join(" · ").slice(0, 2_000), stepPayload);
        } else if (textDelta) {
          this.structuredEvent(jobId, type === "agent_response" ? "assistant_text" : "tool_event", textDelta.slice(0, 2_000), stepPayload);
        }
        if (textDelta && type === "agent_response") {
          this.structuredEvent(jobId, "assistant_text", textDelta.slice(0, 12_000), stepPayload);
        } else if (textDelta && type === "tool_call") {
          this.structuredEvent(jobId, "tool_event", `  → ${textDelta.slice(0, 6_000)}`, stepPayload);
        } else if (textDelta && type === "tool_result") {
          this.structuredEvent(jobId, "tool_event", `  ← ${textDelta.slice(0, 6_000)}`, stepPayload);
        }
        if (Number.isFinite(Number(step.thinking_tokens)) || (step.usage && typeof step.usage === "object")) this.emitUsage(jobId, step);
        return;
      }
      if (eventName === "result") {
        const result = payload.result || payload;
        const usage = result.usage || payload.usage || {};
        const totalTokens = Number(usage.total_tokens || usage.input_tokens + usage.output_tokens);
        const duration = Number(result.duration_seconds || payload.duration_seconds);
        const turns = Number(result.num_turns || payload.num_turns);
        const detail = [
          `CLI 完成 · ${String(result.status || payload.status || "unknown").toUpperCase()}`,
          Number.isFinite(duration) ? `${duration.toFixed(1)} 秒` : "",
          Number.isFinite(turns) ? `${turns} 轮` : "",
          Number.isFinite(totalTokens) ? `${totalTokens.toLocaleString()} tokens` : "",
        ].filter(Boolean).join(" · ");
        const resultPayload: Record<string, unknown> = {
          status: String(result.status || payload.status || "unknown"),
          durationSeconds: Number.isFinite(duration) ? duration : undefined,
          turns: Number.isFinite(turns) ? turns : undefined,
          response: String(result.response || payload.response || ""),
        };
        const usagePayload = this.usagePayload(usage);
        if (usagePayload) resultPayload.usage = usagePayload;
        this.structuredEvent(jobId, "result", detail, resultPayload);
        if (usagePayload) this.structuredEvent(jobId, "usage", `用量 · 输入 ${usagePayload.inputTokens ?? 0} · 输出 ${usagePayload.outputTokens ?? 0} · 思考 ${usagePayload.thinkingTokens ?? 0} · 总计 ${usagePayload.totalTokens ?? 0}`, usagePayload);
        return;
      }
      const message = String(payload.message || payload.text_delta || payload.status || "").trim();
      this.event(jobId, "stdout", `${eventName}${message ? ` · ${message}` : ""}`.slice(0, 8_000));
    } catch {
      this.event(jobId, "stdout", line.slice(0, 8_000));
    }
  }

  private emitUsage(jobId: string, step: Record<string, any>): void {
    const usage = this.usagePayload(step.usage || {thinking_tokens: step.thinking_tokens});
    if (!usage) return;
    this.structuredEvent(jobId, "usage", `用量 · 思考 ${usage.thinkingTokens ?? 0} tokens`, usage);
  }

  private usagePayload(usage: Record<string, any>): Record<string, number> | null {
    const value = {
      inputTokens: Number(usage.input_tokens),
      outputTokens: Number(usage.output_tokens),
      thinkingTokens: Number(usage.thinking_tokens),
      totalTokens: Number(usage.total_tokens),
    };
    return Object.values(value).some(Number.isFinite) ? value : null;
  }

  private scheduleCorrectionRetry(jobId: string): void {
    if (!this.autoCorrectionRetries) return;
    const job = this.store.getJob(jobId);
    if (!job || this.pausedRuns.has(job.runId)) return;
    let attempts = 0;
    let cursor: AgentJob | null = job;
    while (cursor?.retryOf) {
      const prior = this.store.getJob(cursor.retryOf);
      if (!prior || prior.stage !== job.stage || prior.chapter !== job.chapter) break;
      attempts += 1;
      cursor = prior;
    }
    if (attempts >= this.autoCorrectionRetries) {
      this.event(jobId, "error", `当前阶段已自动纠错 ${attempts} 次，已停止；请查看错误或通过修改反馈重跑`);
      return;
    }
    this.event(jobId, "info", `检测到可纠正的产物错误，将自动进行第 ${attempts + 1} 次定向重试`);
    if (PLANNING_STAGES.has(job.stage)) {
      setTimeout(() => void this.retryPlanning(job).catch((error) => this.event(jobId, "error", error instanceof Error ? error.message : String(error))), 300);
    } else {
      setTimeout(() => void this.startContinuous(job.runId, job.id).catch((error) => this.event(jobId, "error", error instanceof Error ? error.message : String(error))), 300);
    }
  }

  private async retryPlanning(prior: AgentJob): Promise<AgentJob> {
    const active = this.store.activeJobForBook(prior.bookId);
    if (active) return active;
    const prompt = await readFile(prior.promptPath, "utf8");
    const draft = this.store.createJob({
      runId: prior.runId, bookId: prior.bookId, chapter: prior.chapter, stage: prior.stage, status: "queued",
      promptPath: prior.promptPath, promptHash: createHash("sha256").update(prompt).digest("hex"), outputPath: "pending", retryOf: prior.id,
    });
    const outputPath = join(this.store.dataDir, "jobs", `${draft.id}.json`);
    this.store.db.prepare("UPDATE agent_jobs SET output_path=? WHERE id=?").run(outputPath, draft.id);
    const job = this.store.getJob(draft.id)!;
    if (!this.executable) return this.store.updateJob(job.id, {status: "failed", error: "未检测到 AGY CLI", finishedAt: new Date().toISOString()});
    this.launch(job, {output_schema: planningSchema(job.stage), planning: true});
    return this.store.getJob(job.id)!;
  }
}
