import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {createHash} from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AntigravityRunner, repairJsonText } from "../server/antigravity.js";
import type { PythonBridge } from "../server/python.js";
import { StudioStore } from "../server/store.js";

function hashJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)]));
    return item;
  };
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

test("deterministic JSON repair fixes wrappers and missing commas without changing business values", () => {
  const raw = "```json\n{\n  \"stage\": \"draft\"\n  \"content\": \"正文，不改这句话\",\n}\n```";
  const repaired = repairJsonText(raw);
  assert.deepEqual(JSON.parse(repaired.text), {stage: "draft", content: "正文，不改这句话"});
  assert.deepEqual(repaired.repairs, ["removed_markdown_fence", "removed_trailing_commas", "inserted_missing_property_commas"]);
});

test("distillation evidence ledger rejects mutation and ambiguity while preserving Unicode offsets", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-evidence-ledger-"));
  const store = new StudioStore(root);
  try {
    const runner = new AntigravityRunner(root, store, {} as PythonBridge, {executable: null});
    const structure = {segmentation_mode:"fixed_segments",segments:[{segment_id:"segment-1",kind:"fixed_segment",ordinal:1,title:"固定段落 1",start:0,end:6,character_count:6,sha256:"hash"}],phases:[{phase_id:"phase-1",ordinal:1,title:"阶段 1",segment_ids:["segment-1"],start:0,end:6,character_count:6}]};
    const artifact = (quote: string) => ({stage:"author_style_full_read",source_id:"source-a",batch_index:1,observations:[{axis:"scene_causality",observation_kind:"structure",label:"因果",finding:"动作改变局面",writing_instruction:"用动作交付后果",avoid:"抽象总结",scope_hint:"recurrent_candidate",applies_to:["drafting"],confidence:80,evidence:[{location:"当前块",quote}],links_hint:[]}],structure_signals:[],topic_or_character_signals:[],uncertainties:[]});
    const ledger = (runId: string, sourceText: string) => ({authorId:"author-a",runId,sourceId:"source-a",sourceHash:createHash("sha256").update(sourceText).digest("hex"),sourceSnapshotId:"snapshot-a",batchId:"source-a:1",sourceStartUtf8:0,sourceStartCharacter:0,sourceLineOffset:1,structure});
    const source = "甲🙂\n乙。";
    const first = runner.validateStyleFullReadForTest(artifact("甲🙂 乙。"), {sourceId:"source-a",sourceBatchIndex:1}, source, ledger("run-a", source) as never);
    const second = runner.validateStyleFullReadForTest(artifact("甲🙂 乙。"), {sourceId:"source-a",sourceBatchIndex:1}, source, ledger("run-b", source) as never);
    assert.equal(first.evidenceRecords[0].exactQuote, source);
    assert.equal(first.evidenceRecords[0].startUtf8, 0);
    assert.equal(first.evidenceRecords[0].endUtf8, Buffer.byteLength(source, "utf8"));
    assert.equal(first.evidenceRecords[0].id, second.evidenceRecords[0].id, "evidence identity must stay stable across incremental runs");
    assert.throws(() => runner.validateStyleFullReadForTest(artifact("甲🙂\n丙。"), {sourceId:"source-a",sourceBatchIndex:1}, source, ledger("run-c", source) as never), /证据归位后仅剩/);
    const repeated = "重复证据。中间。重复证据。";
    assert.throws(() => runner.validateStyleFullReadForTest(artifact("重复证据。"), {sourceId:"source-a",sourceBatchIndex:1}, repeated, ledger("run-d", repeated) as never), /证据归位后仅剩/);

    const portraitBase = {narrative_function:"推进冲突",conflict_movement:"压力上升",value_changes:["安全→危险"],pressure_curve:["递增"],information_strategy:["新增线索"],character_voice_changes:["句子变短"],scene_transition_methods:["后果交接"],ending_method:"收在新代价",stable_patterns:[{pattern:"动作后果承载转折",evidence_ids:[]}],local_exceptions:[],counterexamples:[],evidence_ids:[first.evidenceRecords[0].id],coverage_state:"supported",limitations:[]};
    const phaseArtifact = {stage:"author_style_phase_portrait",source_id:"source-a",phase_id:"phase-1",segment_portraits:[{segment_id:"segment-1",segment_kind:"fixed_segment",title:"固定段落 1",...portraitBase}],phase_portrait:{phase_id:"phase-1",evolution:["由平静转入危险"],...portraitBase}};
    runner.validateStylePhasePortraitForTest(phaseArtifact, {sourceId:"source-a",phaseId:"phase-1",distillationRunId:"run-a"}, structure as never, first.evidenceRecords);
    const ungrounded = structuredClone(phaseArtifact); ungrounded.segment_portraits[0].evidence_ids = [];
    assert.throws(() => runner.validateStylePhasePortraitForTest(ungrounded, {sourceId:"source-a",phaseId:"phase-1",distillationRunId:"run-a"}, structure as never, first.evidenceRecords), /必须引用证据/);
    runner.removeAllListeners();
  } finally {
    store.db.close();
    await removeTempDir(root);
  }
});

async function waitFor(predicate: () => boolean, timeout = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("timed out waiting for agent job");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function readDiagnostic(store: StudioStore, jobId: string): Promise<string> {
  const logPath = join(store.dataDir, "jobs", `${jobId}.agy.log`);
  try {
    return await readFile(logPath, "utf8");
  } catch {
    return "";
  }
}

function planningConversationBinding(authorContract: Record<string, unknown>, conversation: Array<Record<string, unknown>>, options: {scope?: "new_book" | "book" | "volume" | "chapter" | "chapters"; foundationContract?: Record<string, unknown>; canon?: Record<string, unknown>} = {}): Record<string, unknown> {
  const scope = options.scope || "chapter";
  const allowedScopes = scope === "new_book"
    ? ["book_design", "volume_design", "chapter_design"]
    : scope === "book"
      ? ["book_design", "volume_design"]
      : scope === "volume"
        ? ["volume_design"]
        : ["chapter_design"];
  const methodRules = Array.isArray(authorContract.method_rules) ? authorContract.method_rules : [];
  const optionalTendencies = Array.isArray(authorContract.optional_content_tendencies) ? authorContract.optional_content_tendencies : [];
  const rules = [...methodRules, ...optionalTendencies].filter((item) => {
    const rule = item as Record<string, unknown>;
    return Array.isArray(rule.applies_to) && rule.applies_to.map(String).some((itemScope) => allowedScopes.includes(itemScope));
  });
  const foundationContract = options.foundationContract || {};
  const canon = options.canon || {};
  return {
    author_version_id: String(authorContract.author_version_id || ""),
    author_profile_hash: String(authorContract.profile_hash || ""),
    author_rule_count: rules.length,
    author_rules_hash: hashJson(rules),
    foundation_contract_hash: String(foundationContract.contract_hash || (Object.keys(foundationContract).length ? hashJson(foundationContract) : "")),
    canon_hash: hashJson(canon),
    conversation_hash: hashJson(conversation),
  };
}

async function removeTempDir(path: string): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await rm(path, {recursive: true, force: true});
      return;
    } catch (error) {
      if ((error as {code?: string})?.code !== "EBUSY") throw error;
      if (attempt === 11) return; // Windows may briefly hold SQLite WAL files after close.
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
  }
}

