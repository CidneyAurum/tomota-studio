import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {existsSync} from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { initializeAuthorLayerBackup, initializeWorkspace, safeBookPath, StudioStore } from "../server/store.js";

test("migration backs up the database and inventories existing books without changing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-store-"));
  let store: StudioStore | undefined;
  try {
    await mkdir(join(root, "books", "demo", "drafts"), { recursive: true });
    const draft = join(root, "books", "demo", "drafts", "chapter-0001.md");
    await writeFile(draft, "原稿不会被修改\n", "utf8");
    const core = new DatabaseSync(join(root, "tomota.db"));
    try { core.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('database-snapshot')"); }
    finally { core.close(); }
    const databaseBefore = createHash("sha256").update(await readFile(join(root, "tomota.db"))).digest("hex");
    const backupValue = (path: string) => {
      const db = new DatabaseSync(path, {readOnly: true});
      try { return db.prepare("SELECT value FROM fixture").get()!.value; }
      finally { db.close(); }
    };
    const before = createHash("sha256").update(await readFile(draft)).digest("hex");
    store = new StudioStore(root);
    const migration = await initializeWorkspace(store);
    assert.ok(migration.backupPath);
    assert.equal(backupValue(migration.backupPath!), "database-snapshot");
    assert.equal(createHash("sha256").update(await readFile(draft)).digest("hex"), before);
    const manifest = JSON.parse(await readFile(migration.manifestPath, "utf8"));
    assert.equal(manifest.files[0].sha256, before);
    const second = await initializeWorkspace(store);
    assert.equal(second.manifestPath, migration.manifestPath);
    const authorBackup = await initializeAuthorLayerBackup(store);
    assert.ok(authorBackup.tomotaDb);
    assert.equal(backupValue(authorBackup.tomotaDb!), "database-snapshot");
    assert.ok(existsSync(authorBackup.studioDb));
    const authorBackupAgain = await initializeAuthorLayerBackup(store);
    assert.deepEqual(authorBackupAgain, authorBackup);
    assert.equal(createHash("sha256").update(await readFile(join(root, "tomota.db"))).digest("hex"), databaseBefore);
  } finally {
    store?.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("book path guard rejects traversal outside the books directory", () => {
  const root = join(tmpdir(), "tomota-safe-root");
  assert.throws(() => safeBookPath(root, join(root, "tomota.db")), /超出 books/);
  assert.equal(safeBookPath(root, join(root, "books", "demo", "drafts", "one.md")), join(root, "books", "demo", "drafts", "one.md"));
});

test("quality baselines and blind judgments persist without mutating project files", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-quality-store-"));
  try {
    const store = new StudioStore(root);
    const baseline = store.saveQualityBenchmark({bookId: "demo", name: "首章基线", chapters: [1], snapshot: {chapterBodies: {"1": {content: "原稿", hash: "a"}}, report: {book_naturalness_score: 88}}});
    assert.equal(store.listQualityBenchmarks("demo").length, 1);
    const run = store.saveQualityBenchmarkRun({benchmarkId: String(baseline.id), bookId: "demo", comparison: {pairs: [{chapter: 1, A: {content: "原稿"}, B: {content: "新稿"}}]}});
    const judged = store.saveQualityJudgment(String(run.id), 1, "B", "人物动作更具体");
    assert.deepEqual((judged.judgments as Record<string, any>)["1"].choice, "B");
    store.db.close();
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("stage metrics aggregate retries and whole-workspace snapshots are recoverable", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-ops-store-"));
  try {
    await mkdir(join(root, ".tomota-studio", "jobs"), {recursive: true});
    await writeFile(join(root, ".tomota-studio", "jobs", "artifact.json"), "{}", "utf8");
    const core = new DatabaseSync(join(root, "tomota.db"));
    core.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE fixture(value TEXT); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO fixture VALUES ('committed in WAL')");
    for (const name of ["books", "authors", "config", "library", "audit"]) {
      await mkdir(join(root, name), {recursive: true});
      await writeFile(join(root, name, "fixture.txt"), `unique ${name}`, "utf8");
    }
    const store = new StudioStore(root);
    const first = store.createJob({runId: "run-one", bookId: "demo", chapter: 1, stage: "draft", status: "queued", promptPath: "prompt", promptHash: "x", outputPath: "output", retryOf: null});
    store.db.prepare("UPDATE agent_jobs SET status='succeeded',started_at=?,finished_at=? WHERE id=?").run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:10.000Z", first.id);
    const retry = store.createJob({runId: "run-one", bookId: "demo", chapter: 1, stage: "draft", status: "timeout", promptPath: "prompt", promptHash: "x", outputPath: "output", retryOf: first.id});
    store.db.prepare("UPDATE agent_jobs SET started_at=?,finished_at=? WHERE id=?").run("2026-01-01T00:01:00.000Z", "2026-01-01T00:01:30.000Z", retry.id);
    const metric = store.stageMetrics().find((item) => item.stage === "draft")!;
    assert.equal(metric.retries, 1);
    assert.equal(metric.timedOut, 1);
    assert.equal(metric.medianSeconds, 30);
    const backup = await store.createWorkspaceSnapshot(2).finally(() => core.close());
    assert.ok(existsSync(join(backup.snapshot.path, "studio.db")));
    const restored = new DatabaseSync(join(backup.snapshot.path, "tomota.db"), {readOnly: true});
    try { assert.equal(restored.prepare("SELECT value FROM fixture").get()!.value, "committed in WAL"); }
    finally { restored.close(); }
    for (const name of ["books", "authors", "config", "library", "audit"]) {
      assert.equal(await readFile(join(backup.snapshot.path, name, "fixture.txt"), "utf8"), `unique ${name}`);
    }
    assert.equal(await readFile(join(backup.snapshot.path, "artifacts", "jobs", "artifact.json"), "utf8"), "{}");
    assert.equal(backup.policy.encrypted, false);
    assert.ok(backup.policy.currentTotalBytes <= backup.policy.maxTotalBytes);
    const manifest = JSON.parse(await readFile(join(backup.snapshot.path, "snapshot.json"), "utf8")) as Record<string, any>;
    assert.equal(manifest.security.content_encryption, "none");
    assert.equal(manifest.schema_version, 3);
    assert.equal(manifest.directory_mapping.artifacts, ".tomota-studio");
    await assert.rejects(store.createWorkspaceSnapshot(2, {maxTotalBytes: 1, reserveFreeBytes: 0}), /超过总容量上限/);
    await assert.rejects(store.createWorkspaceSnapshot(2, {maxTotalBytes: 1024 ** 3, reserveFreeBytes: Number.MAX_SAFE_INTEGER}), /磁盘可用空间不足/);
    assert.ok(existsSync(backup.snapshot.path), "failed preflight must preserve the last valid snapshot");
    store.db.close();
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("confirmation tokens are single-use and stored by hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-confirm-"));
  try {
    const store = new StudioStore(root);
    store.recordConfirmation("publish", "batch-one", "PUBLISH batch-one");
    assert.equal(store.consumeConfirmation("publish", "batch-one", "wrong"), false);
    assert.equal(store.consumeConfirmation("publish", "batch-one", "PUBLISH batch-one"), true);
    assert.equal(store.consumeConfirmation("publish", "batch-one", "PUBLISH batch-one"), false);
    const row = store.db.prepare("SELECT token_hash FROM operation_confirmations LIMIT 1").get() as {token_hash: string};
    assert.notEqual(row.token_hash, "PUBLISH batch-one");
    store.db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("batch confirmations are consumed atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-confirm-batch-"));
  try {
    const store = new StudioStore(root);
    store.recordConfirmation("publish", "batch-two", "PUBLISH batch-two");
    store.recordConfirmation("write", "batch-two", "WRITE batch-two");
    const items = [
      {operation: "publish", targetId: "batch-two", token: "PUBLISH batch-two"},
      {operation: "write", targetId: "batch-two", token: "WRITE batch-two"},
      {operation: "submit", targetId: "batch-two", token: "SUBMIT batch-two:1:abcdef123456"},
    ];
    assert.equal(store.consumeConfirmations(items), false);
    assert.equal(store.consumeConfirmation("publish", "batch-two", "PUBLISH batch-two"), true, "failed group must not consume earlier rows");
    store.recordConfirmation("publish", "batch-two", "PUBLISH batch-two");
    store.recordConfirmation("submit", "batch-two", "SUBMIT batch-two:1:abcdef123456");
    assert.equal(store.consumeConfirmations(items), true);
    assert.equal(store.consumeConfirmations(items), false, "successful group remains single-use");
    store.db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authoritative chapter sync replaces inferred placeholder ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-chapter-sync-"));
  try {
    const store = new StudioStore(root);
    const account = store.createFanqieAccount("账号", join(root, "profile"), "account-one");
    const base = {workId: "7675620772693429273", chapterNumber: 4, title: "旧抄本", status: "已发布", wordCount: 1534, scheduledAt: null, contentHash: "", syncedAt: new Date().toISOString()};
    store.upsertChapters(account.id, [{...base, platformId: "7675620772693429273-4"}]);
    store.replaceWorkChapters(account.id, base.workId, [{...base, platformId: "7675893913663586840"}]);
    assert.deepEqual(store.listChapters(base.workId, account.id).map((item) => item.platformId), ["7675893913663586840"]);
    store.db.close();
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("legacy author preferences stay read-only after migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-preferences-"));
  try {
    const store = new StudioStore(root);
    assert.throws(() => store.addAuthorPreference({bookId: "demo", category: "人物声音", rule: "主要角色台词必须可辨识", evidence: "旧反馈", enabled: true, sourceJobId: "job-one"}), /read-only/);
    assert.deepEqual(store.listAuthorPreferences("demo"), []);
    store.db.close();
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("revision briefs persist separately and track started status", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-briefs-"));
  try {
    const store = new StudioStore(root);
    const brief = store.saveRevisionBrief({bookId: "demo", chapter: 2, feedback: "对白过密，前两场合并，保留信件特写", sourceJobId: "job-two"});
    assert.equal(brief.status, "pending");
    assert.equal(store.listRevisionBriefs("demo").length, 1);
    const started = store.updateRevisionBriefStatus(brief.id, "started");
    assert.equal(started.status, "started");
    assert.equal(store.getRevisionBrief(brief.id)?.chapter, 2);
    store.db.close();
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("planning conversations persist by book and scope and deduplicate polling results", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-planning-conversation-"));
  let store: StudioStore | null = null;
  try {
    store = new StudioStore(root);
    store.savePlanningMessage({bookId: "demo", scopeType: "chapter", scopeId: "2", role: "user", text: "保留误判，重做代价", jobId: "planning-one"});
    store.savePlanningMessage({bookId: "demo", scopeType: "chapter", scopeId: "2", role: "assistant", text: "已形成候选", proposal: {objective: "让误判付出代价"}, warnings: ["不得改变知识边界"], jobId: "planning-one"});
    store.savePlanningMessage({bookId: "demo", scopeType: "chapter", scopeId: "2", role: "assistant", text: "已形成最终候选", proposal: {objective: "让误判付出明确代价"}, warnings: [], jobId: "planning-one"});
    const messages = store.listPlanningMessages("demo", "chapter", "2");
    assert.equal(messages.length, 2);
    assert.deepEqual(messages.map((item) => item.role), ["user", "assistant"]);
    assert.equal(messages[1].text, "已形成最终候选");
    assert.equal(messages[1].proposal?.objective, "让误判付出明确代价");
    assert.deepEqual(store.planningConversationScopeForJob("planning-one"), {bookId: "demo", scopeType: "chapter", scopeId: "2"});
    assert.equal(store.clearPlanningMessages("demo", "chapter", "2"), 2);
    assert.deepEqual(store.listPlanningMessages("demo", "chapter", "2"), []);
  } finally {
    store?.db.close();
    await rm(root, {recursive: true, force: true});
  }
});

test("clearing a planning topic removes every tab artifact for that scope but preserves formal workflow jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-planning-purge-"));
  let store: StudioStore | null = null;
  try {
    store = new StudioStore(root);
    const planningDir = join(store.dataDir, "planning");
    const jobsDir = join(store.dataDir, "jobs");
    await mkdir(planningDir, {recursive: true});
    await mkdir(jobsDir, {recursive: true});
    const sourcePrompt = join(planningDir, "planning-source.prompt.md");
    const producerPrompt = join(planningDir, "planning-book.A.prompt.md");
    const reviewPrompt = join(planningDir, "planning-review.prompt.md");
    const producerOutput = join(jobsDir, "planning-book.json");
    const reviewOutput = join(jobsDir, "planning-review.json");
    const workflowPrompt = join(root, "workflow.prompt.md");
    const workflowOutput = join(root, "workflow.output.json");
    for (const [path, content] of [[sourcePrompt, "old source"], [producerPrompt, "old prompt"], [reviewPrompt, "old review"], [producerOutput, "{}"], [reviewOutput, "{}"], [workflowPrompt, "keep"], [workflowOutput, "{}"]]) await writeFile(path, content, "utf8");

    const producer = store.createJob({runId: "planning-run", bookId: "demo", chapter: null, stage: "planning_book", status: "succeeded", promptPath: producerPrompt, promptHash: "a".repeat(64), outputPath: producerOutput, retryOf: null});
    const reviewer = store.createJob({runId: "planning-run", bookId: "demo", chapter: null, stage: "candidate_repair_review", status: "succeeded", promptPath: reviewPrompt, promptHash: "b".repeat(64), outputPath: reviewOutput, retryOf: producer.id});
    const workflow = store.createJob({runId: "workflow-run", bookId: "demo", chapter: 1, stage: "review_logic", status: "succeeded", promptPath: workflowPrompt, promptHash: "c".repeat(64), outputPath: workflowOutput, retryOf: null});
    const lineage = {planningScope: "book", planningSourcePromptPath: sourcePrompt, candidateScope: "planning", planningContextSnapshot: {selected_ids: {level: "book", id: "book"}}};
    store.saveJobResult(producer.id, {lineage});
    store.saveJobResult(reviewer.id, {lineage: {...lineage, candidateRole: "repair_reviewer"}});
    store.savePlanningMessage({bookId: "demo", scopeType: "book", scopeId: "book", role: "user", text: "废弃旧方案", jobId: producer.id});
    store.savePlanningMessage({bookId: "demo", scopeType: "book", scopeId: "demo", role: "assistant", text: "旧版错误范围锚点", jobId: producer.id});

    const purged = store.purgePlanningConversationArtifacts("demo", "book", "book");
    assert.deepEqual(purged, {deletedMessages: 2, deletedJobs: 2, deletedFiles: 5});
    assert.deepEqual(store.listPlanningMessages("demo", "book", "demo"), []);
    assert.equal(store.getJob(producer.id), null);
    assert.equal(store.getJob(reviewer.id), null);
    assert.equal(store.getJob(workflow.id)?.id, workflow.id);
    for (const path of [sourcePrompt, producerPrompt, reviewPrompt, producerOutput, reviewOutput]) assert.equal(existsSync(path), false, `${path} should be deleted`);
    assert.equal(existsSync(workflowPrompt), true);
    assert.equal(existsSync(workflowOutput), true);
  } finally {
    store?.db.close();
    await rm(root, {recursive: true, force: true});
  }
});

test("planning cleanup follows every producer across run ids and removes an orphan review", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-cross-run-purge-"));
  let store: StudioStore | null = null;
  try {
    store = new StudioStore(root);
    const jobsDir = join(store.dataDir, "jobs");
    await mkdir(jobsDir, {recursive:true});
    const producerPrompt = join(jobsDir, "producer.prompt.md");
    const producerOutput = join(jobsDir, "producer.json");
    const reviewPrompt = join(jobsDir, "review.prompt.md");
    const reviewOutput = join(jobsDir, "review.json");
    const unrelatedPrompt = join(jobsDir, "unrelated.prompt.md");
    const unrelatedOutput = join(jobsDir, "unrelated.json");
    for (const path of [producerPrompt,producerOutput,reviewPrompt,reviewOutput,unrelatedPrompt,unrelatedOutput]) await writeFile(path, "{}", "utf8");

    const producer = store.createJob({runId:"producer-run",bookId:"demo",chapter:2,stage:"planning_chapter",status:"succeeded",promptPath:producerPrompt,promptHash:"a".repeat(64),outputPath:producerOutput,retryOf:null});
    store.saveJobResult(producer.id, {lineage:{planningScope:"chapter",planningContextSnapshot:{selected_ids:{level:"chapter",id:"2"}},candidateRole:"producer",candidateId:"B"}});
    const orphanReview = store.createJob({runId:"review-run",bookId:"demo",chapter:2,stage:"candidate_blind_review",status:"succeeded",promptPath:reviewPrompt,promptHash:"b".repeat(64),outputPath:reviewOutput,retryOf:null});
    store.saveJobResult(orphanReview.id, {lineage:{candidateRole:"reviewer",producerJobIds:{A:"missing-first-producer",B:producer.id}}});
    const unrelated = store.createJob({runId:"unrelated-run",bookId:"demo",chapter:3,stage:"planning_chapter",status:"succeeded",promptPath:unrelatedPrompt,promptHash:"c".repeat(64),outputPath:unrelatedOutput,retryOf:null});
    store.saveJobResult(unrelated.id, {lineage:{planningScope:"chapter",planningContextSnapshot:{selected_ids:{level:"chapter",id:"3"}},candidateRole:"producer",candidateId:"A"}});

    const purged = store.purgePlanningConversationArtifacts("demo", "chapter", "2");
    assert.equal(purged.deletedJobs, 2);
    assert.equal(store.getJob(producer.id), null);
    assert.equal(store.getJob(orphanReview.id), null, "review in another run must follow its surviving second producer");
    assert.equal(store.getJob(unrelated.id)?.id, unrelated.id);
    assert.equal(existsSync(unrelatedPrompt), true);
    assert.equal(existsSync(unrelatedOutput), true);
  } finally {
    store?.db.close();
    await rm(root, {recursive:true,force:true});
  }
});

test("active planning jobs remain discoverable after conversation messages disappear", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-active-planning-"));
  let store: StudioStore | null = null;
  try {
    store = new StudioStore(root);
    const planning = store.createJob({runId: "run-planning", bookId: "demo", chapter: null, stage: "planning_book", status: "running", promptPath: "planning.prompt.md", promptHash: "a".repeat(64), outputPath: "planning.output.json", retryOf: null});
    const generation = store.createJob({runId: "run-generation", bookId: "demo", chapter: 1, stage: "story_foundation", status: "running", promptPath: "generation.prompt.md", promptHash: "b".repeat(64), outputPath: "generation.output.json", retryOf: null});
    assert.equal(store.activePlanningJobForBook("demo")?.id, planning.id);
    assert.equal(store.activeJobForBook("demo")?.id, generation.id);
    store.updateJob(planning.id, {status: "succeeded"});
    assert.equal(store.activePlanningJobForBook("demo"), null);
  } finally {
    store?.db.close();
    await rm(root, {recursive: true, force: true});
  }
});

test("book job history remains discoverable after a stale conversation anchor is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-planning-anchor-"));
  let store: StudioStore | null = null;
  try {
    store = new StudioStore(root);
    const planning = store.createJob({runId: "run-planning", bookId: "demo", chapter: null, stage: "planning_book", status: "succeeded", promptPath: "planning.prompt.md", promptHash: "a".repeat(64), outputPath: "planning.output.json", retryOf: null});
    const review = store.createJob({runId: "run-planning", bookId: "demo", chapter: null, stage: "candidate_blind_review", status: "succeeded", promptPath: "review.prompt.md", promptHash: "b".repeat(64), outputPath: "review.output.json", retryOf: null});
    const generation = store.createJob({runId: "run-generation", bookId: "demo", chapter: 1, stage: "story_foundation", status: "succeeded", promptPath: "generation.prompt.md", promptHash: "c".repeat(64), outputPath: "generation.output.json", retryOf: null});
    const jobs = store.listJobsForBook("demo");
    assert.deepEqual(jobs.map((item) => item.id), [generation.id, review.id, planning.id]);
  } finally {
    store?.db.close();
    await rm(root, {recursive: true, force: true});
  }
});

