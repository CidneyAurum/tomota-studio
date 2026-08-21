import { spawn } from "node:child_process";
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

  constructor(root: string, python = process.env.TOMOTA_PYTHON || "python") {
    this.root = resolve(root);
    this.python = python;
  }

  async run<T = unknown>(args: string[], options: {allowExitCodes?: number[]} = {}): Promise<CommandResult<T>> {
    const fullArgs = ["-m", "tomota", "--root", this.root, ...args];
    const env = { ...process.env, PYTHONUTF8: "1", PYTHONPATH: [resolve(this.root, "src"), process.env.PYTHONPATH || ""].filter(Boolean).join(process.platform === "win32" ? ";" : ":") };
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
          reject(new TomotaCommandError(stderr.trim() || `Tomota 命令退出码 ${exitCode}`, exitCode, stderr));
          return;
        }
        resolvePromise({ value, stdout, stderr, exitCode });
      });
    });
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

  outline(bookId: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["book", "outline", "--book-id", bookId, "--json"]);
  }

  updateOutline(bookId: string, value: Record<string, unknown>): Promise<CommandResult<Record<string, unknown>>> {
    return this.runPayload(["book", "outline", "--book-id", bookId], value);
  }

  project(bookId: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["status", "--book-id", bookId, "--json"]);
  }

  startWorkflow(bookId: string, chapters: number[], maxRevisions = 5): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["workflow", "start", "--book-id", bookId, "--chapters", chapters.join(","), "--max-revisions", String(maxRevisions), "--json"]);
  }

  startRework(bookId: string, chapter: number, feedback: string, maxRevisions = 5): Promise<CommandResult<Record<string, unknown>>> {
    return this.runPayload(["workflow", "rework", "--book-id", bookId, "--chapter", String(chapter), "--max-revisions", String(maxRevisions)], {feedback});
  }

  workflowStatus(runId: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["workflow", "status", "--run-id", runId, "--json"]);
  }

  nextAction(runId: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["workflow", "next", "--run-id", runId, "--json"]);
  }

  submit(runId: string, file: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["workflow", "submit", "--run-id", runId, "--file", file, "--json"], { allowExitCodes: [2] });
  }

  recordFanqieSession(bookId: string, file: string): Promise<CommandResult<Record<string, unknown>>> {
    return this.run(["fanqie", "record-session", "--book-id", bookId, "--file", file, "--json"]);
  }
}
