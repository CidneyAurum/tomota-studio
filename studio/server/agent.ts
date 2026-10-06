import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentJob, JobEvent } from "./types.js";
import type { StudioStore } from "./store.js";
import type { AuthorPreference } from "./types.js";

export type AgentPlanAction =
  | {type: "run_workflow"; bookId: string; chapters: number[]; autoRun: boolean}
  | {type: "rework_chapter"; bookId: string; chapter: number; feedback: string; autoRun: boolean}
  | {type: "run_next_stage"; runId: string}
  | {type: "retry_job"; jobId: string}
  | {type: "create_revision_brief"; bookId: string; chapter: number; feedback: string}
  | {type: "update_author_preference"; bookId: string; category: AuthorPreference["category"]; rule: string; evidence: string; enabled: boolean}
  | {type: "switch_view"; view: string}
  | {type: "select_project"; bookId: string};

export interface AgentPlanArtifact {
  stage: "workbench_agent";
  summary: string;
  reasoning: string[];
  actions: AgentPlanAction[];
  warnings: string[];
}

const ALLOWED_ACTIONS = new Set<string>(["run_workflow", "rework_chapter", "run_next_stage", "retry_job", "create_revision_brief", "update_author_preference", "switch_view", "select_project"]);
const ALLOWED_VIEWS = new Set(["overview", "planning", "workflow", "workspace", "fanqie", "settings"]);
const ALLOWED_PREFERENCE_CATEGORIES = new Set<AuthorPreference["category"]>(["人物声音", "对白密度", "伏笔边界", "节奏", "章末", "去AI味", "题材偏好"]);

function normalizeAction(value: Record<string, unknown>): AgentPlanAction {
  const type = String(value.type || "");
  if (!ALLOWED_ACTIONS.has(type)) throw new Error(`工作台代理动作不被允许：${type || "(empty)"}`);
  const bookId = String(value.bookId || "");
  if (!["switch_view", "run_next_stage", "retry_job"].includes(type) && !/^[A-Za-z0-9_-]+$/.test(bookId)) throw new Error("工作台代理动作包含无效作品编号");
  if (type === "run_workflow") {
    const chapters = Array.isArray(value.chapters) ? value.chapters.map(Number) : [];
    if (!chapters.length || chapters.some((item) => !Number.isInteger(item) || item <= 0)) throw new Error("run_workflow 需要正整数章节列表");
    return {type, bookId, chapters, autoRun: value.autoRun !== false};
  }
  if (type === "rework_chapter") {
    const chapter = Number(value.chapter);
    const feedback = String(value.feedback || "").trim();
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error("rework_chapter 需要正整数章节");
    if (!feedback || feedback.length > 4000) throw new Error("rework_chapter 需要非空返工要求");
    return {type, bookId, chapter, feedback, autoRun: value.autoRun !== false};
  }
  if (type === "run_next_stage" || type === "retry_job") {
    const key = type === "run_next_stage" ? "runId" : "jobId";
    const target = String(value[key] || "");
    if (!/^[A-Za-z0-9_-]+$/.test(target)) throw new Error(`${type} 编号无效`);
    return type === "run_next_stage" ? {type, runId: target} : {type, jobId: target};
  }
  if (type === "create_revision_brief") {
    const chapter = Number(value.chapter);
    const feedback = String(value.feedback || "").trim();
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error("create_revision_brief 需要正整数章节");
    if (!feedback || feedback.length > 4000) throw new Error("create_revision_brief 需要非空返工要求");
    return {type, bookId, chapter, feedback};
  }
  if (type === "update_author_preference") {
    const category = String(value.category || "");
    const rule = String(value.rule || "").trim();
    const evidence = String(value.evidence || "").trim();
    if (!rule || rule.length > 1000) throw new Error("update_author_preference 需要非空规则");
    if (!evidence || evidence.length > 1000) throw new Error("update_author_preference 需要来源证据");
    if (!ALLOWED_PREFERENCE_CATEGORIES.has(category as AuthorPreference["category"])) throw new Error("update_author_preference 分类无效");
    return {type, bookId, category: category as AuthorPreference["category"], rule, evidence, enabled: value.enabled !== false};
  }
  if (type === "switch_view") {
    const view = String(value.view || "");
    if (!ALLOWED_VIEWS.has(view)) throw new Error("switch_view 目标无效");
    return {type, view};
  }
  if (type === "select_project") return {type, bookId};
  throw new Error(`工作台代理动作缺少必要字段：${type}`);
}

