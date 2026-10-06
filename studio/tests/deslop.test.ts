import assert from "node:assert/strict";
import {execFileSync, spawn, type ChildProcess} from "node:child_process";
import {once} from "node:events";
import {readFile, mkdtemp, rm} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {delimiter, join, resolve} from "node:path";
import {test} from "node:test";

import {PythonBridge, type CommandResult} from "../server/python.js";
import {StudioStore} from "../server/store.js";

const studioRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(studioRoot, "..");
const pythonPath = [join(repositoryRoot, "src"), process.env.PYTHONPATH || ""].filter(Boolean).join(delimiter);

class RecordingBridge extends PythonBridge {
  readonly calls: string[][] = [];

  override async run<T = unknown>(args: string[]): Promise<CommandResult<T>> {
    this.calls.push(args);
    return {value: {} as T, stdout: "{}", stderr: "", exitCode: 0};
  }
}

test("PythonBridge deslop keeps scans read-only and only adds --apply explicitly", async () => {
  const bridge = new RecordingBridge(repositoryRoot);
  await bridge.deslop("demo", 3);
  await bridge.deslop("demo", 4, true, "yan");
  assert.deepEqual(bridge.calls, [
    ["deslop", "--book-id", "demo", "--chapter", "3", "--quote-mode", "keep"],
    ["deslop", "--book-id", "demo", "--chapter", "4", "--apply", "--quote-mode", "yan"],
  ]);
});

function usablePython(candidate: string | undefined): candidate is string {
  if (!candidate) return false;
  try {
    execFileSync(candidate, ["-c", "from zoneinfo import ZoneInfo; ZoneInfo('Asia/Shanghai'); import tomota"], {
      cwd: repositoryRoot,
      env: {...process.env, PYTHONPATH: pythonPath},
      stdio: "ignore",
    });
    return true;
  } catch { return false; }
}

const python = [
  process.env.TOMOTA_PYTHON,
  process.platform === "win32" ? "D:\\Develop\\Python\\python.exe" : undefined,
  process.platform === "win32" ? "python.exe" : "python3",
  "python",
].find(usablePython);

