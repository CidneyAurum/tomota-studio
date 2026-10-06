import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {WorkbenchAgent} from "../server/agent.js";
import {AntigravityRunner} from "../server/antigravity.js";
import {ModelProviderService, type SecretVault} from "../server/model-providers.js";
import {assertFeedbackSnapshot, validateReworkInstruction} from "../server/reader-feedback.js";
import {safeBookPath, StudioStore} from "../server/store.js";
import {listProjectFiles, readProjectFile, saveProjectFile} from "../server/projects.js";
import {SnapshotGuard} from "../server/snapshot-guard.js";
import {readJsonObjectBody} from "../server/request-body.js";

async function* byteChunks(bytes: Uint8Array, cut: number) {
  yield bytes.subarray(0, cut);
  yield bytes.subarray(cut);
}

test("JSON body preserves Chinese and emoji across every byte boundary", async () => {
  const expected = {text: "中文对白🙂𠮷野家", nested: {title: "第一章"}};
  const bytes = Buffer.from(JSON.stringify(expected));
  for (let cut = 1; cut < bytes.length; cut++) {
    assert.deepEqual(await readJsonObjectBody(byteChunks(bytes, cut)), expected, `split at byte ${cut}`);
  }
});

test("JSON body limits raw bytes once and rejects malformed UTF-8", async () => {
  const expected = {text: "汉🙂字"};
  const bytes = Buffer.from(JSON.stringify(expected));
  assert.deepEqual(await readJsonObjectBody(byteChunks(bytes, 10), bytes.length), expected);
  await assert.rejects(readJsonObjectBody(byteChunks(bytes, 10), bytes.length - 1), /大小限制/);
  const invalid = Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  await assert.rejects(readJsonObjectBody(byteChunks(invalid, 2)), /UTF-8/);
});

test("JSON body keeps the object-only contract and propagates stream failures", async () => {
  for (const invalid of ["null", "[]", "42", '"text"', "{"]) {
    await assert.rejects(readJsonObjectBody(byteChunks(Buffer.from(invalid), 1)));
  }
  assert.deepEqual(await readJsonObjectBody(byteChunks(Buffer.alloc(0), 0)), {});
  async function* failed() {yield Buffer.from('{"text":'); throw new Error("broken stream");}
  await assert.rejects(readJsonObjectBody(failed()), /broken stream/);
});

test("agent plan claim is atomic across store connections and reject cannot override execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-plan-claim-"));
  const first = new StudioStore(root), second = new StudioStore(root);
  try {
    const job = first.createJob({runId: "fixture", bookId: "demo", chapter: 1, stage: "workbench_agent", status: "succeeded", promptPath: "fixture", promptHash: "fixture", outputPath: "fixture", retryOf: null});
    first.saveAgentPlan(job, {summary: "Fixture"});
    assert.equal(first.claimAgentPlan(job.id, "confirmed").status, "confirmed");
    assert.throws(() => second.claimAgentPlan(job.id, "confirmed"), /已被处理/);
    assert.throws(() => second.claimAgentPlan(job.id, "rejected"), /已被处理/);
    first.updateAgentPlanStatus(job.id, "executed");
    assert.throws(() => second.claimAgentPlan(job.id, "rejected"), /已被处理/);
    assert.equal(second.getAgentPlan(job.id)?.status, "executed");
  } finally {
    first.db.close(); second.db.close();
    await rm(root, {recursive: true, force: true});
  }
});

