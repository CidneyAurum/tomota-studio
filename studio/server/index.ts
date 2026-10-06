import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";

import { AntigravityRunner, relevantPlanningAuthorRules, foundationIncompleteCategories, validateFoundationCompletionDelta } from "./antigravity.js";
import { dedupeAuthorPlanningInputs, selectAuthorPlanningStages, selectAuthorPolicyPlanningInputs, selectFoundationSnapshotInputs } from "./author-contract.js";
import { FanqieBrowserService, fanqieWriteWindow } from "./fanqie.js";
import { applyPlanningProposal, currentPlanningConversationEpoch, planningFoundationContractHash, planningSnapshotFromContext, planningSnapshotFromPayload, planningSnapshotHashes, planningCanonicalJson, preparePlanningConversation } from "./planning.js";
import { collectReviewFindings, listProjectFiles, readProjectFile, saveProjectFile } from "./projects.js";
import { PythonBridge } from "./python.js";
import { readJsonObjectBody as body } from "./request-body.js";
import { assertFeedbackSnapshot, validateReworkInstruction } from "./reader-feedback.js";
import { SnapshotGuard } from "./snapshot-guard.js";
import { recoveryDiagnostics } from "./runtime-recovery.js";
import { initializeAuthorLayerBackup, initializeWorkspace, StudioStore } from "./store.js";
import { ModelProviderService } from "./model-providers.js";
import type { AgentExecutionResult, PlanningConversationMessage, ReaderFeedbackRecord } from "./types.js";

const PLANNING_STAGES = new Set(["planning_new_book", "planning_book", "planning_volume", "planning_chapter", "planning_chapters"]);

const root = resolve(process.env.TOMOTA_ROOT || join(import.meta.dirname, "..", ".."));
const studioDir = resolve(import.meta.dirname, "..");
const buildId: string = createRequire(import.meta.url)(join(studioDir, "../scripts/runtime_identity.cjs")).runtimeBuildId(resolve(studioDir, ".."), import.meta.filename.endsWith(".ts"));
const distDir = join(studioDir, "dist");
const development = process.env.npm_lifecycle_event === "dev" || !existsSync(join(distDir, "index.html"));
const uiPort = Number(process.env.TOMOTA_STUDIO_PORT || 43127);
const apiPort = Number(process.env.TOMOTA_STUDIO_API_PORT || 43128);
const port = development ? apiPort : uiPort;
const host = "127.0.0.1";
// Only desktop-owned services require this per-launch secret. It is never
// exposed to renderer JavaScript, written to disk or added to a URL.
const desktopToken = process.env.TOMOTA_DESKTOP_TOKEN || "";

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function canonicalJsonHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

const store = new StudioStore(root);
const migration = await initializeWorkspace(store);
const authorLayerBackup = await initializeAuthorLayerBackup(store);
const python = new PythonBridge(root);
// Pending recovery must not prevent opening the diagnostics UI. Indexing and
// legacy imports are writes and remain deferred until recovery + restart.
const startupRecoveryPending = await recoveryDiagnostics(root, python.python)
  .then(value => value.entries.length > 0).catch(() => true);
if (!startupRecoveryPending) {
  await python.run(["studio-index", "--json"]);
  const indexedProjects = (await python.listProjects()).value;
  for (const project of indexedProjects) {
    const fromStudio = store.listAuthorPreferences(project.id) as unknown as Array<Record<string, unknown>>;
    const legacyPath = join(root, "books", project.id, "canon", "author-preferences.json");
    let fromFile: Array<Record<string, unknown>> = [];
    if (existsSync(legacyPath)) {
      try {
        const value = JSON.parse(await readFile(legacyPath, "utf8")) as unknown;
        if (Array.isArray(value)) fromFile = value.filter((item): item is Record<string, unknown> => Boolean(item) && !Array.isArray(item) && typeof item === "object");
      } catch { fromFile = []; }
    }
    if (fromStudio.length || fromFile.length) await python.importAuthorOverrides(project.id, [...fromStudio, ...fromFile]);
  }
}
const agyPrefix = (() => {
  try { return JSON.parse(process.env.TOMOTA_AGY_PREFIX_ARGS || "[]") as string[]; } catch { return []; }
})();
const modelProviders = new ModelProviderService(store);
const runner = new AntigravityRunner(root, store, python, { prefixArgs: agyPrefix, modelProviders });
const fanqie = new FanqieBrowserService(root, store, python);
const snapshotGuard = new SnapshotGuard();
let lastProjectRefresh = 0;
let projectRefresh: Promise<unknown> | null = null;

async function agentContext(bookId?: string): Promise<Record<string, unknown>> {
  const projects = await projectSummaries();
  const selected = bookId ? projects.find((item) => String(item.id) === bookId) : projects[0];
  if (!selected) return {projects: [], activeProject: null, antigravity: runner.status(), authorPreferences: []};
  const activeProject = {
    id: selected.id,
    title: selected.title,
    chapterCount: selected.chapterCount,
    approvedCount: selected.approvedCount,
    blockedCount: selected.blockedCount,
    activeJob: selected.activeJob,
    latestWorkflow: selected.latestWorkflow,
  };
  const findings = await collectReviewFindings(root, String(selected.id));
  const openFindings = findings.filter((item) => String(item.status || "open") === "open").slice(0, 30).map((item) => ({
    gate: String(item.gate || "review"), category: String(item.category || "未分类"),
    location: String(item.location || ""), quote: String(item.quote || ""), repairRequirement: String(item.repair_requirement || ""),
  }));
  return {
    projects: projects.map((item) => ({id: item.id, title: item.title, chapterCount: item.chapterCount, activeJob: item.activeJob})),
    activeProject,
    openFindings,
    authorPreferences: (((await python.authorOverrides(String(selected.id))).value.overrides || []) as Array<Record<string, unknown>>).map((item) => ({category: item.category, rule: item.rule, enabled: item.enabled})),
    antigravity: runner.status(),
    recentFeedback: store.listWorkflowFeedback(String(selected.latestWorkflow?.run_id || selected.latestWorkflow?.id || ""), 10).map((item) => ({stage: item.stage, chapter: item.chapter, content: item.content})),
  };
}

async function refreshProjectIndex(force = false): Promise<void> {
  if (!force && Date.now() - lastProjectRefresh < 2_000) return;
  if (!projectRefresh) {
    projectRefresh = python.refreshProjects().then(() => { lastProjectRefresh = Date.now(); }).finally(() => { projectRefresh = null; });
  }
  await projectRefresh;
}

function publicWritingPolicy(value: unknown): Record<string, unknown> | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const policy = structuredClone(value) as Record<string, unknown>;
  delete policy.provenance;
  delete policy.source_samples;
  const style = policy.style_profile;
  if (style && !Array.isArray(style) && typeof style === "object") {
    delete (style as Record<string, unknown>).provenance;
    delete (style as Record<string, unknown>).source_samples;
  }
  return policy;
}

const OPTIONAL_AUTHOR_CONTENT_AXES = new Set([
  "protagonist_engine", "relationship_dynamics", "story_promise", "ending_hook", "genre_tendency",
]);

function abstractAuthorRuleText(value: unknown): string {
  return String(value || "")
    .replace(/[（(](?:如|例如|比如|譬如|e\.g\.)[^）)]*[）)]/gi, "")
    .replace(/(?:例如|比如|譬如)[:：]?[^。；;]{2,80}(?=[。；;]|$)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Preserve the deep distillation fields (evidence_ids / counter-examples /
// non-applicable cases / failure modes / cross-dimension links / transfer
// verdict) that prove a rule is grounded.  Both the original style_dimensions
// (transfer_test.verdict) and the compiled active_rules (transfer_verdict)
// shapes are accepted, so a rule is never silently stripped of its evidence
// when it crosses the planning boundary.
function deepRuleFields(item: Record<string, unknown>): Record<string, unknown> {
  const asStrings = (value: unknown): string[] =>
    Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  const transfer = item.transfer_test;
  const transferVerdict = transfer && !Array.isArray(transfer) && typeof transfer === "object"
    ? String((transfer as Record<string, unknown>).verdict || "")
    : String(item.transfer_verdict || "");
  const links = Array.isArray(item.links)
    ? item.links.map((link) => {
        if (!link || Array.isArray(link) || typeof link !== "object") return null;
        const o = link as Record<string, unknown>;
        return {dimension_id: String(o.dimension_id || ""), relation: String(o.relation || "")};
      }).filter(Boolean)
    : [];
  return {
    evidence_ids: asStrings(item.evidence_ids),
    counterevidence_ids: asStrings(item.counterevidence_ids),
    failure_modes: asStrings(item.failure_modes).map(abstractAuthorRuleText).filter(Boolean),
    non_applicable_cases: asStrings(item.non_applicable_cases).map(abstractAuthorRuleText).filter(Boolean),
    transfer_verdict: transferVerdict,
    links,
  };
}

function compactAuthorPlanningRules(values: unknown): Array<Record<string, unknown>> {
  const rows = Array.isArray(values)
    ? values.filter((item): item is Record<string, unknown> => Boolean(item) && !Array.isArray(item) && typeof item === "object")
    : [];
  const preferred = new Map<string, {score: number; value: Record<string, unknown>; axis: string; instruction: string; appliesTo: string[]}>();
  for (const item of rows) {
    // Older/manual author versions may omit applies_to.  Python's policy
    // compiler treats an omitted or empty scope as broadly applicable; for
    // planning we conservatively default it to the three design stages so a
    // valid author rule is not silently dropped before generation.
    const appliesTo = selectAuthorPlanningStages(item.applies_to);
    if (!appliesTo.length) continue;
    const instruction = abstractAuthorRuleText(item.writing_instruction || item.rule);
    if (!instruction) continue;
    const axis = String(item.axis || item.category || item.id || "uncategorized").trim();
    const score = (item.axis ? 100 : 0)
      + (Array.isArray(item.implementation_steps) ? item.implementation_steps.length : 0)
      + (Array.isArray(item.acceptance_tests) ? item.acceptance_tests.length : 0);
    const signature = canonicalJsonHash({axis, instruction, appliesTo: [...appliesTo].sort()});
    const current = preferred.get(signature);
    if (!current || score > current.score) preferred.set(signature, {score, value: item, axis, instruction, appliesTo});
  }
  return [...preferred.values()].map((entry) => {
    const item = entry.value;
    const axis = entry.axis;
    const instruction = entry.instruction;
    const declaredRequirement = String(item.application_requirement || "").trim().toLowerCase();
    const explicitlyOptional = ["optional", "contextual", "should", "optional_content_tendency"].includes(declaredRequirement);
    const explicitlyRequired = ["required", "must", "method"].includes(declaredRequirement);
    const deferrableOnConflict = declaredRequirement === "required_unless_user_or_canon_conflict";
    const transferMode = explicitlyOptional || (!explicitlyRequired && !deferrableOnConflict && OPTIONAL_AUTHOR_CONTENT_AXES.has(axis))
      ? "optional_content_tendency"
      : deferrableOnConflict ? "method_unless_conflict" : "method";
    return {
      rule_id: String(item.id || `author-rule-${canonicalJsonHash({axis, instruction}).slice(0, 16)}`),
      axis,
      transfer_mode: transferMode,
      application_requirement: transferMode === "method" ? "required" : transferMode === "method_unless_conflict" ? "required_unless_conflict" : "optional",
      instruction,
      trigger: abstractAuthorRuleText(item.trigger),
      implementation_steps: Array.isArray(item.implementation_steps) ? item.implementation_steps.map(abstractAuthorRuleText).filter(Boolean) : [],
      allowed_variations: Array.isArray(item.allowed_variations) ? item.allowed_variations.map(abstractAuthorRuleText).filter(Boolean) : [],
      acceptance_tests: Array.isArray(item.acceptance_tests) ? item.acceptance_tests.map(abstractAuthorRuleText).filter(Boolean) : [],
      avoid: abstractAuthorRuleText(item.avoid),
      confidence: Number(item.confidence || 0),
      stability: Number(item.stability || 0),
      applies_to: entry.appliesTo,
      ...deepRuleFields(item),
    };
  });
}

const AUTHOR_BLUEPRINT_FIELDS = ["book_design", "volume_design", "chapter_design"] as const;

function compactAuthorBlueprintRules(value: unknown): Array<Record<string, unknown>> {
  if (!value || Array.isArray(value) || typeof value !== "object") return [];
  const blueprint = value as Record<string, unknown>;
  return AUTHOR_BLUEPRINT_FIELDS.flatMap((stage) => {
    const rows = Array.isArray(blueprint[stage]) ? blueprint[stage] as unknown[] : [];
    return rows.map(abstractAuthorRuleText).filter(Boolean).map((instruction, index) => ({
      rule_id: `author-blueprint-${canonicalJsonHash({stage, instruction}).slice(0, 16)}`,
      axis: `application_blueprint:${stage}:${index + 1}`,
      source_kind: "application_blueprint",
      transfer_mode: "method",
      application_requirement: "required_unless_user_or_canon_conflict",
      instruction,
      trigger: `进入 ${stage} 规划时`,
      implementation_steps: [instruction],
      allowed_variations: [],
      acceptance_tests: [`proposal 中必须存在可定位字段，证明已执行：${instruction}`],
      avoid: "不得只在说明文字中复述这条方法而不改变方案字段",
      confidence: 100,
      stability: 100,
      applies_to: [stage],
    }));
  });
}

function buildAuthorPlanningContract(metadata: Record<string, unknown>, values: unknown, blueprint: unknown = {}): Record<string, unknown> {
  const rows = Array.isArray(values) ? values : [];
  const rules = [...compactAuthorPlanningRules(dedupeAuthorPlanningInputs(rows)), ...compactAuthorBlueprintRules(blueprint)];
  return {
    schema_version: "author-planning-contract-v2",
    author_version_id: metadata.author_version_id || metadata.id || null,
    author_id: metadata.author_id || null,
    version_number: metadata.version_number || null,
    profile_hash: metadata.profile_hash || null,
    is_system: Boolean(metadata.is_system) || String(metadata.author_id || "") === "system-legacy-author",
    method_rules: rules.filter((item) => item.transfer_mode === "method" || item.transfer_mode === "method_unless_conflict"),
    optional_content_tendencies: rules.filter((item) => item.transfer_mode === "optional_content_tendency"),
    transfer_protocol: {
      authority: "用户题材、已确认故事事实、Canon 与人物边界决定写什么；作者契约决定如何观察、组织、揭示和表达。",
      method_rule: "方法规则必须转译为本书自己的因果、场景和信息组织，不得复制来源作品的名词、人物、意象组合、机制或情节骨架。",
      content_rule: "题材与人物母题只作为可选倾向；仅在与用户创意自然相合时采用，不得为了证明作者符合度强塞原罪、残损、契约、特定终局等标志物。",
      originality_rule: "不得出现‘某作品式’‘精准还原’‘复刻作者’等表层模仿声明；不得把多个辨识度母题成套堆入同一方案。",
      reporting_rule: "逐条说明采用、转译或暂缓的规则，并引用 proposal 的真实字段；只写符合不算落实。",
    },
    precedence: "用户明确要求、Canon、已确认基础契约和人物知识边界 > 作者方法规则 > 可选内容倾向。",
  };
}

function authorPlanningContract(version: Record<string, unknown>): Record<string, unknown> {
  const profile = version.profile && !Array.isArray(version.profile) && typeof version.profile === "object" ? version.profile as Record<string, unknown> : {};
  const storyDesign = profile.story_design && !Array.isArray(profile.story_design) && typeof profile.story_design === "object" ? profile.story_design as Record<string, unknown> : {};
  const bookArch = profile.book_architecture && !Array.isArray(profile.book_architecture) && typeof profile.book_architecture === "object" ? profile.book_architecture as Record<string, unknown> : {};
  const dimensions = Array.isArray(profile.style_dimensions) ? profile.style_dimensions as Array<Record<string, unknown>> : [];
  const dimensionById = new Map(dimensions.map((item) => [String(item?.id || ""), item]));
  const resolveMethods = (value: unknown): unknown[] => Array.isArray(value) ? value.flatMap((item) => {
    if (!item || Array.isArray(item) || typeof item !== "object") return [item];
    const reference = String((item as Record<string, unknown>).dimension_id || "");
    return reference && dimensionById.has(reference) ? [dimensionById.get(reference)!] : [item];
  }) : [];
  const values = [
    ...(Array.isArray(profile.rules) ? profile.rules : []),
    ...dimensions,
    ...resolveMethods(storyDesign.worldbuilding_mechanics),
    ...resolveMethods(storyDesign.character_design_mechanics),
    ...resolveMethods(bookArch.volume),
    ...resolveMethods(bookArch.chapter),
    ...resolveMethods(bookArch.scene),
    ...resolveMethods(bookArch.serial),
  ];
  return buildAuthorPlanningContract(version, values, profile.application_blueprint);
}

function authorPlanningContractFromPolicy(value: unknown): Record<string, unknown> {
  const policy = publicWritingPolicy(value) || {};
  const selected = selectAuthorPolicyPlanningInputs(policy);
  return buildAuthorPlanningContract(selected.metadata, selected.values, selected.blueprint);
}

function planningAuthorBinding(value: unknown): Record<string, unknown> | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const binding = value as Record<string, unknown>;
  return Object.fromEntries([
    "book_id", "author_id", "version_id", "version_number", "version_status", "profile_hash", "is_system", "bound_at", "updated_at",
  ].filter((key) => binding[key] !== undefined).map((key) => [key, binding[key]]));
}

type AuthorPolicyProject = {
  book?: Record<string, unknown>;
  chapters?: Array<Record<string, unknown>>;
  workflows?: Array<Record<string, unknown>>;
  author_binding?: Record<string, unknown> | null;
  writing_policy?: Record<string, unknown> | null;
};

function authorPolicyMatchesBinding(policyValue: unknown, binding: Record<string, unknown>): boolean {
  const policy = publicWritingPolicy(policyValue);
  if (!policy) return false;
  const snapshot = policy.author_binding && !Array.isArray(policy.author_binding) && typeof policy.author_binding === "object"
    ? policy.author_binding as Record<string, unknown> : {};
  const contract = policy.author_book_contract && !Array.isArray(policy.author_book_contract) && typeof policy.author_book_contract === "object"
    ? policy.author_book_contract as Record<string, unknown> : null;
  if (!contract) return false;
  const isSystem = Boolean(binding.is_system) || String(binding.author_id || "") === "system-legacy-author";
  const selected = selectAuthorPolicyPlanningInputs(policy);
  const selectedMetadata = selected.metadata;
  const hasExecutableAuthorRule = [...compactAuthorPlanningRules(selected.values), ...compactAuthorBlueprintRules(selected.blueprint)].length > 0;
  // A bound non-system author must never silently fall back to a policy whose
  // rule payload was lost during an older migration.  Force recompilation so
  // the current profile is used, and let ensureAuthorPolicy fail closed if it
  // genuinely contains no planning rule.
  if (!isSystem && !hasExecutableAuthorRule) return false;
  return Boolean(
    contract
    && Array.isArray(policy.active_rules)
    && String(snapshot.version_id || "") === String(binding.version_id || "")
    && String(snapshot.profile_hash || "") === String(binding.profile_hash || "")
    && String(selectedMetadata.author_version_id || contract.author_version_id || "") === String(binding.version_id || "")
    && String(selectedMetadata.profile_hash || contract.profile_hash || "") === String(binding.profile_hash || ""),
  );
}

async function ensureAuthorPolicy(bookId: string, purpose: string): Promise<{project: AuthorPolicyProject; binding: Record<string, unknown>; policy: Record<string, unknown>; contract: Record<string, unknown>; repaired: boolean}> {
  let project = (await python.project(bookId)).value as AuthorPolicyProject;
  const binding = project.author_binding;
  if (!binding) throw new Error(`${purpose}前置校验失败：作品尚未绑定作者版本`);
  let repaired = false;
  if (!authorPolicyMatchesBinding(project.writing_policy, binding)) {
    const compiled = (await python.compileAuthorPolicy(bookId)).value as {policy?: Record<string, unknown>; binding?: Record<string, unknown>};
    project = {...project, writing_policy: compiled.policy || null, author_binding: compiled.binding || binding};
    repaired = true;
  }
  const currentBinding = project.author_binding || binding;
  if (!authorPolicyMatchesBinding(project.writing_policy, currentBinding)) {
    throw new Error(`${purpose}前置校验失败：作者绑定与 CompiledWritingPolicy 的版本或哈希不一致，已拒绝在错误约束下生成`);
  }
  const policy = publicWritingPolicy(project.writing_policy)!;
  const contract = authorPlanningContractFromPolicy(policy);
  const ruleCount = [contract.method_rules, contract.optional_content_tendencies]
    .flatMap((value) => Array.isArray(value) ? value : []).length;
  const isCompatibility = Boolean(currentBinding.is_system) || String(currentBinding.author_id || "") === "system-legacy-author";
  if (!isCompatibility && ruleCount === 0) {
    throw new Error(`${purpose}前置校验失败：已绑定的作者版本没有任何可执行作者规则；系统不会再静默跳过作者契约`);
  }
  return {project, binding: currentBinding, policy, contract, repaired};
}

function publicFoundationContract(value: unknown): Record<string, unknown> | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const contract = structuredClone(value) as Record<string, unknown>;
  if (contract.author_binding_snapshot) contract.author_binding_snapshot = planningAuthorBinding(contract.author_binding_snapshot);
  const snapshot = contract.author_contract_snapshot;
  if (snapshot && !Array.isArray(snapshot) && typeof snapshot === "object") {
    const raw = snapshot as Record<string, unknown>;
    if (raw.schema_version !== "author-planning-contract-v2") {
      const selected = selectFoundationSnapshotInputs(raw, contract.author_binding_snapshot);
      contract.author_contract_snapshot = buildAuthorPlanningContract(selected.metadata, selected.values, selected.blueprint);
    }
  }
  return contract;
}