async function waitForJobs(store: StudioStore, runId: string, predicate: (job: ReturnType<StudioStore["getJob"]>) => boolean, timeout = 10_000): Promise<void> {
  const started = Date.now();
  while (true) {
    const jobs = store.listJobs(runId, 50);
    if (jobs.some((job) => predicate(store.getJob(job.id)))) return;
    if (Date.now() - started > timeout) {
      const details = await Promise.all(jobs.map(async (job) => ({
        id: job.id,
        stage: job.stage,
        status: job.status,
        error: job.error,
        events: store.listEvents(job.id, 0).map((event) => `${event.level}:${event.message}`),
        result: store.getJobResult(job.id).validationTrace,
        diagnostics: await readDiagnostic(store, job.id),
      })));
      throw new Error(`timed out waiting for agent jobs: ${JSON.stringify(details, null, 2)}`);
    }
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
    console.log(JSON.stringify({event:"init",conversation_id:"fixture-conversation",init:{cwd:process.cwd()}}));
    console.log(JSON.stringify({event:"step_update",step_update:{step_index:1,state:"DONE",step_type:"file_write",path:output,duration_seconds:0.2}}));
        console.log(JSON.stringify({event:"step_update",step_update:{step_index:2,state:"ACTIVE",step_type:"agent_response",text_delta:"指定 JSON 已写入\\n"}}));
    await writeFile(output, ${mode === "valid" ? "JSON.stringify({stage:'draft',content:'正文'})" : "'not-json'"}, "utf8");
    console.log(JSON.stringify({event:"result",status:"SUCCESS",response:"指定 JSON 已写入\\n",duration_seconds:0.3,num_turns:1,usage:{input_tokens:10,output_tokens:20,thinking_tokens:5,total_tokens:42}}));
  `, "utf8");
  let submits = 0;
  let submitsInFirstTest = 0;
  const python = {
    async workflowStatus() { return { value: { run_id: "run-1", book_id: "demo", status: "running", current_stage: "draft" } }; },
    async nextAction() { return { value: { run_id: "run-1", book_id: "demo", chapter: 1, stage: "draft", status: "running", prompt_path: promptPath, output_schema: {stage: "draft", content: ""} } }; },
    async submit() {
      submits += 1;
      submitsInFirstTest += 1;
      return { value: { status: submitsInFirstTest === 1 ? "completed" : "stopped" } };
    },
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
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(value.submits(), 1);
    assert.ok(value.store.getJob(started.job!.id)?.outputHash);
    assert.equal(value.runner.status().execution, "ready");
    assert.equal(value.runner.status().auth, "authenticated");
    const events = value.store.listEvents(started.job!.id, 0);
    const messages = events.map((event) => event.message).join("\n");
    assert.match(messages, /CLI 会话已建立/);
    assert.match(messages, /写入产物/);
    assert.match(messages, /指定 JSON 已写入/);
    assert.match(messages, /CLI 完成 · SUCCESS/);
    assert.doesNotMatch(messages, /运行 \d+ 秒 ·/);
    const assistant = events.filter((event) => event.kind === "assistant_text" && event.payload?.textDelta);
    assert.equal(assistant.map((event) => String(event.payload?.textDelta || "")).join(""), "指定 JSON 已写入\n");
    const toolEvent = events.find((event) => event.kind === "tool_event" && event.payload?.path);
    assert.ok(toolEvent);
    assert.equal(toolEvent?.payload?.stepType, "file_write");
    const result = [...events].reverse().find((event) => event.kind === "result");
    assert.equal(result?.payload?.status, "SUCCESS");
    assert.deepEqual(result?.payload?.usage, {inputTokens: 10, outputTokens: 20, thinkingTokens: 5, totalTokens: 42});
    const usage = [...events].reverse().find((event) => event.kind === "usage");
    assert.equal(usage?.payload?.thinkingTokens, 5);
    assert.ok(!events.some((event) => event.message.includes("思考原文")));
    value.runner.removeAllListeners();
    value.store.db.close();
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally { await removeTempDir(value.root); }
});

test("AGY structured output is atomically persisted without trusting model file writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-structured-output-"));
  let store: StudioStore | null = null;
  try {
    const chapterDir = join(root, "books", "demo", "workflow", "run-structured", "chapter-0001");
    await mkdir(chapterDir, {recursive: true});
    const promptPath = join(chapterDir, "draft.prompt.md");
    await writeFile(promptPath, "stage draft", "utf8");
    const fake = join(root, "structured-agy.mjs");
    await writeFile(fake, `
      if (!process.argv.includes("--json-schema")) throw new Error("missing enforced schema");
      const schema = JSON.parse(process.argv[process.argv.indexOf("--json-schema") + 1]);
      if (schema.properties.stage.const !== "draft") throw new Error("wrong schema");
      console.log(JSON.stringify({event:"result",result:{status:"SUCCESS",structured_output:{stage:"draft",content:"结构化正文"},usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}));
    `, "utf8");
    let submitted = "";
    const python = {
      async workflowStatus() { return {value: {run_id: "run-structured", book_id: "demo", status: "running", current_stage: "draft"}}; },
      async nextAction() { return {value: {run_id: "run-structured", book_id: "demo", chapter: 1, stage: "draft", status: "running", prompt_path: promptPath, output_schema: {type:"object",properties:{stage:{type:"string",const:"draft"},content:{type:"string"}},required:["stage","content"],additionalProperties:false}}}; },
      async submit(_runId: string, outputPath: string) { submitted = JSON.parse(await readFile(outputPath, "utf8")).content; return {value: {status: "completed"}}; },
    } as unknown as PythonBridge;
    store = new StudioStore(root);
    await mkdir(join(store.dataDir, "jobs"), {recursive: true});
    const runner = new AntigravityRunner(root, store, python, {executable: process.execPath, prefixArgs: [fake], autoCorrectionRetries: 0});
    const started = await runner.startContinuous("run-structured");
    await waitFor(() => store!.getJob(started.job!.id)?.status === "succeeded");
    assert.equal(submitted, "结构化正文");
    assert.match(store.listEvents(started.job!.id, 0).map((item) => item.message).join("\n"), /结构化输出已由 Tomota 原子写入/);
    runner.removeAllListeners();
  } finally {
    store?.db.close();
    await removeTempDir(root);
  }
});

test("author distillation reads every locked character before hierarchical reduction and version creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-author-full-read-"));
  let store: StudioStore | null = null;
  try {
    const authorId = "author-full-read";
    const extracted = join(root, "authors", authorId, "extracted");
    await mkdir(extracted, {recursive: true});
    const texts = {
      "source-a": "甲作品完整正文：门外的雨停了，他仍然没有回答。\n甲证据一。甲证据二。甲证据三。甲证据四。甲证据五。甲证据六。甲证据七。甲证据八。",
      "source-b": "乙作品完整正文：灯影越过走廊，她把问题重新问了一遍。\n乙证据一。乙证据二。乙证据三。乙证据四。乙证据五。乙证据六。乙证据七。乙证据八。",
    };
    for (const [sourceId, body] of Object.entries(texts)) await writeFile(join(extracted, `${sourceId}.txt`), sourceId === "source-a" ? body.replaceAll("\n", "\r\n") : body, "utf8");
    const fake = join(root, "author-full-read-agy.mjs");
    await writeFile(fake, `
      import { readFile } from "node:fs/promises";
      const instruction = process.argv[process.argv.indexOf("-p") + 1];
      const promptPath = instruction.match(/完整读取任务文件：(.+)/)[1].trim();
      const prompt = await readFile(promptPath, "utf8");
      const schema = JSON.parse(process.argv[process.argv.indexOf("--json-schema") + 1]);
      const stage = schema.properties.stage.const;
      if (stage === "author_style_distill" && (schema.properties.profile.properties.style_dimensions.minItems !== 66 || schema.properties.profile.properties.provenance.properties.evidence.minItems !== 16)) throw new Error("distillation schema is not deep enough");
      if (stage === "author_style_verify" && (!Array.isArray(schema.properties.dimension_ids.const) || schema.properties.dimension_ids.const.length < 1 || !schema.properties.dimensions)) throw new Error("verification schema lost the dimension batch contract");
      const sourceId = (prompt.match(/来源编号：([^\\n]+)/) || [,"source-a"])[1].trim();
      if (stage === "author_style_full_read" && (schema.properties.source_id.const !== sourceId || schema.properties.batch_index.const !== 1)) throw new Error("full-read schema did not lock source and batch identity");
      const sourceQuote = sourceId === "source-a" ? "甲作品完整正文：门外的雨停了，他仍然没有回答。" : "乙作品完整正文：灯影越过走廊，她把问题重新问了一遍。";
      const evidenceIds = [...new Set([...prompt.matchAll(/ev-[a-f0-9]{24}/g)].map((match) => match[0]))];
      const sourceEvidenceIds = evidenceIds.slice(0, 8);
      const ledgerRunId = stage === "author_style_distill" ? schema.properties.profile.properties.provenance.properties.ledger_run_id.const : "";
      const styleAxes = ["story_promise","protagonist_engine","relationship_dynamics","conflict_escalation","revelation_and_foreshadowing","worldbuilding_delivery","narrative_distance","sentence_rhythm","paragraph_rhythm","dialogue_mechanics","character_voice","emotion_delivery","transition_logic"];
      const methodAxes = ["worldbuilding_mechanics","character_design_mechanics","volume_architecture","chapter_architecture","scene_causality","serial_rhythm"];
      const axisPlan = [...styleAxes, ...methodAxes.flatMap((axis) => Array.from({length:10}, () => axis))];
      const methodRefs = (axis) => { const start = styleAxes.length + methodAxes.indexOf(axis)*10; return Array.from({length:10}, (_, i) => ({dimension_id:"dimension-"+(start+i),role:"primary",order:i+1,local_note:"第"+(i+1)+"条不同侧面"})); };
      const provenanceEvidence = evidenceIds.slice(0, 16).map((evidence_id, index) => ({evidence_id,supports:["dimension-"+(index%axisPlan.length)]}));
      const transferTest = {abstract_mechanism:"让行动产生可追踪后果",removed_terms:[],trials:[{target_genre:"职场",translated_example:"越权行动改变团队信任",mechanism_preserved:true},{target_genre:"竞技",translated_example:"冒险动作影响后续参赛",mechanism_preserved:true}],verdict:"pass"};
      const profile = {
        narrative:{pov:"限知",distance:"近距",camera:"动作切换"},rhythm:{sentence:"长短交替",paragraph:"按动作换段"},dialogue:{density:"中等",subtext:"回避中传递信息"},
        character_voice:{rule:"按目标和知识边界换声"},emotion:{rule:"用动作后果落地"},scene_pacing:{rule:"目标、阻碍、选择、后果"},
        story_design:{premise:"承诺由选择兑现",protagonist:"欲望与代价绑定",relationship:"压力中变化",conflict:"后果升级",revelation:"证据递进",worldbuilding:"规则由后果显影",worldbuilding_mechanics:methodRefs("worldbuilding_mechanics"),character_design_mechanics:methodRefs("character_design_mechanics")},
        book_architecture:{volume:methodRefs("volume_architecture"),chapter:methodRefs("chapter_architecture"),scene:methodRefs("scene_causality"),serial:methodRefs("serial_rhythm")},
        openings:["从正在发生的阻碍进入"],transitions:["以上一场后果进入下一场"],endings:["以选择后的新压力收束"],lexical_preferences:["中文自然"],forbidden_patterns:["模板总结"],platform_constraints:["纯文字成立"],genre_tendencies:["人物驱动"],
        rules:[{category:"因果",rule:"选择必须产生后果",scope:"author_core_strong",confidence:90,stability:85,applies_to:["book_design","chapter_design","drafting","revision"],evidence_ids:[evidenceIds[0],evidenceIds[evidenceIds.length-1]]}],
        style_dimensions:axisPlan.map((axis,index)=>({id:"dimension-"+index,axis,label:"维度"+index,finding:"跨作品稳定模式",trigger:"当场景进入关键转折",writing_instruction:"用目标、阻碍与后果组织",implementation_steps:["建立目标","施加阻碍","兑现后果"],allowed_variations:["随场景强度调整"],acceptance_tests:["后果进入后续因果"],failure_modes:["只写概括"],non_applicable_cases:["无场景变化"],avoid:"无代价巧合",scope:"author_core_strong",confidence:88,stability:82,applies_to:["book_design","volume_design","chapter_design","drafting","dialogue","revision"],evidence_ids:[evidenceIds[0],evidenceIds[evidenceIds.length-1]],counterevidence_ids:[],transfer_test:transferTest,links:[]})),
        statistical_signature:{targets:[{metric:"sentence_median",range:{low:8,typical:16,high:28},tolerance:"高潮可变化",writing_use:"避免节奏单一"}]},
        application_blueprint:{book_design:["故事承诺绑定选择"],volume_design:["卷末兑现"],chapter_design:["因果交接"],drafting:["动作落地"],dialogue:["目标与回避"],revision:["检查无代价巧合"]},
        distillation_quality:{reliability_level:"high",corpus_coverage:100,cross_source_consistency:86,holdout_consistency:84,actionability_score:91,topic_leakage_risk:"low",limitations:[]},
        provenance:{kind:"distilled",ledger_run_id:ledgerRunId,evidence:provenanceEvidence}
      };
      const candidate = {stage:"author_style_distill",profile,source_ids:["source-a","source-b"],rationale:["全文覆盖并按作品等权聚合"],warnings:[]};
      let artifact;
      if (stage === "author_style_full_read") {
        const evidenceQuotes = [sourceQuote, ...["一","二","三","四","五","六","七","八"].map((number) => (sourceId === "source-a" ? "甲证据" : "乙证据") + number + "。")];
        artifact = {stage,source_id:sourceId,batch_index:1,observations:[
          {axis:"scene_causality",observation_kind:"structure",label:"场景因果",finding:"动作承载转折",writing_instruction:"先动作后判断",avoid:"概括代替动作",scope_hint:"recurrent_candidate",applies_to:["drafting","revision"],confidence:80,evidence:evidenceQuotes.map((quote) => ({location:"当前块",quote})),links_hint:[]},
          {axis:"sentence_rhythm",observation_kind:"style",label:"错误冗余项",finding:"不应保留",writing_instruction:"不应应用",avoid:"不应应用",scope_hint:"recurrent_candidate",applies_to:["drafting"],confidence:50,evidence:[{location:"当前块",quote:"当前原文不存在的伪证据"}],links_hint:[]}
        ],structure_signals:["动作后果"],topic_or_character_signals:[],uncertainties:[]};
      }
      else if (stage === "author_style_phase_portrait") {
        const portrait = {narrative_function:"建立追问与回避的场景动力",conflict_movement:"由静态疑问转为关系压力",value_changes:["平静→试探"],pressure_curve:["低压起步","问题加压"],information_strategy:["用回避保留信息"],character_voice_changes:["语句缩短以显示防备"],scene_transition_methods:["由当前动作后果接入下一拍"],ending_method:"收在未回答带来的新压力",stable_patterns:[{pattern:"动作后果承载转折",evidence_ids:sourceEvidenceIds}],local_exceptions:[],counterexamples:[],evidence_ids:sourceEvidenceIds,coverage_state:"supported",limitations:[]};
        artifact = {stage,source_id:sourceId,phase_id:"phase-1",segment_portraits:[{segment_id:"segment-1",segment_kind:"fixed_segment",title:"固定段落 1",...portrait}],phase_portrait:{phase_id:"phase-1",evolution:["由引入异常转入人物试探"],...portrait}};
      }
      else if (stage === "author_style_work_reduce") artifact = {stage,source_id:sourceId,level:Number((prompt.match(/归纳层级：(\\d+)/)||[,0])[1]),work_profile:{dimensions:[{id:"scene-causality",axis:"scene_causality",label:"场景因果",finding:"动作引发后果",trigger:"场景转折",writing_instruction:"动作后呈现后果",implementation_steps:["动作","后果"],allowed_variations:["节奏可变"],acceptance_tests:["后果可追溯"],avoid:"无因果切换",scope:"within_work_stable",confidence:85,stability:80,applies_to:["chapter_design","drafting"],evidence_ids:sourceEvidenceIds,links:[]}],story_and_structure:["因果交接"],world_mechanics:[],character_mechanics:[],structure:[],phase_summaries:[{phase_id:"phase-1",stable_patterns:["动作与后果交接"],exceptions:[],counterexamples:[],evidence_ids:sourceEvidenceIds,coverage_state:"supported"}],coverage_matrix:[{dimension_id:"scene-causality",phase_id:"phase-1",state:"supported",evidence_ids:sourceEvidenceIds}],expression:["动作落地"],topic_specific:[],limitations:[]}};
      else if (stage === "author_style_distill") artifact = candidate;
      else {
        const groupIndex = schema.properties.group_index.const;
        const groupCount = schema.properties.group_count.const;
        const dimensionIds = schema.properties.dimension_ids.const;
        const dimensions = JSON.parse(prompt.match(/## 本批待复核维度\\s*\\x60\\x60\\x60json\\s*([\\s\\S]*?)\\s*\\x60\\x60\\x60\\s*## 本批按需证据包/)[1]);
        artifact = {stage:"author_style_verify",group_index:groupIndex,group_count:groupCount,dimension_ids:dimensionIds,verdict:"pass",checks:{evidence_grounded:true,cross_work_separation:true,topic_leakage_control:true,executable_contract:true,counterfactual_transfer:true},dimensions,corrections:[],public_summary:"本批维度证据与迁移复核通过"};
      }
      console.log(JSON.stringify({event:"result",result:{status:"SUCCESS",structured_output:artifact,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}));
    `, "utf8");
    let created = 0;
    const python = {async createAuthorVersion() { created += 1; return {value:{version:{id:"version-full-read",version_number:1,profile_hash:"hash",profile:{}}}}; }} as unknown as PythonBridge;
    store = new StudioStore(root);
    await mkdir(join(store.dataDir, "jobs"), {recursive: true});
    const runner = new AntigravityRunner(root, store, python, {executable: process.execPath, prefixArgs:[fake], autoCorrectionRetries:0});
    const sourcePlans = Object.entries(texts).map(([sourceId, body]) => ({
      source_id: sourceId, original_name: `${sourceId}.txt`, text_path: `authors/${authorId}/extracted/${sourceId}.txt`,
      text_sha256: createHash("sha256").update(body).digest("hex"), character_count: body.length, batch_count: 1,
      batches:[{batch_index:1,start:0,end:body.length,character_count:body.length,sha256:createHash("sha256").update(body).digest("hex")}],
    }));
    const context = {
      author:{id:authorId,name:"全文作者"}, sources:sourcePlans.map((item)=>({source_id:item.source_id,original_name:item.original_name,metrics:{}})), corpus_analysis:{aggregation:"equal_weight_per_work"},
      semantic_full_read_plan:{required:true,sampling_only:false,partition_rule:"every_character_exactly_once",total_characters:Object.values(texts).reduce((total,body)=>total+body.length,0),total_batches:2,sources:sourcePlans},
      distillation_contract:{minimum_style_dimensions:66, method_axis_minimum:10}, rules:[],
    };
    const started = await runner.startStyleDistillation(authorId, context);
    try {
      await waitFor(() => {
        if (created !== 1) return false;
        const latest = store.listJobs(started.job.runId, 1)[0];
        return Boolean(latest && store.getJobResult(latest.id).validationTrace.candidateVersion);
      }, 20_000);
    } catch (error) {
      console.error(store.listJobs(started.job.runId, 20).map((item) => ({stage:item.stage,status:item.status,error:item.error})));
      throw error;
    }
    const bundle = await runner.authorCandidateResult(started.job.id);
    assert.equal(created, 1, "version is created only after independent verification");
    const readJobs = store.listJobs(started.job.runId, 200).filter((item)=>item.stage === "author_style_full_read");
    assert.equal(readJobs.length, 2);
    const sourceAJob = readJobs.find((item) => String(store!.getJobResult(item.id).lineage.sourceId) === "source-a")!;
    const sourceAArtifact = JSON.parse(await readFile(sourceAJob.outputPath, "utf8")) as {observations:Array<{evidence:Array<{evidence_id:string;quote?:string}>}>};
    assert.equal(sourceAArtifact.observations.length, 1, "an extra ungrounded observation is discarded only when the batch still satisfies its minimum");
    assert.match(sourceAArtifact.observations[0].evidence[0].evidence_id, /^ev-[a-f0-9]{24}$/);
    assert.equal(sourceAArtifact.observations[0].evidence[0].quote, undefined, "downstream artifacts must reference immutable evidence IDs instead of rewriting quotes");
    const sourceAEvidence = store.listEvidenceByRun(started.job.runId).filter((item) => item.sourceId === "source-a");
    assert.equal(sourceAEvidence.length, 9);
    assert.equal(sourceAEvidence[0].exactQuote, "甲作品完整正文：门外的雨停了，他仍然没有回答。");
    assert.match(store.listEvents(sourceAJob.id, 0).map((item) => item.message).join("\n"), /证据已严格归位/);
    assert.equal(bundle.pipeline?.coverage_percent, 100);
    assert.equal(bundle.pipeline?.completed_characters, Object.values(texts).reduce((total,body)=>total+body.length,0));
    assert.equal(bundle.pipeline?.pipeline_status, "completed");
    assert.equal((bundle.candidateVersion as {id?:string})?.id, "version-full-read");
    const repeated = await runner.startStyleDistillation(authorId, context);
    assert.notEqual(repeated.job.runId, started.job.runId, "a completed pipeline must not be mistaken for an interrupted hand-off");
    await waitFor(() => created === 2, 12_000);
    const repeatedReadJobs = store.listJobs(repeated.job.runId, 200).filter((item) => item.stage === "author_style_full_read");
    assert.equal(repeatedReadJobs.length, 0, "unchanged sources should reuse grounded evidence and hierarchical portraits");
    const durableCaches = store.db.prepare("SELECT read_outputs_json,phase_portraits_json,work_profile_path FROM distillation_source_cache").all() as Array<Record<string, unknown>>;
    assert.ok(durableCaches.every((row) => !String(row.work_profile_path).includes(`${join(".tomota-studio", "jobs")}`)));
    assert.ok(durableCaches.every((row) => (JSON.parse(String(row.read_outputs_json)) as string[]).every((path) => path.includes(`${join("authors", authorId, "source-cache")}`))));
    runner.removeAllListeners();
  } finally {
    store?.db.close();
    await removeTempDir(root);
  }
});

test("dimension verification enforces batch identity, completeness and order", () => {
  const runner = new AntigravityRunner(".", null as never, {} as PythonBridge, {executable: "noop"});
  const checks = {evidence_grounded: true, cross_work_separation: true, topic_leakage_control: true, executable_contract: true, counterfactual_transfer: true};
  const dimension = (id: string) => ({id, axis: "scene_causality", label: "结构方法", finding: "动作后果", trigger: "场景转折", writing_instruction: "动作后呈现后果", implementation_steps: ["动作"], allowed_variations: ["节奏可变"], acceptance_tests: ["后果可追溯"], avoid: "无因果切换", scope: "author_core_strong", confidence: 88, stability: 82, applies_to: ["chapter_design"], evidence_ids: ["ev-1"], counterevidence_ids: [], transfer_test: {abstract_mechanism: "让行动产生可追踪后果", removed_terms: [], trials: [{target_genre: "职场", translated_example: "越权行动改变信任", mechanism_preserved: true}, {target_genre: "竞技", translated_example: "冒险动作影响资格", mechanism_preserved: true}], verdict: "pass"}, links: []});
  const base = (overrides: Record<string, unknown> = {}) => ({stage: "author_style_verify", group_index: 2, group_count: 9, dimension_ids: ["d-0"], verdict: "pass", checks, dimensions: [dimension("d-0")], corrections: [], public_summary: "复核通过", ...overrides});
  const lineage = {verifyGroupIndex: 2, verifyGroupCount: 9, dimensionIds: ["d-0"], sourceIds: ["source-a", "source-b"]};
  const validate = (value: Record<string, unknown>) => (runner as unknown as {validateStyleDimensionVerifyForTest: (v: Record<string, unknown>, l: Record<string, unknown>, a: Record<string, unknown>, e: unknown[]) => void}).validateStyleDimensionVerifyForTest(value, lineage, {}, []);

  assert.throws(() => validate(base({verdict: "invalid"})), /verdict 无效/);
  assert.throws(() => validate(base({group_index: 3})), /批次与锁定状态不一致/);
  assert.throws(() => validate(base({group_count: 0})), /group_count 无效/);
  assert.throws(() => validate(base({dimension_ids: ["d-1"]})), /按原顺序且仅返回锁定维度/);
  assert.throws(() => validate(base({dimension_ids: ["d-0", "d-0"]})), /按原顺序且仅返回锁定维度/);
  assert.throws(() => validate(base({checks: {...checks, evidence_grounded: false}})), /质量检查必须通过/);
  assert.throws(() => validate(base({dimensions: []})), /维度数量与锁定批次不一致/);
  assert.throws(() => validate(base({dimensions: [dimension("d-renamed")]})), /不得新增、删除、重排或改名维度/);
});

test("author distillation requires structure axes and book architecture groups", () => {
  const runner = new AntigravityRunner(".", null as never, {} as PythonBridge, {executable: "noop"});
  const styleAxes = ["story_promise","protagonist_engine","relationship_dynamics","conflict_escalation","revelation_and_foreshadowing","worldbuilding_delivery","narrative_distance","sentence_rhythm","paragraph_rhythm","dialogue_mechanics","character_voice","emotion_delivery","transition_logic"];
  const methodAxes = ["worldbuilding_mechanics","character_design_mechanics","volume_architecture","chapter_architecture","scene_causality","serial_rhythm"];
  const axisPlan = [...styleAxes, ...methodAxes.flatMap((axis) => Array.from({length: 10}, () => axis))];
  const methodRefs = (axis: string) => { const start = styleAxes.length + methodAxes.indexOf(axis) * 10; return Array.from({length: 10}, (_, i) => ({dimension_id: `d-${start + i}`, role: "primary", order: i + 1, local_note: ""})); };
  const evidence = Array.from({length: 16}, (_, i) => ({evidence_id: `E${i+1}`, source_id: i % 2 === 0 ? "source-a" : "source-b", location: `位置${i+1}`, quote: `短引文${i+1}`}));
  const transferTest = {abstract_mechanism: "让行动产生可追踪后果", removed_terms: [], trials: [{target_genre: "职场", translated_example: "越权行动改变信任", mechanism_preserved: true}, {target_genre: "竞技", translated_example: "冒险动作影响资格", mechanism_preserved: true}], verdict: "pass"};
  const makeCandidate = (): Record<string, unknown> => ({
    stage: "author_style_distill",
    profile: {
      narrative: {pov: "限知", distance: "近距", camera: "动作切换"}, rhythm: {sentence: "长短交替", paragraph: "按动作换段"},
      dialogue: {density: "中等", subtext: "回避传递"}, character_voice: {rule: "按目标换声"}, emotion: {rule: "用动作后果落地"}, scene_pacing: {rule: "目标阻碍选择后果"},
      openings: ["从阻碍进入"], transitions: ["后果接下一场"], endings: ["新压力收束"],
      lexical_preferences: ["中文自然"], forbidden_patterns: ["模板总结"], platform_constraints: ["纯文字成立"], genre_tendencies: ["人物驱动"],
      rules: [{category: "因果", rule: "选择产生后果", scope: "author_core_strong", confidence: 90, stability: 85, applies_to: ["book_design"], evidence_ids: ["E1"]}],
      style_dimensions: axisPlan.map((axis, index) => ({id: `d-${index}`, axis, label: `维度${index}`, finding: "跨作品稳定模式", trigger: "场景转折", writing_instruction: "用目标阻碍后果组织", implementation_steps: ["建立目标"], allowed_variations: ["随场景调整"], acceptance_tests: ["后果可追溯"], avoid: "无代价巧合", scope: "author_core", confidence: 88, stability: 82, applies_to: ["book_design","volume_design","chapter_design","drafting","dialogue","revision"], evidence_ids: ["E1","E16"], transfer_test: transferTest, links: []})),
      story_design: {worldbuilding_mechanics: methodRefs("worldbuilding_mechanics"), character_design_mechanics: methodRefs("character_design_mechanics")},
      book_architecture: {volume: methodRefs("volume_architecture"), chapter: methodRefs("chapter_architecture"), scene: methodRefs("scene_causality"), serial: methodRefs("serial_rhythm")},
      statistical_signature: {targets: [{metric: "sentence_median", range: {low: 8, typical: 16, high: 28}, tolerance: "可变", writing_use: "避免单调"}]},
      application_blueprint: {book_design: ["承诺绑定选择"], volume_design: ["卷末兑现"], chapter_design: ["因果交接"], drafting: ["动作落地"], dialogue: ["目标回避"], revision: ["检查无代价巧合"]},
      distillation_quality: {reliability_level: "high", corpus_coverage: 100, cross_source_consistency: 86, holdout_consistency: 84, actionability_score: 91, topic_leakage_risk: "low", limitations: []},
      provenance: {kind: "distilled", evidence},
    },
    source_ids: ["source-a", "source-b"], rationale: ["全文覆盖"], warnings: [],
  });
  const validate = (value: Record<string, unknown>) => (runner as unknown as {validateAuthorCandidateForTest: (stage: string, v: Record<string, unknown>, l: unknown[]) => void}).validateAuthorCandidateForTest("author_style_distill", value, []);
  validate(makeCandidate()); // baseline 通过

  // scene_causality 轴维度不足 10 个（删掉一半，保持总数 ≥66）→ 拒绝
  const noScene = makeCandidate();
  let sceneSeen = 0;
  (noScene.profile as Record<string, {style_dimensions: Array<Record<string, unknown>>}>).style_dimensions = ((noScene.profile as Record<string, unknown>).style_dimensions as Array<Record<string, unknown>>).filter((dimension) => {
    if (dimension.axis !== "scene_causality") return true;
    sceneSeen += 1;
    return sceneSeen <= 5; // 只保留前 5 个，剩 5 个不足 10
  });
  assert.throws(() => validate(noScene), /scene_causality 轴至少需要 10 个/);

  // chapter_architecture 轴维度不足 → 拒绝
  const noChapter = makeCandidate();
  let chapterSeen = 0;
  (noChapter.profile as Record<string, {style_dimensions: Array<Record<string, unknown>>}>).style_dimensions = ((noChapter.profile as Record<string, unknown>).style_dimensions as Array<Record<string, unknown>>).filter((dimension) => {
    if (dimension.axis !== "chapter_architecture") return true;
    chapterSeen += 1;
    return chapterSeen <= 5;
  });
  assert.throws(() => validate(noChapter), /chapter_architecture 轴至少需要 10 个/);
});

test("reader feedback is evaluated without mutating the book and waits for user confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-reader-feedback-agent-"));
  let store: StudioStore | null = null;
  try {
    const fake = join(root, "reader-feedback-agy.mjs");
    await writeFile(fake, `
      import { readFile, writeFile } from "node:fs/promises";
      const instruction = process.argv[process.argv.indexOf("-p") + 1];
      const output = instruction.match(/UTF-8 JSON 到：(.+)/)[1].trim();
      const promptPath = instruction.match(/完整读取任务文件：(.+)/)[1].trim();
      const prompt = await readFile(promptPath, "utf8");
      const feedbackIds = [...prompt.matchAll(/"feedback_id":\\s*"(reader-[^"]+)"/g)].map((match) => match[1]);
      const artifact = {
        stage:"reader_feedback_evaluation", verdict:"actionable", severity:"high",
        summary:"第 2—3 章冲突推进过顺，需要增加失败代价。", affected_chapters:[2,3],
        preserve:["第一章已经锁定的线索"], changes:["让第二章的调查失败并付出代价"],
        risks:["不得改变人物当前知识边界"], compiled_instruction:"保留既有线索，重做第 2—3 章代价链并重新通过全部审查",
        feedback_responses:feedbackIds.map((feedback_id) => ({feedback_id,disposition:"accepted",interpretation:"调查推进缺少失败代价",reason:"正文直接把调查写成一路顺利",evidence_refs:["E1"],affected_chapters:[2,3]})),
        evidence:[
          {evidence_id:"E1",chapter:2,location:"第二章调查段",quote:"调查一路顺利"},
          {evidence_id:"E2",chapter:3,location:"第三章转折段",quote:"线索突然出现"}
        ],
        chapter_audit:[
          {chapter:2,verdict:"rewrite_required",finding:"调查缺少代价",preserve:["第一章线索"],rewrite:["重构调查失败链"],evidence_refs:["E1"]},
          {chapter:3,verdict:"rewrite_required",finding:"转折缺少铺垫",preserve:["人物知识边界"],rewrite:["补足转折因果"],evidence_refs:["E2"]}
        ],
        proposed_book_rules:[{category:"因果与转场",rule:"关键线索出现前必须有可回溯铺垫，调查推进必须伴随代价。",rationale:"防止后续章节重复出现无代价推进和突兀转折",evidence_refs:["E1","E2"],covers_change_indexes:[0]}],
        clarification_questions:[]
      };
      await writeFile(output, JSON.stringify(artifact), "utf8");
      console.log(JSON.stringify({event:"result",status:"SUCCESS",response:"反馈评估已写入",duration_seconds:0.1,num_turns:1,usage:{input_tokens:10,output_tokens:20,total_tokens:30}}));
    `, "utf8");
    store = new StudioStore(root);
    await mkdir(join(store.dataDir, "jobs"), {recursive: true});
    const first = store.createReaderFeedback({bookId: "demo", scopeType: "volume", scopeId: "volume-1", content: "中段太顺"});
    store.updateReaderFeedback(first.id, {status: "evaluated", evaluation: {verdict: "actionable", summary: "推进过顺"}});
    const feedback = store.createReaderFeedback({bookId: "demo", scopeType: "volume", scopeId: "volume-1", content: "补充：保留第一章线索并全文重修", parentFeedbackId: first.id, reviewMode: "full_scope"});
    store.updateReaderFeedback(feedback.id, {requestedChapters: [2, 3]});
    const runner = new AntigravityRunner(root, store, {} as PythonBridge, {executable: process.execPath, prefixArgs: [fake], autoCorrectionRetries: 0});
    const started = await runner.startReaderFeedbackEvaluation({
      feedbackId: feedback.id, bookId: "demo", scopeType: "volume", scopeId: "volume-1", content: feedback.content,
      context: {eligible_chapters: [2, 3], generated_chapters: [{chapter_number:2,body:"调查一路顺利。"},{chapter_number:3,body:"线索突然出现。"}], feedback_thread: [{feedback_id:first.id,sequence:1,content:first.content,status:"evaluated"},{feedback_id:feedback.id,sequence:2,content:feedback.content,status:"evaluating"}]}, eligibleChapters: [2, 3],
    });
    await waitFor(() => ["succeeded", "failed"].includes(String(store!.getJob(started.job.id)?.status || "")));
    assert.equal(store.getJob(started.job.id)?.status, "succeeded", store.getJob(started.job.id)?.error || "reader feedback job failed");
    const saved = store.getReaderFeedback(feedback.id)!;
    assert.equal(saved.status, "evaluated");
    assert.deepEqual(saved.evaluation.affected_chapters, [2, 3]);
    assert.equal(store.getReaderFeedback(first.id)?.supersededById, feedback.id, "the prior conclusion is superseded only after the continuation passes validation");
    assert.equal(saved.workflowId, null, "evaluation must not start rework before user confirmation");
    assert.match(String(store.getJobResult(started.job.id).publicDecision.summary), /第 2—3 章/);
    runner.removeAllListeners();
  } finally {
    store?.db.close();
    await removeTempDir(root);
  }
});

test("full-scope reader feedback cannot be narrowed by the evaluator", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-reader-full-scope-"));
  let store: StudioStore | null = null;
  try {
    const fake = join(root, "reader-full-scope-agy.mjs");
    await writeFile(fake, `
      import { readFile, writeFile } from "node:fs/promises";
      const instruction = process.argv[process.argv.indexOf("-p") + 1];
      const output = instruction.match(/UTF-8 JSON 到：(.+)/)[1].trim();
      const promptPath = instruction.match(/完整读取任务文件：(.+)/)[1].trim();
      const prompt = await readFile(promptPath, "utf8");
      const feedbackId = prompt.match(/"feedback_id":\\s*"(reader-[^"]+)"/)[1];
      await writeFile(output, JSON.stringify({
        stage:"reader_feedback_evaluation",verdict:"actionable",severity:"high",summary:"只修改第二章",
        affected_chapters:[2],preserve:[],changes:["修改第二章"],risks:[],compiled_instruction:"只修改第二章",
        feedback_responses:[{feedback_id:feedbackId,disposition:"partially_accepted",interpretation:"只接受第二章",reason:"第三章无需修改",evidence_refs:["E1"],affected_chapters:[2]}],
        evidence:[{evidence_id:"E1",chapter:2,location:"第二章",quote:"调查一路顺利"}],
        chapter_audit:[{chapter:2,verdict:"rewrite_required",finding:"推进过顺",preserve:[],rewrite:["增加代价"],evidence_refs:["E1"]}],
        proposed_book_rules:[{category:"节奏",rule:"调查必须有代价",rationale:"避免推进过顺",evidence_refs:["E1"],covers_change_indexes:[0]}],clarification_questions:[]
      }), "utf8");
      console.log(JSON.stringify({event:"result",status:"SUCCESS",response:"done",duration_seconds:0.1,num_turns:1,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}));
    `, "utf8");
    store = new StudioStore(root);
    await mkdir(join(store.dataDir, "jobs"), {recursive: true});
    const feedback = store.createReaderFeedback({bookId:"demo",scopeType:"book",scopeId:"book",content:"全文审查并全部重修",reviewMode:"full_scope"});
    store.updateReaderFeedback(feedback.id, {requestedChapters:[2,3]});
    const runner = new AntigravityRunner(root, store, {} as PythonBridge, {executable:process.execPath,prefixArgs:[fake],autoCorrectionRetries:0});
    const started = await runner.startReaderFeedbackEvaluation({
      feedbackId:feedback.id,bookId:"demo",scopeType:"book",scopeId:"book",content:feedback.content,
      context:{eligible_chapters:[2,3],generated_chapters:[{chapter_number:2,body:"调查一路顺利。"},{chapter_number:3,body:"线索突然出现。"}],feedback_thread:[{feedback_id:feedback.id,sequence:1,content:feedback.content,status:"evaluating"}]},eligibleChapters:[2,3],
    });
    await waitFor(() => ["succeeded","failed"].includes(String(store!.getJob(started.job.id)?.status || "")));
    assert.equal(store.getJob(started.job.id)?.status, "failed");
    assert.match(store.getJob(started.job.id)?.error || "", /无权缩小|不得漏章/);
    runner.removeAllListeners();
  } finally {
    store?.db.close();
    await removeTempDir(root);
  }
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
      const initialChapter = (chapter_number) => ({chapter_number,volume_id:"volume-1",title:"雨夜"+chapter_number,objective:"推进调查",obstacle:"追兵逼近",change:"关系与线索前进一步",new_information:"得到第"+chapter_number+"条线索",chapter_hook:"出现新的可核验危机",next_first_beat:"处理上一章后果",current_character_goal:"保护同伴并查清真相",relationship_state:"有限信任逐步建立",body_information_state:"身体状态与已知信息明确",unresolved_foreshadowing:"黑伞来源",ending_type:"因果钩子",previous_force:"上一章代价与未解线索继续施压",target_word_count:2800,problem_tags:["动机","承接"],causality_check:"调查选择产生代价并推动下一章",boundary_check:"主角只使用其身份可获取的信息",consequence_check:"成功结盟同时暴露行踪"});
      const constraints = {contract_version:"foundation-contract-v1",reader_promise:"用可核验线索推进身份谜团",protagonist_goal:"保护少女并找回被抹除的记忆",stakes_and_cost:"失败会导致同伴被清算且记忆永久丢失",causal_chain:["收留少女→遭到追捕→被迫查明机构目的"],character_constraints:["主角谨慎且不会无证据相信陌生人"],knowledge_boundaries:["主角开篇不知道少女身份"],world_rules:["记忆能力每次使用都付出可见代价"],relationship_arc:"陌生到有限信任，再到共同承担代价",foreshadowing_plan:["黑伞坐标在第一卷内兑现"],pacing_rules:["每章必须发生价值变化并让后果进入下一章"],voice_and_platform_rules:["中文自然且纯文字场景可以独立成立"],forbidden_shortcuts:["禁止巧合解围和人物机械降智"],workflow_acceptance:["正文事实与章纲、Canon和人物知识边界一致"],unresolved_decisions:["最终记忆是否完整恢复由后续作者确认"]};
      const proposals = {
        planning_new_book:{title:"雨夜来客",genre:"都市异能/悬疑",synopsis:"雨夜里，旧物店迎来失忆少女。",completion_mode:"open_ended",target_chapters:0,rolling_window:5,premise:"两名边缘人追查城市异常",core_conflict:"个体记忆对抗机构清算",ending_direction:"未锁定",major_beats:["相遇","结盟"],volumes:[volume],initial_chapters:[initialChapter(1),initialChapter(2),initialChapter(3)],constraints},
        planning_book:{synopsis:"雨夜里，旧物店迎来失忆少女。",genre:"都市异能/悬疑",premise:"两名边缘人追查城市异常",core_conflict:"个体记忆对抗机构清算",ending_direction:"未锁定",major_beats:["相遇","结盟"],volumes:[volume]},
        planning_volume:volume,
        planning_chapter:{chapter_number:1,volume_id:"volume-1",title:"雨中来客",objective:"收留少女",obstacle:"追兵逼近",change:"达成临时合作",new_information:"少女失忆",chapter_hook:"门外传来敲门声",next_first_beat:"核验来客身份",current_character_goal:"保护旧物店",relationship_state:"陌生人开始合作",body_information_state:"少女失温",unresolved_foreshadowing:"黑伞来源",ending_type:"危机逼近",previous_force:"追捕压力与上一章遗留线索",target_word_count:2800,problem_tags:["动机"],causality_check:"收留选择引来追兵并推动下一步核验",boundary_check:"主角只知道眼前可见信息",consequence_check:"合作同时暴露旧物店"},
        planning_chapters:{chapters:[
          {chapter_number:1,volume_id:"volume-1",title:"雨中来客",objective:"收留少女",obstacle:"追兵逼近",change:"达成临时合作",new_information:"少女失忆",chapter_hook:"门外传来敲门声",next_first_beat:"核验来客身份",current_character_goal:"保护旧物店",relationship_state:"陌生人开始合作",body_information_state:"少女失温",unresolved_foreshadowing:"黑伞来源",ending_type:"危机逼近",previous_force:"追捕压力与上一章遗留线索",target_word_count:2800,problem_tags:["动机"],causality_check:"收留选择引来追兵",boundary_check:"主角只知道眼前信息",consequence_check:"合作暴露旧物店"},
          {chapter_number:2,volume_id:"volume-1",title:"门外追兵",objective:"核验来客身份",obstacle:"追兵封锁街区",change:"两人共同突围",new_information:"追兵来自清算机构",chapter_hook:"黑伞上浮现坐标",next_first_beat:"前往坐标所在地",current_character_goal:"保护少女并查清真相",relationship_state:"形成有限信任",body_information_state:"少女恢复体温但记忆仍缺失",unresolved_foreshadowing:"黑伞坐标",ending_type:"线索揭示",previous_force:"突围代价与追兵线索继续施压",target_word_count:2900,problem_tags:["承接"],causality_check:"核验行动引来封锁",boundary_check:"两人只知道机构线索",consequence_check:"突围暴露行踪"}
        ]}
      };
      const bookAuditPaths = {causality:["premise","core_conflict","major_beats"],knowledge_boundaries:["premise"],choice_cost_consequence:["core_conflict","ending_direction"],relationship_change:["volumes[0].character_change"],foreshadowing:["volumes[0].foreshadowing"],continuity:["volumes[0].ending"]};
      const newBookAuditPaths = {causality:["premise","core_conflict","major_beats"],knowledge_boundaries:["initial_chapters[0].new_information","initial_chapters[1].new_information","initial_chapters[2].new_information"],choice_cost_consequence:["core_conflict","ending_direction"],relationship_change:["volumes[0].character_change"],foreshadowing:["volumes[0].foreshadowing"],continuity:["volumes[0].ending","initial_chapters[0].next_first_beat","initial_chapters[1].next_first_beat","initial_chapters[2].next_first_beat"]};
      const volumeAuditPaths = {causality:["objective","main_conflict","character_change"],knowledge_boundaries:["foreshadowing"],choice_cost_consequence:["main_conflict"],relationship_change:["character_change"],foreshadowing:["foreshadowing"],continuity:["ending"]};
      const chapterAuditPaths = {causality:["objective","obstacle","change"],knowledge_boundaries:["new_information","body_information_state"],choice_cost_consequence:["change","causality_check"],relationship_change:["relationship_state"],foreshadowing:["unresolved_foreshadowing"],continuity:["chapter_hook","next_first_beat"]};
      const batchChapterAuditPaths = {causality:["chapters[0].objective","chapters[1].objective"],knowledge_boundaries:["chapters[0].new_information","chapters[1].new_information"],choice_cost_consequence:["chapters[0].change","chapters[1].change"],relationship_change:["chapters[0].relationship_state","chapters[1].relationship_state"],foreshadowing:["chapters[0].unresolved_foreshadowing","chapters[1].unresolved_foreshadowing"],continuity:["chapters[0].chapter_hook","chapters[1].next_first_beat"]};
      const auditPaths = stage === "planning_new_book" ? newBookAuditPaths : stage === "planning_book" ? bookAuditPaths : stage === "planning_volume" ? volumeAuditPaths : stage === "planning_chapters" ? batchChapterAuditPaths : chapterAuditPaths;
      const readerWorldContract = {reader_promise:"读者获得可核验线索逐层揭开身份谜团的验证快感，且每章兑付一次而非空许诺。",emotional_payoff:"先让主角因误判付出关系代价，再用可验证证据给读者补偿，形成挫败与满足交替。",world_mechanics:"记忆能力受身体状态与时间限制，每次使用都会留下可观察损耗并改变双方信任。",world_exceptions:"只有机构维护者能改写记录，但必须留下时间戳并承担暴露风险。",author_world_integration:"作者方法把规则转为信息差与代价结构，让世界事实通过人物行动后果显影，并用选择代价替代设定说明。",character_integration:"主角保护欲受身份暴露风险限制，身份压力让每次结盟选择同时改变信息、关系和下一阶段危险。",conflicts_and_tradeoffs:"已核验与用户要求及Canon无冲突；保留既有记忆代价与人物知识边界。",evidence_paths:stage === "planning_chapters" ? ["chapters[0].objective","chapters[0].new_information","chapters[1].change"] : ["objective","new_information","change"]};
      const freshCategories = ["reader_promise","protagonist_goal","stakes_and_cost","causal_chain","character_constraints","knowledge_boundaries","world_rules","relationship_arc","foreshadowing_plan","pacing_rules","voice_and_platform_rules","forbidden_shortcuts","workflow_acceptance"];
      const changes = stage === "planning_book"
        ? freshCategories.map((category) => ({operation:"add",constraint_id:"",scope_type:"book",scope_id:"book",category,rule:"首次规划建立的"+category+"约束，必须在后续设计、正文与审查中持续对证",priority:category === "forbidden_shortcuts" ? "avoid" : "must",reason:"全书重建后从空建立第一份完整基础契约"}))
        : [{operation:"add",constraint_id:"",scope_type:stage === "planning_volume" ? "volume" : "chapter",scope_id:stage === "planning_volume" ? "volume-1" : "1",category:"causal_acceptance",rule:"每次选择必须产生可见后果并进入下一层规划",priority:"must",reason:"让共创结果持续约束后续正文"}];
      const reviewSourceStage = stage === "candidate_blind_review" ? instruction.match(/"source_stage":"(planning_[^"]+)/)[1] : stage;
      const value = stage === "candidate_blind_review"
        ? {stage,source_stage:reviewSourceStage,candidates:{A:{score:90,blocking_issues:[],strengths:["可执行"],evidence:reviewSourceStage === "planning_new_book" || reviewSourceStage === "planning_book" ? ["proposal.premise"] : reviewSourceStage === "planning_chapters" ? ["proposal.chapters[0].objective"] : ["proposal.objective"],author_transfer:{method_fidelity:90,content_independence:90,originality:88,generic_scaffold_risk:12,surface_imitation_hits:[]},reader_world_quality:{reader_promise:92,world_consistency:90,mechanic_verifiability:91,cost_clarity:89}},B:{score:76,blocking_issues:[],strengths:["不同路径"],evidence:reviewSourceStage === "planning_new_book" || reviewSourceStage === "planning_book" ? ["proposal.synopsis"] : reviewSourceStage === "planning_chapters" ? ["proposal.chapters[0].change"] : reviewSourceStage === "planning_volume" ? ["proposal.character_change"] : ["proposal.change"],author_transfer:{method_fidelity:78,content_independence:84,originality:80,generic_scaffold_risk:24,surface_imitation_hits:[]},reader_world_quality:{reader_promise:80,world_consistency:79,mechanic_verifiability:78,cost_clarity:77}}},selected:"A",score_gap:14,rationale:["A 更可执行"]}
        : {stage,proposal:proposals[stage],...(stage === "planning_new_book" ? {} : {constraint_delta:{base_contract_hash:"",changes}}),planning_audit:Object.fromEntries(Object.entries(auditPaths).map(([field, paths]) => [field,{passed:true,findings:["目标、阻碍与变化闭合"],evidence_paths:paths}])),reader_world_contract:stage === "planning_new_book" || stage === "planning_book" ? {...readerWorldContract,evidence_paths:["premise","core_conflict","volumes[0].main_conflict"]} : stage === "planning_volume" ? {...readerWorldContract,evidence_paths:["objective","main_conflict","character_change"]} : readerWorldContract,rationale:["目标、冲突与人物变化形成闭环"],warnings:[]};
      await writeFile(output, JSON.stringify(value), "utf8");
      console.log(JSON.stringify({event:"result",status:"SUCCESS",structured_output:value,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}));
      console.log(JSON.stringify({event:"result",result:{status:"SUCCESS",structured_output:value,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}));
      console.log(JSON.stringify({event:"result",result:{status:"SUCCESS",structured_output:value,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}));
    `, "utf8");
    const python = { async submit() { throw new Error("planning preview must not submit workflow"); } } as unknown as PythonBridge;
    store = new StudioStore(root);
    await mkdir(join(store.dataDir, "jobs"), {recursive: true});
    const runner = new AntigravityRunner(root, store, python, {executable: process.execPath, prefixArgs: [fake], autoCorrectionRetries: 0});
    const testAuthorContract = {author_version_id:"test-author-version", profile_hash:"a".repeat(64), is_system:true};
    for (const scope of ["new_book", "book", "volume", "chapter", "chapters"] as const) {
      const batchChapters = [{chapter_number:1,volume_id:"volume-1"},{chapter_number:2,volume_id:"volume-1"}];
      const conversation = [{role:"user",content:`补全 ${scope}`}];
      const context = {
        bookId:"demo", selected: {volume_id: "volume-1", chapter_number: 1}, author_contract:testAuthorContract,
        conversation, conversation_binding:planningConversationBinding(testAuthorContract, conversation, {scope}),
        ...(scope === "book" ? {foundation_contract:null, fresh_foundation:true} : {}),
        ...(scope === "chapters" ? {selected:batchChapters, selectedChapterNumbers:[1,2], chapters:batchChapters, clearSelectedOutline:true} : {}),
      };
      const started = await runner.startPlanning({bookId: scope === "new_book" ? "new-book" : "demo", scope, mode: scope === "chapters" ? "rewrite" : "fill", instruction: `补全 ${scope}`, context});
      await waitForJobs(store!, started.job.runId, (job) => job?.stage === "candidate_blind_review" && job.status === "succeeded");
      const result = await runner.planningResult(started.job.id);
      assert.equal(result.artifact?.stage, `planning_${scope}`);
      assert.equal(result.artifactHash?.length, 64);
      const frozenHashes = store.getJobResult(result.job.id).lineage.planningContextHashes as Record<string, unknown>;
      assert.equal(String(frozenHashes.author_contract_hash || "").length, 64);
      assert.equal(String(frozenHashes.canon_hash || "").length, 64);
      if (scope === "new_book") {
        assert.ok(result.planningDraft?.path.endsWith(".foundation-contract.json"));
        assert.equal(result.planningDraft?.hash.length, 64);
        assert.ok(existsSync(result.planningDraft!.path));
      }
      const proposal = result.artifact?.proposal as Record<string, unknown>;
      assert.ok(scope === "book" ? proposal.synopsis : scope === "chapters" ? Array.isArray(proposal.chapters) && proposal.chapters.length === 2 : proposal.title);
      if (scope !== "new_book") assert.equal((result.artifact?.constraint_delta as Record<string, unknown>)?.base_contract_hash, "");
      if (scope === "book") {
        assert.equal(store.getJobResult(result.job.id).lineage.planningFreshFoundation, true);
        const categories = new Set(((result.artifact?.constraint_delta as Record<string, unknown>)?.changes as Array<Record<string, unknown>>).map((item) => String(item.category)));
        for (const category of ["reader_promise","protagonist_goal","stakes_and_cost","causal_chain","character_constraints","knowledge_boundaries","world_rules","relationship_arc","foreshadowing_plan","pacing_rules","voice_and_platform_rules","forbidden_shortcuts","workflow_acceptance"]) assert.ok(categories.has(category));
      }
      assert.match(result.events.at(-1)?.message || "", /未修改项目文件/);
      assert.equal(existsSync(join(root, "books", "demo", "outlines", "foundation-contract.json")), false, "规划候选不得提前写入正式约束文件");
      if (scope === "chapters") {
        const selectedId = String(store.getJobResult(result.job.id).lineage.selectedJobId || "");
        const selectedJob = store.getJob(selectedId);
        assert.ok(selectedJob);
        await writeFile(selectedJob!.outputPath, JSON.stringify({stage: "planning_chapters", proposal: {chapters: []}}), "utf8");
        await assert.rejects(() => runner.planningResult(result.job.id), /哈希与任务来源链不一致/);
      }
    }
  } finally {
    store?.db.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await removeTempDir(root);
  }
});

test("planning injects only stage author methods and rejects source-style surface imitation", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-planning-author-transfer-"));
  let store: StudioStore | null = null;
  try {
    await mkdir(join(root, "books", "demo"), {recursive: true});
    const fake = join(root, "planning-author-agy.mjs");
    await writeFile(fake, `
      import {readFile,writeFile} from "node:fs/promises";
      process.on("uncaughtException", (error) => { console.error("FAKE_ERROR", error); process.exit(1); });
      const instruction = process.argv[process.argv.indexOf("-p") + 1];
      const output = instruction.match(/UTF-8 JSON 到：(.+)/)[1].trim();
      const taskPath = instruction.match(/完整读取任务文件：(.+)/)[1].trim();
      let task = "";
      try { task = await readFile(taskPath, "utf8"); } catch (error) { console.error("TASK_READ_FAILED", taskPath, String(error)); process.exit(1); }
      const bad = task.includes("生成表层模仿");
      const shallow = task.includes("生成浅层作者映射");
      const isPolish = /planning-polish\\.prompt\\.md/.test(taskPath);
      const isReview = /blind-review\\.prompt\\.md/.test(taskPath);
      const proposal = {chapter_number:4,volume_id:"volume-1",title:bad?"《来源作品》式回声":"钟楼回声",objective:"让主角用错误判断换来一条可核验线索",obstacle:"证词彼此矛盾",change:"主角承认自己的观察盲区",new_information:"钟声与失踪时间并不同步",chapter_hook:"证人说出不可能听见的第十三响",next_first_beat:"核验证人的位置与听觉条件",current_character_goal:"找出证词矛盾的原因",relationship_state:"同伴开始质疑主角的判断",body_information_state:"主角疲惫但信息边界清楚",unresolved_foreshadowing:"第十三响的来源",ending_type:"因果反转",previous_force:"上一章误判代价与未查明线索",target_word_count:2800,problem_tags:["知识边界","错误代价"],causality_check:"误判导致错误行动并产生新证据",boundary_check:"证人只能听见其位置可听见的钟声",consequence_check:"主角失去部分信任但得到线索"};
      const planningAudit = {causality:{passed:true,findings:["误判推动行动与后果"],evidence_paths:["objective","obstacle","change"]},knowledge_boundaries:{passed:true,findings:["证人听觉条件受位置限制"],evidence_paths:["new_information","body_information_state"]},choice_cost_consequence:{passed:true,findings:["误判带来信任代价"],evidence_paths:["causality_check","consequence_check"]},relationship_change:{passed:true,findings:["同伴信任降低"],evidence_paths:["relationship_state"]},foreshadowing:{passed:true,findings:["第十三响保持可核验"],evidence_paths:["unresolved_foreshadowing"]},continuity:{passed:true,findings:["下一拍核验听觉条件"],evidence_paths:["chapter_hook","next_first_beat"]}};
      const readerWorldContract = {reader_promise:"读者获得证词矛盾被逐项核验的推理快感，每次揭示都改变人物关系而非堆设定。",emotional_payoff:"先让主角因误判受挫，再用可核验证据补偿，形成挫败与满足的交替。",world_mechanics:"钟声传播受位置、时间与身体状态限制，任何结论必须通过可观察条件验证。",world_exceptions:"只有记录维护者能补写证词，但必须留下时间戳并承担暴露风险。",author_world_integration:"作者方法把世界规则转为信息差与代价结构，让人物行动后果显影，并用选择代价替代设定说明段。",character_integration:"主角求真的欲望受身份暴露风险限制，身份压力让核证选择同时改变信任、信息边界和下一步危险。",conflicts_and_tradeoffs:"已核验与用户要求及Canon无冲突；保留既有钟声事实。",evidence_paths:["objective","new_information","change"]};
      const polishNote = isPolish ? "；打磨轮进一步把证词矛盾与章末钩子的因果闭合写细" : "";
      const value = isReview
        ? {stage:"candidate_blind_review",source_stage:"planning_chapter",candidates:{
            A:{score:90,blocking_issues:[],strengths:["因果与知识边界闭合"],evidence:["proposal.objective","proposal.unresolved_foreshadowing"],author_transfer:{method_fidelity:90,content_independence:88,originality:86,generic_scaffold_risk:14,surface_imitation_hits:[]},reader_world_quality:{reader_promise:91,world_consistency:90,mechanic_verifiability:89,cost_clarity:88}},
            B:{score:76,blocking_issues:[],strengths:["结构不同"],evidence:["proposal.obstacle"],author_transfer:{method_fidelity:80,content_independence:82,originality:79,generic_scaffold_risk:26,surface_imitation_hits:[]},reader_world_quality:{reader_promise:80,world_consistency:79,mechanic_verifiability:78,cost_clarity:77}}
          },selected:"A",score_gap:14,rationale:["A 的作者方法落地更具体"]}
        : shallow
        ? {stage:"planning_chapter",proposal,planning_audit:planningAudit,constraint_delta:{base_contract_hash:"",changes:[]},reader_world_contract:readerWorldContract,author_application:{adopted:[{rule_id:"method-observation",function:"符合作者",realization:"符合作者风格",proposal_paths:["proposal.objective"],surface_copy_avoided:"不照搬"}],deferred:[{rule_id:"content-injury",reason:"本章冲突不需要通过身体残损制造识别度"}]},originality_audit:{source_specific_echoes:[],generic_serial_scaffold_risks:[],corrective_actions:["让章末钩子由本章证词矛盾因果推出"]},rationale:["错误判断、代价与新信息形成闭环"],warnings:[]}
        : {stage:"planning_chapter",proposal,planning_audit:planningAudit,constraint_delta:{base_contract_hash:"",changes:[]},reader_world_contract:readerWorldContract,author_application:{adopted:[{rule_id:"method-observation",function:"让视角偏差成为本章因果和信息压力发动机",realization:"主角先因观察盲区信任错误证词，导致调查方向偏移；随后用位置、时间和证词的可核验矛盾反推真相，使错误判断直接改变行动与关系" + polishNote,proposal_paths:["proposal.objective","proposal.change","proposal.new_information"],surface_copy_avoided:"只保留观察偏差方法，不使用来源人物、专名、机制或情节骨架，改为钟声时间与听觉位置矛盾"}],deferred:[{rule_id:"content-injury",reason:"本章冲突不需要通过身体残损制造识别度"}]},originality_audit:{source_specific_echoes:[],generic_serial_scaffold_risks:[],corrective_actions:["让章末钩子由本章证词矛盾因果推出"]},rationale:["错误判断、代价与新信息形成闭环"],warnings:[]};
      await writeFile(output, JSON.stringify(value), "utf8");
      console.log(JSON.stringify({event:"result",status:"SUCCESS",structured_output:value,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}));
    `, "utf8");
    store = new StudioStore(root);
    await mkdir(join(store.dataDir, "jobs"), {recursive:true});
    const runner = new AntigravityRunner(root, store, {} as PythonBridge, {executable:process.execPath,prefixArgs:[fake],autoCorrectionRetries:0});
    const authorContract = {
      schema_version:"author-planning-contract-v2",author_version_id:"test-author-version",profile_hash:"a".repeat(64),
      method_rules:[{rule_id:"method-observation",axis:"revelation_and_foreshadowing",transfer_mode:"method",instruction:"让人物观察盲区改变因果链",applies_to:["chapter_design"]}],
      optional_content_tendencies:[{rule_id:"content-injury",axis:"protagonist_engine",transfer_mode:"optional_content_tendency",instruction:"可选身体残损母题",applies_to:["chapter_design"]}],
      provenance:{evidence:[{quote:"SOURCE_LEAK_SHOULD_NEVER_ENTER_PROMPT",character:"来源角色"}]},
    };
    const baseConversation = [{role:"user",content:"重做第四章"}];
    const baseContext = {selected:{chapter_number:4,volume_id:"volume-1"},author_contract:authorContract,conversation:baseConversation,conversation_binding:planningConversationBinding(authorContract, baseConversation)};
    const start = await runner.startPlanning({bookId:"demo",scope:"chapter",mode:"rewrite",instruction:"重做第四章",context:baseContext});
    const dump = () => store!.listJobs(start.job.runId, 100).map((job) => `${job.id.slice(0,12)}:${job.stage}/${store!.getJobResult(job.id).lineage.candidateRole || "-"}/${job.status}${job.error ? ":" + job.error.slice(0,80) : ""}`).join("\n  ");
    await waitForJobs(store!, start.job.runId, (job) => job?.stage === "candidate_blind_review" && ["succeeded","failed"].includes(job.status), 20_000).catch((err) => { throw new Error(`${err.message}\n  JOBS:\n  ${dump()}`); });
    // 等待整个 run 收敛（无双阻塞修复时应全部终结），避免残留运行中的 job 触发"已有任务运行"。
    await waitFor(() => store!.listJobs(start.job.runId, 100).every((job) => !["queued","running"].includes(job.status)), 15_000).catch((err) => {
      const stuck = store!.listJobs(start.job.runId, 100).filter((job) => ["queued","running"].includes(job.status)).map((job) => `${job.id}:${job.stage}:${job.status}:${store!.getJobResult(job.id).lineage.candidateRole || ""}:${job.error || ""}`);
      throw new Error(`run 未收敛: ${err.message} | stuck=${stuck.join(" | ")}`);
    });
    const reviewer = store.listJobs(start.job.runId, 100).find((job) => job.stage === "candidate_blind_review")!;
    assert.equal(reviewer.status, "succeeded", reviewer.error || store.listJobs(start.job.runId, 100).map((job) => `${job.stage}:${job.status}:${job.error || ""}`).join(" | "));
    const polishes = store.listJobs(start.job.runId, 100).filter((job) => store.getJobResult(job.id).lineage.candidateRole === "planning_polish");
    assert.equal(polishes.length, 2, `polish count\n  ${dump()}`);
    assert.ok(polishes.every((job) => job.status === "succeeded"), `polish status\n  ${dump()}`);
    const prompt = await readFile(start.job.promptPath, "utf8");
    assert.doesNotMatch(prompt, /SOURCE_LEAK_SHOULD_NEVER_ENTER_PROMPT/);
    assert.match(prompt, /method-observation/);
    assert.match(prompt, /content-injury/);
    const rules = store.getJobResult(start.job.id).lineage.planningAuthorRules as Array<Record<string, unknown>>;
    assert.deepEqual(rules.map((item) => item.rule_id), ["method-observation", "content-injury"]);

    const badConversation = [{role:"user",content:"生成表层模仿"}];
    const bad = await runner.startPlanning({bookId:"demo",scope:"chapter",mode:"rewrite",instruction:"生成表层模仿",context:{...baseContext,conversation:badConversation,conversation_binding:planningConversationBinding(authorContract, badConversation)}});
    // 单章也走双候选流水线；autoCorrectionRetries=0 时，任何候选被硬校验拒绝都会让 run 收敛，
    // 且不产生盲审、不应用任何产物。这里等待 run 收敛并断言失败候选命中表层拦截原因。
    await waitFor(() => store!.listJobs(bad.job.runId, 100).every((job) => !["queued","running"].includes(job.status)), 15_000);
    const badJobs = store.listJobs(bad.job.runId, 100);
    assert.ok(!badJobs.some((job) => job.stage === "candidate_blind_review"), "表层模仿不得进入盲审");
    const badFailed = badJobs.filter((job) => job.status === "failed").map((job) => job.error || "").join("\n");
    assert.match(badFailed, /表面相似声明|表层/, badFailed);
    assert.ok(!badJobs.some((job) => job.status === "succeeded"), "表层模仿候选不得有成功产物被应用");

    const shallowConversation = [{role:"user",content:"生成浅层作者映射"}];
    const shallow = await runner.startPlanning({bookId:"demo",scope:"chapter",mode:"rewrite",instruction:"生成浅层作者映射",context:{...baseContext,conversation:shallowConversation,conversation_binding:planningConversationBinding(authorContract, shallowConversation)}});
    await waitFor(() => store!.listJobs(shallow.job.runId, 100).every((job) => !["queued","running"].includes(job.status)), 15_000);
    const shallowJobs = store.listJobs(shallow.job.runId, 100);
    assert.ok(!shallowJobs.some((job) => job.stage === "candidate_blind_review"), "浅层映射不得进入盲审");
    const shallowFailed = shallowJobs.filter((job) => job.status === "failed").map((job) => job.error || "").join("\n");
    assert.match(shallowFailed, /深度不足|风格声明/, shallowFailed);
    assert.ok(!shallowJobs.some((job) => job.status === "succeeded"), "浅层映射候选不得有成功产物被应用");
    runner.removeAllListeners();
  } finally {
    store?.db.close();
    await removeTempDir(root);
  }
});

