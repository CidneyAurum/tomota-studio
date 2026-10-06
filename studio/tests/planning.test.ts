import assert from "node:assert/strict";
import {test} from "node:test";

import {dedupeAuthorPlanningInputs, selectAuthorPolicyPlanningInputs, selectFoundationSnapshotInputs} from "../server/author-contract.js";
import {applyPlanningProposal, currentPlanningConversationEpoch, planningFoundationContractHash, planningSnapshotFromContext, planningSnapshotFromPayload, planningSnapshotHashes, planningCanonicalJson, preparePlanningConversation} from "../server/planning.js";

const chapters = [
  {chapter_number: 1, volume_id: "volume-1", title: "一", objective: "旧目标"},
  {chapter_number: 2, volume_id: "volume-1", title: "二", objective: "旧目标二"},
  {chapter_number: 3, volume_id: "volume-1", title: "三", objective: "边界"},
];

test("empty foundation contract uses one shared bootstrap hash convention", () => {
  assert.equal(planningFoundationContractHash(null), "");
  assert.equal(planningFoundationContractHash({}), "");
  assert.equal(planningFoundationContractHash({contract_hash:"a".repeat(64),active_constraints:[{rule:"已锁定"}]}), "a".repeat(64));
  assert.equal(planningFoundationContractHash({active_constraints:[{rule:"旧版无嵌入哈希"}]}).length, 64);
});

test("rewrite planning keeps author requirements but never re-injects old AI candidates", () => {
  const prepared = preparePlanningConversation([
    {role: "user", text: "主角是青少年学生"},
    {role: "assistant", text: "旧方案采用海港钟楼", proposal: {premise: "白渡港与天象钟腔"}},
    {role: "user", text: "女主是异邦非人少女"},
    {role: "assistant", text: "旧方案继续扩展", proposal: {ability: "应力视界"}},
  ], "重做当前全书方案", "rewrite");

  assert.equal(prepared.policy, "user_requirements_only");
  assert.deepEqual(prepared.conversation, [
    {role: "user", text: "主角是青少年学生"},
    {role: "user", text: "女主是异邦非人少女"},
    {role: "user", text: "重做当前全书方案"},
  ]);
  assert.equal(prepared.discardedAssistantTurns, 2);
  assert.doesNotMatch(JSON.stringify(prepared.conversation), /白渡港|天象钟腔|应力视界/);
});

test("an explicit fresh-start instruction creates a new context epoch", () => {
  const instruction = "故事不要受先前的影响，重新建造；但保留我在本条里重新写明的青少年主角要求";
  const prepared = preparePlanningConversation([
    {role: "user", text: "旧要求：使用港口"},
    {role: "assistant", text: "旧候选", proposal: {premise: "海雾港口与第十三响仪式"}},
  ], instruction, "rewrite");

  assert.equal(prepared.policy, "fresh_start");
  assert.deepEqual(prepared.conversation, [{role: "user", text: instruction}]);
  assert.equal(prepared.discardedEarlierTurns, 2);
  assert.doesNotMatch(JSON.stringify(prepared.conversation), /海雾港口|第十三响仪式/);
});

test("a persisted fresh-start epoch keeps earlier requirements and candidates out of later turns", () => {
  const history = [
    {role: "user" as const, text: "旧要求：海港与声学钟楼"},
    {role: "assistant" as const, text: "旧候选", proposal: {premise: "天象钟腔"}},
    {role: "user" as const, text: "不要受先前方案影响，从零开始；主角保留为青少年"},
    {role: "assistant" as const, text: "新纪元候选", proposal: {premise: "新的城市怪谈"}},
  ];
  assert.deepEqual(currentPlanningConversationEpoch(history), history.slice(2));

  const laterRewrite = preparePlanningConversation(history, "再重做一次人物关系", "rewrite");
  assert.deepEqual(laterRewrite.conversation, [
    {role: "user", text: "不要受先前方案影响，从零开始；主角保留为青少年"},
    {role: "user", text: "再重做一次人物关系"},
  ]);
  assert.doesNotMatch(JSON.stringify(laterRewrite.conversation), /海港|声学钟楼|天象钟腔/);

  const laterFill = preparePlanningConversation(history, "把新方案的关系压力补清楚", "fill");
  assert.match(JSON.stringify(laterFill.conversation), /新的城市怪谈/);
  assert.doesNotMatch(JSON.stringify(laterFill.conversation), /海港|声学钟楼|天象钟腔/);
});

