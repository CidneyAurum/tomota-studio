import assert from "node:assert/strict";
import {execFileSync, spawn} from "node:child_process";
import {once} from "node:events";
import {mkdir, mkdtemp, readFile, writeFile, rm, symlink} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {test} from "node:test";
import {StudioStore} from "../server/store.js";
import type {AgentPlanArtifact} from "../server/agent.js";

test("audit API regressions use real Python contracts and only isolated fixture data", {timeout: 180000}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tomota-api-regression-"));
  const studio = resolve(import.meta.dirname, "..");
  const repository = resolve(studio, "..");
  const python = process.env.TOMOTA_PYTHON || "python";
  const env = {...process.env, PYTHONPATH: join(repository, "src"), PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1"};
  const py = (code: string) => execFileSync(python, ["-c", code, root], {env, windowsHide: true, encoding: "utf8"});
  py(`
import sys
from pathlib import Path
from tomota.store import ProjectStore
from tomota.models import ChapterContract
from tomota.authors import AuthorService
s = ProjectStore(Path(sys.argv[1]))
for book in ['start-auto','start-manual','rework-auto','rework-manual','long','stale','stale-outline','file-race']:
 s.create_book(book, 'Fixture '+book, {})
 c = ChapterContract(book, 1, 'One', 'Goal', 'Obstacle', 'Change', next_first_beat='Next')
 s.save_outline_chapters(book, [c.to_dict()])
 s.save_chapter(c, status='draft_unreviewed', content='Original fixture evidence.')
 AuthorService(s.root).compile_policy(book)
`);
  const recoveryMarker = py(`
import sys, json
from tomota.store import ProjectStore
from tomota.book_lock import owner_path
s=ProjectStore(sys.argv[1]); staging=s.root/'.planning-staging'/'file-startup-fixture'; staging.mkdir(parents=True)
owner=owner_path(s.root,'file-race')
s.write_json(owner, {'book_id':'file-race','token':'e'*32,'snapshot':str(staging),'scope':'file','decision':'commit'})
print(str(owner))
`).trim();
  const originalMarker = await readFile(recoveryMarker, "utf8");
  const dummy = join(root, "no-model.mjs");
  await writeFile(dummy, "process.exit(1);", "utf8");
  const port = await new Promise<number>((resolvePort, reject) => {
    const server = createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {const port = (server.address() as {port: number}).port; server.close(() => resolvePort(port));});
  });
  // Finish schema initialization and today's snapshot before starting a second
  // database connection and the server's daily-backup timer.
  const store = new StudioStore(root);
  try {
    await store.createWorkspaceSnapshot();
  } catch (error) {
    store.db.close();
    await rm(root, {recursive: true, force: true});
    throw error;
  }
  // --import runs the actual server in this child, avoiding an extra launcher process.
  const serverArgs = process.env.TOMOTA_TEST_COMPILED === "1" ? ["dist-server/index.js"] : ["--import", "tsx", "server/index.ts"];
  const child = spawn(process.execPath, serverArgs, {cwd: studio, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: {...env, TOMOTA_ROOT: root, TOMOTA_PYTHON: python, TOMOTA_STUDIO_PORT: String(port), TOMOTA_STUDIO_API_PORT: String(port), TOMOTA_AGY_EXECUTABLE: process.execPath, TOMOTA_AGY_PREFIX_ARGS: JSON.stringify([dummy])}});
  let logs = "";
  child.stdout.on("data", (v) => {logs = (logs + v).slice(-6000);}); child.stderr.on("data", (v) => {logs = (logs + v).slice(-6000);});
  const base = `http://127.0.0.1:${port}`;
  const post = async (path: string, body = {}) => {const r = await fetch(base + path, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)}); return {status: r.status, value: await r.json() as any};};
  const idle = async (book: string) => {
    const deadline = Date.now() + 15000;
    while (store.activeJobForBook(book) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30));
    assert.equal(store.activeJobForBook(book), null);
  };
  try {
    const deadline = Date.now() + 30000;
    let healthy = false;
    while (!healthy && Date.now() < deadline) {
      assert.equal(child.exitCode, null, logs);
      healthy = await fetch(base + "/api/health").then((r) => r.ok).catch(() => false);
      if (!healthy) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(healthy, logs);
    await t.test("startup with pending recovery opens read-only diagnostics without erasing the marker", async () => {
      const health = await (await fetch(base + "/api/health")).json() as any;
      assert.match(health.buildId, /^[a-f0-9]{64}$/);
      for (let i = 0; i < 2; i++) {
        const response = await fetch(base + "/api/runtime/recovery"); assert.equal(response.status, 200);
        const diagnostics = await response.json() as any;
        assert.equal(diagnostics.entries.length, 1);
        assert.equal(diagnostics.entries[0].bookId, "file-race");
        assert.equal(diagnostics.entries[0].state, "committed_cleanup");
        assert.doesNotMatch(JSON.stringify(diagnostics), /eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee/);
        assert.equal(await readFile(recoveryMarker, "utf8"), originalMarker);
      }
      py("import sys; from tomota.store import ProjectStore; from tomota.book_transaction import coordinate; coordinate(ProjectStore(sys.argv[1]), 'file-race', recover=True)");
      const diagnostics = await (await fetch(base + "/api/runtime/recovery")).json() as any;
      assert.deepEqual(diagnostics.entries, []);
    });
    await t.test("concurrent HTTP confirmations execute exactly once", async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const artifact: AgentPlanArtifact = {stage: "workbench_agent", summary: "Atomic confirmation", reasoning: ["Requested"], warnings: [], actions: [{type: "create_revision_brief", bookId: "file-race", chapter: 1, feedback: "Change fixture"}]};
        const outputPath = join(root, `atomic-${attempt}.json`);
        await writeFile(outputPath, JSON.stringify(artifact));
        const job = store.createJob({runId: `atomic-${attempt}`, bookId: "file-race", chapter: null, stage: "workbench_agent", status: "succeeded", promptPath: outputPath, promptHash: "fixture", outputPath, retryOf: null});
        store.saveAgentPlan(job, artifact);
        const responses = await Promise.all([post(`/api/agent/plans/${job.id}/execute`), post(`/api/agent/plans/${job.id}/execute`)]);
        assert.deepEqual(responses.map(r => r.status).sort(), [200, 400]);
        assert.equal(store.listRevisionBriefs("file-race").filter(b => b.sourceJobId === job.id).length, 1);
        assert.equal((await post(`/api/agent/plans/${job.id}/reject`)).status, 400);
        assert.equal(store.getAgentPlan(job.id)?.status, "executed");
      }
    });
    await t.test("file HTTP API rejects junctions and conflicting saves", async () => {
      const outside = join(root, "mock-outside-books"), drafts = join(root, "books", "file-race", "drafts");
      await mkdir(outside); await writeFile(join(outside, "fixture.txt"), "Outside original");
      const link = join(drafts, "linked");
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
      const escape = join(link, "fixture.txt");
      const put = (path: string, content: string, expectedHash: string) => fetch(base + "/api/files", {method: "PUT", headers: {"Content-Type": "application/json"}, body: JSON.stringify({path, content, expectedHash})});
      assert.equal((await fetch(base + `/api/files?path=${encodeURIComponent(escape)}`)).status, 400);
      assert.equal((await put(escape, "Not allowed", "hash")).status, 400);
      assert.equal(await readFile(join(outside, "fixture.txt"), "utf8"), "Outside original");
      const file = join(drafts, "chapter-0001.md");
      const current = await (await fetch(base + `/api/files?path=${encodeURIComponent(file)}`)).json() as any;
      const results = await Promise.all([put(file, "Writer A", current.hash), put(file, "Writer B", current.hash)]);
      assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
      assert.equal(await readFile(file, "utf8"), results[0].status === 200 ? "Writer A" : "Writer B");
      const active = store.createJob({runId: "file-writer", bookId: "file-race", chapter: 1, stage: "draft", status: "running", promptPath: "fixture", promptHash: "fixture", outputPath: "fixture", retryOf: null});
      try {
        const fresh = await (await fetch(base + `/api/files?path=${encodeURIComponent(file)}`)).json() as any;
        assert.equal((await put(file, "While model is running", fresh.hash)).status, 400);
        assert.equal(await readFile(file, "utf8"), fresh.content);
      } finally { store.updateJob(active.id, {status: "cancelled"}); }
    });
    for (const type of ["run_workflow", "rework_chapter"] as const) for (const autoRun of [false, true]) {
      await t.test(`${type} autoRun=${autoRun} uses the nested workflow id`, async () => {
        const bookId = `${type === "run_workflow" ? "start" : "rework"}-${autoRun ? "auto" : "manual"}`;
        const action = type === "run_workflow" ? {type, bookId, chapters: [1], autoRun} : {type, bookId, chapter: 1, feedback: "Change the scene", autoRun};
        const artifact: AgentPlanArtifact = {stage: "workbench_agent", summary: "Fixture", reasoning: ["Requested"], warnings: [], actions: [action]};
        const outputPath = join(root, `${bookId}.json`);
        await writeFile(outputPath, JSON.stringify(artifact));
        const job = store.createJob({runId: `agent-${bookId}`, bookId, chapter: null, stage: "workbench_agent", status: "succeeded", promptPath: outputPath, promptHash: "fixture", outputPath, retryOf: null});
        store.saveAgentPlan(job, artifact);
        const result = await post(`/api/agent/plans/${job.id}/execute`);
        assert.equal(result.status, 200, JSON.stringify(result.value));
        assert.equal(result.value.execution.status, "executed", JSON.stringify(result.value));
        assert.doesNotMatch(result.value.execution.actions[0].detail, /undefined/);
        await idle(bookId);
      });
    }
    for (const book of ["long", "stale", "stale-outline"]) await t.test(`feedback ${book} checks a real frozen manifest before writes`, async () => {
      const created = await post(`/api/projects/${book}/reader-feedback`, {scopeType: "chapter", scopeId: "1", content: book === "long" ? "长".repeat(3900) : "Revise fixture"});
      assert.equal(created.status, 202, JSON.stringify(created.value));
      const feedbackId = created.value.feedback.id;
      await idle(book);
      store.updateReaderFeedback(feedbackId, {status: "evaluated", evaluation: {verdict: "actionable", summary: "评".repeat(200), affected_chapters: [1], preserve: ["Facts"], changes: ["Change scene"], risks: [], compiled_instruction: "Complete revision", proposed_book_rules: [{category: "节奏", rule: "Use observable actions", evidence_refs: ["E1"]}]}});
      if (book === "stale") await writeFile(join(root, "books", book, "drafts", "chapter-0001.md"), "Changed after evaluation");
      if (book === "stale-outline") {
        const file = join(root, "books", book, "outlines", "chapters.json");
        const chapters = JSON.parse(await readFile(file, "utf8"));
        chapters[0].objective = "An externally edited goal not yet indexed";
        await writeFile(file, JSON.stringify(chapters));
      }
      const result = await post(`/api/reader-feedback/${feedbackId}/rework`);
      assert.equal(result.status, book === "long" ? 202 : 400, JSON.stringify(result.value));
      if (book !== "long") assert.match(result.value.error, /已过期/);
      const rules = JSON.parse(py(`import sys,json; from tomota.authors import AuthorService; print(json.dumps(AuthorService(sys.argv[1]).list_overrides('${book}')))`));
      assert.equal(rules.length, book === "long" ? 1 : 0);
      assert.equal(store.getReaderFeedback(feedbackId)?.status, book === "long" ? "reworking" : "evaluated");
      await idle(book);
    });
    await t.test("backup API rejects activity even without a local model process", async () => {
      const job = store.createJob({runId: "external-fixture", bookId: "fixture", chapter: null, stage: "workbench_agent", status: "running", promptPath: "fixture", promptHash: "fixture", outputPath: "fixture", retryOf: null});
      const metrics = await (await fetch(base + "/api/metrics/stages")).json() as any;
      assert.equal(metrics.runtime.active, 1); assert.equal(metrics.runtime.localActive, 0);
      const result = await post("/api/backups");
      assert.equal(result.status, 400, JSON.stringify(result.value));
      store.updateJob(job.id, {status: "cancelled"});
    });
  } finally {
    if (child.exitCode === null) {const exited = once(child, "exit"); child.kill(); await exited;}
    store.db.close();
    await rm(root, {recursive: true, force: true});
  }
});