test("book planning author paths resolve proposal fields inside volume arrays", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-planning-author-volume-path-"));
  let store: StudioStore | null = null;
  try {
    await mkdir(join(root, "books", "demo"), {recursive: true});
    const fake = join(root, "planning-author-volume-agy.mjs");
    await writeFile(fake, `
      import {readFile,writeFile} from "node:fs/promises";
      process.on("uncaughtException", (error) => { console.error("FAKE_ERROR", error); process.exit(1); });
      const instruction = process.argv[process.argv.indexOf("-p") + 1];
      const output = instruction.match(/UTF-8 JSON 到：(.+)/)[1].trim();
      const promptFile = instruction.match(/完整读取任务文件：(.+)/)[1].trim();
      try { await readFile(promptFile, "utf8"); } catch (error) { console.error("TASK_READ_FAILED", promptFile, String(error)); process.exit(1); }
      const proposal = {
        synopsis:"旧物店收留失忆少女后，两人追查城市异常。",
        genre:"都市异能/悬疑",
        premise:"边缘人用代价换回被抹除的记忆",
        core_conflict:"个体记忆对抗机构清算",
        ending_direction:"未锁定",
        major_beats:["相遇","结盟","发现坐标"],
        volumes:[{
          volume_id:"volume-1",title:"雨夜卷",objective:"建立同盟并暴露黑伞来源",
          main_conflict:"追捕升级与信任成本互相牵引",
          character_change:"由戒备转为有限信任",
          foreshadowing:"黑伞坐标必须在卷末兑现",
          ending:"两人离城并确认下一处坐标"
        }]
      };
      const planningAudit = {
        causality:{passed:true,findings:["卷目标由核心冲突推动"],evidence_paths:["proposal.premise","proposal.core_conflict","proposal.major_beats"]},
        knowledge_boundaries:{passed:true,findings:["卷内只处理已暴露线索"],evidence_paths:["volumes[0].foreshadowing"]},
        choice_cost_consequence:{passed:true,findings:["追捕升级带来同盟代价"],evidence_paths:["volumes[0].main_conflict"]},
        relationship_change:{passed:true,findings:["关系变化有明确起点与终点"],evidence_paths:["volumes[0].character_change"]},
        foreshadowing:{passed:true,findings:["黑伞坐标卷末兑现"],evidence_paths:["volumes[0].foreshadowing"]},
        continuity:{passed:true,findings:["卷末衔接下一卷"],evidence_paths:["volumes[0].ending"]}
      };
      const isPolish = /planning-polish\.prompt\.md/.test(promptFile);
      const polishNote = isPolish ? "；打磨轮进一步把伏笔兑现窗口与卷目标的因果闭合写细" : "";
      const isReview = /blind-review\.prompt\.md/.test(promptFile);
      const readerWorldContract = {reader_promise:"读者获得卷级伏笔被按期兑现的验证快感，且每次揭示都改变同盟关系。",emotional_payoff:"先让主角因误判付出信任代价，再用可核验坐标补偿，形成挫败与满足交替。",world_mechanics:"记忆能力受身体状态与黑伞坐标限制，每次使用都产生可见损耗并改变追捕强度。",world_exceptions:"只有机构维护者能改写坐标记录，但必须留下时间戳并承担暴露风险。",author_world_integration:"作者方法把世界规则转为信息差与代价结构，让卷末揭示由人物行动后果触发，并用选择代价替代设定说明。",character_integration:"主角保护欲受身份暴露限制，身份压力让每次结盟或拒绝结盟都同时改变信息边界、信任关系和下一卷追捕压力，取舍后必须承担可见后果。",conflicts_and_tradeoffs:"已核验与用户要求及Canon无冲突；保留既有黑伞与记忆规则。",evidence_paths:["premise","core_conflict","volumes[0].main_conflict"]};
      const value = isReview
        ? {stage:"candidate_blind_review",source_stage:"planning_book",candidates:{
            A:{score:90,blocking_issues:[],strengths:["卷目标与伏笔兑现闭合"],evidence:["proposal.volumes[0].foreshadowing"],author_transfer:{method_fidelity:90,content_independence:88,originality:86,generic_scaffold_risk:14,surface_imitation_hits:[]},reader_world_quality:{reader_promise:92,world_consistency:90,mechanic_verifiability:91,cost_clarity:89}},
            B:{score:78,blocking_issues:[],strengths:["结构不同"],evidence:["proposal.volumes[0].main_conflict"],author_transfer:{method_fidelity:80,content_independence:82,originality:79,generic_scaffold_risk:26,surface_imitation_hits:[]},reader_world_quality:{reader_promise:80,world_consistency:79,mechanic_verifiability:78,cost_clarity:77}}
          },selected:"A",score_gap:12,rationale:["A 的伏笔兑现与作者方法落地更具体"]}
        : {
        stage:"planning_book",proposal,planning_audit:planningAudit,
        constraint_delta:{base_contract_hash:"",changes:[]},
        reader_world_contract: readerWorldContract,
        author_application:{adopted:[{
          rule_id:"method-observation",
          function:"让观察偏差成为卷级因果和信任压力发动机",
          realization:"主角先因观察盲区与对方结成错误同盟，使追捕压力升级；随后用黑伞坐标、卷目标和伏笔兑现窗口的可核验矛盾反推真相，把卷末转折变成因果兑现" + polishNote,
          proposal_paths:["proposal.volumes[0].objective","proposal.volumes[0].main_conflict","proposal.volumes[0].foreshadowing"],
          surface_copy_avoided:"只保留观察偏差的方法，不使用来源人物、专名、机制或情节骨架，改为黑伞坐标与卷末兑现"
        }],deferred:[]},
        originality_audit:{source_specific_echoes:[],generic_serial_scaffold_risks:[],corrective_actions:["让卷末坐标由证词矛盾因果推出"]},
        rationale:["卷目标、冲突与伏笔形成闭环"],warnings:[]
      };
      await writeFile(output, JSON.stringify(value), "utf8");
      console.log(JSON.stringify({event:"result",status:"SUCCESS",structured_output:value,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}));
    `, "utf8");
    store = new StudioStore(root);
    await mkdir(join(store.dataDir, "jobs"), {recursive:true});
    const runner = new AntigravityRunner(root, store, {} as PythonBridge, {executable:process.execPath,prefixArgs:[fake],autoCorrectionRetries:0});
    const authorContract = {
      schema_version:"author-planning-contract-v2",author_version_id:"test-author-version",profile_hash:"a".repeat(64),
      method_rules:[{rule_id:"method-observation",axis:"revelation_and_foreshadowing",transfer_mode:"method",instruction:"让人物观察盲区改变因果链",applies_to:["book_design","volume_design"]}],
      optional_content_tendencies:[]
    };
    const bookConversation = [{role:"user",content:"重做书籍方案"}];
    const started = await runner.startPlanning({bookId:"demo",scope:"book",mode:"rewrite",instruction:"重做书籍方案",context:{author_contract:authorContract,conversation:bookConversation,conversation_binding:planningConversationBinding(authorContract, bookConversation,{scope:"book"})}});
    await waitForJobs(store!, started.job.runId, (job) => job?.stage === "candidate_blind_review" && ["succeeded","failed"].includes(job.status), 15_000);
    const reviewer = store.listJobs(started.job.runId, 100).find((job) => job.stage === "candidate_blind_review")!;
    assert.equal(reviewer.status, "succeeded", reviewer.error || store.listJobs(started.job.runId, 100).map((job) => `${job.stage}:${job.status}:${job.error || ""}`).join(" | "));
    const result = await runner.planningResult(reviewer.id);
    assert.equal(result.artifact?.stage, "planning_book");
    const polishes = store.listJobs(started.job.runId, 100).filter((job) => store.getJobResult(job.id).lineage.candidateRole === "planning_polish");
    assert.equal(polishes.length, 2);
    assert.ok(polishes.every((job) => job.status === "succeeded"));
    const polishPrompt = await readFile(polishes[0].promptPath, "utf8");
    assert.match(polishPrompt, /规划深度打磨|第二轮重写/);
    assert.match(polishPrompt, /第一轮草稿/);
    const selectedId = String(store.getJobResult(reviewer.id).lineage.selectedJobId || "");
    assert.equal(store.getJobResult(selectedId).lineage.candidateRole, "planning_polish");
    runner.removeAllListeners();
  } finally {
    store?.db.close();
    await removeTempDir(root);
  }
});