function planningConversationForJob(jobId: string): ({bookId: string; scopeType: PlanningConversationMessage["scopeType"]; scopeId: string; anchorJobId: string} | null) {
  const direct = store.planningConversationScopeForJob(jobId);
  if (direct) return {...direct, anchorJobId: jobId};
  const job = store.getJob(jobId);
  const relatedJobs = job ? store.listJobs(job.runId, 100) : store.listJobsForBook(jobId, 200).filter((item) => PLANNING_STAGES.has(item.stage) || item.stage === "candidate_blind_review");
  for (const related of relatedJobs) {
    const scope = store.planningConversationScopeForJob(related.id);
    if (scope) return {...scope, anchorJobId: related.id};
  }
  if (job) {
    // 回退优先用 lineage 里的真实规划层级，而不是候选任务统一的 bookId scopeId。
    const lineage = store.getJobResult(job.id).lineage;
    const planningScope = String(lineage.planningScope || "");
    const scopeType = (planningScope || (PLANNING_STAGES.has(job.stage) ? job.stage.replace("planning_", "") : "book")) as PlanningConversationMessage["scopeType"];
    let scopeId = String(job.scopeId || job.bookId);
    const snapshot = lineage.planningContextSnapshot;
    const selected = snapshot && !Array.isArray(snapshot) && typeof snapshot === "object" ? (snapshot as Record<string, unknown>).selected_ids : null;
    const selectedRecord = selected && !Array.isArray(selected) && typeof selected === "object" ? selected as Record<string, unknown> : {};
    if (planningScope === "chapters") {
      const ids = Array.isArray(selectedRecord.ids) ? selectedRecord.ids.map(String).sort((left, right) => Number(left) - Number(right)) : [];
      if (ids.length) scopeId = ids.join(",");
    } else if (planningScope === "volume" || planningScope === "chapter") {
      const id = String(selectedRecord.id || "");
      if (id) scopeId = id;
    }
    return {bookId: job.bookId, scopeType, scopeId, anchorJobId: job.id};
  }
  return null;
}

async function persistPlanningAssistantMessage(jobId: string): Promise<boolean> {
  const conversation = planningConversationForJob(jobId);
  if (!conversation) return false;
  let artifact: Record<string, unknown> | null = null;
  try {
    const result = await runner.planningResult(jobId);
    if (result.job.status === "succeeded" && result.artifact?.proposal) artifact = result.artifact;
  } catch {
    const source = store.getJob(jobId);
    const sourceIsPlanningJob = Boolean(source && /^planning_(new_book|book|volume|chapter|chapters)$/.test(source.stage));
    const relatedJobs = source ? store.listJobs(source.runId, 100) : store.listJobsForBook(conversation.bookId, 200);
    const latest = relatedJobs.find((item) => item.stage === "candidate_blind_review" && item.status === "succeeded");
    const selectedId = latest ? String(store.getJobResult(latest.id).lineage.selectedJobId || "") : "";
    const selected = selectedId ? store.getJob(selectedId) : sourceIsPlanningJob ? source : null;
    if (!selected || selected.status !== "succeeded" || !/^planning_(new_book|book|volume|chapter|chapters)$/.test(selected.stage) || !existsSync(selected.outputPath)) return false;
    const raw = await readFile(selected.outputPath, "utf8");
    const hash = createHash("sha256").update(raw).digest("hex");
    if (selected.outputHash && selected.outputHash !== hash) return false;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || !(parsed as Record<string, unknown>).proposal) return false;
    artifact = parsed as Record<string, unknown>;
  }
  if (!artifact?.proposal) return false;
  const rationale = Array.isArray(artifact.rationale) ? artifact.rationale.map(String).join("\n") : "候选规划已生成。";
  const warnings = Array.isArray(artifact.warnings) ? artifact.warnings.map(String) : [];
  store.savePlanningMessage({
    bookId: conversation.bookId,
    scopeType: conversation.scopeType,
    scopeId: conversation.scopeId,
    role: "assistant",
    text: rationale,
    proposal: artifact.proposal as Record<string, unknown>,
    warnings,
    jobId: conversation.anchorJobId,
  });
  return true;
}

function explicitFullScopeRequest(content: string): boolean {
  const normalized = content.replace(/\s+/g, " ");
  if (/(?:不要|无需|不必|禁止).{0,8}(?:全文|全部|所有|全章|全书).{0,8}(?:重写|重修|重构|回炉)/.test(normalized)) return false;
  return /(?:(?:全文|全篇|全书|全部|所有|现有|已有|前\s*\d+\s*章).{0,18}(?:审查|检查|重写|重修|重构|回炉)|(?:完全|全部).{0,8}(?:重构|重写|重修).{0,12}(?:\d+\s*章|章节|现有|已有))/.test(normalized);
}

async function bindingAudit(bookId: string): Promise<Record<string, unknown>> {
  const detail = (await python.project(bookId)).value as {
    author_binding?: Record<string, unknown> | null;
    writing_policy?: Record<string, unknown> | null;
    workflows?: Array<Record<string, unknown>>;
  };
  const binding = detail.author_binding || null;
  const compiledPolicy = publicWritingPolicy(detail.writing_policy);
  const latest = detail.workflows?.[0] || null;
  let activeWorkflowPolicy: Record<string, unknown> | null = null;
  if (latest?.id) {
    const frozenPath = join(root, "books", bookId, "workflow", id(String(latest.id), "工作流编号"), "writing-policy.json");
    if (existsSync(frozenPath)) {
      try {
        const frozen = publicWritingPolicy(JSON.parse(await readFile(frozenPath, "utf8")));
        activeWorkflowPolicy = frozen ? {
          workflow_id: latest.id,
          workflow_status: latest.status,
          policy_hash: frozen.policy_hash,
          author_binding: frozen.author_binding,
        } : null;
      } catch { activeWorkflowPolicy = null; }
    }
  }
  const activeVersionId = String((activeWorkflowPolicy?.author_binding as Record<string, unknown> | undefined)?.version_id || "");
  const boundVersionId = String(binding?.version_id || "");
  const running = String(latest?.status || "") === "running";
  const effectState = !binding ? "unbound" : running && activeVersionId === boundVersionId
    ? "active_and_next" : running ? "next_workflow_only" : "next_workflow";
  const policyIntegrity = !binding ? "unbound" : authorPolicyMatchesBinding(compiledPolicy, binding) ? "valid" : "repair_required";
  return {binding, compiledPolicy, activeWorkflowPolicy, effectState, policyIntegrity};
}

async function readerFeedbackContext(bookId: string, scopeType: "book" | "volume" | "chapter", scopeId: string, thread: ReaderFeedbackRecord[] = []): Promise<{context: Record<string, unknown>; eligibleChapters: number[]; manifest: Record<string, unknown>}> {
  const prepared = await ensureAuthorPolicy(bookId, "读后反馈评估");
  const detail = prepared.project;
  const outline = (await python.outline(bookId)).value as {master?: Record<string, unknown>; chapters?: Array<Record<string, unknown>>};
  const contracts = (outline.chapters || []).map((raw) => (raw.contract && typeof raw.contract === "object" ? raw.contract : raw) as Record<string, unknown>);
  const scopedContracts = scopeType === "book" ? contracts
    : scopeType === "volume" ? contracts.filter((item) => String(item.volume_id || "volume-1") === scopeId)
    : contracts.filter((item) => Number(item.chapter_number) === Number(scopeId));
  if (!scopedContracts.length) throw new Error(scopeType === "book" ? "作品还没有章节规划" : "反馈范围不存在或没有章节");
  const earliestScopeChapter = Math.min(...scopedContracts.map((item) => Number(item.chapter_number)).filter(Number.isFinite));
  const assessmentContracts = scopeType === "book" ? scopedContracts : contracts.filter((item) => Number(item.chapter_number) >= earliestScopeChapter);
  const allowedStatus = new Set(["approved", "reviewed_pending_approval", "scheduled", "submitted", "published", "draft_unreviewed", "legacy_unreviewed", "modified_after_review", "invalidated"]);
  const rows = detail.chapters || [];
  const currentFeedback = thread.at(-1) || null;
  const fullScope = currentFeedback?.reviewMode === "full_scope";
  const generated: Array<Record<string, unknown>> = [];
  const eligibleContractCount = assessmentContracts.filter((contract) => {
    const chapterNumber = Number(contract.chapter_number);
    const row = rows.find((item) => Number(item.chapter_number) === chapterNumber);
    const bodyPath = join(root, "books", bookId, "drafts", `chapter-${String(chapterNumber).padStart(4, "0")}.md`);
    return Boolean(row && allowedStatus.has(String(row.status || "")) && existsSync(bodyPath));
  }).length;
  const excerptAllowance = Math.max(600, Math.min(20_000, Math.floor(120_000 / Math.max(1, eligibleContractCount))));
  for (const contract of assessmentContracts) {
    const chapterNumber = Number(contract.chapter_number);
    const row = rows.find((item) => Number(item.chapter_number) === chapterNumber);
    const bodyPath = join(root, "books", bookId, "drafts", `chapter-${String(chapterNumber).padStart(4, "0")}.md`);
    if (!row || !allowedStatus.has(String(row.status || "")) || !existsSync(bodyPath)) continue;
    const body = await readFile(bodyPath, "utf8");
    const headLength = Math.floor(excerptAllowance * 0.65);
    const excerpt = fullScope || body.length <= excerptAllowance ? body : `${body.slice(0, headLength)}\n\n[中段因上下文上限省略]\n\n${body.slice(-(excerptAllowance - headLength))}`;
    generated.push({
      chapter_number: chapterNumber, title: contract.title, status: row.status, contract, body: excerpt,
      body_truncated: !fullScope && body.length > excerptAllowance,
      body_hash: createHash("sha256").update(body).digest("hex"), excerpt_hash: createHash("sha256").update(excerpt).digest("hex"),
    });
  }
  const eligibleChapters = generated.map((item) => Number(item.chapter_number));
  const volume = scopeType === "volume"
    ? ((outline.master?.volumes as Array<Record<string, unknown>> | undefined) || []).find((item) => String(item.volume_id) === scopeId) || null
    : null;
  const canonPath = join(root, "books", bookId, "canon", "current.json");
  let canon: Record<string, unknown> = {};
  if (existsSync(canonPath)) {
    try { canon = JSON.parse(await readFile(canonPath, "utf8")) as Record<string, unknown>; } catch { canon = {}; }
  }
  const feedbackThread = thread.map((item) => ({
    feedback_id: item.id, sequence: item.sequence, content: item.content, status: item.status,
    review_mode: item.reviewMode,
    previous_evaluation: {
      verdict: item.evaluation.verdict, summary: item.evaluation.summary, affected_chapters: item.evaluation.affected_chapters,
      preserve: item.evaluation.preserve, changes: item.evaluation.changes, risks: item.evaluation.risks,
      clarification_questions: item.evaluation.clarification_questions,
    },
  }));
  const context: Record<string, unknown> = {
    book: detail.book || {}, master_outline: outline.master || {}, scope_type: scopeType, scope_id: scopeId,
    scope_outline: scopeType === "book" ? outline.master || {} : scopeType === "volume" ? volume : scopedContracts[0],
    primary_scope_chapters: scopedContracts.map((item) => Number(item.chapter_number)),
    downstream_dependency_chapters: assessmentContracts.filter((item) => Number(item.chapter_number) > Math.max(...scopedContracts.map((source) => Number(source.chapter_number)))).map((item) => Number(item.chapter_number)),
    eligible_chapters: eligibleChapters, generated_chapters: generated, canon,
    writing_policy: prepared.policy, author_policy_receipt: {
      repaired_before_evaluation: prepared.repaired,
      author_version_id: prepared.binding.version_id,
      profile_hash: prepared.binding.profile_hash,
      policy_hash: prepared.policy.policy_hash,
      active_rule_count: Array.isArray(prepared.policy.active_rules) ? prepared.policy.active_rules.length : 0,
    }, feedback_thread: feedbackThread,
    scope_execution_directive: {
      mode: fullScope ? "full_scope" : "targeted",
      authority: fullScope ? "user_locked" : "ai_may_narrow_by_evidence",
      chapters: fullScope ? eligibleChapters : [],
      instruction: fullScope
        ? "用户已锁定全文审查与全部重修范围。AI 必须审查并计划重做全部 eligible_chapters，无权拒绝、缩小或以 Canon 为由排除章节。"
        : "AI 依据正文证据确定必要返工章节。",
    },
    note: eligibleChapters.length ? "只有 eligible_chapters 可以进入正文返工；待审旧稿也必须从章节设计重新走完全部质量闸门" : "当前范围没有可返工的已生成正文；请要求补充反馈或先完成正文",
  };
  const contextHash = createHash("sha256").update(JSON.stringify(context)).digest("hex");
  const policy = prepared.policy;
  // Include disk sources as well as indexed contracts: external file edits may
  // not have reached the Python index yet. This check itself does not resync it.
  const outlineFiles: Record<string, string | null> = {};
  for (const name of ["book.yaml", "outlines/master.json", "outlines/chapters.json", "outlines/foundation-contract.json"]) {
    const source = join(root, "books", bookId, name);
    outlineFiles[name] = existsSync(source) ? createHash("sha256").update(await readFile(source)).digest("hex") : null;
  }
  const lockedAt = new Date().toISOString();
  const manifest: Record<string, unknown> = {
    schemaVersion: "reader-feedback-context-v3", lockedAt, contextHash, scopeType, scopeId,
    reviewMode: fullScope ? "full_scope" : "targeted", requestedChapters: fullScope ? eligibleChapters : [],
    primaryChapters: context.primary_scope_chapters, downstreamDependencyChapters: context.downstream_dependency_chapters,
    eligibleChapters,
    chapters: generated.map((item) => ({
      chapterNumber: item.chapter_number, title: item.title, status: item.status, bodyHash: item.body_hash,
      contractHash: canonicalJsonHash(item.contract),
      excerptHash: item.excerpt_hash, truncated: item.body_truncated,
    })),
    canon: {throughChapter: canon.chapter_number ?? canon.through_chapter ?? canon.chapter ?? null, hash: existsSync(canonPath) ? createHash("sha256").update(JSON.stringify(canon)).digest("hex") : null},
    writingPolicy: {
      policyHash: policy.policy_hash ?? null,
      authorVersionId: (policy.author_binding as Record<string, unknown> | undefined)?.version_id ?? null,
      injectedRuleCount: Array.isArray(policy.active_rules) ? policy.active_rules.length : 0,
    },
    outlineHash: createHash("sha256").update(planningCanonicalJson({book: detail.book, master: outline.master, contracts: assessmentContracts, files: outlineFiles})).digest("hex"),
    feedbackThread: feedbackThread.map((item) => ({feedbackId: item.feedback_id, sequence: item.sequence, status: item.status})),
  };
  return {context, eligibleChapters, manifest};
}

