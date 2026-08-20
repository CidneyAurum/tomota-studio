import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

import { AntigravityRunner } from "./antigravity.js";
import { FanqieBrowserService } from "./fanqie.js";
import { collectReviewFindings, listProjectFiles, readProjectFile, saveProjectFile } from "./projects.js";
import { PythonBridge } from "./python.js";
import { initializeWorkspace, StudioStore } from "./store.js";

const root = resolve(process.env.TOMOTA_ROOT || join(import.meta.dirname, "..", ".."));
const studioDir = resolve(import.meta.dirname, "..");
const distDir = join(studioDir, "dist");
const development = process.env.npm_lifecycle_event === "dev" || !existsSync(join(distDir, "index.html"));
const uiPort = Number(process.env.TOMOTA_STUDIO_PORT || 43127);
const apiPort = Number(process.env.TOMOTA_STUDIO_API_PORT || 43128);
const port = development ? apiPort : uiPort;
const host = "127.0.0.1";

const store = new StudioStore(root);
const migration = await initializeWorkspace(store);
const python = new PythonBridge(root);
await python.run(["studio-index", "--json"]);
const agyPrefix = (() => {
  try { return JSON.parse(process.env.TOMOTA_AGY_PREFIX_ARGS || "[]") as string[]; } catch { return []; }
})();
const runner = new AntigravityRunner(root, store, python, { prefixArgs: agyPrefix });
const fanqie = new FanqieBrowserService(root, store, python);
let lastProjectRefresh = 0;
let projectRefresh: Promise<unknown> | null = null;

async function refreshProjectIndex(force = false): Promise<void> {
  if (!force && Date.now() - lastProjectRefresh < 2_000) return;
  if (!projectRefresh) {
    projectRefresh = python.refreshProjects().then(() => { lastProjectRefresh = Date.now(); }).finally(() => { projectRefresh = null; });
  }
  await projectRefresh;
}

function isLoopbackHost(value: string): boolean {
  const hostName = value.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return hostName === "127.0.0.1" || hostName === "localhost" || hostName === "::1";
}

function validOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try { return isLoopbackHost(new URL(origin).hostname); } catch { return false; }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; font-src 'self' data:; frame-ancestors 'none'");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  setSecurityHeaders(response);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) {
    text += chunk.toString("utf8");
    if (Buffer.byteLength(text) > 5 * 1024 * 1024) throw new Error("请求内容超过 5 MB 限制");
  }
  if (!text) return {};
  const value = JSON.parse(text) as unknown;
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("请求正文必须是 JSON 对象");
  return value as Record<string, unknown>;
}