test("reader world contract rejects missing, shallow and ungrounded evidence", async () => {
  const valid = {
    reader_promise:"读者获得证词矛盾被逐项核验的推理快感，每次揭示都改变人物关系而非堆设定。",
    emotional_payoff:"先让主角因误判受挫，再用可核验证据补偿，形成挫败与满足的交替。",
    world_mechanics:"钟声传播受位置、时间与身体状态限制，任何结论必须通过可观察条件验证。",
    world_exceptions:"只有记录维护者能补写证词，但必须留下时间戳并承担暴露风险。",
    author_world_integration:"作者方法把世界规则转为信息差与代价结构，让人物行动后果显影，并用选择代价替代设定说明段。",
    character_integration:"主角求真的欲望受身份暴露风险限制，身份压力让核证选择同时改变信任、信息边界和下一步危险。",
    conflicts_and_tradeoffs:"已核验与用户要求及Canon无冲突；保留既有钟声事实。",
    evidence_paths:["objective","new_information","change"],
  };
  const proposal = {chapter_number:4,volume_id:"volume-1",title:"钟楼回声",objective:"核验证人位置",obstacle:"证词矛盾",change:"主角承认盲区",new_information:"钟声时间矛盾",chapter_hook:"核验位置",next_first_beat:"进入下一场",current_character_goal:"求真相",relationship_state:"信任下降",body_information_state:"疲惫但边界清楚",unresolved_foreshadowing:"第十三响来源",ending_type:"因果反转",previous_force:"上一章误判代价与未决线索",target_word_count:2800,problem_tags:["知识边界"],causality_check:"误判导致行动",boundary_check:"听觉受限",consequence_check:"信任代价"};
  const base = {
    stage:"planning_chapter",proposal,
    planning_audit:Object.fromEntries(["causality","knowledge_boundaries","choice_cost_consequence","relationship_change","foreshadowing","continuity"].map((field) => [field,{passed:true,findings:["核验通过"],evidence_paths:["objective","change"]}])),
    constraint_delta:{base_contract_hash:"",changes:[]},author_application:{adopted:[],deferred:[]},
    originality_audit:{source_specific_echoes:[],generic_serial_scaffold_risks:[],corrective_actions:[]},
    rationale:["依据"],warnings:[],
  };
  const runner = new AntigravityRunner(".", null as never, {} as PythonBridge, {executable:"noop"});
  for (const [name, contract] of [
    ["missing", undefined],
    ["shallow", {...valid,reader_promise:"符合风格",author_world_integration:"世界观完整",character_integration:"读者爽感"}],
    ["insufficient evidence", {...valid,evidence_paths:["objective","new_information"]}],
    ["invalid evidence", {...valid,evidence_paths:["objective","new_information","missing_path"]}],
  ] as Array<[string, Record<string, unknown> | undefined]>) {
    const artifact = {...base,...(contract === undefined ? {} : {reader_world_contract:contract})};
    assert.throws(
      () => (runner as unknown as {validatePlanningArtifactForTest: (stage: string, value: Record<string, unknown>) => void}).validatePlanningArtifactForTest("planning_chapter", artifact),
      /reader_world_contract|引用的方案路径/,
      name,
    );
  }
});