function readerFeedbackView(feedback: ReaderFeedbackRecord): Record<string, unknown> {
  const job = feedback.jobId ? store.getJob(feedback.jobId) : null;
  const result = job ? store.getJobResult(job.id) : {publicDecision: {}, validationTrace: {}, lineage: {}};
  return {
    ...feedback,
    jobSummary: job ? {
      id: job.id, status: job.status, stage: job.stage, promptHash: job.promptHash, outputHash: job.outputHash,
      error: job.error, startedAt: job.startedAt, finishedAt: job.finishedAt,
    } : null,
    publicDecision: result.publicDecision, validationTrace: result.validationTrace,
  };
}

async function readerFeedbackDetail(feedbackId: string): Promise<Record<string, unknown>> {
  let feedback = store.getReaderFeedback(feedbackId);
  if (!feedback) throw new Error("读后反馈不存在");
  let workflow: Record<string, unknown> | null = null;
  if (feedback.workflowId) {
    workflow = (await python.workflowStatus(feedback.workflowId)).value;
    if (feedback.status === "reworking" && workflow.status === "completed") feedback = store.updateReaderFeedback(feedback.id, {status: "applied"});
  }
  const result = await runner.readerFeedbackResult(feedback.id);
  return {...result, feedback: readerFeedbackView(feedback), thread: store.readerFeedbackThread(feedback.id).map(readerFeedbackView), workflow};
}

function isLoopbackHost(value: string): boolean {
  const hostName = value.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return hostName === "127.0.0.1" || hostName === "localhost" || hostName === "::1";
}

function validOrigin(origin: string | undefined, requestHost: string): boolean {
  if (!origin) return true;
  try {
    const source = new URL(origin);
    if (source.origin !== origin || source.protocol !== "http:" || !isLoopbackHost(source.hostname)) return false;
    if (source.origin === new URL(`http://${requestHost}`).origin) return true;
    return development && Number(source.port || 80) === uiPort;
  } catch { return false; }
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

async function personalTalkContext(
  authorId: string,
  bookId: string,
  styleInfluence: "none" | "current_book",
  requestedProgressThrough: number | null = null,
): Promise<Record<string, unknown>> {
  const authorResult = (await python.author(authorId)).value as {author?: Record<string, unknown>};
  const author = authorResult.author;
  if (!author) throw new Error("作者档案不存在");
  const context: Record<string, unknown> = {
    author: {id: author.id, name: author.name, description: author.description},
    persona_snapshot: author.persona || {},
    style_influence: styleInfluence,
  };
  if (!bookId) return context;
  const project = (await python.project(bookId)).value as {book?: Record<string, unknown>; chapters?: Array<Record<string, unknown>>; writing_policy?: Record<string, unknown>};
  if (!project.book) throw new Error("关联作品不存在");
  const bindings = Array.isArray(author.bindings) ? author.bindings as Array<Record<string, unknown>> : [];
  if (!bindings.some((item) => String(item.book_id || "") === bookId)) throw new Error("只能关联当前作者已经绑定的作品");
  const outline = (await python.outline(bookId)).value as {chapters?: Array<Record<string, unknown>>};
  const rows = [...(project.chapters || [])].sort((a, b) => Number(a.chapter_number || 0) - Number(b.chapter_number || 0));
  const available = rows.filter((item) => String(item.status || "") !== "planned" && Number(item.chapter_number || 0) > 0);
  const availableThrough = Number(available.at(-1)?.chapter_number || 0);
  const progressThrough = requestedProgressThrough === null ? availableThrough : requestedProgressThrough;
  if (!Number.isInteger(progressThrough) || progressThrough < 0 || progressThrough > availableThrough) {
    throw new Error(`个人谈公开进度必须在 0—${availableThrough} 章之间`);
  }
  const progressed = available.filter((item) => Number(item.chapter_number || 0) <= progressThrough);
  const recent = progressed.slice(-3);
  const recentChapters = await Promise.all(recent.map(async (item) => {
    const chapter = Number(item.chapter_number || 0);
    const path = join(root, "books", bookId, "drafts", `chapter-${String(chapter).padStart(4, "0")}.md`);
    const body = existsSync(path) ? await readFile(path, "utf8").catch(() => "") : "";
    return {chapter_number: chapter, title: item.title, status: item.status, contract: item.contract || {}, excerpt: body.slice(-2_500)};
  }));
  const canonPath = join(root, "books", bookId, "canon", "current.json");
  const canon = existsSync(canonPath) ? JSON.parse(await readFile(canonPath, "utf8")) as Record<string, unknown> : {};
  context.progress_snapshot = {
    book: {id: bookId, title: project.book.title, metadata: project.book.metadata},
    progressed_through: progressThrough,
    available_through: availableThrough,
    chapter_contracts: (outline.chapters || []).filter((item) => Number(item.chapter_number || 0) <= progressThrough),
    canon,
    recent_chapters: recentChapters,
    future_outline_included: false,
    boundary: "只提供锁定进度以内的章节契约、Canon 与近期正文；未提供后续总纲或未来章节设计。",
  };
  if (styleInfluence === "current_book") {
    const policy = project.writing_policy || {};
    context.optional_book_expression = {
      policy_hash: policy.policy_hash || "",
      active_rules: Array.isArray(policy.active_rules) ? policy.active_rules : [],
      instruction: "只借用抽象措辞与节奏气质，不扮演小说角色，不改写作者个人人设",
    };
  }
  return context;
}

async function persistPersonalTalk(value: Record<string, unknown>): Promise<void> {
  const authorId = id(String(value.authorId || ""), "作者编号");
  const talkId = id(String(value.id || ""), "个人谈编号");
  const directory = join(root, "authors", authorId, "personal-talks");
  await mkdir(directory, {recursive: true});
  const target = join(directory, `${talkId}.json`);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

async function rawBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const announced = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(announced) && announced > limit) throw new Error("单个作品文件不能超过 50 MB");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > limit) throw new Error("单个作品文件不能超过 50 MB");
    chunks.push(value);
  }
  if (!size) throw new Error("上传文件不能为空");
  return Buffer.concat(chunks, size);
}

