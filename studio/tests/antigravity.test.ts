import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AntigravityRunner } from "../server/antigravity.js";
import type { PythonBridge } from "../server/python.js";
import { StudioStore } from "../server/store.js";

async function waitFor(predicate: () => boolean, timeout = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("timed out waiting for agent job");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function fixture(mode: "valid" | "invalid") {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-agy-"));
  const chapterDir = join(root, "books", "demo", "workflow", "run-1", "chapter-0001");
  await mkdir(chapterDir, { recursive: true });
  const promptPath = join(chapterDir, "draft.prompt.md");
  await writeFile(promptPath, "stage draft", "utf8");
  const fake = join(root, "fake-agy.mjs");
  await writeFile(fake, `
    import { writeFile } from "node:fs/promises";
    if (process.argv.includes("--cwd")) throw new Error("AGY 1.1.x does not support --cwd");
    if (!process.argv.includes("--new-project")) throw new Error("workspace project was not initialized");
    if (process.argv.filter((item) => item === "--add-dir").length !== 2) throw new Error("workspace directories were not mounted");
    if (!process.argv.includes("--effort")) throw new Error("stage effort was not selected");
    const instruction = process.argv[process.argv.indexOf("-p") + 1];
    if (instruction.includes("TOMOTA_EXPECT_FEEDBACK") && !instruction.includes("用户对当前阶段的修改反馈")) throw new Error("feedback was not injected");
    const output = instruction.match(/UTF-8 JSON 到：(.+)/)[1].trim();
    await writeFile(output, ${mode === "valid" ? "JSON.stringify({stage:'draft',content:'正文'})" : "'not-json'"}, "utf8");
  `, "utf8");
  let submits = 0;
  const python = {
    async workflowStatus() { return { value: { run_id: "run-1", book_id: "demo", status: "running", current_stage: "draft" } }; },
    async nextAction() { return { value: { run_id: "run-1", book_id: "demo", chapter: 1, stage: "draft", status: "running", prompt_path: promptPath, output_schema: {stage: "draft", content: ""} } }; },
    async submit() { submits += 1; return { value: { status: "completed" } }; },
  } as unknown as PythonBridge;
  const store = new StudioStore(root);
  await mkdir(join(store.dataDir, "jobs"), { recursive: true });
  const runner = new AntigravityRunner(root, store, python, { executable: process.execPath, prefixArgs: [fake], autoCorrectionRetries: 0 });
  return { root, store, runner, submits: () => submits };
}

test("valid Antigravity JSON advances only through the Tomota submit bridge", async () => {
  const value = await fixture("valid");
  try {
    const started = await value.runner.startContinuous("run-1");
    assert.equal(started.job?.status, "running");
    await waitFor(() => value.store.getJob(started.job!.id)?.status === "succeeded");
    assert.equal(value.submits(), 1);
    assert.ok(value.store.getJob(started.job!.id)?.outputHash);
    assert.equal(value.runner.status().execution, "ready");
    assert.equal(value.runner.status().auth, "authenticated");
    value.store.db.close();
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("planning assistant returns a validated preview without mutating workflow state", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-planning-"));
  let store: StudioStore | null = null;
  try {
    await mkdir(join(root, "books", "demo"), {recursive: true});
    const fake = join(root, "planning-agy.mjs");
    await writeFile(fake, `
      import { writeFile } from "node:fs/promises";
      const instruction = process.argv[process.argv.indexOf("-p") + 1];
      const output = instruction.match(/UTF-8 JSON 到：(.+)/)[1].trim();
      const stage = instruction.match(/当前阶段：([a-z_]+)/)[1];
      const volume = {volume_id:"volume-1",title:"雨夜卷",objective:"建立同盟",main_conflict:"追捕升级",character_change:"由戒备转为有限信任",foreshadowing:"推进黑伞来源",ending:"两人离城并发现下一处坐标"};
      const proposals = {
        planning_new_book:{title:"雨夜来客",genre:"都市异能/悬疑",synopsis:"雨夜里，旧物店迎来失忆少女。",premise:"两名边缘人追查城市异常",core_conflict:"个体记忆对抗机构清算",ending_direction:"未锁定",major_beats:["相遇","结盟"],volumes:[volume]},
        planning_book:{synopsis:"雨夜里，旧物店迎来失忆少女。",genre:"都市异能/悬疑",premise:"两名边缘人追查城市异常",core_conflict:"个体记忆对抗机构清算",ending_direction:"未锁定",major_beats:["相遇","结盟"],volumes:[volume]},
        planning_volume:volume,
        planning_chapter:{chapter_number:1,volume_id:"volume-1",title:"雨中来客",objective:"收留少女",obstacle:"追兵逼近",change:"达成临时合作",new_information:"少女失忆",chapter_hook:"门外传来敲门声",next_first_beat:"核验来客身份",current_character_goal:"保护旧物店",relationship_state:"陌生人开始合作",body_information_state:"少女失温",unresolved_foreshadowing:"黑伞来源",ending_type:"危机逼近",target_word_count:2800,problem_tags:["动机"]}
      };
      await writeFile(output, JSON.stringify({stage,proposal:proposals[stage],rationale:["目标、冲突与人物变化形成闭环"],warnings:[]}), "utf8");
    `, "utf8");
    const python = { async submit() { throw new Error("planning preview must not submit workflow"); } } as unknown as PythonBridge;
    store = new StudioStore(root);
    await mkdir(join(store.dataDir, "jobs"), {recursive: true});
    const runner = new AntigravityRunner(root, store, python, {executable: process.execPath, prefixArgs: [fake], autoCorrectionRetries: 0});
    for (const scope of ["new_book", "book", "volume", "chapter"] as const) {
      const started = await runner.startPlanning({bookId: scope === "new_book" ? "new-book" : "demo", scope, mode: "fill", instruction: `补全 ${scope}`, context: {bookId: "demo", selected: {volume_id: "volume-1", chapter_number: 1}}});
      await waitFor(() => store.getJob(started.job.id)?.status === "succeeded");
      const result = await runner.planningResult(started.job.id);
      assert.equal(result.artifact?.stage, `planning_${scope}`);
      const proposal = result.artifact?.proposal as Record<string, unknown>;
      assert.ok(scope === "book" ? proposal.synopsis : proposal.title);
      assert.match(result.events.at(-1)?.message || "", /未修改项目文件/);
    }
  } finally {
    store?.db.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(root, {recursive: true, force: true});
  }
});

test("malformed Antigravity output fails closed and never calls workflow submit", async () => {
  const value = await fixture("invalid");
  try {
    const started = await value.runner.startContinuous("run-1");
    await waitFor(() => value.store.getJob(started.job!.id)?.status === "failed");
    assert.equal(value.submits(), 0);
    assert.match(value.store.getJob(started.job!.id)?.error || "", /产物无效/);
    value.store.db.close();
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("pending user feedback is injected once and bound to the launched retry job", async () => {
  const value = await fixture("valid");
  try {
    const feedback = value.store.addWorkflowFeedback("run-1", "demo", "draft", 1, "TOMOTA_EXPECT_FEEDBACK：减少解释性对白");
    const started = await value.runner.startContinuous("run-1");
    await waitFor(() => value.store.getJob(started.job!.id)?.status === "succeeded");
    const stored = value.store.listWorkflowFeedback("run-1").find((item) => item.id === feedback.id);
    assert.equal(stored?.status, "applied");
    assert.equal(stored?.jobId, started.job?.id);
    value.store.db.close();
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("feedback cancels an active generation and restarts the same stage with the comment attached", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-feedback-restart-"));
  try {
    const bookDir = join(root, "books", "demo");
    await mkdir(bookDir, {recursive: true});
    const promptPath = join(bookDir, "draft.prompt.md");
    await writeFile(promptPath, "draft", "utf8");
    const fake = join(root, "feedback-restart-agy.mjs");
    await writeFile(fake, `
      import { writeFile } from "node:fs/promises";
      const instruction = process.argv[process.argv.indexOf("-p") + 1];
      const output = instruction.match(/UTF-8 JSON 到：(.+)/)[1].trim();
      if (!instruction.includes("TOMOTA_RESTART_FEEDBACK")) await new Promise((resolve) => setTimeout(resolve, 10_000));
      await writeFile(output, JSON.stringify({stage:"draft",content:"按反馈修改后的正文"}), "utf8");
    `, "utf8");
    let submits = 0;
    const python = {
      async workflowStatus() { return {value: {run_id: "run-feedback", book_id: "demo", status: "running", current_stage: "draft"}}; },
      async nextAction() { return {value: {run_id: "run-feedback", book_id: "demo", chapter: 1, stage: "draft", status: "running", prompt_path: promptPath, output_schema: {stage: "draft", content: ""}}}; },
      async submit() { submits += 1; return {value: {status: "completed"}}; },
    } as unknown as PythonBridge;
    const store = new StudioStore(root);
    await mkdir(join(store.dataDir, "jobs"), {recursive: true});
    const runner = new AntigravityRunner(root, store, python, {executable: process.execPath, prefixArgs: [fake], autoCorrectionRetries: 0});
    const first = await runner.startContinuous("run-feedback");
    assert.equal(first.job?.status, "running");
    const feedback = store.addWorkflowFeedback("run-feedback", "demo", "draft", 1, "TOMOTA_RESTART_FEEDBACK：删掉解释性对白");
    runner.cancel(first.job!.id);
    const restarted = await runner.startContinuous("run-feedback", first.job!.id);
    await waitFor(() => store.getJob(restarted.job!.id)?.status === "succeeded");
    assert.equal(store.getJob(first.job!.id)?.status, "cancelled");
    assert.equal(store.listWorkflowFeedback("run-feedback").find((item) => item.id === feedback.id)?.jobId, restarted.job?.id);
    assert.equal(submits, 1);
    store.db.close();
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("malformed JSON is automatically corrected with the prior error attached", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-auto-correct-"));
  try {
    const bookDir = join(root, "books", "demo");
    await mkdir(bookDir, {recursive: true});
    const promptPath = join(bookDir, "draft.prompt.md");
    await writeFile(promptPath, "draft", "utf8");
    const fake = join(root, "auto-correct-agy.mjs");
    await writeFile(fake, `
      import { writeFile } from "node:fs/promises";
      const instruction = process.argv[process.argv.indexOf("-p") + 1];
      const output = instruction.match(/UTF-8 JSON 到：(.+)/)[1].trim();
      await writeFile(output, instruction.includes("上一次产物被拒绝") ? JSON.stringify({stage:"draft",content:"正文"}) : "{broken", "utf8");
    `, "utf8");
    let submits = 0;
    const python = {
      async workflowStatus() { return {value: {run_id: "run-correct", book_id: "demo", status: "running", current_stage: "draft"}}; },
      async nextAction() { return {value: {run_id: "run-correct", book_id: "demo", chapter: 1, stage: "draft", status: "running", prompt_path: promptPath, output_schema: {stage: "draft", content: ""}}}; },
      async submit() { submits += 1; return {value: {status: "completed"}}; },
    } as unknown as PythonBridge;
    const store = new StudioStore(root);
    await mkdir(join(store.dataDir, "jobs"), {recursive: true});
    const runner = new AntigravityRunner(root, store, python, {executable: process.execPath, prefixArgs: [fake], autoCorrectionRetries: 2});
    await runner.startContinuous("run-correct");
    await waitFor(() => store.listJobs("run-correct").some((job) => job.status === "succeeded"), 8_000);
    const jobs = store.listJobs("run-correct").reverse();
    assert.deepEqual(jobs.map((job) => job.status), ["failed", "succeeded"]);
    assert.equal(submits, 1);
    store.db.close();
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("a restarted store marks active jobs interrupted instead of claiming success", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-restart-"));
  try {
    const first = new StudioStore(root);
    const job = first.createJob({ runId: "run", bookId: "demo", chapter: 1, stage: "draft", status: "running", promptPath: "prompt", promptHash: "hash", outputPath: "output", retryOf: null });
    first.db.close();
    const second = new StudioStore(root);
    assert.equal(second.getJob(job.id)?.status, "interrupted");
    second.db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retry validates an existing interrupted output before launching Antigravity again", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-reuse-"));
  try {
    await mkdir(join(root, "books", "demo"), { recursive: true });
    const outputPath = join(root, "interrupted.json");
    await writeFile(outputPath, JSON.stringify({stage: "draft", content: "已完成的中断产物"}), "utf8");
    let submits = 0;
    const python = {
      async workflowStatus() { return { value: { run_id: "run", book_id: "demo", status: "running", current_stage: "draft" } }; },
      async submit() { submits += 1; return { value: { status: "completed" } }; },
    } as unknown as PythonBridge;
    const store = new StudioStore(root);
    const job = store.createJob({ runId: "run", bookId: "demo", chapter: 1, stage: "draft", status: "interrupted", promptPath: "prompt", promptHash: "hash", outputPath, retryOf: null });
    const runner = new AntigravityRunner(root, store, python, { executable: "missing-executable-that-must-not-run" });
    const result = await runner.retry(job.id);
    assert.equal(result.job?.status, "succeeded");
    assert.equal(submits, 1);
    assert.match(result.job?.error || "", /没有重复调用/);
    store.db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("continuous runner serially invokes every strict Skill stage through completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-full-chain-"));
  try {
    const stages = ["story_foundation", "chapter_design", "design_review", "draft", "review_logic", "review_voice", "review_continuity", "cold_review", "canon_update"];
    const bookDir = join(root, "books", "demo");
    await mkdir(bookDir, {recursive: true});
    const promptPaths = new Map<string, string>();
    for (const stage of stages) {
      const path = join(bookDir, `${stage}.prompt.md`);
      await writeFile(path, `stage ${stage}`, "utf8");
      promptPaths.set(stage, path);
    }
    const fake = join(root, "full-chain-agy.mjs");
    await writeFile(fake, `
      import { writeFile } from "node:fs/promises";
      const instruction = process.argv[process.argv.indexOf("-p") + 1];
      const stage = instruction.match(/当前阶段：([a-z_]+)/)[1];
      const output = instruction.match(/UTF-8 JSON 到：(.+)/)[1].trim();
      await writeFile(output, JSON.stringify({stage}), "utf8");
    `, "utf8");
    let index = 0;
    const python = {
      async workflowStatus() { return {value: {run_id: "run-full", book_id: "demo", status: index < stages.length ? "running" : "completed", current_stage: stages[index] || "completed"}}; },
      async nextAction() { const stage = stages[index]; return {value: {run_id: "run-full", book_id: "demo", chapter: 1, stage, status: "running", prompt_path: promptPaths.get(stage), output_schema: {stage}}}; },
      async submit(_runId: string, outputPath: string) {
        const artifact = JSON.parse(await (await import("node:fs/promises")).readFile(outputPath, "utf8"));
        assert.equal(artifact.stage, stages[index]);
        index += 1;
        return {value: {status: index < stages.length ? "running" : "completed", current_stage: stages[index] || "completed"}};
      },
    } as unknown as PythonBridge;
    const store = new StudioStore(root);
    await mkdir(join(store.dataDir, "jobs"), {recursive: true});
    const runner = new AntigravityRunner(root, store, python, {executable: process.execPath, prefixArgs: [fake]});
    await runner.startContinuous("run-full");
    await waitFor(() => index === stages.length && store.listJobs("run-full", 20).every((job) => job.status === "succeeded"), 15_000);
    assert.deepEqual(store.listJobs("run-full", 20).map((job) => job.stage).reverse(), stages);
    store.db.close();
  } finally { await rm(root, {recursive: true, force: true}); }
});