test("fill planning may continue a visible candidate without promoting it to Canon", () => {
  const proposal = {premise: "当前未保存候选"};
  const prepared = preparePlanningConversation([
    {role: "user", text: "先做一个方向"},
    {role: "assistant", text: "候选如下", proposal},
  ], "把人物动机补清楚", "fill");

  assert.equal(prepared.policy, "continue");
  assert.deepEqual(prepared.conversation[1], {role: "assistant", text: "候选如下", proposal});
  assert.equal(prepared.conversation.at(-1)?.text, "把人物动机补清楚");
});

test("author policy planning inputs do not let an empty design_rules array hide active rules", () => {
  const selected = selectAuthorPolicyPlanningInputs({
    author_binding: {author_id: "author-1", version_id: "author-1-v2", version_number: 2, profile_hash: "a".repeat(64)},
    author_book_contract: {author_version_id: "author-1-v2", profile_hash: "a".repeat(64), design_rules: [], application_blueprint: {book_design: ["从人物选择推出因果"]}},
    active_rules: [{id: "rule-active", rule: "让人物选择产生可见代价", applies_to: ["book_design"]}],
    style_profile: {rules: [{id: "rule-style", rule: "不应抢先于 active_rules", applies_to: ["book_design"]}]},
  });
  assert.equal(selected.metadata.author_version_id, "author-1-v2");
  assert.deepEqual(selected.values, [{id: "rule-active", rule: "让人物选择产生可见代价", applies_to: ["book_design"]}]);
  assert.deepEqual(selected.blueprint, {book_design: ["从人物选择推出因果"]});
});

test("legacy foundation author-book snapshot preserves design rules, blueprint and binding lineage", () => {
  const selected = selectFoundationSnapshotInputs({
    schema_version: "author-book-contract-v1",
    author_book_contract: {
      design_rules: [{id: "legacy-rule", writing_instruction: "让错误判断改变后续行动", applies_to: ["chapter_design"]}],
      application_blueprint: {chapter_design: ["每章明确选择、代价与下一拍"]},
      author_version_id: "author-legacy-v3",
      profile_hash: "b".repeat(64),
    },
  }, {author_id: "author-legacy", version_id: "author-legacy-v3", version_number: 3});
  assert.equal(selected.metadata.author_id, "author-legacy");
  assert.equal(selected.metadata.author_version_id, "author-legacy-v3");
  assert.equal(selected.metadata.profile_hash, "b".repeat(64));
  assert.equal(selected.values.length, 1);
  assert.deepEqual(selected.blueprint, {chapter_design: ["每章明确选择、代价与下一拍"]});
});

test("duplicate author rules are removed only when their executable identity matches", () => {
  const values = [
    {id: "rule-1", axis: "scene_causality", rule: "让选择产生代价", applies_to: ["chapter_design"]},
    {id: "rule-1-copy", axis: "scene_causality", rule: "让选择产生代价", applies_to: ["chapter_design"], implementation_steps: ["先列出选择"]},
    {id: "rule-2", axis: "scene_causality", rule: "让错误判断改变后续行动", applies_to: ["chapter_design"]},
  ];
  assert.equal(dedupeAuthorPlanningInputs(values).length, 2);
});

test("planning snapshot freezes form, outline, selected ids and batch boundaries", () => {
  const snapshot = planningSnapshotFromContext("chapters", "rewrite", {
    book: {title: "书", metadata: {author: "作者", synopsis: "简介", genre: "悬疑", completion_mode: "open_ended"}},
    master: {completion_mode: "open_ended", premise: "核", volumes: [{volume_id: "volume-1", title: "第一卷"}], rolling_plan: {window_size: 5, planned_through: 3}},
    chapters,
    selectedChapterNumbers: [2, 1],
    boundaries: {previous: null, next: chapters[2]},
    clearSelectedOutline: true,
  });
  assert.deepEqual(snapshot.selected_ids, {level: "chapters", ids: [1, 2]});
  assert.deepEqual(snapshot.selected_chapter_numbers, [1, 2]);
  assert.equal((snapshot.state as Record<string, any>).chapters.length, 3);
  assert.equal(((snapshot.boundaries as Record<string, any>).next as Record<string, any>).chapter_number, 3);
  assert.equal(planningSnapshotHashes(snapshot).planning_source_hash.length, 64);
});