function runPython(root: string, source: string): void {
  if (!python) throw new Error("Python runtime is unavailable");
  execFileSync(python, ["-c", source, root], {
    cwd: repositoryRoot,
    env: {...process.env, PYTHONUTF8: "1", PYTHONPATH: pythonPath},
    stdio: "pipe",
  });
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("无法分配临时端口"));
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForHealth(url: string, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`隔离 Studio 提前退出：${child.exitCode}\n${output()}`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch { /* Studio is still starting. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`隔离 Studio 启动超时\n${output()}`);
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const gracefulExit = once(child, "exit").catch(() => undefined);
  child.kill();
  await Promise.race([gracefulExit, new Promise((resolveWait) => setTimeout(resolveWait, 3_000))]);
  if (child.exitCode === null) {
    const forcedExit = once(child, "exit").catch(() => undefined);
    child.kill("SIGKILL");
    await Promise.race([forcedExit, new Promise((resolveWait) => setTimeout(resolveWait, 3_000))]);
  }
}

async function removeTempDir(path: string): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await rm(path, {recursive: true, force: true});
      return;
    } catch (error) {
      if ((error as {code?: string})?.code !== "EBUSY" || attempt === 11) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 125));
    }
  }
}

test("Studio deslop API scans read-only, blocks active work, and applies through the audited CLI", {
  skip: python ? false : "Python with Tomota and Asia/Shanghai timezone data is unavailable",
  timeout: 45_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-deslop-"));
  let server: ChildProcess | null = null;
  try {
    runPython(root, `
import sys
from pathlib import Path
from tomota.models import ChapterContract, WorkflowRun
from tomota.store import ProjectStore

root = Path(sys.argv[1])
store = ProjectStore(root)
store.initialize()
store.create_book("demo", "去AI味接线测试", {})
contract = ChapterContract(
    book_id="demo", chapter_number=1, title="第一章", objective="验证扫描",
    obstacle="运行状态冲突", change="安全应用", next_first_beat="继续验证",
)
store.save_outline_chapters("demo", [contract.to_dict()])
store.save_chapter(contract, status="draft_unreviewed", content="“你好”,他说...")
store.save_workflow_run(WorkflowRun(
    run_id="workflow-running", book_id="demo", chapter_numbers=[1], status="running",
    current_chapter=1, current_stage="draft",
))
`);

    // Keep the startup daily-backup timer out of this active-work guard test.
    const initialStore = new StudioStore(root);
    try {
      await initialStore.createWorkspaceSnapshot();
    } finally {
      initialStore.db.close();
    }

    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const tsxCli = join(studioRoot, "node_modules", "tsx", "dist", "cli.mjs");
    let serverOutput = "";
    server = spawn(process.execPath, [tsxCli, "server/index.ts"], {
      cwd: studioRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONPATH: pythonPath,
        TOMOTA_PYTHON: python,
        TOMOTA_ROOT: root,
        TOMOTA_STUDIO_PORT: String(port),
        TOMOTA_STUDIO_API_PORT: String(port),
      },
    });
    server.stdout?.on("data", (chunk) => { serverOutput += String(chunk); });
    server.stderr?.on("data", (chunk) => { serverOutput += String(chunk); });
    await waitForHealth(url, server, () => serverOutput);

    const endpoint = `${url}/api/projects/demo/chapters/1/deslop`;
    const chapterPath = join(root, "books", "demo", "drafts", "chapter-0001.md");
    const original = await readFile(chapterPath, "utf8");

    const scanResponse = await fetch(endpoint);
    assert.equal(scanResponse.status, 200, await scanResponse.clone().text());
    const scan = await scanResponse.json() as Record<string, unknown>;
    assert.equal(scan.applied, false);
    assert.equal(scan.punctuation_normalized, true);
    assert.equal(await readFile(chapterPath, "utf8"), original, "GET scan must not write the chapter");

    const postScanResponse = await fetch(endpoint, {
      method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({quoteMode: "yan"}),
    });
    assert.equal(postScanResponse.status, 200, await postScanResponse.clone().text());
    assert.equal((await postScanResponse.json() as Record<string, unknown>).applied, false);
    assert.equal(await readFile(chapterPath, "utf8"), original, "POST without apply=true must stay read-only");

    const workflowBlockedResponse = await fetch(endpoint, {
      method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({apply: true}),
    });
    assert.equal(workflowBlockedResponse.status, 400);
    assert.match(String((await workflowBlockedResponse.json() as {error?: string}).error || ""), /运行中的严格工作流/);
    assert.equal(await readFile(chapterPath, "utf8"), original);

    runPython(root, `
import sys
from pathlib import Path
from tomota.store import ProjectStore
store = ProjectStore(Path(sys.argv[1]))
run = store.load_workflow_run("workflow-running")
run.status = "completed"
store.save_workflow_run(run)
`);

    const jobStore = new StudioStore(root);
    const activeJob = jobStore.createJob({
      runId: "workflow-running", bookId: "demo", chapter: 1, stage: "draft", status: "running",
      promptPath: join(root, "active.prompt.md"), promptHash: "active", outputPath: join(root, "active.json"), retryOf: null,
    });
    jobStore.db.close();

    const jobBlockedResponse = await fetch(endpoint, {
      method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({apply: true}),
    });
    assert.equal(jobBlockedResponse.status, 400);
    assert.match(String((await jobBlockedResponse.json() as {error?: string}).error || ""), /活跃 Antigravity 任务/);
    assert.equal(await readFile(chapterPath, "utf8"), original);

    const completedJobStore = new StudioStore(root);
    completedJobStore.updateJob(activeJob.id, {status: "succeeded", finishedAt: new Date().toISOString()});
    completedJobStore.db.close();

    const appliedResponse = await fetch(endpoint, {
      method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({apply: true, quoteMode: "yan"}),
    });
    assert.equal(appliedResponse.status, 200, await appliedResponse.clone().text());
    const applied = await appliedResponse.json() as Record<string, unknown>;
    assert.equal(applied.applied, true);
    assert.equal((await readFile(chapterPath, "utf8")).replaceAll("\r\n", "\n"), "「你好」，他说……\n");
    assert.match(await readFile(join(root, "audit", "events.jsonl"), "utf8"), /"event_type": "chapter_deslopped"/);
  } finally {
    if (server) await stopServer(server);
    await removeTempDir(root);
  }
});