test("reader feedback persists evaluation, scope and linked rework workflow", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-reader-feedback-"));
  try {
    const store = new StudioStore(root);
    const feedback = store.createReaderFeedback({bookId: "demo", scopeType: "volume", scopeId: "volume-2", content: "中段推进太顺，但保留人物误判"});
    assert.equal(feedback.status, "evaluating");
    const evaluated = store.updateReaderFeedback(feedback.id, {status: "evaluated", jobId: "job-feedback", evaluation: {
      stage: "reader_feedback_evaluation", verdict: "actionable", severity: "high", summary: "代价不足",
      affected_chapters: [6, 7], preserve: ["人物误判"], changes: ["增加失败代价"], risks: [], compiled_instruction: "重做第6—7章",
    }});
    assert.deepEqual(evaluated.evaluation.affected_chapters, [6, 7]);
    const reworking = store.updateReaderFeedback(feedback.id, {status: "reworking", workflowId: "workflow-rework"});
    assert.equal(reworking.workflowId, "workflow-rework");
    assert.equal(store.listReaderFeedback("demo", "volume", "volume-2")[0].content, feedback.content);
    store.db.close();
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("reader feedback continuations retain one ordered thread and supersede only after linking", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-reader-thread-"));
  let store: StudioStore | null = null;
  try {
    store = new StudioStore(root);
    const first = store.createReaderFeedback({bookId: "demo", scopeType: "book", scopeId: "book", content: "人物成长太平"});
    const second = store.createReaderFeedback({bookId: "demo", scopeType: "book", scopeId: "book", content: "重点检查第 2—4 章并全部重修", parentFeedbackId: first.id, reviewMode: "full_scope"});
    store.updateReaderFeedback(second.id, {requestedChapters: [2, 3, 4]});
    assert.equal(second.parentFeedbackId, first.id);
    assert.equal(second.rootFeedbackId, first.id);
    assert.equal(second.sequence, 2);
    assert.equal(store.getReaderFeedback(second.id)?.reviewMode, "full_scope");
    assert.deepEqual(store.getReaderFeedback(second.id)?.requestedChapters, [2, 3, 4]);
    assert.equal(store.getReaderFeedback(first.id)?.supersededById, null, "creating a child alone must not hide a parent when launch fails");
    store.linkReaderFeedback(first.id, second.id);
    assert.equal(store.getReaderFeedback(first.id)?.supersededById, second.id);
    assert.deepEqual(store.readerFeedbackThread(second.id).map((item) => item.content), ["人物成长太平", "重点检查第 2—4 章并全部重修"]);
    assert.throws(() => store.createReaderFeedback({bookId: "demo", scopeType: "book", scopeId: "book", content: "错误分叉", parentFeedbackId: first.id}), /最新一轮/);
  } finally {
    store?.db.close();
    await rm(root, {recursive: true, force: true});
  }
});

test("personal talks persist as an independent author stream with frozen persona and progress snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-personal-talk-"));
  let store: StudioStore | null = null;
  try {
    store = new StudioStore(root);
    const persona = {public_identity: "开朗作者", speaking_tone: "坦率轻松"};
    const created = store.savePersonalTalk({
      authorId: "author-one", title: "写到第八章以后", content: "这不是小说章节，只是想和追更到这里的读者聊聊创作感受。",
      linkedBookId: "demo", progressSnapshot: {progressed_through: 8, future_outline_included: false},
      personaSnapshot: persona, personaHash: "persona-hash", styleInfluence: "none", status: "ready", sourceJobId: "job-talk",
    });
    assert.equal(created.status, "ready");
    assert.equal(created.styleInfluence, "none");
    assert.equal(created.progressSnapshot.progressed_through, 8);
    assert.equal(created.progressSnapshot.future_outline_included, false);
    assert.deepEqual(created.personaSnapshot, persona);

    const published = store.savePersonalTalk({id: created.id, authorId: "author-one", title: created.title, content: created.content, status: "published"});
    assert.ok(published.publishedAt);
    assert.equal(store.listPersonalTalks("author-one").length, 1);
    const second = store.savePersonalTalk({authorId: "author-one", title: "第二条", content: "仍然是独立内容，不进入任何小说工程。"});
    assert.equal(second.authorId, "author-one");
    assert.equal(store.listPersonalTalks("author-one").length, 2);
    const deleted = store.deletePersonalTalk("author-one", created.id);
    assert.equal(deleted.id, created.id);
    assert.equal(store.deletePersonalTalksByAuthor("author-one"), 1);
    assert.deepEqual(store.listPersonalTalks("author-one"), []);
  } finally {
    store?.db.close();
    await rm(root, {recursive: true, force: true});
  }
});