test("planning proposal application is limited to the frozen scope", () => {
  const snapshot = planningSnapshotFromContext("chapters", "rewrite", {
    book: {title: "书"}, master: {volumes: [{volume_id: "volume-1", title: "第一卷"}]}, chapters,
    selectedChapterNumbers: [1, 2], boundaries: {previous: null, next: chapters[2]}, clearSelectedOutline: true,
  });
  const next = applyPlanningProposal(snapshot, "chapters", {chapters: [
    {chapter_number: 1, volume_id: "volume-1", title: "新一", objective: "新目标"},
    {chapter_number: 2, volume_id: "volume-1", title: "新二", objective: "新目标二"},
    {chapter_number: 3, volume_id: "volume-1", title: "越权", objective: "不能覆盖"},
  ]});
  const rows = (next.state as Record<string, any>).chapters as Array<Record<string, any>>;
  assert.deepEqual(rows.map((item) => item.title), ["新一", "新二", "三"]);
});

test("payload snapshot matches the exact candidate result and changes when a form field drifts", () => {
  const context = {
    book: {title: "书", synopsis: "简介"},
    master: {premise: "旧核", volumes: [{volume_id: "volume-1", title: "第一卷"}]}, chapters,
    selected: {chapter_number: 1, volume_id: "volume-1"},
  };
  const frozen = planningSnapshotFromContext("chapter", "rewrite", context);
  const expected = applyPlanningProposal(frozen, "chapter", {chapter_number: 1, volume_id: "volume-1", title: "新一", objective: "新目标"});
  const selected = expected.selected_ids;
  const payload = planningSnapshotFromPayload({
    book: {title: "书", synopsis: "简介"},
    master: expected.state && (expected.state as Record<string, any>).master,
    chapters: expected.state && (expected.state as Record<string, any>).chapters,
  }, "chapter", "rewrite", {selected_ids: selected, selected_chapter_numbers: [], boundaries: {previous: null, next: null}, clear_selected_outline: false});
  assert.equal(planningCanonicalJson(payload), planningCanonicalJson(expected));
  const drifted = {...payload, state: {...payload.state as Record<string, any>, master: {...(payload.state as Record<string, any>).master, premise: "手动改动"}}};
  assert.notEqual(planningCanonicalJson(drifted), planningCanonicalJson(expected));
});

test("snapshot replay follows the persisted synopsis fallback for an empty premise", () => {
  const frozen = planningSnapshotFromContext("chapter", "rewrite", {
    book: {title: "书", synopsis: "简介"},
    master: {premise: ""},
    chapters: [{chapter_number: 1, volume_id: "volume-1", title: "旧章"}],
    selected: {chapter_number: 1, volume_id: "volume-1"},
  });
  const expected = applyPlanningProposal(frozen, "chapter", {title: "新章", chapter_number: 1, volume_id: "volume-1"});
  const payload = planningSnapshotFromPayload({
    book: {title: "书", synopsis: "简介"},
    master: {...(expected.state as Record<string, any>).master, premise: ""},
    chapters: (expected.state as Record<string, any>).chapters,
  }, "chapter", "rewrite", {
    selected_ids: expected.selected_ids,
    selected_chapter_numbers: [],
    boundaries: {previous: null, next: null},
    clear_selected_outline: false,
  });
  assert.equal((payload.state as Record<string, any>).master.premise, "简介");
  assert.equal(planningCanonicalJson(payload), planningCanonicalJson(expected));
});

test("payload snapshot preserves explicit batch clear authorization", () => {
  const frozen = planningSnapshotFromContext("chapters", "rewrite", {
    book: {title: "书", synopsis: "简介"},
    master: {premise: "故事核"},
    chapters: [{chapter_number: 1, volume_id: "volume-1", title: "旧章"}, {chapter_number: 2, volume_id: "volume-1", title: "旧章二"}],
    selectedChapterNumbers: [1, 2],
    boundaries: {previous: null, next: null},
    clearSelectedOutline: true,
  });
  const expected = applyPlanningProposal(frozen, "chapters", {chapters: [
    {chapter_number: 1, volume_id: "volume-1", title: "新章"},
    {chapter_number: 2, volume_id: "volume-1", title: "新章二"},
  ]});
  const payload = planningSnapshotFromPayload({
    book: {title: "书", synopsis: "简介"},
    master: expected.state && (expected.state as Record<string, any>).master,
    chapters: expected.state && (expected.state as Record<string, any>).chapters,
  }, "chapters", "rewrite", {
    selected_ids: expected.selected_ids,
    selected_chapter_numbers: expected.selected_chapter_numbers,
    boundaries: expected.boundaries,
    clear_selected_outline: true,
  });
  assert.equal((payload as Record<string, any>).clear_selected_outline, true);
  assert.equal(planningCanonicalJson(payload), planningCanonicalJson(expected));
});