function id(value: string, label = "编号"): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label}格式无效`);
  return value;
}

async function projectSummaries(): Promise<Array<Record<string, unknown>>> {
  await refreshProjectIndex();
  const projects = (await python.listProjects()).value;
  return await Promise.all(projects.map(async (project) => {
    const detail = (await python.project(project.id)).value as {chapters?: Array<Record<string, unknown>>; workflows?: Array<Record<string, unknown>>; book?: Record<string, unknown>};
    const chapters = detail.chapters || [];
    const workflows = detail.workflows || [];
    const latest = workflows[0] || null;
    const approvedStatuses = new Set(["approved", "reviewed_pending_approval", "scheduled", "submitted", "published"]);
    return {
      ...project,
      metadata: detail.book?.metadata || {},
      chapterCount: chapters.length,
      plannedChapterCount: chapters.length,
      completionMode: String((detail.book?.metadata as Record<string, unknown> | undefined)?.completion_mode || "open_ended"),
      targetChapterCount: (detail.book?.metadata as Record<string, unknown> | undefined)?.target_chapters || null,
      approvedCount: chapters.filter((chapter) => approvedStatuses.has(String(chapter.status))).length,
      blockedCount: chapters.filter((chapter) => chapter.status === "blocked").length,
      publishReadyCount: chapters.filter((chapter) => chapter.status === "approved" && chapter.review_path).length,
      latestWorkflow: latest,
      activeJob: store.activeJobForBook(project.id),
      legacy: true,
    };
  }));
}

async function skillSettings(): Promise<Record<string, unknown>> {
  const result = await python.run<Record<string, unknown>>(["skill", "status"], { allowExitCodes: [2] })
    .catch((error) => ({ value: { ok: false, error: error instanceof Error ? error.message : String(error) } }));
  const value = result.value as Record<string, unknown>;
  const manifestValue = value.manifest;
  if (!manifestValue || Array.isArray(manifestValue) || typeof manifestValue !== "object") return value;
  const { file_hashes: _fileHashes, ...manifest } = manifestValue as Record<string, unknown>;
  return {...value, manifest};
}

async function api(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/api/")) return false;
  if (request.method === "GET" && url.pathname === "/api/health") {
    json(response, 200, { status: "ok", root, localOnly: true, migration, antigravity: runner.status(), fanqie: fanqie.availability() });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/projects") {
    json(response, 200, await projectSummaries());
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/projects") {
    const value = await body(request);
    const created = await python.createBook(value);
    lastProjectRefresh = 0;
    json(response, 201, created.value);
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/planning/generate") {
    const value = await body(request);
    const scope = String(value.scope || "");
    if (!["new_book", "book", "volume", "chapter"].includes(scope)) throw new Error("AI 规划层级无效");
    const bookId = scope === "new_book" ? "new-book" : id(String(value.bookId || ""), "作品编号");
    const mode = value.mode === "fill" ? "fill" : "rewrite";
    const instruction = String(value.instruction || "").trim();
    if (!instruction || instruction.length > 4_000) throw new Error("请提供 1—4000 字的共创要求");
    const context = value.context && !Array.isArray(value.context) && typeof value.context === "object" ? value.context as Record<string, unknown> : {};
    json(response, 202, await runner.startPlanning({bookId, scope: scope as "new_book" | "book" | "volume" | "chapter", mode, instruction, context}));
    return true;
  }
  let planningMatch = url.pathname.match(/^\/api\/planning\/jobs\/([A-Za-z0-9_-]+)$/);
  if (request.method === "GET" && planningMatch) {
    json(response, 200, await runner.planningResult(id(planningMatch[1], "任务编号")));
    return true;
  }
  let match = url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)$/);
  if (request.method === "GET" && match) {
    const bookId = id(match[1], "作品编号");
    await refreshProjectIndex();
    const detail = (await python.project(bookId)).value as {workflows?: Array<{id?: string}>};
    const workflowState = detail.workflows?.[0]?.id ? (await python.workflowStatus(String(detail.workflows[0].id))).value : null;
    const outline = (await python.outline(bookId)).value;
    json(response, 200, { ...detail, outline, workflowState, files: await listProjectFiles(root, bookId), findings: await collectReviewFindings(root, bookId), jobs: store.listJobs(undefined).filter((job) => job.bookId === bookId) });
    return true;
  }
  if (request.method === "PUT" && match) {
    const bookId = id(match[1], "作品编号");
    const value = await body(request);
    json(response, 200, (await python.updateBook(bookId, value)).value);
    return true;
  }
  match = url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/outline$/);
  if (request.method === "GET" && match) {
    json(response, 200, (await python.outline(id(match[1], "作品编号"))).value);
    return true;
  }
  if (request.method === "PUT" && match) {
    const bookId = id(match[1], "作品编号");
    const value = await body(request);
    json(response, 200, (await python.updateOutline(bookId, value)).value);
    return true;
  }
  match = url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/files$/);
  if (request.method === "GET" && match) {
    json(response, 200, await listProjectFiles(root, id(match[1], "作品编号")));
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/files") {
    const path = url.searchParams.get("path") || "";
    json(response, 200, await readProjectFile(root, path));
    return true;
  }
  if (request.method === "PUT" && url.pathname === "/api/files") {
    const value = await body(request);
    const result = await saveProjectFile(root, String(value.path || ""), String(value.content || ""), String(value.expectedHash || ""));
    json(response, 200, result);
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/workflows") {
    const value = await body(request);
    const bookId = id(String(value.bookId || ""), "作品编号");
    const chapters = Array.isArray(value.chapters) ? value.chapters.map(Number).filter((item) => Number.isInteger(item) && item > 0) : [];
    if (!chapters.length) throw new Error("至少选择一个正整数章节号");
    const started = (await python.startWorkflow(bookId, chapters, Math.min(5, Math.max(1, Number(value.maxRevisions || 5))))).value;
    const run = started.run as Record<string, unknown>;
    const auto = value.autoRun !== false ? await runner.startContinuous(String(run.run_id)) : null;
    json(response, 201, { ...started, agent: auto });
    return true;
  }
  match = url.pathname.match(/^\/api\/workflows\/([A-Za-z0-9_-]+)$/);
  if (request.method === "GET" && match) {
    const runId = id(match[1], "工作流编号");
    json(response, 200, { workflow: (await python.workflowStatus(runId)).value, jobs: store.listJobs(runId) });
    return true;
  }
  match = url.pathname.match(/^\/api\/workflows\/([A-Za-z0-9_-]+)\/run-next$/);
  if (request.method === "POST" && match) {
    json(response, 202, await runner.startContinuous(id(match[1], "工作流编号")));
    return true;
  }
  match = url.pathname.match(/^\/api\/workflows\/([A-Za-z0-9_-]+)\/feedback$/);
  if (request.method === "GET" && match) {
    json(response, 200, {feedback: store.listWorkflowFeedback(id(match[1], "工作流编号"))});
    return true;
  }
  if (request.method === "POST" && match) {
    const runId = id(match[1], "工作流编号");
    const value = await body(request);
    const content = String(value.feedback || "").trim();
    if (!content || content.length > 4_000) throw new Error("修改反馈必须为 1—4000 个字符");
    const workflow = (await python.workflowStatus(runId)).value;
    if (workflow.status !== "running") throw new Error("只有运行中的工作流可以按反馈重跑当前阶段");
    const bookId = String(workflow.book_id || "");
    const stage = String(workflow.current_stage || "");
    const chapter = workflow.current_chapter === null || workflow.current_chapter === undefined ? null : Number(workflow.current_chapter);
    const active = store.activeJobForBook(bookId);
    if (active && active.runId !== runId) throw new Error("同一本书的另一条工作流正在运行，请先停止后再提交反馈");
    const feedback = store.addWorkflowFeedback(runId, bookId, stage, chapter, content);
    let retryOf = store.listJobs(runId, 1)[0]?.id || null;
    if (active && active.runId === runId) {
      retryOf = active.id;
      runner.cancel(active.id);
    }
    const started = await runner.startContinuous(runId, retryOf);
    json(response, 202, {feedback, feedbackHistory: store.listWorkflowFeedback(runId), ...started});
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/jobs") {
    json(response, 200, store.listJobs(url.searchParams.get("runId") || undefined));
    return true;
  }
  match = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)\/cancel$/);
  if (request.method === "POST" && match) {
    json(response, 200, runner.cancel(id(match[1], "任务编号")));
    return true;
  }
  match = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)\/retry$/);
  if (request.method === "POST" && match) {
    json(response, 202, await runner.retry(id(match[1], "任务编号")));
    return true;
  }
  match = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)\/events$/);
  if (request.method === "GET" && match) {
    const jobId = id(match[1], "任务编号");
    const after = Number(url.searchParams.get("after") || 0);
    setSecurityHeaders(response);
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    const send = (event: {id: number; jobId: string; level: string; message: string; createdAt: string}) => response.write(`id: ${event.id}\nevent: ${event.level}\ndata: ${JSON.stringify(event)}\n\n`);
    for (const event of store.listEvents(jobId, after)) send(event);
    const listener = (event: {id: number; jobId: string; level: string; message: string; createdAt: string}) => { if (event.jobId === jobId) send(event); };
    runner.on("job-event", listener);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    request.on("close", () => { clearInterval(heartbeat); runner.off("job-event", listener); });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/settings") {
    json(response, 200, { antigravity: runner.status(), fanqie: fanqie.availability(), skill: await skillSettings(), migration, retention: {days: 7, maxBookMb: 100, defaultAction: "preview"} });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/skill/refresh-lock") {
    await python.run(["skill", "refresh-lock"]);
    json(response, 200, await skillSettings());
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/antigravity/probe") {
    json(response, 200, await runner.probe());
    return true;
  }
  match = url.pathname.match(/^\/api\/cleanup\/([A-Za-z0-9_-]+)$/);
  if (request.method === "POST" && match) {
    const value = await body(request);
    const args = ["cleanup", "--book-id", id(match[1], "作品编号")];
    if (value.apply === true) args.push("--apply");
    json(response, 200, (await python.run(args)).value);
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/fanqie/accounts") {
    const accounts = fanqie.accounts();
    json(response, 200, {accounts, activeAccountId: accounts.find((item) => item.active)?.id || null});
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/fanqie/accounts") {
    const value = await body(request);
    fanqie.createAccount(String(value.label || ""));
    json(response, 201, {accounts: fanqie.accounts(), session: await fanqie.session()});
    return true;
  }
  match = url.pathname.match(/^\/api\/fanqie\/accounts\/([A-Za-z0-9_-]+)\/switch$/);
  if (request.method === "POST" && match) {
    fanqie.switchAccount(id(match[1], "账号编号"));
    json(response, 200, {accounts: fanqie.accounts(), session: await fanqie.session()});
    return true;
  }
  match = url.pathname.match(/^\/api\/fanqie\/accounts\/([A-Za-z0-9_-]+)\/rename$/);
  if (request.method === "POST" && match) {
    const value = await body(request);
    fanqie.renameAccount(id(match[1], "账号编号"), String(value.label || ""));
    json(response, 200, {accounts: fanqie.accounts(), session: await fanqie.session()});
    return true;
  }
  match = url.pathname.match(/^\/api\/fanqie\/accounts\/([A-Za-z0-9_-]+)\/close$/);
  if (request.method === "POST" && match) {
    await fanqie.closeAccount(id(match[1], "账号编号"));
    json(response, 200, {accounts: fanqie.accounts(), session: await fanqie.session()});
    return true;
  }
  match = url.pathname.match(/^\/api\/fanqie\/accounts\/([A-Za-z0-9_-]+)\/archive$/);
  if (request.method === "POST" && match) {
    const accountId = id(match[1], "账号编号");
    const value = await body(request);
    await fanqie.archiveAccount(accountId, String(value.confirmation || ""));
    json(response, 200, {accounts: fanqie.accounts(), session: await fanqie.session()});
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/fanqie/session") {
    json(response, 200, await fanqie.session());
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/fanqie/login/open") {
    json(response, 200, await fanqie.openLogin());
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/fanqie/sync") {
    const value = await body(request);
    const bookIds = Array.isArray(value.bookIds) ? value.bookIds.map(String) : [];
    json(response, 200, await fanqie.sync(bookIds));
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/fanqie/works") {
    json(response, 200, { works: store.listWorks(), chapters: store.listChapters(url.searchParams.get("workId") || undefined) });
    return true;
  }
  match = url.pathname.match(/^\/api\/fanqie\/local\/([A-Za-z0-9_-]+)$/);
  if (request.method === "GET" && match) {
    const bookId = id(match[1], "作品编号");
    const project = (await python.project(bookId)).value as {book?: Record<string, unknown>};
    const assetsDir = join(root, "books", bookId, "assets");
    const covers = existsSync(assetsDir) ? (await readdir(assetsDir, {withFileTypes: true}))
      .filter((item) => item.isFile() && /\.(png|jpe?g|webp)$/i.test(item.name))
      .map((item) => join(assetsDir, item.name)) : [];
    json(response, 200, {book: project.book || null, covers, platformWorks: store.listWorks()});
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/fanqie/works/preview-write") {
    const value = await body(request);
    json(response, 201, await fanqie.prepareWorkWrite(id(String(value.bookId || ""), "作品编号"), String(value.platformWorkId || ""), value.fields && typeof value.fields === "object" ? value.fields as Record<string, unknown> : {}));
    return true;
  }
  match = url.pathname.match(/^\/api\/fanqie\/works\/([A-Za-z0-9_-]+)\/execute$/);
  if (request.method === "POST" && match) {
    const value = await body(request);
    json(response, 200, await fanqie.executeWorkWrite(id(match[1], "写入预览编号"), String(value.confirmation || "")));
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/fanqie/batches/preview") {
    const value = await body(request);
    const chapters = Array.isArray(value.chapters) ? value.chapters.map(Number).filter((item) => Number.isInteger(item) && item > 0) : [];
    if (!chapters.length) throw new Error("发布批次至少需要一个已严格通过的章节");
    const schedule = value.schedule && typeof value.schedule === "object" ? value.schedule as Record<string, unknown> : {};
    json(response, 201, await fanqie.prepareBatch(id(String(value.bookId || ""), "作品编号"), chapters, String(value.platformWorkId || ""), {
      mode: schedule.mode === "immediate" ? "immediate" : "scheduled",
      chaptersPerDay: Number(schedule.chaptersPerDay || 2),
      publishHour: Number(schedule.publishHour ?? 20),
      startAt: schedule.startAt ? String(schedule.startAt) : null,
    }));
    return true;
  }
  match = url.pathname.match(/^\/api\/fanqie\/batches\/([A-Za-z0-9_-]+)\/confirm$/);
  if (request.method === "POST" && match) {
    const value = await body(request);
    const operation = String(value.operation);
    if (!["publish", "write", "submit"].includes(operation)) throw new Error("未知的确认操作");
    json(response, 201, fanqie.confirm(operation as "publish" | "write" | "submit", id(match[1], "批次编号"), String(value.token || ""), value.chapter === undefined ? undefined : Number(value.chapter), value.hash === undefined ? undefined : String(value.hash)));
    return true;
  }
  match = url.pathname.match(/^\/api\/fanqie\/batches\/([A-Za-z0-9_-]+)\/execute$/);
  if (request.method === "POST" && match) {
    const value = await body(request);
    json(response, 200, await fanqie.executeBatch(id(match[1], "批次编号"), String(value.confirmation || ""), String(value.actionConfirmation || ""), value.chapterConfirmations as Record<string, string> || {}));
    return true;
  }
  match = url.pathname.match(/^\/api\/fanqie\/batches\/([A-Za-z0-9_-]+)\/reconcile$/);
  if (request.method === "POST" && match) {
    json(response, 200, await fanqie.reconcile(id(match[1], "批次编号")));
    return true;
  }
  json(response, 404, { error: "API endpoint not found" });
  return true;
}

async function staticFile(response: ServerResponse, url: URL): Promise<void> {
  if (development) {
    json(response, 404, { error: "开发模式下前端由 Vite 提供" });
    return;
  }
  const requestPath = decodeURIComponent(url.pathname);
  const candidate = resolve(distDir, `.${requestPath}`);
  const withinDist = !relative(distDir, candidate).startsWith("..") && !relative(distDir, candidate).startsWith("/") && !relative(distDir, candidate).startsWith("\\");
  const target = withinDist && existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(distDir, "index.html");
  const content = await readFile(target);
  const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8" };
  setSecurityHeaders(response);
  response.writeHead(200, { "Content-Type": contentTypes[extname(target)] || "application/octet-stream", "Cache-Control": target.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable" });
  response.end(content);
}

const server = createServer(async (request, response) => {
  try {
    const hostHeader = request.headers.host || "";
    const parsedHost = hostHeader.startsWith("[") ? hostHeader.slice(1, hostHeader.indexOf("]")) : hostHeader.split(":")[0];
    if (!isLoopbackHost(parsedHost) || !validOrigin(request.headers.origin)) {
      json(response, 403, { error: "Tomota Studio 只接受本机同源请求" });
      return;
    }
    const url = new URL(request.url || "/", `http://${hostHeader}`);
    if (await api(request, response, url)) return;
    await staticFile(response, url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    json(response, 400, { error: message, code: String((error as {code?: string})?.code || "request_failed") });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Tomota Studio ${development ? "API" : "本机地址"}：http://${host}:${port}\n`);
  process.stdout.write(`现有项目清单：${migration.manifestPath}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