test("rebuild cleanup permanently removes Studio rows without writing a recovery archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-rebuild-"));
  let store: StudioStore | null = null;
  try {
    store = new StudioStore(root);
    const job = store.createJob({runId: "run-one", bookId: "demo", chapter: 2, stage: "draft", status: "succeeded", promptPath: "prompt", promptHash: "hash", outputPath: "output", retryOf: null});
    store.appendEvent(job.id, "info", "旧工作流事件");
    store.addWorkflowFeedback("run-one", "demo", "draft", 2, "旧返工要求");
    store.saveRevisionBrief({bookId: "demo", chapter: 2, feedback: "重写第二章", sourceJobId: job.id});
    store.saveRevisionBrief({bookId: "demo", chapter: 3, feedback: "保留第三章", sourceJobId: job.id});
    store.createReaderFeedback({bookId: "demo", scopeType: "chapter", scopeId: "2", content: "第二章反馈"});
    store.createReaderFeedback({bookId: "demo", scopeType: "chapter", scopeId: "3", content: "第三章反馈"});
    store.savePlanningMessage({bookId: "demo", scopeType: "chapter", scopeId: "2", role: "user", text: "第二章旧规划对话", jobId: "planning-old-two"});
    store.savePlanningMessage({bookId: "demo", scopeType: "chapter", scopeId: "3", role: "user", text: "第三章规划对话", jobId: "planning-keep-three"});
    const result = store.purgeRebuiltScope("demo", "chapter", "2", [2]);
    assert.ok(result.deletedRows >= 5);
    assert.equal(existsSync(join(root, "books", "demo", ".trash")), false);
    assert.equal(store.listJobs().filter((item) => item.bookId === "demo").length, 0);
    assert.equal(store.listWorkflowFeedback("run-one").length, 0);
    assert.equal(store.listRevisionBriefs("demo").length, 1);
    assert.equal(store.listRevisionBriefs("demo")[0].chapter, 3);
    assert.equal(store.listReaderFeedback("demo", "chapter", "2").length, 0);
    assert.equal(store.listReaderFeedback("demo", "chapter", "3").length, 1);
    assert.equal(store.listPlanningMessages("demo", "chapter", "2").length, 0);
    assert.equal(store.listPlanningMessages("demo", "chapter", "3").length, 1);
  } finally {
    store?.db.close();
    await rm(root, {recursive: true, force: true});
  }
});