function validateArtifact(value: Record<string, unknown>): AgentPlanArtifact {
  if (value.stage !== "workbench_agent") throw new Error("JSON stage 必须是 workbench_agent");
  const summary = String(value.summary || "").trim();
  if (!summary || summary.length > 500) throw new Error("代理计划缺少 summary 或超过 500 字");
  const reasoning = Array.isArray(value.reasoning) ? value.reasoning.map(String) : [];
  if (!reasoning.length || reasoning.length > 8) throw new Error("代理计划必须包含 1—8 条 reasoning");
  const warnings = Array.isArray(value.warnings) ? value.warnings.map(String) : [];
  const rawActions = Array.isArray(value.actions) ? value.actions : [];
  if (!rawActions.length || rawActions.length > 5) throw new Error("代理计划必须包含 1—5 个动作");
  const actions = rawActions.map((item) => normalizeAction(item && typeof item === "object" ? item as Record<string, unknown> : {}));
  return {stage: "workbench_agent", summary, reasoning, actions, warnings};
}

export class WorkbenchAgent {
  constructor(
    private readonly root: string,
    private readonly store: StudioStore,
    private readonly launch: (job: AgentJob, instruction: string, outputSchema: Record<string, unknown>) => void,
  ) {}

  async start(message: string, context: Record<string, unknown>, history: Array<{role: string; text: string}> = []): Promise<AgentJob> {
    const instruction = String(message || "").trim();
    if (!instruction || instruction.length > 4000) throw new Error("代理指令必须为 1—4000 字");
    const taskId = `agent-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const promptDir = join(this.store.dataDir, "agent");
    await mkdir(promptDir, {recursive: true});
    const promptPath = join(promptDir, `${taskId}.prompt.md`);
    const outputPath = join(promptDir, `${taskId}.json`);
    const prompt = [
      "你是 Tomota Studio 的工作台代理，只负责把用户要求整理成可执行计划。",
      "你可以读取用户提供的当前工作台状态，但不得要求额外文件访问。",
      "只输出一个 JSON 文件，不修改任何项目文件、正文、Canon、workflow 或番茄平台。",
      "动作必须按顺序排列，一次最多 5 个；不确定时用 warnings 说明，不要猜。",
      "禁止输出凭据、Cookie、Token、平台验证码或隐藏思考原文。",
      "",
      "## 用户要求",
      instruction,
      "",
      "## 本书近期共创对话（公开摘要；越靠后越新）",
      JSON.stringify(history.slice(-16), null, 2),
      "承接已经确认的目标与限制；若新要求冲突，必须在 warnings 指出，禁止把每轮当成互不相关的新任务。",
      "",
      "## 当前工作台状态",
      JSON.stringify(context, null, 2),
      "",
      "## 输出 JSON Schema",
      JSON.stringify({
        stage: "workbench_agent",
        summary: "一句话说明准备做什么",
        reasoning: ["公开的判断依据，每条一句话，最多8条"],
        actions: [{
          type: "run_workflow|rework_chapter|run_next_stage|retry_job|create_revision_brief|update_author_preference|switch_view|select_project",
          bookId: "作品编号",
          chapter: "当动作需要章节时填写正整数",
          chapters: "run_workflow 专用：正整数数组",
          feedback: "返工、偏好或说明文本",
          runId: "run_next_stage 专用：工作流编号",
          jobId: "retry_job 专用：任务编号",
          category: "人物声音|对白密度|伏笔边界|节奏|章末|去AI味|题材偏好",
          rule: "可执行规则",
          evidence: "来源章节和原文证据",
          enabled: true,
          view: "overview|planning|workflow|workspace|fanqie|settings",
          autoRun: true,
        }],
        warnings: ["需要用户确认或补充的事项"],
      }, null, 2),
    ].join("\n");
    await writeFile(promptPath, prompt, "utf8");
    const job = this.store.createJob({
      runId: taskId, bookId: String(context.bookId || "workbench"), chapter: null,
      stage: "workbench_agent", status: "queued", promptPath,
      promptHash: "", outputPath, retryOf: null,
    });
    this.launch(job, prompt, {});
    return job;
  }

  async result(jobId: string): Promise<{job: AgentJob; events: JobEvent[]; artifact: AgentPlanArtifact | null}> {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error("代理任务不存在");
    const events = this.store.listEvents(jobId, 0);
    if (job.status !== "succeeded" || !job.outputPath) return {job, events, artifact: null};
    const parsed = JSON.parse(await readFile(job.outputPath, "utf8")) as Record<string, unknown>;
    return {job, events, artifact: validateArtifact(parsed)};
  }

  static validateArtifact = validateArtifact;
}