test("method rule with required_unless_user_or_canon_conflict can be deferred", () => {
  const proposal = {chapter_number:4,volume_id:"volume-1",title:"钟楼回声",objective:"核验证人位置",obstacle:"证词矛盾",change:"主角承认盲区",new_information:"钟声时间矛盾",chapter_hook:"核验位置",next_first_beat:"进入下一场",current_character_goal:"求真相",relationship_state:"信任下降",body_information_state:"疲惫但边界清楚",unresolved_foreshadowing:"第十三响来源",ending_type:"因果反转",previous_force:"上一章误判代价与未决线索",target_word_count:2800,problem_tags:["知识边界"],causality_check:"误判导致行动",boundary_check:"听觉受限",consequence_check:"信任代价"};
  const blueprintRule = {rule_id:"blueprint-1",axis:"application_blueprint:chapter_design:1",source_kind:"application_blueprint",transfer_mode:"method",application_requirement:"required_unless_user_or_canon_conflict",instruction:"用代价结构驱动章节",trigger:"进入 chapter_design 规划时",implementation_steps:["用代价结构"],allowed_variations:[],acceptance_tests:["proposal 中存在可定位字段"],avoid:"不得只复述",confidence:100,stability:100,applies_to:["chapter_design"]};
  const artifact = {
    stage:"planning_chapter",proposal,
    planning_audit:Object.fromEntries(["causality","knowledge_boundaries","choice_cost_consequence","relationship_change","foreshadowing","continuity"].map((field) => [field,{passed:true,findings:["核验通过"],evidence_paths:["objective","change"]}])),
    constraint_delta:{base_contract_hash:"",changes:[]},
    reader_world_contract:{reader_promise:"读者获得证词矛盾被逐项核验的推理快感，每次揭示都改变人物关系而非堆设定。",emotional_payoff:"先让主角因误判受挫，再用可核验证据补偿，形成挫败与满足的交替。",world_mechanics:"钟声传播受位置、时间与身体状态限制，任何结论必须通过可观察条件验证。",world_exceptions:"只有记录维护者能补写证词，但必须留下时间戳并承担暴露风险。",author_world_integration:"作者方法把世界规则转为信息差与代价结构，让人物行动后果显影，并用选择代价替代设定说明段。",character_integration:"主角求真的欲望受身份暴露风险限制，身份压力让核证选择同时改变信任、信息边界和下一步危险。",conflicts_and_tradeoffs:"已核验与用户要求及Canon无冲突；保留既有钟声事实。",evidence_paths:["objective","new_information","change"]},
    author_application:{adopted:[],deferred:[{rule_id:"blueprint-1",reason:"与用户明确要求冲突，公开暂缓"}]},
    originality_audit:{source_specific_echoes:[],generic_serial_scaffold_risks:[],corrective_actions:["去换皮"]},
    rationale:["依据"],warnings:[],
  };
  const runner = new AntigravityRunner(".", null as never, {} as PythonBridge, {executable:"noop"});
  const validate = (runner as unknown as {validatePlanningArtifactForTest: (stage: string, value: Record<string, unknown>, authorRules?: Array<Record<string, unknown>>) => void}).validatePlanningArtifactForTest;
  // blueprint 规则 transfer_mode=method 但 application_requirement=required_unless_user_or_canon_conflict，可 deferred，不应抛出"不得暂缓"。
  validate("planning_chapter", artifact, [blueprintRule]);
});