function id(value: string, label = "编号"): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label}格式无效`);
  return value;
}

type DeslopQuoteMode = "keep" | "yan" | "ascii";

function deslopQuoteMode(value: unknown): DeslopQuoteMode {
  if (value === undefined || value === null || value === "") return "keep";
  if (typeof value !== "string" || !new Set<DeslopQuoteMode>(["keep", "yan", "ascii"]).has(value as DeslopQuoteMode)) {
    throw new Error("去AI味引号模式必须是 keep、yan 或 ascii");
  }
  return value as DeslopQuoteMode;
}

async function assertDeslopApplyAllowed(bookId: string): Promise<void> {
  const activeJob = store.activeJobForBook(bookId);
  if (activeJob) {
    throw new Error(`本书已有活跃 Antigravity 任务（${activeJob.id}），禁止在任务运行时覆盖正文`);
  }
  const project = (await python.project(bookId)).value as {workflows?: Array<Record<string, unknown>>};
  const activeWorkflows = (project.workflows || []).filter((workflow) => String(workflow.status || "") === "running");
  if (activeWorkflows.length) {
    const runIds = activeWorkflows.map((workflow) => String(workflow.id || workflow.run_id || "")).filter(Boolean);
    throw new Error(`本书已有运行中的严格工作流${runIds.length ? `（${runIds.join("、")}）` : ""}，禁止在流程外覆盖正文`);
  }
}

function publicQualityRun(value: Record<string, unknown>): Record<string, unknown> {
  const judgments = value.judgments && !Array.isArray(value.judgments) && typeof value.judgments === "object"
    ? value.judgments as Record<string, unknown> : {};
  const comparison = value.comparison && !Array.isArray(value.comparison) && typeof value.comparison === "object"
    ? structuredClone(value.comparison as Record<string, unknown>) : {};
  const pairs = Array.isArray(comparison.pairs) ? comparison.pairs as Array<Record<string, unknown>> : [];
  comparison.pairs = pairs.map((pair) => {
    const chapter = String(pair.chapter || "");
    const judged = Boolean(judgments[chapter]);
    const {truth, ...visible} = pair;
    return judged ? {...visible, truth} : visible;
  });
  return {...value, comparison};
}

function planningScopeId(scope: PlanningConversationMessage["scopeType"], supplied: unknown, context: Record<string, unknown>): string {
  const selected = context.selected && !Array.isArray(context.selected) && typeof context.selected === "object" ? context.selected as Record<string, unknown> : {};
  const chapters = Array.isArray(context.selectedChapterNumbers)
    ? [...new Set(context.selectedChapterNumbers.map(Number).filter((item) => Number.isInteger(item) && item > 0))].sort((a, b) => a - b)
    : [];
  const fallback = scope === "new_book" ? `draft-${String(context.authorProfileVersionId || "unbound")}`
    : scope === "book" ? "book"
    : scope === "volume" ? String(selected.volume_id || context.volumeId || "current")
    : scope === "chapter" ? String(selected.chapter_number || context.chapterNumber || "current")
    : `chapters-${chapters.join("-") || "current"}`;
  const value = String(supplied || fallback).trim();
  if (!/^[A-Za-z0-9_,.-]{1,180}$/.test(value)) throw new Error("AI 共创对话范围无效");
  return value;
}

function jsonObjectAfter(text: string, heading: string): Record<string, unknown> | null {
  const anchor = text.indexOf(heading);
  if (anchor < 0) return null;
  const start = text.indexOf("{", anchor + heading.length);
  if (start < 0) return null;
  let depth = 0; let quoted = false; let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const value = JSON.parse(text.slice(start, index + 1)) as unknown;
          return value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : null;
        } catch { return null; }
      }
    }
  }
  return null;
}

async function jsonFile(path: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch { return null; }
}

const contextPurpose: Record<string, string> = {
  canon: "正式事实、人物知识与不可冲突边界", design: "本章计划、场景交付与读者体验契约",
  chapter_contract: "章节目标、阻碍、变化与章末承接", approved_text: "当前受审或待返工的权威正文",
  approved_text_to_rework: "已通过正文的返工基线", prior_handoff: "上一章实际出口与本章入口",
  next_contract: "下一章第一拍和跨章承接", failed_review: "当前有效失败项与返工要求",
  writing_policy: "冻结作者版本、本书覆盖和规则优先级", story_foundation: "故事核、人物与世界基础",
  prior_canon_delta: "上一章正式 Canon 增量", reader_feedback: "用户已确认的读后反馈与保留项",
};

interface ProjectSummary {
  id: string;
  title: string;
  chapterCount: number;
  approvedCount: number;
  blockedCount: number;
  activeJob: ReturnType<StudioStore["activeJobForBook"]>;
  latestWorkflow: Record<string, unknown> | null;
}

async function projectSummaries(): Promise<ProjectSummary[]> {
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
    json(response, 200, { status: "ok", root, localOnly: true, buildId, migration, authorLayerBackup, antigravity: runner.status(), fanqie: fanqie.availability() });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/projects") {
    json(response, 200, await projectSummaries());
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/runtime/recovery") {
    json(response, 200, await recoveryDiagnostics(root, python.python, resolve(studioDir, "../src")));
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/authors") {
    const result = (await python.authors(false)).value as {authors?: Array<Record<string, unknown>>};
    const status = String(url.searchParams.get("status") || "").trim();
    const query = String(url.searchParams.get("q") || "").trim().toLocaleLowerCase("zh-CN");
    if (status && !new Set(["active", "archived", "unpublished"]).has(status)) throw new Error("作者筛选状态无效");
    const authors = (result.authors || []).filter((author) => {
      if (status === "unpublished" && Number(author.current_version_number || 0) > 0) return false;
      if ((status === "active" || status === "archived") && author.status !== status) return false;
      return !query || `${String(author.name || "")} ${String(author.description || "")}`.toLocaleLowerCase("zh-CN").includes(query);
    });
    json(response, 200, {authors});
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/authors") {
    const value = await body(request);
    json(response, 201, (await python.createAuthor(value)).value);
    return true;
  }
  let authorMatch = url.pathname.match(/^\/api\/authors\/([A-Za-z0-9_-]+)\/ai-draft$/);
  if (request.method === "POST" && authorMatch) {
    const authorId = id(authorMatch[1], "作者编号");
    const value = await body(request);
    const instruction = String(value.instruction || "").trim();
    if (!instruction || instruction.length > 4_000) throw new Error("AI 作者要求必须为 1—4000 个字符");
    const author = (await python.author(authorId)).value;
    const context = value.context && !Array.isArray(value.context) && typeof value.context === "object"
      ? value.context as Record<string, unknown> : {};
    json(response, 202, await runner.startAuthorDraft(authorId, instruction, {author, ...context}));
    return true;
  }
  authorMatch = url.pathname.match(/^\/api\/authors\/([A-Za-z0-9_-]+)\/persona\/ai-draft$/);
  if (request.method === "POST" && authorMatch) {
    const authorId = id(authorMatch[1], "作者编号");
    const value = await body(request);
    const instruction = String(value.instruction || "").trim();
    if (!instruction || instruction.length > 4_000) throw new Error("作者个人人设要求必须为 1—4000 个字符");
    const detail = ((await python.author(authorId)).value as {author?: Record<string, unknown>}).author;
    if (!detail) throw new Error("作者档案不存在");
    const author = {id: detail.id, name: detail.name, description: detail.description, current_persona: detail.persona || {}};
    json(response, 202, await runner.startAuthorPersonaDraft(authorId, instruction, {author}));
    return true;
  }
  authorMatch = url.pathname.match(/^\/api\/authors\/([A-Za-z0-9_-]+)\/personal-talks\/ai-draft$/);
  if (request.method === "POST" && authorMatch) {
    const authorId = id(authorMatch[1], "作者编号");
    const value = await body(request);
    const instruction = String(value.instruction || "").trim();
    if (!instruction || instruction.length > 4_000) throw new Error("个人谈要求必须为 1—4000 个字符");
    const linkedBookId = String(value.linkedBookId || "").trim();
    if (linkedBookId) id(linkedBookId, "关联作品编号");
    const styleInfluence = value.styleInfluence === "current_book" ? "current_book" : "none";
    const progressThroughChapter = value.progressThroughChapter === undefined ? null : Number(value.progressThroughChapter);
    const context = await personalTalkContext(authorId, linkedBookId, styleInfluence, progressThroughChapter);
    json(response, 202, await runner.startPersonalTalkDraft(authorId, instruction, context, linkedBookId, styleInfluence));
    return true;
  }
  authorMatch = url.pathname.match(/^\/api\/authors\/([A-Za-z0-9_-]+)\/personal-talks$/);
  if (request.method === "GET" && authorMatch) {
    const authorId = id(authorMatch[1], "作者编号");
    if (!((await python.author(authorId)).value as {author?: unknown}).author) throw new Error("作者档案不存在");
    json(response, 200, {talks: store.listPersonalTalks(authorId)});
    return true;
  }
  if (request.method === "POST" && authorMatch) {
    const authorId = id(authorMatch[1], "作者编号");
    const value = await body(request);
    const title = String(value.title || "").trim();
    const content = String(value.content || "").trim();
    if (!title || title.length > 100) throw new Error("个人谈标题必须为 1—100 个字符");
    if (!content || content.length > 8_000) throw new Error("个人谈正文必须为 1—8000 个字符");
    const linkedBookId = String(value.linkedBookId || "").trim();
    if (linkedBookId) id(linkedBookId, "关联作品编号");
    const styleInfluence = value.styleInfluence === "current_book" ? "current_book" : "none";
    const progressThroughChapter = value.progressThroughChapter === undefined ? null : Number(value.progressThroughChapter);
    const context = await personalTalkContext(authorId, linkedBookId, styleInfluence, progressThroughChapter);
    const sourceJobId = String(value.sourceJobId || "").trim();
    if (sourceJobId) {
      const sourceJob = store.getJob(id(sourceJobId, "个人谈候选任务编号"));
      if (!sourceJob || sourceJob.stage !== "personal_talk_draft" || sourceJob.status !== "succeeded" || sourceJob.scopeId !== authorId) {
        throw new Error("个人谈候选来源无效、未完成或不属于当前作者");
      }
    }
    const talk = store.savePersonalTalk({
      authorId, title, content, linkedBookId: linkedBookId || null,
      progressSnapshot: context.progress_snapshot as Record<string, unknown> || {},
      personaSnapshot: context.persona_snapshot as Record<string, unknown> || {},
      personaHash: canonicalJsonHash(context.persona_snapshot || {}), styleInfluence,
      status: value.status === "ready" ? "ready" : "draft", sourceJobId: sourceJobId || null,
    });
    await persistPersonalTalk(talk as unknown as Record<string, unknown>);
    json(response, 201, {talk});
    return true;
  }
  authorMatch = url.pathname.match(/^\/api\/authors\/([A-Za-z0-9_-]+)\/personal-talks\/([A-Za-z0-9_-]+)$/);
  if (request.method === "PUT" && authorMatch) {
    const authorId = id(authorMatch[1], "作者编号");
    const talkId = id(authorMatch[2], "个人谈编号");
    const current = store.getPersonalTalk(talkId);
    if (!current || current.authorId !== authorId) throw new Error("个人谈不存在");
    const value = await body(request);
    const title = String(value.title ?? current.title).trim();
    const content = String(value.content ?? current.content).trim();
    if (!title || title.length > 100) throw new Error("个人谈标题必须为 1—100 个字符");
    if (!content || content.length > 8_000) throw new Error("个人谈正文必须为 1—8000 个字符");
    const linkedBookId = String(value.linkedBookId ?? current.linkedBookId ?? "").trim();
    if (linkedBookId) id(linkedBookId, "关联作品编号");
    const styleInfluence = value.styleInfluence === "current_book" ? "current_book" : value.styleInfluence === "none" ? "none" : current.styleInfluence;
    const allowedStatus = new Set(["draft", "ready", "published", "archived"]);
    const status = allowedStatus.has(String(value.status || "")) ? String(value.status) as typeof current.status : current.status;
    const context = linkedBookId !== (current.linkedBookId || "") || styleInfluence !== current.styleInfluence
      ? await personalTalkContext(authorId, linkedBookId, styleInfluence) : null;
    const talk = store.savePersonalTalk({
      id: talkId, authorId, title, content, linkedBookId: linkedBookId || null, styleInfluence, status,
      progressSnapshot: context?.progress_snapshot as Record<string, unknown> || current.progressSnapshot,
      personaSnapshot: current.personaSnapshot, personaHash: current.personaHash, sourceJobId: current.sourceJobId,
    });
    await persistPersonalTalk(talk as unknown as Record<string, unknown>);
    json(response, 200, {talk});
    return true;
  }
  if (request.method === "DELETE" && authorMatch) {
    const authorId = id(authorMatch[1], "作者编号");
    const talkId = id(authorMatch[2], "个人谈编号");
    const talk = store.deletePersonalTalk(authorId, talkId);
    const source = join(root, "authors", authorId, "personal-talks", `${talkId}.json`);
    if (existsSync(source)) {
      const trash = join(root, "authors", authorId, ".trash", "personal-talks");
      await mkdir(trash, {recursive: true});
      await rename(source, join(trash, `${talkId}-${Date.now()}.json`));
    }
    json(response, 200, {talk, deleted: true});
    return true;
  }
  authorMatch = url.pathname.match(/^\/api\/authors\/([A-Za-z0-9_-]+)\/sources$/);
  if (request.method === "POST" && authorMatch) {
    const authorId = id(authorMatch[1], "作者编号");
    if (String(request.headers["x-tomota-rights-confirmed"] || "").toLowerCase() !== "true") {
      throw new Error("上传前必须确认拥有作品或具有分析授权");
    }
    const filename = String(url.searchParams.get("filename") || "").trim();
    if (!filename || filename !== basename(filename) || /[\\/\0]/.test(filename)) throw new Error("上传文件名无效");
    if (!new Set([".txt", ".md", ".epub"]).has(extname(filename).toLowerCase())) throw new Error("只支持 TXT、MD、EPUB");
    const content = await rawBody(request, 50 * 1024 * 1024);
    const uploadDir = join(root, ".tomota-studio", "uploads");
    await mkdir(uploadDir, {recursive: true});
    const temporary = join(uploadDir, `${randomUUID()}.upload`);
    await writeFile(temporary, content, {flag: "wx"});
    try {
      json(response, 201, (await python.addAuthorSource(authorId, temporary, filename)).value);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return true;
  }
  authorMatch = url.pathname.match(/^\/api\/authors\/([A-Za-z0-9_-]+)\/sources\/order$/);
  if (request.method === "PUT" && authorMatch) {
    const authorId = id(authorMatch[1], "作者编号");
    const value = await body(request);
    const sourceIds = Array.isArray(value.sourceIds) ? value.sourceIds.map((item) => id(String(item), "来源编号")) : [];
    json(response, 200, (await python.reorderAuthorSources(authorId, sourceIds)).value);
    return true;
  }
  authorMatch = url.pathname.match(/^\/api\/authors\/([A-Za-z0-9_-]+)\/sources\/([A-Za-z0-9_-]+)$/);
  if (request.method === "DELETE" && authorMatch) {
    const authorId = id(authorMatch[1], "作者编号");
    const active = store.activeJobForScope("author", authorId);
    if (active) throw new Error(`作者蒸馏或候选任务仍在运行，不能删除来源：${active.id}`);
    json(response, 200, (await python.deleteAuthorSource(authorId, id(authorMatch[2], "来源编号"))).value);
    return true;
  }
  authorMatch = url.pathname.match(/^\/api\/authors\/([A-Za-z0-9_-]+)\/distillation\/runs\/([A-Za-z0-9_-]+)\/(evidence|portraits)$/);
  if (request.method === "GET" && authorMatch) {
    const authorId = id(authorMatch[1], "作者编号");
    const runId = id(authorMatch[2], "蒸馏运行编号");
    const belongs = store.listJobs(runId, 500).some((job) => job.scopeType === "author" && job.scopeId === authorId);
    if (!belongs) throw new Error("蒸馏运行不存在或不属于当前作者");
    if (authorMatch[3] === "evidence") {
      const sourceId = String(url.searchParams.get("sourceId") || "").trim();
      const values = store.listEvidenceByRun(runId).filter((item) => !sourceId || item.sourceId === sourceId);
      json(response, 200, {runId, evidence: values});
    } else {
      const sourceId = String(url.searchParams.get("sourceId") || "").trim();
      const level = String(url.searchParams.get("level") || "").trim();
      if (level && !["segment", "phase", "work"].includes(level)) throw new Error("画像层级无效");
      json(response, 200, {runId, portraits: store.listDistillationPortraits(runId, sourceId || undefined, level as "segment" | "phase" | "work" || undefined)});
    }
    return true;
  }
  authorMatch = url.pathname.match(/^\/api\/authors\/([A-Za-z0-9_-]+)\/distill$/);
  if (request.method === "POST" && authorMatch) {
    const authorId = id(authorMatch[1], "作者编号");
    const value = await body(request);
    const sourceIds = Array.isArray(value.sourceIds) ? value.sourceIds.map((item) => id(String(item), "来源编号")) : [];
    if (!sourceIds.length) throw new Error("文风蒸馏至少选择一个授权来源");
    const context = (await python.authorDistillContext(authorId, sourceIds)).value;
    json(response, 202, await runner.startStyleDistillation(authorId, context));
    return true;
  }
  authorMatch = url.pathname.match(/^\/api\/authors\/([A-Za-z0-9_-]+)\/versions$/);
  if (request.method === "POST" && authorMatch) {
    const authorId = id(authorMatch[1], "作者编号");
    const value = await body(request);
    if (!value.profile || Array.isArray(value.profile) || typeof value.profile !== "object") throw new Error("作者版本 profile 必须是对象");
    const changeSummary = String(value.changeSummary || "").trim();
    if (changeSummary.length > 1000) throw new Error("版本变更说明不能超过 1000 个字符");
    const baseVersionId = String(value.baseVersionId || "").trim();
    const author = ((await python.author(authorId)).value as {author?: {versions?: Array<{id: string; source_manifest?: Array<{source_id?: string}>}>}}).author;
    const baseVersion = baseVersionId ? author?.versions?.find((version) => version.id === baseVersionId) : undefined;
    if (baseVersionId && !baseVersion) throw new Error("基础作者版本不存在或不属于当前作者");
    const profile = structuredClone(value.profile) as Record<string, unknown>;
    const existingProvenance = profile.provenance && !Array.isArray(profile.provenance) && typeof profile.provenance === "object"
      ? profile.provenance as Record<string, unknown> : {};
    profile.provenance = {...existingProvenance, creation_mode: "manual_editor", base_version_id: baseVersionId || null, change_summary: changeSummary};
    const sourceIds = (baseVersion?.source_manifest || []).map((item) => String(item.source_id || "")).filter(Boolean);
    json(response, 201, (await python.createAuthorVersion(authorId, {profile, source_ids: sourceIds})).value);
    return true;
  }
  authorMatch = url.pathname.match(/^\/api\/authors\/([A-Za-z0-9_-]+)\/versions\/([A-Za-z0-9_-]+)\/publish$/);
  if (request.method === "POST" && authorMatch) {
    json(response, 200, (await python.publishAuthorVersion(id(authorMatch[1], "作者编号"), id(authorMatch[2], "作者版本编号"))).value);
    return true;
  }
  authorMatch = url.pathname.match(/^\/api\/authors\/([A-Za-z0-9_-]+)\/versions\/([A-Za-z0-9_-]+)\/archive$/);
  if (request.method === "POST" && authorMatch) {
    json(response, 200, (await python.archiveAuthorVersion(id(authorMatch[1], "作者编号"), id(authorMatch[2], "作者版本编号"))).value);
    return true;
  }
  authorMatch = url.pathname.match(/^\/api\/authors\/([A-Za-z0-9_-]+)$/);
  if (request.method === "GET" && authorMatch) {
    json(response, 200, (await python.author(id(authorMatch[1], "作者编号"))).value);
    return true;
  }
  if (request.method === "PUT" && authorMatch) {
    json(response, 200, (await python.updateAuthor(id(authorMatch[1], "作者编号"), await body(request))).value);
    return true;
  }
  if (request.method === "DELETE" && authorMatch) {
    const authorId = id(authorMatch[1], "作者编号");
    const result = (await python.deleteAuthor(authorId)).value;
    const personalTalkRowsDeleted = store.deletePersonalTalksByAuthor(authorId);
    json(response, 200, {...result, personalTalkRowsDeleted});
    return true;
  }
  let authorJobMatch = url.pathname.match(/^\/api\/author-jobs\/([A-Za-z0-9_-]+)$/);
  if (request.method === "GET" && authorJobMatch) {
    json(response, 200, await runner.authorCandidateResult(id(authorJobMatch[1], "作者候选任务编号")));
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/projects") {
    const value = await body(request);
    if (!String(value.authorProfileVersionId || "").trim()) throw new Error("新书必须选择一个已发布的作者版本");
    // 服务端从已审查候选读取正式产物，不信任浏览器直接提交的大纲/章纲/契约。
    const submittedContract = value.planning_contract && !Array.isArray(value.planning_contract) && typeof value.planning_contract === "object"
      ? value.planning_contract as Record<string, unknown> : {};
    const sourceJobId = id(String(value.source_job_id || submittedContract.source_job_id || ""), "新书规划任务编号");
    const selected = store.getJob(sourceJobId);
    if (!selected || selected.status !== "succeeded" || selected.stage !== "planning_new_book" || !existsSync(selected.outputPath)) {
      throw new Error("新书候选尚未通过校验，不能直接保存");
    }
    const raw = await readFile(selected.outputPath, "utf8");
    const hash = createHash("sha256").update(raw).digest("hex");
    if (!selected.outputHash || selected.outputHash !== hash) throw new Error("新书候选产物哈希不一致，可能已被篡改");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("新书候选产物无效");
    const artifact = parsed as Record<string, unknown>;
    const proposal = artifact.proposal && !Array.isArray(artifact.proposal) && typeof artifact.proposal === "object" ? artifact.proposal as Record<string, unknown> : {};
    const constraints = proposal.constraints && !Array.isArray(proposal.constraints) && typeof proposal.constraints === "object"
      ? proposal.constraints as Record<string, unknown> : null;
    if (!constraints || !Array.isArray(proposal.initial_chapters)) throw new Error("新书候选缺少正式约束或初始章纲");
    const selectedLineage = store.getJobResult(selected.id).lineage;
    const contextHashes = selectedLineage.planningContextHashes && !Array.isArray(selectedLineage.planningContextHashes) && typeof selectedLineage.planningContextHashes === "object"
      ? selectedLineage.planningContextHashes as Record<string, unknown> : {};
    const versionResult = (await python.authorVersion(String(value.authorProfileVersionId))).value as {version?: Record<string, unknown>};
    const version = versionResult.version;
    if (!version || version.status !== "published") throw new Error("新书绑定的作者版本不存在或尚未发布");
    if (!String(version.profile_hash || "") || String(contextHashes.author_profile_hash || "") !== String(version.profile_hash || "")) {
      throw new Error("新书候选使用的作者版本与当前选择不一致，请重新生成规划");
    }
    // 正式故事字段只取服务端已校验产物；浏览器只能继续提供发布署名等不参与规划的界面元数据。
    value.title = String(proposal.title || "").trim();
    value.metadata = {
      ...(value.metadata && !Array.isArray(value.metadata) && typeof value.metadata === "object" ? value.metadata as Record<string, unknown> : {}),
      synopsis: String(proposal.synopsis || ""), genre: String(proposal.genre || ""),
      completion_mode: String(proposal.completion_mode || "open_ended"),
      target_chapters: proposal.target_chapters ?? null,
    };
    value.outline = proposal;
    value.chapters = proposal.initial_chapters;
    value.author_application = artifact.author_application && !Array.isArray(artifact.author_application) && typeof artifact.author_application === "object"
      ? artifact.author_application : {};
    value.planning_contract = {
      schema_version: "foundation-contract-v2",
      source_job_id: selected.id,
      source_artifact_hashes: {[selected.id]: hash},
      generated_at: selected.finishedAt || new Date().toISOString(),
      constraints,
      reader_world_contract: artifact.reader_world_contract && !Array.isArray(artifact.reader_world_contract) && typeof artifact.reader_world_contract === "object"
        ? artifact.reader_world_contract : {},
      rationale: Array.isArray(artifact.rationale) ? artifact.rationale.map(String) : [],
      warnings: Array.isArray(artifact.warnings) ? artifact.warnings.map(String) : [],
      applied_fields: ["title", "genre", "synopsis", "completion_mode", "target_chapters", "rolling_window", "premise", "core_conflict", "ending_direction", "major_beats", "volumes", "initial_chapters", "author_application", "reader_world_contract"],
      author_contract_snapshot: selectedLineage.planningAuthorContract || {},
    };
    const created = await python.createBook(value);
    lastProjectRefresh = 0;
    json(response, 201, created.value);
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/planning/generate") {
    const value = await body(request);
    const scope = String(value.scope || "");
    if (!["new_book", "book", "volume", "chapter", "chapters"].includes(scope)) throw new Error("AI 规划层级无效");
    const bookId = scope === "new_book" ? "new-book" : id(String(value.bookId || ""), "作品编号");
    const mode = value.mode === "fill" ? "fill" : "rewrite";
    const instruction = String(value.instruction || "").trim();
    if (!instruction || instruction.length > 4_000) throw new Error("请提供 1—4000 字的共创要求");
    const context: Record<string, unknown> = value.context && !Array.isArray(value.context) && typeof value.context === "object" ? {...value.context as Record<string, unknown>} : {};
    const typedScope = scope as Exclude<PlanningConversationMessage["scopeType"], "workbench">;
    const conversationScopeId = planningScopeId(typedScope, value.conversationScopeId, context);
    // The database is the authority for conversation history. Never trust a
    // client-supplied proposal list: a stale tab could otherwise resurrect an
    // abandoned candidate after the author asks for a rewrite.
    const preparedConversation = preparePlanningConversation(
      store.listPlanningMessages(bookId, typedScope, conversationScopeId),
      instruction,
      mode,
    );
    context.conversation = preparedConversation.conversation;
    context.planning_conversation_policy = {
      mode: preparedConversation.policy,
      source: "server_authoritative_history",
      retained_user_turns: preparedConversation.retainedUserTurns,
      discarded_assistant_turns: preparedConversation.discardedAssistantTurns,
      discarded_earlier_turns: preparedConversation.discardedEarlierTurns,
      assistant_candidates_are_constraints: false,
    };
    if (context.clearSelectedOutline === true && (scope !== "chapters" || mode !== "rewrite")) throw new Error("清空并替换授权只适用于批量章节重规划");
    if (scope === "new_book") {
      const versionId = id(String(context.authorProfileVersionId || ""), "作者版本编号");
      const result = (await python.authorVersion(versionId)).value as {version?: Record<string, unknown>};
      if (!result.version || result.version.status !== "published") throw new Error("AI 共创新书必须锁定一个已发布作者版本");
      context.author_contract = authorPlanningContract(result.version);
    } else {
      const prepared = await ensureAuthorPolicy(bookId, "AI 规划");
      const project = prepared.project;
      const outline = (await python.outline(bookId)).value as {master?: Record<string, unknown>; chapters?: Array<Record<string, unknown>>; foundation_contract?: Record<string, unknown> | null};
      // 服务端权威：用磁盘中的正式大纲覆盖浏览器提交的 master/chapters，防止旧标签、
      // 未保存候选或前端内存里的过期大纲重新进入生成。
      context.master = outline.master ?? context.master;
      context.chapters = outline.chapters ?? context.chapters;
      context.author_contract = prepared.contract;
      context.author_binding = planningAuthorBinding(prepared.binding);
      context.author_policy_receipt = {
        repaired_before_generation: prepared.repaired,
        author_version_id: prepared.binding.version_id,
        profile_hash: prepared.binding.profile_hash,
        policy_hash: prepared.policy.policy_hash,
        compiled_rule_count: Array.isArray(prepared.policy.active_rules) ? prepared.policy.active_rules.length : 0,
      };
      context.foundation_contract = publicFoundationContract(outline.foundation_contract);
      context.canon = await jsonFile(join(root, "books", bookId, "canon", "current.json"));
      const foundationContractCheck = context.foundation_contract as Record<string, unknown> | null;
      const foundationLocked = Boolean(foundationContractCheck && String(foundationContractCheck.contract_hash || "").trim() && Array.isArray(foundationContractCheck.active_constraints) && (foundationContractCheck.active_constraints as unknown[]).length > 0);
      // 全书重建后 foundation 为空是合法的"首次规划"起点：从空生成第一份正式契约，不阻塞启动。
      if (!foundationLocked) {
        context.foundation_contract = null;
        context.fresh_foundation = true;
      } else {
        const incomplete = foundationIncompleteCategories(context.foundation_contract as Record<string, unknown> | null | undefined);
        if (incomplete.length) context.foundation_incomplete_categories = incomplete;
      }
      // Canon 允许为空：新书尚未生成第一章时没有事实边界是正常的；事实边界由 foundation_contract.active_constraints 提供。
      if (!context.canon || Array.isArray(context.canon) || typeof context.canon !== "object") context.canon = null;
    }
    const authorContract = (context.author_contract && typeof context.author_contract === "object" ? context.author_contract : {}) as Record<string, unknown>;
    const foundationContract = (context.foundation_contract && typeof context.foundation_contract === "object" ? context.foundation_contract : {}) as Record<string, unknown>;
    // 与运行器一致：按当前规划层级过滤作者规则后计算 binding。之前这里用全部规则数量/哈希，
    // 运行器却按层级过滤再校验，导致现有作品的全书/卷/章规划在调用 AGY 前就因数量哈希不一致死锁。
    const scopedAuthorRules = relevantPlanningAuthorRules(authorContract, `planning_${typedScope}`);
    context.conversation_binding = {
      author_version_id: String(authorContract.author_version_id || ""),
      author_profile_hash: String(authorContract.profile_hash || ""),
      author_rule_count: scopedAuthorRules.length,
      author_rules_hash: canonicalJsonHash(scopedAuthorRules),
      // 空 FoundationContract 是全书重建后的合法首次规划状态。运行器同样把它
      // 绑定为空字符串；这里不能把 null 计算成 `{}` 的哈希，否则请求会在生成前
      // 被 conversation_binding 强绑定拒绝。
      foundation_contract_hash: planningFoundationContractHash(foundationContract),
      canon_hash: canonicalJsonHash(context.canon || {}),
      conversation_hash: canonicalJsonHash(context.conversation || []),
    };
    const started = await runner.startPlanning({bookId, scope: typedScope, mode, instruction, context});
    store.savePlanningMessage({bookId, scopeType: typedScope, scopeId: conversationScopeId, role: "user", text: instruction, jobId: started.job.id});
    json(response, 202, {...started, conversationPolicy: context.planning_conversation_policy});
    return true;
  }
  if ((request.method === "GET" || request.method === "DELETE") && url.pathname === "/api/planning/conversation") {
    const bookId = id(String(url.searchParams.get("bookId") || ""), "作品编号");
    const scope = String(url.searchParams.get("scope") || "") as PlanningConversationMessage["scopeType"];
    if (!["new_book", "book", "volume", "chapter", "chapters"].includes(scope)) throw new Error("AI 共创对话层级无效");
    const scopeId = planningScopeId(scope, url.searchParams.get("scopeId"), {});
    if (request.method === "DELETE") {
      const activePlanningJob = store.activePlanningJobForBook(bookId);
      if (activePlanningJob) throw new Error(`本书仍有规划任务（${activePlanningJob.id}）正在运行，请先停止任务；清空后会一并移除当前范围的候选、审查、Prompt、JSON 产物和交接缓存`);
      const purged = store.purgePlanningConversationArtifacts(bookId, scope as Exclude<PlanningConversationMessage["scopeType"], "workbench">, scopeId);
      json(response, 200, {deleted: purged.deletedMessages, ...purged});
    } else {
      let messages = currentPlanningConversationEpoch(store.listPlanningMessages(bookId, scope, scopeId));
      const assistantJobs = new Set(messages.filter((item) => item.role === "assistant").map((item) => item.jobId));
      for (const message of messages) {
        if (message.role === "user" && !assistantJobs.has(message.jobId)) await persistPlanningAssistantMessage(message.jobId);
      }
      messages = currentPlanningConversationEpoch(store.listPlanningMessages(bookId, scope, scopeId));
      const activeJob = [...messages].reverse().map((item) => store.getJob(item.jobId)).find((job) => job && ["queued", "running", "awaiting_choice"].includes(job.status))
        || store.activePlanningJobForBook(bookId);
      json(response, 200, {messages, activeJob});
    }
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/agent/context") {
    const bookId = url.searchParams.get("bookId") ? id(url.searchParams.get("bookId")!, "作品编号") : undefined;
    json(response, 200, await agentContext(bookId));
    return true;
  }
  if ((request.method === "GET" || request.method === "DELETE") && url.pathname === "/api/agent/conversation") {
    const bookId = id(String(url.searchParams.get("bookId") || ""), "作品编号");
    if (request.method === "DELETE") {
      json(response, 200, {deleted: store.clearPlanningMessages(bookId, "workbench", "book")});
    } else {
      const messages = store.listPlanningMessages(bookId, "workbench", "book");
      const activeJob = [...messages].reverse().map((item) => store.getJob(item.jobId)).find((job) => job && ["queued", "running"].includes(job.status)) || null;
      json(response, 200, {messages, activeJob});
    }
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/agent/message") {
    const value = await body(request);
    const message = String(value.message || "").trim();
    if (!message || message.length > 4000) throw new Error("代理指令必须为 1—4000 个字符");
    const bookId = value.bookId ? id(String(value.bookId), "作品编号") : undefined;
    const context = await agentContext(bookId);
    const history = bookId ? store.listPlanningMessages(bookId, "workbench", "book").map((item) => ({role: item.role, text: item.text})) : [];
    const started = await runner.agent.start(message, context, history);
    if (bookId) store.savePlanningMessage({bookId, scopeType: "workbench", scopeId: "book", role: "user", text: message, jobId: started.id});
    json(response, 202, started);
    return true;
  }
  let agentMatch = url.pathname.match(/^\/api\/agent\/jobs\/([A-Za-z0-9_-]+)$/);
  if (request.method === "GET" && agentMatch) {
    const detail = await runner.agent.result(id(agentMatch[1], "代理任务编号"));
    const plan = detail.artifact && detail.job.status === "succeeded" ? store.saveAgentPlan(detail.job, detail.artifact as unknown as Record<string, unknown>) : store.getAgentPlan(detail.job.id);
    if (detail.artifact && detail.job.status === "succeeded" && /^[A-Za-z0-9_-]+$/.test(detail.job.bookId)) {
      store.savePlanningMessage({
        bookId: detail.job.bookId, scopeType: "workbench", scopeId: "book", role: "assistant",
        text: [detail.artifact.summary, ...detail.artifact.reasoning].filter(Boolean).join("\n"),
        proposal: detail.artifact as unknown as Record<string, unknown>, warnings: detail.artifact.warnings, jobId: detail.job.id,
      });
    }
    json(response, 200, {...detail, plan, execution: plan ? store.getAgentExecutionResult(plan.jobId) : null});
    return true;
  }
  agentMatch = url.pathname.match(/^\/api\/agent\/jobs\/([A-Za-z0-9_-]+)\/cancel$/);
  if (request.method === "POST" && agentMatch) {
    json(response, 200, runner.cancel(id(agentMatch[1], "代理任务编号")));
    return true;
  }
  agentMatch = url.pathname.match(/^\/api\/agent\/plans\/([A-Za-z0-9_-]+)\/(execute|reject)$/);
  if (request.method === "POST" && agentMatch) {
    const jobId = id(agentMatch[1], "代理计划编号");
    const plan = store.getAgentPlan(jobId);
    if (!plan) throw new Error("代理计划不存在");
    if (agentMatch[2] === "reject") {
      const rejected = store.claimAgentPlan(jobId, "rejected");
      json(response, 200, {plan: rejected});
      return true;
    }
    if (plan.status !== "pending") throw new Error("该计划已被处理，不能重复执行");
    const result = await runner.agent.result(jobId);
    const artifact = result.artifact;
    if (!artifact) throw new Error("计划尚未生成或未通过校验");
    store.claimAgentPlan(jobId, "confirmed");
    const actions: AgentExecutionResult["actions"] = [];
    for (const action of artifact.actions) {
      try {
        if (action.type === "run_workflow") {
          const active = store.activeJobForBook(action.bookId);
          if (active) throw new Error("同一本书已有任务运行，计划已安全停止");
          const started = await python.startWorkflow(action.bookId, action.chapters, 5);
          const run = started.value.run as Record<string, unknown>;
          if (!run?.run_id) throw new Error("创建工作流未返回有效编号");
          const job = action.autoRun ? await runner.startContinuous(String(run.run_id)) : null;
          actions.push({type: action.type, status: "succeeded", detail: `已创建工作流 ${String(run.run_id)}${job?.job ? " 并启动 Antigravity" : ""}`});
        } else if (action.type === "rework_chapter") {
          const active = store.activeJobForBook(action.bookId);
          if (active) throw new Error("同一本书已有任务运行，返工计划已安全停止");
          const started = await python.startRework(action.bookId, action.chapter, action.feedback, 5);
          const run = started.value.run as Record<string, unknown>;
          if (!run?.run_id) throw new Error("创建返工流程未返回有效编号");
          const job = action.autoRun ? await runner.startContinuous(String(run.run_id)) : null;
          actions.push({type: action.type, status: "succeeded", detail: `第 ${action.chapter} 章返工流程已创建${job?.job ? "，Antigravity 已启动" : ""}`});
        } else if (action.type === "run_next_stage") {
          const started = await runner.startContinuous(action.runId);
          actions.push({type: action.type, status: started.job ? "succeeded" : "skipped", detail: started.job ? `任务 ${started.job.id} 已启动` : "工作流不在运行状态，未启动任务"});
        } else if (action.type === "retry_job") {
          const started = await runner.retry(action.jobId);
          actions.push({type: action.type, status: started.job ? "succeeded" : "skipped", detail: started.job ? `任务 ${started.job.id} 已重试` : "没有可重试任务"});
        } else if (action.type === "create_revision_brief") {
          const brief = store.saveRevisionBrief({bookId: action.bookId, chapter: action.chapter, feedback: action.feedback, sourceJobId: jobId});
          actions.push({type: action.type, status: "succeeded", detail: `已保存第 ${action.chapter} 章结构化返工方案 ${brief.id}，可在严格流水线中启动返工`});
        } else if (action.type === "update_author_preference") {
          const preference = (await python.setAuthorOverride(action.bookId, {
            category: action.category, rule: action.rule, evidence: action.evidence,
            enabled: action.enabled, source_id: `agent-plan:${jobId}`,
          })).value.override as Record<string, unknown>;
          actions.push({type: action.type, status: "succeeded", detail: `本书覆盖规则已保存：${String(preference.category)}`});
        } else if (action.type === "switch_view" || action.type === "select_project") {
          actions.push({type: action.type, status: "succeeded", detail: action.type === "switch_view" ? `前端将切换到 ${action.view}` : `前端将切换作品 ${action.bookId}`});
        }
      } catch (error) {
        actions.push({type: action.type, status: "failed", detail: error instanceof Error ? error.message : String(error)});
      }
    }
    const status = actions.some((item) => item.status === "failed") ? "failed" : "executed";
    const executed = store.updateAgentPlanStatus(jobId, status);
    const execution = store.saveAgentExecutionResult({planId: jobId, status, executedAt: new Date().toISOString(), actions});
    json(response, 200, {plan: executed, execution});
    return true;
  }
  let planningMatch = url.pathname.match(/^\/api\/planning\/jobs\/([A-Za-z0-9_-]+)$/);
  if (request.method === "GET" && planningMatch) {
    const sourceJobId = id(planningMatch[1], "任务编号");
    const result = await runner.planningResult(sourceJobId);
    if (result.job.status === "succeeded" && result.artifact?.proposal) await persistPlanningAssistantMessage(sourceJobId);
    json(response, 200, result);
    return true;
  }
  let qualityMatch = url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/quality-lab$/);
  if (request.method === "GET" && qualityMatch) {
    const bookId = id(qualityMatch[1], "作品编号");
    json(response, 200, {
      baselines: store.listQualityBenchmarks(bookId).map((item) => {
        const snapshot = item.snapshot as Record<string, unknown>;
        return {...item, snapshot: {...snapshot, chapterBodies: undefined}};
      }),
      runs: store.listQualityBenchmarkRuns(bookId).map(publicQualityRun),
    });
    return true;
  }
  if (request.method === "POST" && qualityMatch) {
    const bookId = id(qualityMatch[1], "作品编号");
    const value = await body(request);
    const chapters = [...new Set((Array.isArray(value.chapters) ? value.chapters : []).map(Number))]
      .filter((item) => Number.isInteger(item) && item > 0).sort((left, right) => left - right);
    if (!chapters.length || chapters.length > 12) throw new Error("质量基线需要选择 1—12 个已有正文的章节");
    const files = await listProjectFiles(root, bookId);
    const chapterBodies: Record<string, Record<string, unknown>> = {};
    for (const chapter of chapters) {
      const file = files.find((item) => item.category === "drafts" && Number(item.name.match(/^chapter-(\d+)\.md$/)?.[1]) === chapter);
      if (!file) throw new Error(`第 ${chapter} 章没有可建立基线的正文`);
      const content = await readProjectFile(root, file.path);
      chapterBodies[String(chapter)] = {content: content.content, hash: content.hash};
    }
    const report = (await python.qualityReport(bookId, chapters)).value;
    const name = String(value.name || `章节质量基线 ${new Date().toLocaleDateString("zh-CN")}`).trim().slice(0, 80);
    const baseline = store.saveQualityBenchmark({bookId, name, chapters, snapshot: {chapterBodies, report}});
    const snapshot = baseline.snapshot as Record<string, unknown>;
    json(response, 201, {...baseline, snapshot: {...snapshot, chapterBodies: undefined}});
    return true;
  }
  qualityMatch = url.pathname.match(/^\/api\/quality-lab\/baselines\/([A-Za-z0-9_-]+)\/run$/);
  if (request.method === "POST" && qualityMatch) {
    const baseline = store.getQualityBenchmark(id(qualityMatch[1], "质量基线编号"));
    if (!baseline) throw new Error("质量基线不存在");
    const bookId = String(baseline.bookId);
    const chapters = baseline.chapters as number[];
    const snapshot = baseline.snapshot as Record<string, unknown>;
    const baseBodies = snapshot.chapterBodies as Record<string, Record<string, unknown>>;
    const files = await listProjectFiles(root, bookId);
    const report = (await python.qualityReport(bookId, chapters)).value;
    const currentReports = new Map((Array.isArray(report.chapter_reports) ? report.chapter_reports : []).map((item: any) => [Number(item.chapter), item]));
    const baseReport = snapshot.report as Record<string, unknown>;
    const baseReports = new Map((Array.isArray(baseReport.chapter_reports) ? baseReport.chapter_reports : []).map((item: any) => [Number(item.chapter), item]));
    const pairs = [];
    for (const chapter of chapters) {
      const file = files.find((item) => item.category === "drafts" && Number(item.name.match(/^chapter-(\d+)\.md$/)?.[1]) === chapter);
      if (!file) throw new Error(`第 ${chapter} 章当前正文不存在，无法对照`);
      const current = await readProjectFile(root, file.path);
      const base = baseBodies[String(chapter)] || {};
      const baselineFirst = createHash("sha256").update(`${baseline.id}:${chapter}:${String(base.hash || "")}:${current.hash}`).digest()[0] % 2 === 0;
      const baselineVersion = {content: String(base.content || ""), metrics: baseReports.get(chapter) || {}};
      const currentVersion = {content: current.content, metrics: currentReports.get(chapter) || {}};
      pairs.push({chapter, A: baselineFirst ? baselineVersion : currentVersion, B: baselineFirst ? currentVersion : baselineVersion, truth: {A: baselineFirst ? "baseline" : "current", B: baselineFirst ? "current" : "baseline"}});
    }
    const run = store.saveQualityBenchmarkRun({benchmarkId: String(baseline.id), bookId, comparison: {pairs, baselineReport: snapshot.report, currentReport: report}});
    json(response, 201, publicQualityRun(run));
    return true;
  }
  qualityMatch = url.pathname.match(/^\/api\/quality-lab\/runs\/([A-Za-z0-9_-]+)\/judgment$/);
  if (request.method === "POST" && qualityMatch) {
    const value = await body(request);
    const chapter = Number(value.chapter);
    const choice = String(value.choice) as "A" | "B" | "tie";
    const rationale = String(value.rationale || "").trim();
    if (!Number.isInteger(chapter) || chapter <= 0 || !["A", "B", "tie"].includes(choice)) throw new Error("盲评结果无效");
    if (!rationale || rationale.length > 1000) throw new Error("请填写 1—1000 字的选择依据");
    json(response, 200, publicQualityRun(store.saveQualityJudgment(id(qualityMatch[1], "质量对照编号"), chapter, choice, rationale)));
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
  match = url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/author-binding\/preview$/);
  if (request.method === "POST" && match) {
    const value = await body(request);
    const versionId = id(String(value.authorProfileVersionId || value.versionId || ""), "作者版本编号");
    json(response, 200, (await python.previewAuthorBinding(id(match[1], "作品编号"), versionId)).value);
    return true;
  }
  match = url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/author-binding$/);
  if (request.method === "GET" && match) {
    json(response, 200, await bindingAudit(id(match[1], "作品编号")));
    return true;
  }
  match = url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/author-binding$/);
  if (request.method === "PUT" && match) {
    const value = await body(request);
    const versionId = id(String(value.authorProfileVersionId || value.versionId || ""), "作者版本编号");
    json(response, 200, (await python.bindAuthorVersion(id(match[1], "作品编号"), versionId)).value);
    return true;
  }
  match = url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/writing-policy$/);
  if (request.method === "GET" && match) {
    const audit = await bindingAudit(id(match[1], "作品编号"));
    json(response, 200, {writingPolicy: audit.compiledPolicy, activeWorkflowPolicy: audit.activeWorkflowPolicy, effectState: audit.effectState});
    return true;
  }
  match = url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/preferences$/);
  if (request.method === "GET" && match) {
    const bookId = id(match[1], "作品编号");
    const result = (await python.authorOverrides(bookId)).value;
    json(response, 200, {preferences: result.overrides || []});
    return true;
  }
  let overrideMatch = url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/overrides\/([A-Za-z0-9_-]+)$/);
  if (request.method === "PUT" && overrideMatch) {
    const bookId = id(overrideMatch[1], "作品编号");
    const overrideId = id(overrideMatch[2], "覆盖规则编号");
    const value = await body(request);
    const current = ((await python.authorOverrides(bookId)).value.overrides || []) as Array<Record<string, unknown>>;
    const found = current.find((item) => item.id === overrideId);
    if (!found) throw new Error("本书覆盖规则不存在");
    const result = (await python.setAuthorOverride(bookId, {...found, ...value, id: overrideId})).value;
    json(response, 200, {preference: result.override, preferences: result.overrides});
    return true;
  }
  if (request.method === "DELETE" && overrideMatch) {
    const result = (await python.deleteAuthorOverride(id(overrideMatch[1], "作品编号"), id(overrideMatch[2], "覆盖规则编号"))).value;
    json(response, 200, {preference: result.override, preferences: result.overrides});
    return true;
  }
  let preferenceMatch = url.pathname.match(/^\/api\/preferences\/([A-Za-z0-9_-]+)$/);
  if (request.method === "PUT" && preferenceMatch) {
    throw new Error("旧 author_preferences 已迁移为本书覆盖规则并设为只读；请使用项目 overrides 接口");
  }
  if (request.method === "DELETE" && preferenceMatch) {
    throw new Error("旧 author_preferences 已迁移为本书覆盖规则并设为只读；请使用项目 overrides 接口");
  }
  const outlineMatch = url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/outline$/);
  if (request.method === "GET" && outlineMatch) {
    json(response, 200, (await python.outline(id(outlineMatch[1], "作品编号"))).value);
    return true;
  }
  let rebuildMatch = url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/rebuild-preview$/);
  if (request.method === "GET" && rebuildMatch) {
    const bookId = id(rebuildMatch[1], "作品编号");
    const scopeType = String(url.searchParams.get("scopeType") || "") as "chapter" | "volume" | "book";
    if (!["chapter", "volume", "book"].includes(scopeType)) throw new Error("重建层级无效");
    const scopeId = String(url.searchParams.get("scopeId") || (scopeType === "book" ? "book" : "")).trim();
    if (!scopeId) throw new Error("重建范围不能为空");
    json(response, 200, (await python.previewRebuild(bookId, scopeType, scopeId)).value);
    return true;
  }
  rebuildMatch = url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/rebuild$/);
  if (request.method === "POST" && rebuildMatch) {
    const bookId = id(rebuildMatch[1], "作品编号");
    if (store.activeJobForBook(bookId)) throw new Error("本书仍有 Antigravity 任务运行，禁止删除其输入与产物");
    const value = await body(request);
    const scopeType = String(value.scopeType || "") as "chapter" | "volume" | "book";
    if (!["chapter", "volume", "book"].includes(scopeType)) throw new Error("重建层级无效");
    const scopeId = String(value.scopeId || (scopeType === "book" ? "book" : "")).trim();
    const confirmation = String(value.confirmation || "");
    // Validate Studio's scope lineage before mutating the Python project. A
    // fail-closed cleanup must not leave a successfully rebuilt book with
    // stale jobs, quality snapshots or progress artifacts behind.
    const rebuildPreview = (await python.previewRebuild(bookId, scopeType, scopeId)).value as {chapter_numbers?: unknown[]};
    const previewChapterNumbers = Array.isArray(rebuildPreview.chapter_numbers) ? rebuildPreview.chapter_numbers.map(Number) : [];
    store.purgeRebuiltScope(bookId, scopeType, scopeId, previewChapterNumbers, {dryRun: true});
    const {rebuilt, studioCleanup} = await python.withBookTransaction(bookId, async (transactionId) => {
      const rebuilt = (await python.rebuild(bookId, scopeType, scopeId, confirmation)).value;
      const studioCleanup = store.purgeRebuiltScope(bookId, scopeType, scopeId, Array.isArray(rebuilt.chapter_numbers) ? rebuilt.chapter_numbers.map(Number) : [], {transactionId});
      return {rebuilt, studioCleanup};
    });
    lastProjectRefresh = 0;
    if (studioCleanup.cleanupPending && !existsSync(studioCleanup.cleanupPending)) delete studioCleanup.cleanupPending;
    json(response, 200, {...rebuilt, studioCleanup});
    return true;
  }
  match = url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/revision-briefs$/);
  if (request.method === "GET" && match) {
    json(response, 200, {briefs: store.listRevisionBriefs(id(match[1], "作品编号"))});
    return true;
  }
  let readerMatch = url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/reader-feedback$/);
  if (request.method === "GET" && readerMatch) {
    const bookId = id(readerMatch[1], "作品编号");
    const scopeType = url.searchParams.get("scopeType") || undefined;
    if (scopeType && !["book", "volume", "chapter"].includes(scopeType)) throw new Error("反馈层级无效");
    const scopeId = url.searchParams.get("scopeId") || "";
    json(response, 200, {feedback: store.listReaderFeedback(bookId, scopeType as "book" | "volume" | "chapter" | undefined, scopeId).map(readerFeedbackView)});
    return true;
  }
  if (request.method === "POST" && readerMatch) {
    const bookId = id(readerMatch[1], "作品编号");
    const value = await body(request);
    const scopeType = String(value.scopeType || "");
    if (!["book", "volume", "chapter"].includes(scopeType)) throw new Error("反馈层级必须是全书、分卷或章节");
    const scopeId = String(value.scopeId || (scopeType === "book" ? "book" : "")).trim();
    if (!scopeId || !/^[A-Za-z0-9_-]+$/.test(scopeId)) throw new Error("反馈范围编号无效");
    const content = String(value.content || "").trim();
    if (!content || content.length > 4_000) throw new Error("读后反馈必须为 1—4000 个字符");
    if (store.activeJobForBook(bookId)) throw new Error("同一本书已有 Antigravity 任务正在运行，请等待或先取消");
    const parentFeedbackId = value.parentFeedbackId ? id(String(value.parentFeedbackId), "父反馈编号") : null;
    const requestedMode = String(value.reviewMode || "targeted");
    if (!["targeted", "full_scope"].includes(requestedMode)) throw new Error("反馈审查模式无效");
    const reviewMode = requestedMode === "full_scope" || explicitFullScopeRequest(content) ? "full_scope" : "targeted";
    const feedback = store.createReaderFeedback({bookId, scopeType: scopeType as "book" | "volume" | "chapter", scopeId, content, parentFeedbackId, reviewMode});
    try {
      const thread = store.readerFeedbackThread(feedback.id);
      const {context, eligibleChapters, manifest} = await readerFeedbackContext(bookId, feedback.scopeType, scopeId, thread);
      store.updateReaderFeedback(feedback.id, {contextManifest: manifest, requestedChapters: reviewMode === "full_scope" ? eligibleChapters : []});
      const started = await runner.startReaderFeedbackEvaluation({...feedback, context, eligibleChapters, feedbackId: feedback.id});
      json(response, 202, {feedback: readerFeedbackView(store.getReaderFeedback(feedback.id)!), ...started});
    } catch (error) {
      store.updateReaderFeedback(feedback.id, {status: "failed"});
      throw error;
    }
    return true;
  }
  readerMatch = url.pathname.match(/^\/api\/reader-feedback\/([A-Za-z0-9_-]+)$/);
  if (request.method === "GET" && readerMatch) {
    json(response, 200, await readerFeedbackDetail(id(readerMatch[1], "反馈编号")));
    return true;
  }
  readerMatch = url.pathname.match(/^\/api\/reader-feedback\/([A-Za-z0-9_-]+)\/reevaluate$/);
  if (request.method === "POST" && readerMatch) {
    const feedback = store.getReaderFeedback(id(readerMatch[1], "反馈编号"));
    if (!feedback) throw new Error("读后反馈不存在");
    if (["evaluating", "reworking", "applied"].includes(feedback.status)) throw new Error("当前反馈状态不能重新评估");
    if (store.activeJobForBook(feedback.bookId)) throw new Error("同一本书已有 Antigravity 任务正在运行，请等待或先取消");
    store.updateReaderFeedback(feedback.id, {reviewMode: "full_scope", status: "evaluating"});
    try {
      const updated = store.getReaderFeedback(feedback.id)!;
      const thread = store.readerFeedbackThread(updated.id);
      const {context, eligibleChapters, manifest} = await readerFeedbackContext(updated.bookId, updated.scopeType, updated.scopeId, thread);
      context.reevaluation_of = {feedback_id: updated.id, prior_job_id: feedback.jobId, reason: "旧评估未执行用户锁定的全文范围"};
      manifest.contextHash = createHash("sha256").update(JSON.stringify(context)).digest("hex");
      store.updateReaderFeedback(updated.id, {contextManifest: manifest, requestedChapters: eligibleChapters});
      const started = await runner.startReaderFeedbackEvaluation({...updated, context, eligibleChapters, feedbackId: updated.id});
      json(response, 202, {feedback: readerFeedbackView(store.getReaderFeedback(updated.id)!), ...started});
    } catch (error) {
      store.updateReaderFeedback(feedback.id, {status: "failed"});
      throw error;
    }
    return true;
  }
  readerMatch = url.pathname.match(/^\/api\/reader-feedback\/([A-Za-z0-9_-]+)\/rework$/);
  if (request.method === "POST" && readerMatch) {
    const feedback = store.getReaderFeedback(id(readerMatch[1], "反馈编号"));
    if (!feedback) throw new Error("读后反馈不存在");
    if (feedback.supersededById) throw new Error("这轮评估已被后续补充取代，请在反馈线程最新一轮确认返工");
    if (feedback.status !== "evaluated" || feedback.evaluation.verdict !== "actionable") throw new Error("只有已经完成且可执行的反馈评估才能启动重做");
    const chapters = Array.isArray(feedback.evaluation.affected_chapters) ? feedback.evaluation.affected_chapters.map(Number).filter((item) => Number.isInteger(item) && item > 0) : [];
    if (feedback.reviewMode === "full_scope" && JSON.stringify([...chapters].sort((a, b) => a - b)) !== JSON.stringify([...feedback.requestedChapters].sort((a, b) => a - b))) throw new Error("旧评估擅自缩小了用户锁定的全文范围，已禁止返工；请先按全文模式重新评估");
    if (!chapters.length) throw new Error("反馈评估没有可重做的已生成章节");
    if (store.activeJobForBook(feedback.bookId)) throw new Error("同一本书已有任务运行，反馈重做尚未启动");
    const thread = store.readerFeedbackThread(feedback.id);
    const liveContext = await readerFeedbackContext(feedback.bookId, feedback.scopeType, feedback.scopeId, thread);
    assertFeedbackSnapshot(feedback.contextManifest, liveContext.manifest);
    const preserve = Array.isArray(feedback.evaluation.preserve) ? feedback.evaluation.preserve.map(String) : [];
    const changes = Array.isArray(feedback.evaluation.changes) ? feedback.evaluation.changes.map(String) : [];
    const risks = Array.isArray(feedback.evaluation.risks) ? feedback.evaluation.risks.map(String) : [];
    const proposedRules = Array.isArray(feedback.evaluation.proposed_book_rules) ? feedback.evaluation.proposed_book_rules as Array<Record<string, unknown>> : [];
    if (!proposedRules.length) throw new Error("反馈评估没有形成可确认的本书长期质量规则，请先重新评估");
    const confirmedRules: Array<Record<string, unknown>> = [];
    for (const [index, rule] of proposedRules.entries()) {
      confirmedRules.push({
        id: `override-${feedback.id}-${index + 1}`,
        category: String(rule.category || "其他"), rule: String(rule.rule || ""),
        evidence: `来自反馈线程 ${feedback.rootFeedbackId} 第 ${feedback.sequence} 轮；评估证据 ${Array.isArray(rule.evidence_refs) ? rule.evidence_refs.map(String).join("、") : "未标注"}`,
        enabled: true, source_id: `reader-feedback:${feedback.id}:${index + 1}`,
      });
    }
    const instruction = validateReworkInstruction([
      "完整读后反馈线程：",
      ...thread.map((item) => `第 ${item.sequence} 轮：${item.content}`),
      `评估结论：${String(feedback.evaluation.summary || "")}`,
      `必须保留：${preserve.join("；") || "未指定"}`,
      `必须修改：${changes.join("；")}`,
      `需要防止：${risks.join("；") || "无额外风险"}`,
      "已确认写入本书并必须持续执行的长期质量约束：",
      ...confirmedRules.map((item, index) => `${index + 1}. [${String(item.category || "其他")}] ${String(item.rule || "")}`),
      `返工验收：${String(feedback.evaluation.compiled_instruction || "必须逐项落实反馈并重新通过全部严格审查")}`,
    ].join("\n"));
    const started = (await python.startScopeRework(feedback.bookId, chapters, feedback.scopeType, feedback.scopeId, instruction, 5, confirmedRules)).value;
    const run = started.run as Record<string, unknown>;
    const runId = String(run.run_id || "");
    store.updateReaderFeedback(feedback.id, {status: "reworking", workflowId: runId});
    const agent = await runner.startContinuous(runId);
    json(response, 202, {feedback: store.getReaderFeedback(feedback.id), workflow: run, agent, bookRules: confirmedRules});
    return true;
  }
  let briefMatch = url.pathname.match(/^\/api\/revision-briefs\/([A-Za-z0-9_-]+)\/start$/);
  if (request.method === "POST" && briefMatch) {
    const brief = store.getRevisionBrief(id(briefMatch[1], "返工方案编号"));
    if (!brief) throw new Error("返工方案不存在");
    if (brief.status !== "pending") throw new Error("该返工方案已处理");
    const active = store.activeJobForBook(brief.bookId);
    if (active) throw new Error("同一本书已有任务运行，返工方案未启动");
    const claim = randomUUID();
    if (!store.claimRevisionBrief(brief.id, claim)) throw new Error("返工方案正在处理或已经启动");
    try {
      const started = await python.startRework(brief.bookId, brief.chapter, brief.feedback, 5, brief.id);
      store.updateRevisionBriefStatus(brief.id, "started");
      json(response, 202, {brief: store.getRevisionBrief(brief.id), workflow: started.value});
    } finally { store.releaseRevisionBrief(brief.id, claim); }
    return true;
  }
  if (request.method === "PUT" && outlineMatch) {
    const bookId = id(outlineMatch[1], "作品编号");
    if (store.activeJobForBook(bookId)) throw new Error("同一本书已有 Antigravity 任务正在运行；为避免大纲与生成快照错位，请等待任务完成或先取消");
    const projectState = (await python.project(bookId)).value as {workflows?: Array<{status?: string}>};
    if (projectState.workflows?.some((workflow) => workflow.status === "running")) throw new Error("本书仍有严格工作流处于运行或暂停恢复状态；请先完成或停止该流程，再修改三级大纲");
    const value = await body(request);
    if (value.planning_contract_update && !Array.isArray(value.planning_contract_update) && typeof value.planning_contract_update === "object") {
      const prepared = await ensureAuthorPolicy(bookId, "大纲与约束保存");
      const project = prepared.project;
      const outline = (await python.outline(bookId)).value as {master?: Record<string, unknown>; chapters?: Array<Record<string, unknown>>; foundation_contract?: Record<string, unknown> | null};
      const update = {...value.planning_contract_update as Record<string, unknown>};
      const sourceJobIds = [...new Set((Array.isArray(update.source_job_ids) ? update.source_job_ids : [update.source_job_id]).map(String).filter(Boolean))];
      if (!sourceJobIds.length) throw new Error("约束变更缺少可追踪的共创任务来源");
      if (sourceJobIds.length !== 1) throw new Error("一次保存只能绑定一个规划候选；旧候选不能与新候选拼接，请重新生成单一候选");
      const authorContract = prepared.contract;
      const foundationContract = publicFoundationContract(outline.foundation_contract) || {};
      const canon = await jsonFile(join(root, "books", bookId, "canon", "current.json")) || {};
      const liveBaseHashes = {
        author_contract_hash: canonicalJsonHash(authorContract),
        author_profile_hash: String(authorContract.profile_hash || ""),
        foundation_contract_hash: planningFoundationContractHash(foundationContract),
        canon_hash: canonicalJsonHash(canon),
      };
      const sourceArtifacts: Array<{jobId: string; artifactHash: string; artifact: Record<string, unknown>; delta: Record<string, unknown>; lineage: Record<string, unknown>}> = [];
      for (const sourceJobId of sourceJobIds) {
        const sourceJob = store.getJob(sourceJobId);
        if (!sourceJob || sourceJob.bookId !== bookId || sourceJob.status !== "succeeded" || !(/^planning_(book|volume|chapter|chapters)$/.test(sourceJob.stage) || sourceJob.stage === "candidate_blind_review")) {
          throw new Error(`约束变更来源任务无效或不属于当前作品：${sourceJobId}`);
        }
        const result = await runner.planningResult(sourceJobId);
        if (!result.artifact || !result.artifactHash) throw new Error(`共创候选缺少可核验原始产物：${sourceJobId}`);
        const rawDelta = result.artifact.constraint_delta;
        if (!rawDelta || Array.isArray(rawDelta) || typeof rawDelta !== "object") throw new Error(`共创候选没有约束差异：${sourceJobId}`);
        const lineage = store.getJobResult(result.job.id).lineage;
        const contextHashes = lineage.planningContextHashes;
        if (!contextHashes || Array.isArray(contextHashes) || typeof contextHashes !== "object") {
          throw new Error(`共创候选缺少作者、Canon 与约束冻结快照，请重新生成：${sourceJobId}`);
        }
        const frozenHashes = contextHashes as Record<string, unknown>;
        for (const key of Object.keys(liveBaseHashes) as Array<keyof typeof liveBaseHashes>) {
          const frozen = String(frozenHashes[key] || "");
          if (frozen !== liveBaseHashes[key]) {
            throw new Error(`共创候选输入已过期（${key} 已变化），旧废案不会写入；请基于当前作者、Canon 与约束重新生成`);
          }
        }
        const planningScope = String(lineage.planningScope || sourceJob.stage.replace(/^planning_/, ""));
        const planningMode = lineage.planningMode === "rewrite" ? "rewrite" : "fill";
        if (!["book", "volume", "chapter", "chapters"].includes(planningScope)) throw new Error(`共创候选缺少可追踪的规划范围：${sourceJobId}`);
        const frozenSnapshot = lineage.planningContextSnapshot && !Array.isArray(lineage.planningContextSnapshot) && typeof lineage.planningContextSnapshot === "object"
          ? lineage.planningContextSnapshot as Record<string, unknown> : null;
        if (!frozenSnapshot) throw new Error(`共创候选缺少规划编辑器冻结快照，请重新生成：${sourceJobId}`);
        const frozenSelection = frozenSnapshot.selected_ids && !Array.isArray(frozenSnapshot.selected_ids) && typeof frozenSnapshot.selected_ids === "object"
          ? frozenSnapshot.selected_ids as Record<string, unknown> : {};
        const currentChapters = (outline.chapters || []).map((item) => item.contract && typeof item.contract === "object" ? item.contract as Record<string, unknown> : item);
        const selectedNumbers = Array.isArray(frozenSnapshot.selected_chapter_numbers) ? frozenSnapshot.selected_chapter_numbers.map(Number).filter((item) => Number.isInteger(item) && item > 0) : [];
        const currentByNumber = new Map(currentChapters.map((item) => [Number(item.chapter_number), item]));
        const selectedId = String(frozenSelection.id || "");
        const liveContext: Record<string, unknown> = {
          book: project.book || {}, master: outline.master || {}, chapters: currentChapters,
          selected: planningScope === "volume"
            ? {volume_id: selectedId}
            : planningScope === "chapter"
              ? {chapter_number: Number(selectedId), volume_id: String(frozenSelection.volume_id || currentByNumber.get(Number(selectedId))?.volume_id || "")}
              : {},
          selectedChapterNumbers: selectedNumbers,
          boundaries: planningScope === "chapters" && selectedNumbers.length
            ? {previous: currentByNumber.get(Math.min(...selectedNumbers) - 1) || null, next: currentByNumber.get(Math.max(...selectedNumbers) + 1) || null}
            : {},
          clearSelectedOutline: lineage.planningClearSelectedOutline === true,
        };
        const liveSnapshot = planningSnapshotFromContext(planningScope as "book" | "volume" | "chapter" | "chapters", planningMode, liveContext);
        const livePlanningHashes = planningSnapshotHashes(liveSnapshot);
        for (const key of Object.keys(livePlanningHashes)) {
          const frozen = String(frozenHashes[key] || "");
          if (!frozen || frozen !== livePlanningHashes[key]) {
            throw new Error(`共创候选规划上下文已过期（${key} 已变化），旧废案不会写入；请重新生成候选`);
          }
        }
        const deltaForScope = result.artifact.constraint_delta && !Array.isArray(result.artifact.constraint_delta) && typeof result.artifact.constraint_delta === "object"
          ? result.artifact.constraint_delta as Record<string, unknown> : {};
        const proposal = result.artifact.proposal && !Array.isArray(result.artifact.proposal) && typeof result.artifact.proposal === "object"
          ? result.artifact.proposal as Record<string, unknown> : {};
        const proposalVolumes = new Set([
          ...(Array.isArray((outline.master || {}).volumes) ? ((outline.master || {}).volumes as Array<Record<string, unknown>>).map((item) => String(item.volume_id || "")) : []),
          ...(Array.isArray(proposal.volumes) ? (proposal.volumes as Array<Record<string, unknown>>).map((item) => String(item?.volume_id || "")) : []),
        ].filter(Boolean));
        const allowedChapterIds = new Set(selectedNumbers.map((item) => String(item)));
        if (planningScope === "chapter") allowedChapterIds.add(String(Number(selectedId)));
        const rawChanges = Array.isArray(deltaForScope.changes) ? deltaForScope.changes as Array<Record<string, unknown>> : [];
        const seenConstraintIds = new Set<string>();
        const seenChangeKeys = new Set<string>();
        for (const change of rawChanges) {
          const operation = String(change.operation || "");
          const scopeType = String(change.scope_type || "");
          const scopeId = String(change.scope_id || "");
          const constraintId = String(change.constraint_id || "");
          if (operation !== "add" && constraintId) {
            if (seenConstraintIds.has(constraintId)) throw new Error(`共创候选重复修改同一约束 ${constraintId}；拒绝合并冲突差异`);
            seenConstraintIds.add(constraintId);
          }
          const changeKey = `${operation}|${scopeType}|${scopeId}|${constraintId}|${String(change.category || "")}|${String(change.rule || "")}`;
          if (seenChangeKeys.has(changeKey)) throw new Error("共创候选包含重复约束差异；请重新生成单一候选");
          seenChangeKeys.add(changeKey);
          const allowed = planningScope === "book"
            ? (scopeType === "book" && scopeId === "book" || scopeType === "volume" && proposalVolumes.has(scopeId))
            : planningScope === "volume"
              ? scopeType === "volume" && scopeId === selectedId
              : scopeType === "chapter" && allowedChapterIds.has(String(Number(scopeId)));
          if (!allowed) throw new Error(`共创候选约束越权：${scopeType}/${scopeId} 不属于当前 ${planningScope} 范围`);
        }
        sourceArtifacts.push({jobId: sourceJobId, artifactHash: result.artifactHash, artifact: result.artifact, delta: rawDelta as Record<string, unknown>, lineage});
      }
      const source = sourceArtifacts[0];
      const sourceScope = String(source.lineage.planningScope || "") as "book" | "volume" | "chapter" | "chapters";
      const sourceMode = source.lineage.planningMode === "rewrite" ? "rewrite" : "fill";
      const sourceSnapshot = source.lineage.planningContextSnapshot && !Array.isArray(source.lineage.planningContextSnapshot) && typeof source.lineage.planningContextSnapshot === "object"
        ? source.lineage.planningContextSnapshot as Record<string, unknown> : null;
      if (!sourceSnapshot || !["book", "volume", "chapter", "chapters"].includes(sourceScope)) throw new Error("共创候选缺少可验证的规划范围或编辑器快照，请重新生成");
      const expectedSnapshot = applyPlanningProposal(sourceSnapshot, sourceScope, source.artifact.proposal && !Array.isArray(source.artifact.proposal) && typeof source.artifact.proposal === "object" ? source.artifact.proposal as Record<string, unknown> : {});
      const selectedMeta = expectedSnapshot.selected_ids && !Array.isArray(expectedSnapshot.selected_ids) && typeof expectedSnapshot.selected_ids === "object" ? expectedSnapshot.selected_ids : {};
      const expectedBoundaries = expectedSnapshot.boundaries && !Array.isArray(expectedSnapshot.boundaries) && typeof expectedSnapshot.boundaries === "object" ? expectedSnapshot.boundaries : {};
      const submittedSnapshot = planningSnapshotFromPayload(value, sourceScope, sourceMode, {
        selected_ids: selectedMeta,
        selected_chapter_numbers: expectedSnapshot.selected_chapter_numbers,
        boundaries: expectedBoundaries,
        clear_selected_outline: expectedSnapshot.clear_selected_outline === true,
      });
      const submittedSelection = update.planning_selection && !Array.isArray(update.planning_selection) && typeof update.planning_selection === "object"
        ? update.planning_selection as Record<string, unknown> : null;
      if (!submittedSelection || planningCanonicalJson({
        selected_ids: submittedSelection.selected_ids || {},
        selected_chapter_numbers: submittedSelection.selected_chapter_numbers || [],
        boundaries: submittedSelection.boundaries || {previous: null, next: null},
        clear_selected_outline: submittedSelection.clear_selected_outline === true,
      }) !== planningCanonicalJson({
        selected_ids: expectedSnapshot.selected_ids || {},
        selected_chapter_numbers: expectedSnapshot.selected_chapter_numbers || [],
        boundaries: expectedSnapshot.boundaries || {previous: null, next: null},
        clear_selected_outline: expectedSnapshot.clear_selected_outline === true,
      })) {
        throw new Error("规划候选绑定的选中章节、批量边界或清空授权已变化；不能把旧候选应用到新范围");
      }
      if (planningCanonicalJson(expectedSnapshot) !== planningCanonicalJson(submittedSnapshot)) {
        throw new Error("提交的大纲不是该规划候选的唯一预期结果；候选应用后又发生了手动修改，或选中/批量范围已变化，请重新生成候选");
      }
      const exactChanges = sourceArtifacts.flatMap(({delta}) => Array.isArray(delta.changes) ? delta.changes : []);
      const submittedChanges = Array.isArray(update.changes) ? update.changes : [];
      if (canonicalJsonHash(submittedChanges) !== canonicalJsonHash(exactChanges)) {
        throw new Error("前端提交的约束差异与 Antigravity 原始候选不一致；已拒绝保存，避免废案或手工拼接污染正式约束");
      }
      const candidateBaseHashes = new Set(sourceArtifacts.map(({delta}) => String(delta.base_contract_hash || "")));
      if (candidateBaseHashes.size !== 1 || !candidateBaseHashes.has(liveBaseHashes.foundation_contract_hash)) {
        throw new Error("共创候选基于旧版全书约束，不能覆盖当前快照；请重新生成候选");
      }
      const liveIncomplete = foundationIncompleteCategories(foundationContract);
      if (liveIncomplete.length) {
        validateFoundationCompletionDelta({constraint_delta: {base_contract_hash: liveBaseHashes.foundation_contract_hash, changes: exactChanges}}, liveIncomplete);
      }
      update.source_job_ids = sourceJobIds;
      update.source_job_id = sourceJobIds.at(-1) || "";
      update.source_artifact_hashes = Object.fromEntries(sourceArtifacts.map((item) => [item.jobId, item.artifactHash]));
      update.planning_context_hashes = store.getJobResult(sourceArtifacts[0].jobId).lineage.planningContextHashes || {};
      update.planning_context_snapshot = store.getJobResult(sourceArtifacts[0].jobId).lineage.planningContextSnapshot || null;
      update.changes = exactChanges;
      update.rationale = sourceArtifacts.flatMap(({artifact}) => Array.isArray(artifact.rationale) ? artifact.rationale.map(String) : []);
      update.warnings = sourceArtifacts.flatMap(({artifact}) => Array.isArray(artifact.warnings) ? artifact.warnings.map(String) : []);
      const application = sourceArtifacts[0].artifact.author_application;
      update.author_application = application && !Array.isArray(application) && typeof application === "object" ? application : {};
      const readerWorldContract = sourceArtifacts[0].artifact.reader_world_contract;
      update.reader_world_contract = readerWorldContract && !Array.isArray(readerWorldContract) && typeof readerWorldContract === "object"
        ? readerWorldContract : {};
      update.author_contract_snapshot = authorContract;
      update.author_binding_snapshot = planningAuthorBinding(prepared.binding) || {};
      value.planning_contract_update = update;
    }
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
    const path = String(value.path || "");
    const bookId = relative(join(root, "books"), resolve(path)).split(/[\\/]/)[0];
    // Keep the book lease but compensate only this file; saving a chapter
    // must not copy every other chapter, Canon and workflow artifact.
    const result = await python.withBookTransaction(id(bookId, "作品编号"), () => saveProjectFile(root, path, String(value.content || ""), String(value.expectedHash || ""), () => {
      if (store.activeJobForBook(bookId)) throw new Error("同一本书已有任务运行，请先停止后再编辑文件");
    }), {file: path});
    json(response, 200, result);
    return true;
  }
  match = url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/chapters\/(\d+)\/deslop$/);
  if (request.method === "GET" && match) {
    const bookId = id(match[1], "作品编号");
    const chapter = Number(match[2]);
    if (!Number.isInteger(chapter) || chapter < 1) throw new Error("章节编号无效");
    const quoteMode = deslopQuoteMode(url.searchParams.get("quoteMode") || url.searchParams.get("quote_mode") || "keep");
    json(response, 200, (await python.deslop(bookId, chapter, false, quoteMode)).value);
    return true;
  }
  if (request.method === "POST" && match) {
    const bookId = id(match[1], "作品编号");
    const chapter = Number(match[2]);
    if (!Number.isInteger(chapter) || chapter < 1) throw new Error("章节编号无效");
    const value = await body(request);
    if (value.apply !== undefined && typeof value.apply !== "boolean") throw new Error("去AI味 apply 必须是布尔值");
    const apply = value.apply === true;
    const quoteMode = deslopQuoteMode(value.quoteMode ?? value.quote_mode ?? "keep");
    if (apply) await assertDeslopApplyAllowed(bookId);
    json(response, 200, (await python.deslop(bookId, chapter, apply, quoteMode)).value);
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/workflows") {
    const value = await body(request);
    const bookId = id(String(value.bookId || ""), "作品编号");
    const chapters = Array.isArray(value.chapters) ? value.chapters.map(Number).filter((item) => Number.isInteger(item) && item > 0) : [];
    if (!chapters.length) throw new Error("至少选择一个正整数章节号");
    const active = store.activeJobForBook(bookId);
    if (active) throw new Error("同一本书已有 Antigravity 任务正在运行，请先停止后再启动工作流");
    const started = (await python.startWorkflow(bookId, chapters, Math.min(5, Math.max(1, Number(value.maxRevisions || 5))))).value;
    const run = started.run as Record<string, unknown>;
    const auto = value.autoRun !== false ? await runner.startContinuous(String(run.run_id)) : null;
    json(response, 201, { ...started, agent: auto });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/workflows/rework") {
    const value = await body(request);
    const bookId = id(String(value.bookId || ""), "作品编号");
    const chapter = Number(value.chapter);
    const feedback = String(value.feedback || "").trim();
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error("返工章节号无效");
    if (!feedback || feedback.length > 4_000) throw new Error("返工要求必须为 1—4000 个字符");
    const active = store.activeJobForBook(bookId);
    if (active) throw new Error("同一本书已有 Antigravity 任务正在运行，请先停止后再返工");
    const started = (await python.startRework(bookId, chapter, feedback, Math.min(5, Math.max(1, Number(value.maxRevisions || 5))))).value;
    const workflow = started.run as Record<string, unknown>;
    const runId = String(workflow.run_id || "");
    store.addWorkflowFeedback(runId, bookId, "chapter_design", chapter, feedback);
    const agent = value.autoRun !== false ? await runner.startContinuous(runId) : null;
    json(response, 201, {...started, agent});
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
  match = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)$/);
  if (request.method === "GET" && match) {
    const job = store.getJob(id(match[1], "任务编号"));
    if (!job) throw new Error("任务不存在");
    json(response, 200, {job});
    return true;
  }
  match = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)\/artifact$/);
  if (request.method === "GET" && match) {
    const jobId = id(match[1], "任务编号");
    const job = store.getJob(jobId);
    if (!job) throw new Error("任务不存在");
    const result = store.getJobResult(jobId);
    const selectedJob = result.lineage.selectedJobId ? store.getJob(String(result.lineage.selectedJobId)) : null;
    const artifactPath = selectedJob?.outputPath || job.outputPath;
    let artifact: Record<string, unknown> | null = null;
    if (existsSync(artifactPath)) {
      try {
        const value = JSON.parse(await readFile(artifactPath, "utf8")) as unknown;
        if (value && !Array.isArray(value) && typeof value === "object") artifact = value as Record<string, unknown>;
      } catch { artifact = null; }
    }
    json(response, 200, {artifact, ...result});
    return true;
  }
  match = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)\/context-receipt$/);
  if (request.method === "GET" && match) {
    const jobId = id(match[1], "任务编号");
    const job = store.getJob(jobId);
    if (!job) throw new Error("任务不存在");
    const jobResult = store.getJobResult(jobId);
    const selectedJob = jobResult.lineage.selectedJobId ? store.getJob(String(jobResult.lineage.selectedJobId)) : null;
    const sourceJob = selectedJob || job;
    const prompt = existsSync(sourceJob.promptPath) ? await readFile(sourceJob.promptPath, "utf8").catch(() => "") : "";
    const action = jsonObjectAfter(prompt, "## StageActionV2") || {};
    const policy = jsonObjectAfter(prompt, "## 冻结写作策略") || {};
    const allowed = Array.isArray(action.allowed_context) ? action.allowed_context.map(String) : [];
    const schema = action.output_schema && !Array.isArray(action.output_schema) && typeof action.output_schema === "object" ? action.output_schema as Record<string, unknown> : {};
    const properties = schema.properties && !Array.isArray(schema.properties) && typeof schema.properties === "object" ? Object.keys(schema.properties as Record<string, unknown>) : [];
    const executableRules = Array.isArray(policy.executable_style_rules)
      ? (policy.executable_style_rules as unknown[]).filter((item): item is Record<string, unknown> => Boolean(item) && !Array.isArray(item) && typeof item === "object")
      : [];
    const conflicts = Array.isArray(policy.conflicts)
      ? (policy.conflicts as unknown[]).filter((item): item is Record<string, unknown> => Boolean(item) && !Array.isArray(item) && typeof item === "object")
      : [];
    const suppliedCounts = policy.classification_counts && !Array.isArray(policy.classification_counts) && typeof policy.classification_counts === "object"
      ? policy.classification_counts as Record<string, unknown> : {};
    const classificationCounts = Object.keys(suppliedCounts).length ? suppliedCounts : executableRules.reduce((counts, item) => {
      const key = String(item.class || "should");
      counts[key] = Number(counts[key] || 0) + 1;
      return counts;
    }, {} as Record<string, number>);
    json(response, 200, {
      jobId, sourceJobId: sourceJob.id, runId: sourceJob.runId, bookId: sourceJob.bookId, chapter: sourceJob.chapter,
      stage: sourceJob.stage, status: job.status, actionId: String(action.action_id || sourceJob.actionId || ""),
      promptHash: sourceJob.promptHash, outputHash: sourceJob.outputHash, promptEstimatedTokens: Math.ceil(prompt.length / 4),
      policyHash: String(policy.policy_hash || ""),
      contextBlocks: allowed.map((key) => ({key, status: "included", purpose: contextPurpose[key] || "当前阶段经过最小化选择的权威上下文"})),
      executableRules, stageBlueprint: policy.stage_blueprint || {}, conflicts,
      hardRules: policy.hard_rules || null, precedence: policy.precedence || null,
      classificationCounts, unmappedRuleIds: policy.unmapped_rule_ids || [],
      withheldForOtherStages: Number(policy.withheld_for_other_stages || 0),
      outputContract: {required: Array.isArray(schema.required) ? schema.required.map(String) : [], properties},
      lineage: {...jobResult.lineage, inputsHash: action.inputs_hash || jobResult.lineage.inputsHash || ""},
    });
    return true;
  }
  match = url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/chapters\/(\d+)\/cockpit$/);
  if (request.method === "GET" && match) {
    const bookId = id(match[1], "作品编号");
    const chapter = Number(match[2]);
    if (!Number.isInteger(chapter) || chapter < 1) throw new Error("章节编号无效");
    let runId = String(url.searchParams.get("runId") || "");
    if (runId) runId = id(runId, "工作流编号");
    if (!runId) {
      const project = (await python.project(bookId)).value as {workflows?: Array<{id?: string}>};
      runId = String(project.workflows?.[0]?.id || "");
    }
    if (!runId) {
      json(response, 200, {bookId, runId: "", chapter, available: false, readerContract: null, continuityHandoff: null, constraintApplication: [], canonDelta: null, finalValidation: null, qualityGates: [], notice: "本章还没有工作流产物。"});
      return true;
    }
    const stageDir = join(root, "books", bookId, "workflow", runId, `chapter-${String(chapter).padStart(4, "0")}`);
    const design = await jsonFile(join(stageDir, "chapter_design.json"));
    const canonDelta = await jsonFile(join(stageDir, "canon_update.json"));
    const finalValidation = await jsonFile(join(stageDir, "final_validation.json"));
    const qualityGates: Array<{stage: string; passed: boolean | null; summary: string; evidenceCount: number; scorecard: unknown}> = [];
    for (const stage of ["design_review", "review_logic", "review_voice", "review_continuity", "cold_review"]) {
      const artifact = await jsonFile(join(stageDir, `${stage}.json`));
      if (!artifact) continue;
      qualityGates.push({
        stage, passed: typeof artifact.passed === "boolean" ? artifact.passed : null,
        summary: String(artifact.public_summary || artifact.summary || artifact.verdict || (artifact.passed === true ? "通过" : artifact.passed === false ? "未通过" : "已完成")),
        evidenceCount: Array.isArray(artifact.evidence) ? artifact.evidence.length : 0,
        scorecard: artifact.quality_scorecard || null,
      });
    }
    const constraintApplication = Array.isArray(design?.constraint_application)
      ? (design!.constraint_application as unknown[]).filter((item): item is Record<string, unknown> => Boolean(item) && !Array.isArray(item) && typeof item === "object")
      : [];
    const available = Boolean(design || canonDelta || qualityGates.length || finalValidation);
    json(response, 200, {
      bookId, runId, chapter, available,
      readerContract: design?.reader_experience_contract || null,
      continuityHandoff: design?.continuity_handoff || null,
      constraintApplication, canonDelta, finalValidation, qualityGates,
      notice: canonDelta
        ? "计划与实际均有权威产物：以最终正文提取的 Canon 增量为实际结果，不用候选或推测冒充事实。"
        : design ? "当前展示的是已确认计划；正文尚未通过 Canon 更新前，不会把计划冒充为实际结果。" : "本章尚无可对账的结构化设计。",
    });
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
    const send = (event: {id: number; jobId: string; level: string; message: string; createdAt: string}) => response.write(`id: ${event.id}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`);
    for (const event of store.listEvents(jobId, after)) send(event);
    const listener = (event: {id: number; jobId: string; level: string; message: string; createdAt: string}) => { if (event.jobId === jobId) send(event); };
    runner.on("job-event", listener);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    request.on("close", () => { clearInterval(heartbeat); runner.off("job-event", listener); });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/settings") {
    json(response, 200, { antigravity: runner.status(), models: modelProviders.snapshot(), fanqie: fanqie.availability(), skill: await skillSettings(), migration, authorLayerBackup, retention: {days: 7, maxBookMb: 100, defaultAction: "preview"} });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/metrics/stages") {
    json(response, 200, {stages: store.stageMetrics(), runtime: runner.activity()});
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/backups") {
    json(response, 200, {snapshots: await store.listWorkspaceSnapshots(), policy: await store.workspaceSnapshotPolicy()});
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/backups") {
    json(response, 201, await snapshotGuard.snapshot(runner.activity(), () => store.createWorkspaceSnapshot(), 1));
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/model-providers") {
    json(response, 200, modelProviders.snapshot());
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/model-providers") {
    const value = await body(request);
    const provider = modelProviders.saveProvider(value);
    json(response, 201, {...modelProviders.snapshot(), createdProviderId: provider.id});
    return true;
  }
  match = url.pathname.match(/^\/api\/model-providers\/([A-Za-z0-9_-]+)$/);
  if (request.method === "PUT" && match) {
    const value = await body(request);
    modelProviders.saveProvider({...value, id: id(match[1], "供应商编号")});
    json(response, 200, modelProviders.snapshot());
    return true;
  }
  if (request.method === "DELETE" && match) {
    modelProviders.deleteProvider(id(match[1], "供应商编号"));
    json(response, 200, modelProviders.snapshot());
    return true;
  }
  match = url.pathname.match(/^\/api\/model-providers\/([A-Za-z0-9_-]+)\/models\/refresh$/);
  if (request.method === "POST" && match) {
    await modelProviders.refreshModels(id(match[1], "供应商编号"));
    json(response, 200, modelProviders.snapshot());
    return true;
  }
  match = url.pathname.match(/^\/api\/model-routes\/(generation|review|workbench|review_arbitration)$/);
  if (request.method === "PUT" && match) {
    const value = await body(request);
    modelProviders.saveRoute({...value, role: match[1]});
    json(response, 200, modelProviders.snapshot());
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
  match = url.pathname.match(/^\/api\/fanqie\/accounts\/([A-Za-z0-9_-]+)\/takeover$/);
  if (request.method === "POST" && match) {
    const value = await body(request);
    json(response, 200, await fanqie.takeoverAccount(id(match[1], "账号编号"), String(value.confirmation || "")));
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
  if (request.method === "GET" && url.pathname === "/api/fanqie/write-window") {
    json(response, 200, fanqieWriteWindow());
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
    const accountId = store.activeFanqieAccount()?.id || "legacy";
    json(response, 200, {
      book: project.book || null,
      covers,
      platformWorks: store.listWorks(accountId),
      boundPlatformWorkId: store.getMeta(`fanqie_book_work:${accountId}:${bookId}`) || "",
      pendingBatch: await fanqie.pendingBatch(bookId),
    });
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
    json(response, 201, await fanqie.prepareBatch(id(String(value.bookId || ""), "作品编号"), chapters, String(value.platformWorkId || ""), {mode: "immediate"}));
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/fanqie/batches/one-click") {
    const value = await body(request);
    const chapters = Array.isArray(value.chapters) ? value.chapters.map(Number).filter((item) => Number.isInteger(item) && item > 0) : [];
    if (!chapters.length) throw new Error("一键提交至少需要一个已严格通过的章节");
    json(response, 200, await fanqie.prepareOrResumeBatch(id(String(value.bookId || ""), "作品编号"), chapters, String(value.platformWorkId || ""), {mode: "immediate"}));
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/fanqie/publish/preflight") {
    const value = await body(request);
    json(response, 200, await fanqie.preflightPublish(String(value.platformWorkId || "")));
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/fanqie/publish/inspect") {
    const value = await body(request);
    json(response, 200, await fanqie.inspectChapterPage(String(value.platformWorkId || "")));
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/fanqie/publish/inspect-editor") {
    const value = await body(request);
    json(response, 200, await fanqie.inspectChapterEditor(String(value.platformWorkId || ""), String(value.platformChapterId || ""), value.advance === true));
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
  match = url.pathname.match(/^\/api\/fanqie\/batches\/([A-Za-z0-9_-]+)\/abandon$/);
  if (request.method === "POST" && match) {
    json(response, 200, await fanqie.abandonBatch(id(match[1], "批次编号")));
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
    if (desktopToken && request.headers["x-tomota-desktop"] !== desktopToken) {
      json(response, 403, {error: "此服务仅供当前 Tomota 桌面窗口访问"});
      return;
    }
    const hostHeader = request.headers.host || "";
    const parsedHost = hostHeader.startsWith("[") ? hostHeader.slice(1, hostHeader.indexOf("]")) : hostHeader.split(":")[0];
    if (!isLoopbackHost(parsedHost) || !validOrigin(request.headers.origin, hostHeader)) {
      json(response, 403, { error: "Tomota Studio 只接受本机同源请求" });
      return;
    }
    const url = new URL(request.url || "/", `http://${hostHeader}`);
    // A snapshot blocks mutation, not liveness. Desktop launchers must not
    // mistake a busy but healthy service for an absent backend and start twice.
    if (request.method === "GET" && url.pathname === "/api/health") {
      await api(request, response, url);
      return;
    }
    if (await snapshotGuard.request(() => api(request, response, url))) return;
    await staticFile(response, url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const details = error as {code?: string; accountId?: string; takeoverConfirmation?: string; batchId?: string; resultStatus?: string; writeWindow?: unknown};
    json(response, 400, {
      error: message,
      code: String(details.code || "request_failed"),
      ...(details.accountId ? {accountId: details.accountId} : {}),
      ...(details.takeoverConfirmation ? {takeoverConfirmation: details.takeoverConfirmation} : {}),
      ...(details.batchId ? {batchId: details.batchId} : {}),
      ...(details.resultStatus ? {resultStatus: details.resultStatus} : {}),
      ...(details.writeWindow ? {writeWindow: details.writeWindow} : {}),
    });
  }
});

