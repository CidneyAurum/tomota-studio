import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface CommandResult<T = unknown> {
  value: T;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class TomotaCommandError extends Error {
  readonly exitCode: number;
  readonly stderrText: string;

  constructor(message: string, exitCode: number, stderrText: string) {
    super(message);
    this.exitCode = exitCode;
    this.stderrText = stderrText;
  }
}

export class PythonBridge {
  readonly root: string;
  readonly python: string;
  private readonly transactions = new AsyncLocalStorage<{bookId: string; token: string; file?: string}>();

  constructor(root: string, python = process.env.TOMOTA_PYTHON || "python") {
    this.root = resolve(root);
    this.python = python;
  }

  async run<T = unknown>(args: string[], options: {allowExitCodes?: number[]} = {}): Promise<CommandResult<T>> {
    const fullArgs = ["-m", "tomota", "--root", this.root, ...args];
    const transaction = this.transactions.getStore();
    if (transaction?.file) throw new Error("单文件事务不能执行其他 Python 操作");
    const env = { ...process.env, TOMOTA_BOOK_TRANSACTION: transaction?.token || "", TOMOTA_BOOK_TRANSACTION_BOOK: transaction?.bookId || "", PYTHONUTF8: "1", PYTHONPATH: [resolve(this.root, "src"), process.env.PYTHONPATH || ""].filter(Boolean).join(process.platform === "win32" ? ";" : ":") };
    return await new Promise((resolvePromise, reject) => {
      const child = spawn(this.python, fullArgs, { cwd: this.root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("close", (code) => {
        const exitCode = code ?? 1;
        let value: T;
        try {
          value = JSON.parse(stdout.trim()) as T;
        } catch {
          if (exitCode !== 0 && !(options.allowExitCodes || []).includes(exitCode)) {
            reject(new TomotaCommandError(stderr.trim() || stdout.trim() || "Tomota 命令执行失败", exitCode, stderr));
            return;
          }
          reject(new TomotaCommandError(`Tomota 命令没有返回有效 JSON：${stdout.slice(0, 500)}`, exitCode, stderr));
          return;
        }
        if (exitCode !== 0 && !(options.allowExitCodes || []).includes(exitCode)) {
          const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
          const structuredMessage = String(record.message || record.error || record.detail || "").trim();
          reject(new TomotaCommandError(structuredMessage || stderr.trim() || `Tomota 命令退出码 ${exitCode}`, exitCode, stderr));
          return;
        }
        resolvePromise({ value, stdout, stderr, exitCode });
      });
    });
  }

  async withBookTransaction<T>(bookId: string, operation: (transactionId: string) => Promise<T>, options: {file?: string} = {}): Promise<T> {
    const current = this.transactions.getStore();
    if (current) {
      if (current.bookId !== bookId) throw new Error("跨作品操作不能借用另一本书的事务");
      if (current.file || options.file) throw new Error("单文件事务不允许嵌套其他事务");
      return operation(current.token);
    }
    const child = spawn(this.python, ["-m", "tomota.book_transaction", "--root", this.root, "--book-id", bookId, ...(options.file ? ["--file", resolve(options.file)] : [])], {
      cwd: this.root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: {...process.env, TOMOTA_BOOK_TRANSACTION: "", TOMOTA_BOOK_TRANSACTION_BOOK: "", PYTHONUTF8: "1", PYTHONPATH: [resolve(this.root, "src"), process.env.PYTHONPATH || ""].filter(Boolean).join(process.platform === "win32" ? ";" : ":")},
    });
    let buffer = "", stderr = "", final: Record<string, string> = {};
    let readyResolve!: (token: string) => void, readyReject!: (error: Error) => void;
    const ready = new Promise<string>((yes, no) => {readyResolve = yes; readyReject = no;});
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stderr.on("data", value => {stderr = (stderr + value).slice(-4000);});
    child.stdout.on("data", value => {
      buffer += value;
      const lines = buffer.split("\n"); buffer = lines.pop() || "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as Record<string, string>;
          if (message.status === "ready") readyResolve(message.token);
          else {final = message; if (message.status === "error") readyReject(new Error(message.message));}
        } catch {readyReject(new Error("作品事务没有返回有效 JSON"));}
      }
    });
    const closed = new Promise<void>(resolveClose => {
      child.once("error", error => {readyReject(error); resolveClose();});
      child.once("close", () => {readyReject(new Error(final.message || stderr || "作品事务意外退出")); resolveClose();});
    });
    child.stdin.on("error", () => undefined);
    let value: T;
    try {
      const token = await ready;
      value = await this.transactions.run({bookId, token, file: options.file}, () => operation(token));
    } catch (error) {
      child.stdin.end("rollback\n"); await closed;
      if (final.status === "committed") throw new Error(`操作已提交，不能作为未执行重试：${error instanceof Error ? error.message : error}`);
      if (final.status !== "rolled_back") throw new Error(`${error instanceof Error ? error.message : error}；事务未确认恢复：${final.message || stderr || "协调进程意外退出，请先检查恢复记录"}`);
      throw error;
    }
    child.stdin.end("commit\n"); await closed;
    if (final.status !== "committed") throw new Error(`${final.message || "作品事务未确认完成"}；恢复记录：${final.recovery || "请检查作品事务标记"}`);
    return value;
  }

  private async runPayload<T>(args: string[], value: Record<string, unknown>): Promise<CommandResult<T>> {
    const directory = join(this.root, ".tomota-studio", "requests");
    await mkdir(directory, {recursive: true});
    const path = join(directory, `${randomUUID()}.json`);
    await writeFile(path, JSON.stringify(value), "utf8");
    try { return await this.run<T>([...args, "--file", path, "--json"]); }
    finally { await unlink(path).catch(() => undefined); }
  }

  listProjects(): Promise<CommandResult<Array<{id: string; title: string; updated_at: string}>>> {
    return this.run(["status", "--json"]);
  }

  refreshProjects(): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["book", "sync", "--json"]);
  }

  createBook(value: Record<string, unknown>): Promise<CommandResult<Record<string, unknown>>> {
    return this.runPayload(["book", "create"], value);
  }

  updateBook(bookId: string, value: Record<string, unknown>): Promise<CommandResult<Record<string, unknown>>> {
    return this.runPayload(["book", "update", "--book-id", bookId], value);
  }

  authors(includeSystem = false): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["author", "list", ...(includeSystem ? ["--include-system"] : []), "--json"]);
  }

  author(authorId: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["author", "get", "--author-id", authorId, "--json"]);
  }

  authorVersion(versionId: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["author", "version-get", "--version-id", versionId, "--json"]);
  }

  createAuthor(value: Record<string, unknown>): Promise<CommandResult<Record<string, unknown>>> {
    return this.runPayload(["author", "create"], value);
  }

  updateAuthor(authorId: string, value: Record<string, unknown>): Promise<CommandResult<Record<string, unknown>>> {
    return this.runPayload(["author", "update", "--author-id", authorId], value);
  }

  deleteAuthor(authorId: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["author", "delete", "--author-id", authorId, "--json"]);
  }

  createAuthorVersion(authorId: string, value: Record<string, unknown>): Promise<CommandResult<Record<string, unknown>>> {
    return this.runPayload(["author", "version-create", "--author-id", authorId], value);
  }

  publishAuthorVersion(authorId: string, versionId: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["author", "version-publish", "--author-id", authorId, "--version-id", versionId, "--json"]);
  }

  archiveAuthorVersion(authorId: string, versionId: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["author", "version-archive", "--author-id", authorId, "--version-id", versionId, "--json"]);
  }

  addAuthorSource(authorId: string, path: string, name: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["author", "source-add", "--author-id", authorId, "--file", path, "--name", name, "--rights-confirmed", "--json"]);
  }

  deleteAuthorSource(authorId: string, sourceId: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["author", "source-delete", "--author-id", authorId, "--source-id", sourceId, "--json"]);
  }

  reorderAuthorSources(authorId: string, sourceIds: string[]): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["author", "source-reorder", "--author-id", authorId, "--sources", sourceIds.join(","), "--json"]);
  }

  authorDistillContext(authorId: string, sourceIds: string[] = []): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["author", "distill-context", "--author-id", authorId, ...(sourceIds.length ? ["--sources", sourceIds.join(",")] : []), "--json"]);
  }

  previewAuthorBinding(bookId: string, versionId: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["author", "binding-preview", "--book-id", bookId, "--version-id", versionId, "--json"]);
  }

  bindAuthorVersion(bookId: string, versionId: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["author", "binding-set", "--book-id", bookId, "--version-id", versionId, "--json"]);
  }

  authorOverrides(bookId: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["author", "override-list", "--book-id", bookId, "--json"]);
  }

  setAuthorOverride(bookId: string, value: Record<string, unknown>): Promise<CommandResult<Record<string, unknown>>> {
    return this.runPayload(["author", "override-set", "--book-id", bookId], value);
  }

  deleteAuthorOverride(bookId: string, overrideId: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["author", "override-delete", "--book-id", bookId, "--override-id", overrideId, "--json"]);
  }

  importAuthorOverrides(bookId: string, preferences: Array<Record<string, unknown>>): Promise<CommandResult<Record<string, unknown>>> {
    return this.runPayload(["author", "override-import", "--book-id", bookId], {preferences});
  }

  compileAuthorPolicy(bookId: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["author", "policy-compile", "--book-id", bookId, "--json"]);
  }

  outline(bookId: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["book", "outline", "--book-id", bookId, "--json"]);
  }

  updateOutline(bookId: string, value: Record<string, unknown>): Promise<CommandResult<Record<string, unknown>>> {
    return this.runPayload(["book", "outline", "--book-id", bookId], value);
  }

  previewRebuild(bookId: string, scopeType: "chapter" | "volume" | "book", scopeId: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["book", "rebuild-preview", "--book-id", bookId, "--scope-type", scopeType, "--scope-id", scopeId, "--json"]);
  }

  rebuild(bookId: string, scopeType: "chapter" | "volume" | "book", scopeId: string, confirmation: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["book", "rebuild", "--book-id", bookId, "--scope-type", scopeType, "--scope-id", scopeId, "--confirm", confirmation, "--json"]);
  }

  project(bookId: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["status", "--book-id", bookId, "--json"]);
  }

  deslop(bookId: string, chapter: number, apply = false, quoteMode: "keep" | "yan" | "ascii" = "keep"): Promise<CommandResult<Record<string, unknown>>> {
    return this.run([
      "deslop", "--book-id", bookId, "--chapter", String(chapter),
      ...(apply ? ["--apply"] : []), "--quote-mode", quoteMode,
    ]);
  }

  qualityReport(bookId: string, chapters: number[] = []): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["quality", "report", "--book-id", bookId, ...(chapters.length ? ["--chapters", chapters.join(",")] : []), "--json"]);
  }

  startWorkflow(bookId: string, chapters: number[], maxRevisions = 5): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["workflow", "start", "--book-id", bookId, "--chapters", chapters.join(","), "--max-revisions", String(maxRevisions), "--exclusive", "--json"]);
  }

  startRework(bookId: string, chapter: number, feedback: string, maxRevisions = 5, requestId = ""): Promise<CommandResult<Record<string, unknown>>> {
    return this.runPayload(["workflow", "rework", "--book-id", bookId, "--chapter", String(chapter), "--max-revisions", String(maxRevisions)], {feedback, request_id: requestId});
  }

  startScopeRework(bookId: string, chapters: number[], scopeType: "book" | "volume" | "chapter", scopeId: string, feedback: string, maxRevisions = 5, bookRules?: Array<Record<string, unknown>>): Promise<CommandResult<Record<string, unknown>>> {
    return this.runPayload(["workflow", "rework-scope", "--book-id", bookId, "--chapters", chapters.join(","), "--scope-type", scopeType, "--scope-id", scopeId, "--max-revisions", String(maxRevisions)], {feedback, ...(bookRules ? {book_rules: bookRules} : {})});
  }

  workflowStatus(runId: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["workflow", "status", "--run-id", runId, "--json"]);
  }

  nextAction(runId: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["workflow", "next", "--run-id", runId, "--json"]);
  }

  submit(runId: string, file: string, actionId = ""): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["workflow", "submit", "--run-id", runId, "--file", file, "--action-id", actionId, "--json"], { allowExitCodes: [2] });
  }

  supersedeCandidate(runId: string, sourceStage: "story_foundation" | "chapter_design", chapter: number | null, file: string): Promise<CommandResult<Record<string, unknown>>> {
    const args = ["workflow", "supersede-candidate", "--run-id", runId, "--source-stage", sourceStage, "--file", file, "--json"];
    if (chapter !== null) args.push("--chapter", String(chapter));
    return this.run(args, {allowExitCodes: [2]});
  }

  recordFanqieSession(bookId: string, file: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["fanqie", "record-session", "--book-id", bookId, "--file", file, "--json"]);
  }
}