test("fresh foundation rejects an empty or partial contract delta", () => {
  const runner = new AntigravityRunner(".", null as never, {} as PythonBridge, {executable:"noop"});
  const validate = (runner as unknown as {validateFreshFoundationDeltaForTest: (value: Record<string, unknown>) => void}).validateFreshFoundationDeltaForTest;
  assert.throws(
    () => validate({constraint_delta:{base_contract_hash:"",changes:[]}}),
    /不能提交空契约/,
  );
  assert.throws(
    () => validate({constraint_delta:{base_contract_hash:"",changes:[{operation:"add",scope_type:"book",scope_id:"book",category:"reader_promise"}]}}),
    /缺少基础约束类别/,
  );
  assert.throws(
    () => validate({constraint_delta:{base_contract_hash:"a".repeat(64),changes:[{operation:"add",scope_type:"book",scope_id:"book",category:"reader_promise"}]}}),
    /base_contract_hash 必须为空字符串/,
  );
});

test("repair blind review rejects evidence paths missing from the real repair product", () => {
  const runner = new AntigravityRunner(".", null as never, {} as PythonBridge, {executable:"noop"});
  const validate = (runner as unknown as {validateRepairReviewForTest: (value: Record<string, unknown>, stage: string, repairProduct: Record<string, unknown>) => void}).validateRepairReviewForTest;
  const review = {
    stage:"candidate_repair_review",source_stage:"planning_chapter",accepted:true,score:88,
    blocking_issues:[],strengths:["因果阻塞已消除"],evidence:["proposal.objective"],
    author_transfer:{method_fidelity:88,content_independence:90,originality:89,generic_scaffold_risk:10,surface_imitation_hits:[]},
    reader_world_quality:{reader_promise:88,world_consistency:87,mechanic_verifiability:86,cost_clarity:85},
    rationale:["真实修复字段可定位"],
  };
  const repairProduct = {stage:"planning_chapter",proposal:{objective:"让错误判断产生可见代价"},reader_world_contract:{world_mechanics:"钟声传播受距离与身体状态限制"}};
  validate(review, "planning_chapter", repairProduct);
  validate({...review,evidence:["reader_world_contract.world_mechanics"]}, "planning_chapter", repairProduct);
  assert.throws(
    () => validate({...review,evidence:["proposal.nonexistent"]}, "planning_chapter", repairProduct),
    /不存在或为空的路径/,
  );
  assert.throws(
    () => validate(review, "planning_chapter", {}),
    /不存在或为空的路径/,
  );
});