test("full rebuild removes legacy per-book author preference rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-rebuild-full-"));
  let store: StudioStore | null = null;
  try {
    store = new StudioStore(root);
    store.db.exec("DROP TRIGGER IF EXISTS author_preferences_read_only_insert");
    store.db.prepare("INSERT INTO author_preferences(id,book_id,category,rule,evidence,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run("legacy-one", "demo", "文风", "旧规则", "旧证据", new Date().toISOString(), new Date().toISOString());
    assert.equal(store.listAuthorPreferences("demo").length, 1);
    store.purgeRebuiltScope("demo", "book", "book", []);
    assert.equal(store.listAuthorPreferences("demo").length, 0);
    assert.throws(() => store.deleteAuthorPreference("missing"), /不存在/);
  } finally {
    store?.db.close();
    await rm(root, {recursive: true, force: true});
  }
});

test("full rebuild removes book-bound Studio progress, quality snapshots, talks and Fanqie metadata without touching another book", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-rebuild-cleanup-"));
  let store: StudioStore | null = null;
  try {
    store = new StudioStore(root);
    const promptPath = join(root, ".tomota-studio", "planning", "old.prompt.md");
    const outputPath = join(root, ".tomota-studio", "jobs", "job-old.json");
    await mkdir(join(root, ".tomota-studio", "planning"), {recursive: true});
    await mkdir(join(root, ".tomota-studio", "jobs"), {recursive: true});
    await writeFile(promptPath, "旧规划 Prompt", "utf8");
    await writeFile(outputPath, "旧任务产物", "utf8");
    const job = store.createJob({runId: "run-old", bookId: "demo", chapter: null, stage: "planning_book", status: "succeeded", promptPath, promptHash: "hash", outputPath, retryOf: null});
    store.appendEvent(job.id, "info", "旧任务进度");

    const baseline = store.saveQualityBenchmark({bookId: "demo", name: "旧基线", chapters: [1], snapshot: {chapterBodies: {"1": {content: "旧正文", hash: "old"}}}});
    store.saveQualityBenchmarkRun({benchmarkId: String(baseline.id), bookId: "demo", comparison: {pairs: []}});
    const talk = store.savePersonalTalk({authorId: "author-one", title: "旧进度谈", content: "旧内容", linkedBookId: "demo", progressSnapshot: {progressed_through: 3}});
    const talkPath = join(root, "authors", "author-one", "personal-talks", `${talk.id}.json`);
    await mkdir(join(root, "authors", "author-one", "personal-talks"), {recursive: true});
    await writeFile(talkPath, JSON.stringify(talk), "utf8");

    await mkdir(join(root, ".tomota-studio", "reader-feedback", "demo"), {recursive: true});
    await writeFile(join(root, ".tomota-studio", "reader-feedback", "demo", "old.prompt.md"), "旧反馈进度", "utf8");
    await writeFile(join(root, ".tomota-studio", "fanqie-session-demo-account-one.json"), "旧会话", "utf8");
    await writeFile(join(root, ".tomota-studio", "fanqie-session-other-account-one.json"), "别的作品会话", "utf8");

    store.setMeta("fanqie_book_work:account-one:demo", "work-demo");
    store.setMeta("fanqie_book_pending_batch:account-one:demo", "batch-demo");
    store.setMeta("fanqie_batch_account:batch-demo", "account-one");
    store.setMeta("fanqie_batch_work:batch-demo", "work-demo");
    store.setMeta("fanqie_batch_intent:batch-demo", JSON.stringify({bookId: "demo", platformWorkId: "work-demo", chapters: [1]}));
    store.setMeta("fanqie_book_work:account-one:other", "work-other");
    store.setMeta("fanqie_batch_account:batch-other", "account-one");

    const result = store.purgeRebuiltScope("demo", "book", "book", []);
    assert.ok(result.deletedRows >= 5);
    assert.equal(store.listJobs().filter((item) => item.bookId === "demo").length, 0);
    assert.equal(store.listQualityBenchmarks("demo").length, 0);
    assert.equal(store.listQualityBenchmarkRuns("demo").length, 0);
    assert.deepEqual(store.listPersonalTalks("author-one"), []);
    assert.equal(existsSync(talkPath), false);
    assert.equal(existsSync(join(root, ".tomota-studio", "jobs", `${job.id}.json`)), false);
    assert.equal(existsSync(join(root, ".tomota-studio", "reader-feedback", "demo")), false);
    assert.equal(existsSync(join(root, ".tomota-studio", "fanqie-session-demo-account-one.json")), false);
    assert.equal(existsSync(join(root, ".tomota-studio", "fanqie-session-other-account-one.json")), true);
    assert.equal(store.getMeta("fanqie_book_work:account-one:other"), "work-other");
    assert.equal(store.getMeta("fanqie_batch_account:batch-other"), "account-one");
    assert.equal(store.getMeta("fanqie_batch_intent:batch-demo"), null);
  } finally {
    store?.db.close();
    await rm(root, {recursive: true, force: true});
  }
});

test("scoped rebuild fails closed when a Studio artifact cannot be attributed to the selected range", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-rebuild-scope-"));
  let store: StudioStore | null = null;
  try {
    store = new StudioStore(root);
    const job = store.createJob({runId: "run-book", bookId: "demo", chapter: null, stage: "planning_book", status: "succeeded", promptPath: "prompt", promptHash: "hash", outputPath: "output", retryOf: null});
    assert.throws(() => store.purgeRebuiltScope("demo", "chapter", "2", [2]), /无章节范围的全书任务/);
    assert.ok(store.getJob(job.id));
  } finally {
    store?.db.close();
    await rm(root, {recursive: true, force: true});
  }
});