test("file APIs reject junctions including links into read-only book categories", async () => {
  const temp = await mkdtemp(join(tmpdir(), "tomota-file-boundary-"));
  const root = join(temp, "workspace"), outside = join(temp, "outside");
  const drafts = join(root, "books", "demo", "drafts"), canon = join(root, "books", "demo", "canon");
  try {
    for (const dir of [drafts, canon, outside]) await mkdir(dir, {recursive: true});
    for (const [name, target] of [["outside", outside], ["readonly", canon]]) {
      await writeFile(join(target, "fixture.txt"), "Original fixture");
      const link = join(drafts, name);
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
      const file = join(link, "fixture.txt");
      assert.throws(() => safeBookPath(root, file), /链接|联接/);
      await assert.rejects(readProjectFile(root, file), /链接|联接/);
      await assert.rejects(saveProjectFile(root, file, "Changed", "hash"), /链接|联接/);
      assert.equal(await readFile(join(target, "fixture.txt"), "utf8"), "Original fixture");
    }
    assert.ok(!(await listProjectFiles(root, "demo")).some(f => f.path.includes("readonly") || f.path.includes("outside")));
    const readonly = await readProjectFile(root, join(canon, "fixture.txt"));
    assert.equal(readonly.editable, false);
    await assert.rejects(saveProjectFile(root, readonly.path, "Changed", readonly.hash), /只能查看/);
  } finally { await rm(temp, {recursive: true, force: true}); }
});