test("two blocked planning candidates are replaced by an automatic third plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-planning-auto-repair-"));
  let store: StudioStore | null = null;
  try {
    await mkdir(join(root, "books", "demo"), {recursive:true});
    const fake = join(root, "planning-repair-agy.mjs");
    await writeFile(fake, `
      import {writeFile} from "node:fs/promises";
      const instruction = process.argv[process.argv.indexOf("-p") + 1];
      const output = instruction.match(/UTF-8 JSON 到：(.+)/)[1].trim();
      const chapter = (title) => ({chapter_number:1,volume_id:"volume-1",title,objective:"找出证词矛盾",obstacle:"现场证据缺失",change:"主角承担误判代价并改变调查方向",new_information:"钟声记录被人为改写",chapter_hook:"第二份记录出现第十三响",next_first_beat:"核验两份记录的生成时间",current_character_goal:"找出记录被改写的原因",relationship_state:"同伴因误判而降低信任",body_information_state:"人物状态与知识边界明确",unresolved_foreshadowing:"第十三响来源",ending_type:"证据反转",previous_force:"误判代价与未决线索继续施压",target_word_count:2800,problem_tags:["因果","知识边界"],causality_check:"误判导致调查方向改变",boundary_check:"主角只使用可获取的记录",consequence_check:"信任下降但线索更明确"});
      const planningAudit = {causality:{passed:true,findings:["误判改变行动"],evidence_paths:["objective","obstacle","change"]},knowledge_boundaries:{passed:true,findings:["信息来源可核验"],evidence_paths:["new_information","body_information_state"]},choice_cost_consequence:{passed:true,findings:["误判付出信任代价"],evidence_paths:["causality_check","consequence_check"]},relationship_change:{passed:true,findings:["同伴信任下降"],evidence_paths:["relationship_state"]},foreshadowing:{passed:true,findings:["第十三响待兑现"],evidence_paths:["unresolved_foreshadowing"]},continuity:{passed:true,findings:["下一拍核验记录时间"],evidence_paths:["chapter_hook","next_first_beat"]}};
      const readerWorldContract = {reader_promise:"读者获得证词矛盾被逐项核验的推理快感，每次揭示都改变人物关系而非堆设定。",emotional_payoff:"先让主角因误判受挫，再用可核验证据补偿，形成挫败与满足交替。",world_mechanics:"钟声传播受位置、时间与身体状态限制，任何结论必须通过可观察条件验证。",world_exceptions:"只有记录维护者能补写证词，但必须留下时间戳并承担暴露风险。",author_world_integration:"作者方法把世界规则转为信息差与代价结构，让人物行动后果显影，并用选择代价替代设定说明段。",character_integration:"主角求真的欲望受身份暴露风险限制，身份压力让核证选择同时改变信任、信息边界和下一步危险。",conflicts_and_tradeoffs:"已核验与用户要求及Canon无冲突；保留既有钟声事实。",evidence_paths:["objective","new_information","change"]};
      let value;
      if (instruction.includes("candidate_repair_review")) value = {stage:"candidate_repair_review",source_stage:"planning_chapter",accepted:true,score:88,blocking_issues:[],strengths:["证据矛盾已进入人物选择"],evidence:["proposal.objective"],author_transfer:{method_fidelity:86,content_independence:90,originality:88,generic_scaffold_risk:12,surface_imitation_hits:[]},reader_world_quality:{reader_promise:88,world_consistency:87,mechanic_verifiability:86,cost_clarity:85},rationale:["原阻塞项已消除"]};
      else if (instruction.includes("candidate_blind_review")) value = {stage:"candidate_blind_review",source_stage:"planning_chapter",candidates:{A:{score:70,blocking_issues:["只是换名，没有因果转译"],strengths:["字段完整"],evidence:["proposal.title"],author_transfer:{method_fidelity:40,content_independence:35,originality:30,generic_scaffold_risk:65,surface_imitation_hits:["表面换皮"]},reader_world_quality:{reader_promise:68,world_consistency:67,mechanic_verifiability:66,cost_clarity:65}},B:{score:68,blocking_issues:["通用模板覆盖用户创意"],strengths:["承接明确"],evidence:["proposal.objective"],author_transfer:{method_fidelity:45,content_independence:40,originality:34,generic_scaffold_risk:70,surface_imitation_hits:["模板化"]},reader_world_quality:{reader_promise:66,world_consistency:65,mechanic_verifiability:64,cost_clarity:63}}},selected:"A",score_gap:2,rationale:["两者均需重写"]};
      else value = {stage:"planning_chapter",proposal:chapter(instruction.includes("planning-automatic-repair.prompt.md")?"钟声记录":"候选章"),planning_audit:planningAudit,reader_world_contract:readerWorldContract,constraint_delta:{base_contract_hash:"",changes:[]},author_application:{adopted:[],deferred:[]},originality_audit:{source_specific_echoes:[],generic_serial_scaffold_risks:[],corrective_actions:["让证据矛盾直接改变人物选择"]},rationale:["证据、误判代价与下一拍闭合"],warnings:[]};
      await writeFile(output, JSON.stringify(value), "utf8");
    `, "utf8");
    store = new StudioStore(root);
    await mkdir(join(store.dataDir, "jobs"), {recursive:true});
    const runner = new AntigravityRunner(root, store, {} as PythonBridge, {executable:process.execPath,prefixArgs:[fake],autoCorrectionRetries:0});
    const systemAuthorContract = {author_version_id:"test-author-version",profile_hash:"a".repeat(64),is_system:true};
    const repairConversation = [{role:"user",content:"重做第一章"}];
    const started = await runner.startPlanning({bookId:"demo",scope:"chapter",mode:"rewrite",instruction:"重做第一章",context:{selected:{chapter_number:1,volume_id:"volume-1"},author_contract:systemAuthorContract,conversation:repairConversation,conversation_binding:planningConversationBinding(systemAuthorContract, repairConversation)}});
    await waitForJobs(store!, started.job.runId, (job) => store!.getJobResult(job.id).lineage.candidateRole === "repair_reviewer" && job.status === "succeeded");
    const result = await runner.planningResult(started.job.id);
    assert.equal((result.artifact?.proposal as Record<string, unknown>)?.title, "钟声记录");
    const repair = store.listJobs(started.job.runId, 20).find((job) => store!.getJobResult(job.id).lineage.candidateRole === "planning_automatic_repair")!;
    const reviewer = store.getJob(String(store.getJobResult(repair.id).lineage.repairOfReviewerId || ""))!;
    assert.equal(store.getJobResult(reviewer.id).validationTrace.status, "planning_automatic_repair_verified");
    assert.equal(store.getJobResult(reviewer.id).lineage.selectedJobId, repair.id);
    runner.removeAllListeners();
  } finally {
    store?.db.close();
    await removeTempDir(root);
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
  } finally { await removeTempDir(value.root); }
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
  } finally { await removeTempDir(value.root); }
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
  } finally { await removeTempDir(root); }
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
  } finally { await removeTempDir(root); }
});

test("a restarted store marks active jobs interrupted instead of claiming success", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-restart-"));
  try {
    const first = new StudioStore(root);
    const job = first.createJob({ runId: "run", bookId: "demo", chapter: 1, stage: "draft", status: "running", promptPath: "prompt", promptHash: "hash", outputPath: "output", retryOf: null });
    const legacyChoice = first.createJob({ runId: "old-run", bookId: "legacy", chapter: 1, stage: "candidate_blind_review", status: "awaiting_choice", promptPath: "prompt", promptHash: "hash", outputPath: "output", retryOf: null });
    first.db.close();
    const second = new StudioStore(root);
    assert.equal(second.getJob(job.id)?.status, "interrupted");
    assert.equal(second.getJob(legacyChoice.id)?.status, "interrupted");
    assert.match(second.getJob(legacyChoice.id)?.error || "", /人工选择已停用/);
    second.db.close();
  } finally { await removeTempDir(root); }
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
  } finally { await removeTempDir(root); }
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
  } finally { await removeTempDir(root); }
});

test("direct workbench agent is isolated and never submits workflow state", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-direct-agent-"));
  try {
    const bookDir = join(root, "books", "demo", "canon");
    await mkdir(bookDir, {recursive: true});
    const sensitivePath = join(bookDir, "story-bible.json");
    await writeFile(sensitivePath, "must-not-be-mounted", "utf8");
    const fake = join(root, "direct-agent-agy.mjs");
    await writeFile(fake, `
      import { writeFile } from "node:fs/promises";
      const instruction = process.argv[process.argv.indexOf("-p") + 1];
      const output = instruction.match(/UTF-8 JSON 到：(.+)/)[1].trim();
      const bookMounted = process.argv.some((item) => item.includes("books\\demo") || item.includes("books/demo"));
      if (bookMounted) throw new Error("book directory must not be mounted for direct agent");
      await writeFile(output, JSON.stringify({
        stage: "workbench_agent",
        summary: "帮助用户返工第一章",
        reasoning: ["用户要求改善章节质量"],
        actions: [{type: "rework_chapter", bookId: "demo", chapter: 1, feedback: "强化人物声音", autoRun: false}],
        warnings: []
      }), "utf8");
    `, "utf8");
    let submits = 0;
    const python = { async submit() { submits += 1; return {value: {status: "completed"}}; } } as unknown as PythonBridge;
    const store = new StudioStore(root);
    await mkdir(join(store.dataDir, "jobs"), {recursive: true});
    const runner = new AntigravityRunner(root, store, python, {executable: process.execPath, prefixArgs: [fake]});
    const job = await runner.agent.start("请帮我返工第一章", {bookId: "demo"});
    await waitFor(() => store.getJob(job.id)?.status === "succeeded", 8_000);
    assert.equal(submits, 0);
    const result = await runner.agent.result(job.id);
    assert.equal(result.artifact?.actions.length, 1);
    assert.equal(store.getAgentPlan(job.id), null);
    store.db.close();
  } finally { await removeTempDir(root); }
});

test("invalid direct agent plan fails closed and cannot be confirmed", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-direct-invalid-"));
  try {
    const fake = join(root, "invalid-agent-agy.mjs");
    await writeFile(fake, `
      import { writeFile } from "node:fs/promises";
      const instruction = process.argv[process.argv.indexOf("-p") + 1];
      const output = instruction.match(/UTF-8 JSON 到：(.+)/)[1].trim();
      await writeFile(output, JSON.stringify({stage: "workbench_agent", actions: [{type: "delete_everything"}]}), "utf8");
    `, "utf8");
    const python = {} as unknown as PythonBridge;
    const store = new StudioStore(root);
    await mkdir(join(store.dataDir, "jobs"), {recursive: true});
    const runner = new AntigravityRunner(root, store, python, {executable: process.execPath, prefixArgs: [fake], autoCorrectionRetries: 0});
    const job = await runner.agent.start("随便给个危险计划", {bookId: "demo"});
    await waitFor(() => store.getJob(job.id)?.status === "failed", 8_000);
    assert.match(store.getJob(job.id)?.error || "", /代理计划缺少 summary|动作不被允许/);
    const result = await runner.agent.result(job.id);
    assert.equal(result.artifact, null);
    store.db.close();
  } finally { await removeTempDir(root); }
});

test("dual critical-stage candidates are isolated, blindly reviewed, and only the winner is submitted", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-candidates-"));
  const stageDir = join(root, "books", "demo", "workflow", "run-dual", "chapter-0001");
  await mkdir(stageDir, {recursive: true});
  const promptPath = join(stageDir, "story_foundation.prompt.md");
  await writeFile(promptPath, "stage story_foundation\nlocked canon and contract", "utf8");
  const fake = join(root, "fake-dual-agy.mjs");
  await writeFile(fake, `
    import {writeFile} from "node:fs/promises";
    const instruction = process.argv[process.argv.indexOf("-p") + 1];
    const output = instruction.match(/UTF-8 JSON 到：(.+)/)[1].trim();
    let value;
    if (instruction.includes("candidate_blind_review")) value = {
      stage:"candidate_blind_review", source_stage:"story_foundation",
      candidates:{A:{score:91,blocking_issues:[],strengths:["因果清晰"],evidence:["candidate"],author_transfer:{method_fidelity:90,content_independence:91,originality:88,generic_scaffold_risk:10,surface_imitation_hits:[]},reader_world_quality:{reader_promise:90,world_consistency:89,mechanic_verifiability:88,cost_clarity:87}},B:{score:74,blocking_issues:[],strengths:["新鲜"],evidence:["candidate"],author_transfer:{method_fidelity:75,content_independence:82,originality:80,generic_scaffold_risk:22,surface_imitation_hits:[]},reader_world_quality:{reader_promise:80,world_consistency:79,mechanic_verifiability:78,cost_clarity:77}}},
      selected:"A", score_gap:17, rationale:["A 在相同契约下更可执行"]
    };
    else value = {stage:"story_foundation", candidate: instruction.includes(".A.prompt.md") ? "A" : "B"};
    await writeFile(output, JSON.stringify(value), "utf8");
  `, "utf8");
  let submitted = "";
  const python = {
    async workflowStatus() { return {value: {run_id: "run-dual", book_id: "demo", status: "running", current_stage: "story_foundation"}}; },
    async nextAction() { return {value: {run_id: "run-dual", book_id: "demo", chapter: 1, stage: "story_foundation", status: "running", prompt_path: promptPath, output_schema: {type: "object"}, action_id: "action-dual", inputs_hash: "inputs", candidate_mode: "dual_blind"}}; },
    async submit(_runId: string, file: string, actionId: string) {
      assert.equal(actionId, "action-dual");
      submitted = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8")).candidate;
      return {value: {status: "completed"}};
    },
  } as unknown as PythonBridge;
  const store = new StudioStore(root);
  await mkdir(join(store.dataDir, "jobs"), {recursive: true});
  const runner = new AntigravityRunner(root, store, python, {executable: process.execPath, prefixArgs: [fake], autoCorrectionRetries: 0});
  try {
    await runner.startContinuous("run-dual");
    await waitFor(() => store.listJobs("run-dual", 10).some((item) => item.stage === "candidate_blind_review" && item.status === "succeeded"), 10_000);
    assert.equal(submitted, "A");
    const jobs = store.listJobs("run-dual", 10);
    assert.equal(jobs.filter((item) => item.stage === "story_foundation" && item.status === "succeeded").length, 2);
    const reviewer = jobs.find((item) => item.stage === "candidate_blind_review")!;
    assert.equal(store.getJobResult(reviewer.id).validationTrace.selection, "automatic");
    assert.equal(store.getJobResult(reviewer.id).lineage.selectedCandidate, "A");
  } finally {
    runner.removeAllListeners();
    store.db.close();
    await removeTempDir(root);
  }
});