server.listen(port, host, () => {
  const actualPort = (server.address() as {port: number}).port;
  process.send?.({type: "tomota-ready", port: actualPort, buildId});
  process.stdout.write(`Tomota Studio ${development ? "API" : "本机地址"}：http://${host}:${actualPort}\n`);
  process.stdout.write(`现有项目清单：${migration.manifestPath}\n`);
  setTimeout(() => void runner.recoverInterruptedWorkflowJobs().then((result) => {
    if (result.recovered.length) process.stdout.write(`已自动恢复 ${result.recovered.length} 个中断工作流任务\n`);
  }).catch((error) => process.stderr.write(`工作流启动恢复检查失败：${error instanceof Error ? error.message : String(error)}\n`)), 300);
  setTimeout(() => void store.listWorkspaceSnapshots().then(async (snapshots) => {
    const latest = snapshots[0]?.createdAt ? new Date(snapshots[0].createdAt).getTime() : 0;
    const runtime = runner.activity();
    if ((!latest || Date.now() - latest > 24 * 60 * 60_000) && runtime.active === 0 && runtime.queued === 0) {
      await snapshotGuard.snapshot(runtime, () => store.createWorkspaceSnapshot());
    }
  }).catch((error) => process.stderr.write(`Studio 每日快照失败：${error instanceof Error ? error.message : String(error)}\n`)), 2_000);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

if (desktopToken && process.send) {
  // If the desktop crashes, do not leave its background workers orphaned.
  process.on("disconnect", () => {
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(process.pid), "/T", "/F"], {windowsHide: true, stdio: "ignore"});
      killer.once("error", () => process.exit(1));
      killer.once("close", () => process.exit(1));
    } else process.exit(1);
  });
}