test("concurrent saves serialize hash checking, preserve one winner and release failed locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-file-race-"));
  const drafts = join(root, "books", "demo", "drafts"), file = join(drafts, "chapter.md");
  try {
    await mkdir(drafts, {recursive: true}); await writeFile(file, "Original");
    const original = await readProjectFile(root, file);
    const alternativePath = process.platform === "win32" ? join(drafts, "CHAPTER.MD") : file;
    const results = await Promise.allSettled([saveProjectFile(root, file, "Writer A", original.hash), saveProjectFile(root, alternativePath, "Writer B", original.hash)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.filter(r => r.status === "rejected").length, 1);
    assert.equal(await readFile(file, "utf8"), results[0].status === "fulfilled" ? "Writer A" : "Writer B");
    await assert.rejects(saveProjectFile(root, file, "Stale", original.hash), /已被其他流程更新/);
    const fresh = await readProjectFile(root, file);
    await saveProjectFile(root, file, "Next revision", fresh.hash);
    assert.equal(await readFile(file, "utf8"), "Next revision");
    assert.deepEqual(await readdir(drafts), ["chapter.md"]);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("non-book assistant actions validate their own targets, not an unrelated bookId", () => {
  const artifact = (action: Record<string, unknown>) => ({stage: "workbench_agent", summary: "Fixture", reasoning: ["Requested"], warnings: [], actions: [action]});
  for (const action of [{type: "switch_view", view: "workflow"}, {type: "run_next_stage", runId: "workflow-test"}, {type: "retry_job", jobId: "job-test"}]) {
    assert.deepEqual(WorkbenchAgent.validateArtifact(artifact(action)).actions, [action]);
  }
  for (const action of [{type: "switch_view", view: "invalid"}, {type: "run_next_stage", runId: "../escape"}, {type: "retry_job"}, {type: "run_workflow", chapters: [1]}, {type: "select_project", bookId: "../escape"}]) {
    assert.throws(() => WorkbenchAgent.validateArtifact(artifact(action)));
  }
});

test("feedback snapshot ignores evaluation status but rejects changes to any source surface", () => {
  const source = {schemaVersion: "v2", scopeType: "chapter", scopeId: "1", reviewMode: "targeted", requestedChapters: [],
    primaryChapters: [1], downstreamDependencyChapters: [2], eligibleChapters: [1, 2],
    chapters: [{chapterNumber: 1, bodyHash: "body", contractHash: "contract", status: "approved"}],
    canon: {hash: "canon"}, writingPolicy: {policyHash: "policy", authorVersionId: "version"}, outlineHash: "outline"};
  assert.doesNotThrow(() => assertFeedbackSnapshot({...source, lockedAt: "yesterday", feedbackThread: [{status: "evaluating"}]}, {...source, lockedAt: "now", feedbackThread: [{status: "evaluated"}]}));
  for (const key of Object.keys(source)) {
    assert.throws(() => assertFeedbackSnapshot(source, {...source, [key]: "changed"}), /已过期/);
    const missing = {...source} as Record<string, unknown>;
    delete missing[key];
    assert.throws(() => assertFeedbackSnapshot(missing, source), /已过期/);
  }
});

test("compiled feedback accepts the shared limit and never silently truncates", () => {
  assert.equal(validateReworkInstruction("长".repeat(3900) + "评".repeat(200)).length, 4100);
  assert.equal(validateReworkInstruction("x".repeat(12000)).length, 12000);
  assert.throws(() => validateReworkInstruction("x".repeat(12001)), /12000/);
  assert.throws(() => validateReworkInstruction("  "), /12000/);
});

test("snapshot guard excludes requests, overlapping snapshots and releases on failure", async () => {
  const guard = new SnapshotGuard();
  const idle = {active: 0, queued: 0};
  let release!: () => void;
  const copy = guard.snapshot(idle, () => new Promise<void>((resolve) => {release = resolve;}));
  await assert.rejects(guard.request(async () => "edit"), /快照正在创建/);
  await assert.rejects(guard.snapshot(idle, async () => "overlap"), /其他请求或快照/);
  release(); await copy;
  assert.equal(await guard.request(() => guard.snapshot(idle, async () => "manual", 1)), "manual");
  await guard.request(async () => {await assert.rejects(guard.snapshot(idle, async () => "daily"), /其他请求或快照/);});
  await assert.rejects(guard.snapshot({active: 1, queued: 0}, async () => "busy"), /模型任务/);
  await assert.rejects(guard.snapshot(idle, async () => {throw new Error("copy failed");}), /copy failed/);
  assert.equal(await guard.request(async () => "after failure"), "after failure");
});

test("runtime activity includes pending external requests and the persisted finishing window", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-runtime-regression-"));
  const store = new StudioStore(root);
  const priorFetch = globalThis.fetch;
  let finish!: (response: Response) => void;
  class TestVault implements SecretVault {
    protect(value: string) { return Buffer.from(value).toString("base64"); }
    unprotect(value: string) { return Buffer.from(value, "base64").toString(); }
  }
  try {
    globalThis.fetch = (() => new Promise<Response>((resolve) => { finish = resolve; })) as typeof fetch;
    const providers = new ModelProviderService(store, new TestVault());
    const provider = providers.saveProvider({label: "Test", kind: "openai_compatible", baseUrl: "https://fixture.invalid/v1", apiKey: "test-only"});
    store.updateModelProviderProbe(provider.id, {status: "ready", models: ["fixture"]});
    providers.saveRoute({role: "workbench", providerId: provider.id, modelId: "fixture"});
    const runner = new AntigravityRunner(root, store, {} as never, {modelProviders: providers, executable: "missing-test-agy"});
    const job = await runner.agent.start("Inspect fixture", {});
    assert.equal(store.getJob(job.id)?.status, "running");
    assert.equal(runner.activity().active, 1);
    assert.equal(runner.activity().externalActive, 1);
    assert.equal(runner.activity().localActive, 0);
    const requestedBy = Date.now() + 5000;
    while (!finish && Date.now() < requestedBy) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(typeof finish, "function");
    finish(new Response(JSON.stringify({choices: [{message: {content: "invalid fixture JSON"}}]}), {status: 200}));
    const deadline = Date.now() + 5000;
    while (runner.activity().active && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runner.activity().active, 0);
    store.updateJob(job.id, {status: "running"});
    assert.equal(runner.activity().active, 1, "validation/finalization stays busy after the request closes");
    store.updateJob(job.id, {status: "queued"});
    assert.equal(runner.activity().queued, 1);
    store.updateJob(job.id, {status: "failed"});
    const missingInput = store.createJob({runId: "missing-input", bookId: "fixture", chapter: null, stage: "workbench_agent", status: "queued", promptPath: join(root, "missing.md"), promptHash: "fixture", outputPath: join(root, "unused.json"), retryOf: null});
    // Fault injection at the private launcher boundary: no request is sent.
    await (runner as any).launchExternal(missingInput, {}, "workbench");
    assert.equal(store.getJob(missingInput.id)?.status, "failed");
    assert.equal(runner.activity().active, 0, "input-read failures must release external activity");
  } finally {
    globalThis.fetch = priorFetch;
    store.db.close();
    await rm(root, {recursive: true, force: true});
  }
});