test("blind review strips producer self-claims and rejects low-originality high-risk candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-blind-thresholds-"));
  const stageDir = join(root, "books", "demo", "workflow", "run-thresholds", "chapter-0001");
  await mkdir(stageDir, {recursive:true});
  const promptPath = join(stageDir, "story_foundation.prompt.md");
  await writeFile(promptPath, "locked foundation task", "utf8");
  const fake = join(root, "fake-thresholds-agy.mjs");
  await writeFile(fake, `
    import {readFile,writeFile} from "node:fs/promises";
    const instruction = process.argv[process.argv.indexOf("-p") + 1];
    const output = instruction.match(/UTF-8 JSON 到：(.+)/)[1].trim();
    let value;
    if (instruction.includes("candidate_blind_review")) {
      const taskPath = instruction.match(/完整读取任务文件：(.+)/)[1].trim();
      const task = await readFile(taskPath, "utf8");
      if (task.includes("LEAKED_SELF_")) throw new Error("producer self-claim leaked into blind review");
      value = {stage:"candidate_blind_review",source_stage:"story_foundation",candidates:{A:{score:96,blocking_issues:[],strengths:["表面完整"],evidence:["candidate"],author_transfer:{method_fidelity:92,content_independence:45,originality:30,generic_scaffold_risk:78,surface_imitation_hits:[]},reader_world_quality:{reader_promise:91,world_consistency:90,mechanic_verifiability:89,cost_clarity:88}},B:{score:82,blocking_issues:[],strengths:["因果独立"],evidence:["candidate"],author_transfer:{method_fidelity:84,content_independence:88,originality:86,generic_scaffold_risk:18,surface_imitation_hits:[]},reader_world_quality:{reader_promise:85,world_consistency:84,mechanic_verifiability:83,cost_clarity:82}}},selected:"A",score_gap:14,rationale:["A 分数更高"]};
    } else {
      const candidate = instruction.includes(".A.prompt.md") ? "A" : "B";
      value = {stage:"story_foundation",candidate,...(candidate === "A" ? {author_application:{claim:"LEAKED_SELF_APPLICATION"},rationale:["LEAKED_SELF_RATIONALE"],originality_audit:{claim:"LEAKED_SELF_ORIGINALITY"}} : {})};
    }
    await writeFile(output, JSON.stringify(value), "utf8");
  `, "utf8");
  let submitted = "";
  const python = {
    async workflowStatus() { return {value:{run_id:"run-thresholds",book_id:"demo",status:"running",current_stage:"story_foundation"}}; },
    async nextAction() { return {value:{run_id:"run-thresholds",book_id:"demo",chapter:1,stage:"story_foundation",status:"running",prompt_path:promptPath,output_schema:{type:"object"},action_id:"action-thresholds",candidate_mode:"dual_blind"}}; },
    async submit(_runId:string, file:string) { submitted = JSON.parse(await readFile(file,"utf8")).candidate; return {value:{status:"completed"}}; },
  } as unknown as PythonBridge;
  const store = new StudioStore(root);
  await mkdir(join(store.dataDir,"jobs"),{recursive:true});
  const runner = new AntigravityRunner(root,store,python,{executable:process.execPath,prefixArgs:[fake],autoCorrectionRetries:0});
  try {
    await runner.startContinuous("run-thresholds");
    await waitFor(() => submitted === "B", 10_000);
    const reviewer = store.listJobs("run-thresholds",20).find((item) => item.stage === "candidate_blind_review")!;
    const decision = store.getJobResult(reviewer.id).publicDecision as Record<string, any>;
    assert.ok(decision.candidates.A.blocking_issues.some((item:string) => /原创性|脚手架|独立性/.test(item)));
    assert.doesNotMatch(await readFile(reviewer.promptPath,"utf8"), /LEAKED_SELF_/);
  } finally {
    runner.removeAllListeners(); store.db.close(); await removeTempDir(root);
  }
});

test("ungrounded Canon evidence is corrected in place without stopping the workflow", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-canon-correct-"));
  try {
    const bookDir = join(root, "books", "demo");
    await mkdir(bookDir, {recursive: true});
    const promptPath = join(bookDir, "canon_update.prompt.md");
    await writeFile(promptPath, "canon update with current final draft", "utf8");
    const fake = join(root, "canon-correct-agy.mjs");
    await writeFile(fake, `
      import { writeFile } from "node:fs/promises";
      const instruction = process.argv[process.argv.indexOf("-p") + 1];
      const output = instruction.match(/UTF-8 JSON 到：(.+)/)[1].trim();
      const evidence = instruction.includes("evidence_not_grounded") ? "最终正文中的逐字引文" : "对最终正文的概括";
      await writeFile(output, JSON.stringify({stage:"canon_update",facts:["事实"],character_states:["状态"],relationships:["关系"],open_threads:["悬念"],foreshadowing:["伏笔"],evidence:[evidence]}), "utf8");
    `, "utf8");
    let submits = 0;
    const python = {
      async workflowStatus() { return {value: {run_id: "run-canon", book_id: "demo", status: "running", current_stage: "canon_update"}}; },
      async nextAction() { return {value: {run_id: "run-canon", book_id: "demo", chapter: 1, stage: "canon_update", status: "running", prompt_path: promptPath, action_id: "action-canon", output_schema: {stage: "canon_update", evidence: ["最终正文原文"]}}}; },
      async submit(_runId: string, file: string) {
        submits += 1;
        const artifact = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8"));
        return artifact.evidence[0] === "最终正文中的逐字引文"
          ? {value: {status: "completed"}}
          : {value: {status: "error", error_code: "evidence_not_grounded", failure_class: "evidence", field_path: "evidence[0]", expected: "exact quote from current final draft", actual: artifact.evidence[0], message: "Canon evidence 必须逐条原样引用当前最终正文", retryable: true}};
      },
    } as unknown as PythonBridge;
    const store = new StudioStore(root);
    await mkdir(join(store.dataDir, "jobs"), {recursive: true});
    const runner = new AntigravityRunner(root, store, python, {executable: process.execPath, prefixArgs: [fake], autoCorrectionRetries: 2});
    await runner.startContinuous("run-canon");
    await waitFor(() => store.listJobs("run-canon").some((job) => job.status === "succeeded"), 8_000);
    const jobs = store.listJobs("run-canon").reverse();
    assert.deepEqual(jobs.map((job) => job.status), ["failed", "succeeded"]);
    assert.equal(submits, 2);
    assert.match(jobs[0].error, /evidence\[0\]/);
    assert.ok(store.listEvents(jobs[0].id, 0).some((event) => /定向重试/.test(event.message)));
    store.db.close();
  } finally { await removeTempDir(root); }
});

test("a close blind-review score is automatically resolved without user selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-candidate-choice-"));
  const stageDir = join(root, "books", "demo", "workflow", "run-choice", "chapter-0001");
  await mkdir(stageDir, {recursive: true});
  const promptPath = join(stageDir, "chapter_design.prompt.md");
  await writeFile(promptPath, "stage chapter_design", "utf8");
  const fake = join(root, "fake-choice-agy.mjs");
  await writeFile(fake, `
    import {writeFile} from "node:fs/promises";
    const instruction = process.argv[process.argv.indexOf("-p") + 1];
    const output = instruction.match(/UTF-8 JSON 到：(.+)/)[1].trim();
    const value = instruction.includes("candidate_blind_review")
      ? {stage:"candidate_blind_review",source_stage:"chapter_design",candidates:{A:{score:82,blocking_issues:[],strengths:["稳"],evidence:["candidate"],author_transfer:{method_fidelity:84,content_independence:85,originality:80,generic_scaffold_risk:18,surface_imitation_hits:[]},reader_world_quality:{reader_promise:86,world_consistency:85,mechanic_verifiability:84,cost_clarity:83}},B:{score:78,blocking_issues:[],strengths:["新"],evidence:["candidate"],author_transfer:{method_fidelity:80,content_independence:86,originality:84,generic_scaffold_risk:20,surface_imitation_hits:[]},reader_world_quality:{reader_promise:82,world_consistency:81,mechanic_verifiability:80,cost_clarity:79}}},selected:"A",score_gap:4,rationale:["A 略优且无需用户仲裁"]}
      : {stage:"chapter_design",candidate:instruction.includes(".A.prompt.md")?"A":"B"};
    await writeFile(output, JSON.stringify(value), "utf8");
  `, "utf8");
  let submitted = "";
  const python = {
    async workflowStatus() { return {value: {run_id: "run-choice", book_id: "demo", status: "running", current_stage: "chapter_design"}}; },
    async nextAction() { return {value: {run_id: "run-choice", book_id: "demo", chapter: 1, stage: "chapter_design", status: "running", prompt_path: promptPath, output_schema: {type: "object"}, action_id: "action-choice", candidate_mode: "dual_blind"}}; },
    async submit(_runId: string, file: string) { submitted = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8")).candidate; return {value: {status: "completed"}}; },
  } as unknown as PythonBridge;
  const store = new StudioStore(root);
  await mkdir(join(store.dataDir, "jobs"), {recursive: true});
  const runner = new AntigravityRunner(root, store, python, {executable: process.execPath, prefixArgs: [fake], autoCorrectionRetries: 0});
  try {
    await runner.startContinuous("run-choice");
    await waitFor(() => store.listJobs("run-choice", 10).some((item) => item.stage === "candidate_blind_review" && item.status === "succeeded"), 10_000);
    assert.equal(submitted, "A");
    const reviewer = store.listJobs("run-choice", 10).find((item) => item.stage === "candidate_blind_review")!;
    assert.equal(store.getJob(reviewer.id)?.status, "succeeded");
    assert.equal(store.getJobResult(reviewer.id).validationTrace.selection, "automatic");
  } finally {
    runner.removeAllListeners(); store.db.close(); await removeTempDir(root);
  }
});

test("two blocked workflow candidates trigger an automatic third repair candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-candidate-repair-"));
  const stageDir = join(root, "books", "demo", "workflow", "run-repair", "chapter-0001");
  await mkdir(stageDir, {recursive: true});
  const promptPath = join(stageDir, "chapter_design.prompt.md");
  await writeFile(promptPath, "stage chapter_design\nlocked contract", "utf8");
  const fake = join(root, "fake-repair-agy.mjs");
  await writeFile(fake, `
    import {writeFile} from "node:fs/promises";
    const instruction = process.argv[process.argv.indexOf("-p") + 1];
    const output = instruction.match(/UTF-8 JSON 到：(.+)/)[1].trim();
    let value;
    if (instruction.includes("candidate_repair_review")) value = {stage:"candidate_repair_review",source_stage:"chapter_design",accepted:true,score:89,blocking_issues:[],strengths:["动机缺口已补齐"],evidence:["candidate"],author_transfer:{method_fidelity:86,content_independence:90,originality:88,generic_scaffold_risk:10,surface_imitation_hits:[]},reader_world_quality:{reader_promise:88,world_consistency:87,mechanic_verifiability:86,cost_clarity:85},rationale:["修复候选可独立执行"]};
    else if (instruction.includes("candidate_blind_review")) value = {stage:"candidate_blind_review",source_stage:"chapter_design",candidates:{A:{score:71,blocking_issues:["动机缺口"],strengths:["结构稳"],evidence:["candidate"],author_transfer:{method_fidelity:72,content_independence:78,originality:70,generic_scaffold_risk:30,surface_imitation_hits:[]},reader_world_quality:{reader_promise:82,world_consistency:81,mechanic_verifiability:80,cost_clarity:79}},B:{score:68,blocking_issues:["知识越界"],strengths:["新鲜"],evidence:["candidate"],author_transfer:{method_fidelity:70,content_independence:80,originality:76,generic_scaffold_risk:28,surface_imitation_hits:[]},reader_world_quality:{reader_promise:79,world_consistency:78,mechanic_verifiability:77,cost_clarity:76}}},selected:"A",score_gap:3,rationale:["A 更适合作为修复基稿"]};
    else if (instruction.includes("automatic-repair.prompt.md")) value = {stage:"chapter_design",candidate:"REPAIRED"};
    else value = {stage:"chapter_design",candidate:instruction.includes(".A.prompt.md")?"A":"B"};
    await writeFile(output, JSON.stringify(value), "utf8");
  `, "utf8");
  let submitted = "";
  const python = {
    async workflowStatus() { return {value: {run_id:"run-repair",book_id:"demo",status:"running",current_stage:"chapter_design"}}; },
    async nextAction() { return {value: {run_id:"run-repair",book_id:"demo",chapter:1,stage:"chapter_design",status:"running",prompt_path:promptPath,output_schema:{type:"object"},action_id:"action-repair",candidate_mode:"dual_blind"}}; },
    async submit(_runId: string, file: string) { submitted = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8")).candidate; return {value:{status:"completed"}}; },
  } as unknown as PythonBridge;
  const store = new StudioStore(root);
  await mkdir(join(store.dataDir, "jobs"), {recursive:true});
  const runner = new AntigravityRunner(root, store, python, {executable:process.execPath,prefixArgs:[fake],autoCorrectionRetries:0});
  try {
    await runner.startContinuous("run-repair");
    await waitFor(() => submitted === "REPAIRED", 10_000);
    const reviewer = store.listJobs("run-repair", 20).find((item) => item.stage === "candidate_blind_review")!;
    assert.equal(store.getJobResult(reviewer.id).validationTrace.status, "automatic_repair_verified_and_accepted");
    assert.ok(store.listJobs("run-repair", 20).some((item) => store.getJobResult(item.id).lineage.candidateRole === "automatic_repair" && item.status === "succeeded"));
    assert.ok(store.listJobs("run-repair", 20).some((item) => store.getJobResult(item.id).lineage.candidateRole === "repair_reviewer" && item.status === "succeeded"));
  } finally {
    runner.removeAllListeners(); store.db.close(); await removeTempDir(root);
  }
});
