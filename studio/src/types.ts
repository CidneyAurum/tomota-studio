export interface WorkflowSummary {
  id: string;
  status: string;
  current_chapter: number | null;
  current_stage: string;
  created_at: string;
  updated_at: string;
}

export type ModelProviderKind = "openai_compatible" | "openai_responses" | "anthropic" | "gemini";
export type ModelRole = "generation" | "review" | "workbench" | "review_arbitration";

export interface ModelProviderRecord {
  id: string;
  label: string;
  kind: ModelProviderKind;
  baseUrl: string;
  apiKeyConfigured: boolean;
  models: string[];
  status: "unchecked" | "ready" | "error";
  error: string;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelRouteRecord {
  role: ModelRole;
  providerId: string;
  modelId: string;
  fallbackEnabled: boolean;
  updatedAt: string;
}

export interface ModelSettingsSnapshot {
  providers: ModelProviderRecord[];
  routes: ModelRouteRecord[];
  localProvider: {id: "agy"; label: string; kind: "local"};
}

export interface ProjectSummary {
  id: string;
  title: string;
  updated_at: string;
  metadata: Record<string, unknown>;
  chapterCount: number;
  plannedChapterCount: number;
  completionMode: "open_ended" | "fixed";
  targetChapterCount: number | null;
  approvedCount: number;
  blockedCount: number;
  publishReadyCount: number;
  latestWorkflow: WorkflowSummary | null;
  activeJob: AgentJob | null;
  legacy: boolean;
}

export interface VolumeOutline {
  volume_id: string;
  title: string;
  objective: string;
  main_conflict: string;
  character_change: string;
  foreshadowing: string;
  ending: string;
}

export interface MasterOutline {
  version: number;
  completion_mode: "open_ended" | "fixed";
  target_chapters: number | null;
  premise: string;
  core_conflict: string;
  ending_direction: string;
  major_beats: string[];
  volumes: VolumeOutline[];
  rolling_plan: {window_size: number; planned_through: number};
  updated_at?: string;
}

export interface OutlineBundle {
  master: MasterOutline;
  chapters: Array<Record<string, unknown>>;
  foundation_contract?: FoundationContract;
}

export interface FoundationConstraint {
  constraint_id: string;
  scope_type: "book" | "volume" | "chapter";
  scope_id: string;
  category: string;
  rule: string;
  priority: "must" | "should" | "avoid";
  source_job_id?: string;
  source_scope?: string;
  reason?: string;
  created_at?: string;
  updated_at?: string;
}

export interface FoundationContract {
  schema_version?: string;
  revision?: number;
  contract_hash?: string;
  parent_contract_hash?: string;
  active_constraints?: FoundationConstraint[];
  author_contract_snapshot?: Record<string, unknown>;
  last_change_summary?: {added?: string[]; updated?: string[]; removed?: string[]; unchanged?: number};
  applied_at?: string;
  [key: string]: unknown;
}

export interface RebuildPreview {
  book_id: string;
  scope_type: "chapter" | "volume" | "book";
  scope_id: string;
  chapter_numbers: number[];
  file_paths: string[];
  confirmation_phrase: string;
  blocked: boolean;
  blockers: string[];
  warnings: string[];
  retained: string[];
  cleared: string[];
  permanent: boolean;
}

export interface AgentJob {
  id: string;
  runId: string;
  bookId: string;
  chapter: number | null;
  stage: string;
  status: string;
  promptPath: string;
  outputPath: string;
  error: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  scopeType?: string;
  scopeId?: string;
  actionId?: string;
}

export interface AuthorStyleRule {
  category: string;
  rule: string;
  evidence?: string;
  scope?: "author_core" | "author_core_strong" | "author_core_candidate" | "work_cluster" | "work_specific" | "character_specific" | "uncertain" | "contradicted" | "general";
  confidence?: number;
  stability?: number;
  applies_to?: string[];
  evidence_ids?: string[];
}

export interface AuthorDimensionLink {
  dimension_id: string;
  relation: "realized_via" | "constrains" | "informs";
}

export interface AuthorStyleDimension {
  id: string;
  axis?: string;
  label: string;
  finding: string;
  trigger?: string;
  writing_instruction: string;
  implementation_steps?: string[];
  allowed_variations?: string[];
  acceptance_tests?: string[];
  failure_modes?: string[];
  non_applicable_cases?: string[];
  avoid: string;
  scope: "author_core" | "author_core_strong" | "author_core_candidate" | "work_cluster" | "work_specific" | "character_specific" | "uncertain" | "contradicted";
  confidence: number;
  stability: number;
  applies_to: string[];
  evidence_ids: string[];
  counterevidence_ids?: string[];
  transfer_test?: {
    abstract_mechanism: string;
    removed_terms: string[];
    trials: Array<{target_genre: string; translated_example: string; mechanism_preserved: boolean}>;
    verdict: "pass" | "partial" | "fail";
  };
  scope_evaluation?: Record<string, unknown>;
  links?: AuthorDimensionLink[];
}

export interface AuthorMethodReference {
  dimension_id: string;
  role: "primary" | "supporting" | "warning";
  order: number;
  local_note: string;
}

export interface AuthorApplicationBlueprint {
  book_design: string[];
  volume_design: string[];
  chapter_design: string[];
  drafting: string[];
  dialogue: string[];
  revision: string[];
}

export interface AuthorStyleProfile {
  narrative: Record<string, string>;
  rhythm: Record<string, string>;
  dialogue: Record<string, string>;
  character_voice: Record<string, string>;
  emotion: Record<string, string>;
  scene_pacing: Record<string, string>;
  story_design: Record<string, string | AuthorStyleDimension[] | AuthorMethodReference[]>;
  book_architecture: Record<string, string | AuthorStyleDimension[] | AuthorMethodReference[]>;
  openings: string[];
  transitions: string[];
  endings: string[];
  lexical_preferences: string[];
  forbidden_patterns: string[];
  platform_constraints: string[];
  genre_tendencies: string[];
  rules: AuthorStyleRule[];
  style_dimensions?: AuthorStyleDimension[];
  statistical_signature?: {targets: Array<{metric: string; range: {low: number; typical: number; high: number}; tolerance: string; writing_use: string}>};
  application_blueprint?: AuthorApplicationBlueprint;
  distillation_quality?: {
    reliability_level: "low" | "medium" | "high";
    corpus_coverage: number;
    cross_source_consistency: number;
    holdout_consistency: number;
    actionability_score: number;
    topic_leakage_risk: "low" | "medium" | "high";
    limitations: string[];
  };
  distillation_growth?: {
    baseline_version_id: string | null;
    source_changes: {added: string[]; removed: string[]; changed: string[]; unchanged: string[]};
    dimension_changes: Array<{
      dimension_id: string; label: string; change: "new" | "strengthened" | "weakened" | "contradicted" | "upgraded" | "downgraded" | "retired" | "unchanged";
      old_scope: string | null; new_scope: string | null; old_evidence_count: number; new_evidence_count: number;
    }>;
    summary: Record<string, number>;
  };
  provenance?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AuthorVersion {
  id: string;
  author_id: string;
  version_number: number;
  status: "draft" | "published" | "archived";
  profile: AuthorStyleProfile;
  source_manifest: Array<Record<string, unknown>>;
  profile_hash: string;
  created_at: string;
  published_at: string | null;
}

export interface AuthorSource {
  id: string;
  author_id: string;
  original_name: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  metrics: Record<string, unknown>;
  status: string;
  rights_confirmed: boolean;
  sort_order: number;
  created_at: string;
  deleted_at: string | null;
  deduplicated?: boolean;
}

export interface AuthorBindingSummary {
  book_id: string;
  book_title: string;
  version_id: string;
  version_number: number;
  profile_hash: string;
  bound_at: string;
  updated_at: string;
  compiled_policy_hash?: string | null;
  latest_workflow_id?: string | null;
  latest_workflow_status?: string | null;
  frozen_policy_hash?: string | null;
  frozen_version_id?: string | null;
  effect_state: "active_and_next" | "next_workflow_only" | "next_workflow";
}

export interface AuthorProfileSummary {
  id: string;
  name: string;
  description: string;
  persona: AuthorPersona;
  status: "active" | "archived";
  is_system: boolean;
  current_version_id?: string | null;
  current_version_number?: number | null;
  draft_count?: number;
  source_count?: number;
  binding_count?: number;
  created_at: string;
  updated_at: string;
}

export interface AuthorPersona {
  public_identity: string;
  speaking_tone: string;
  reader_relationship: string;
  humor_style: string;
  emotional_openness: string;
  values: string[];
  preferred_topics: string[];
  avoided_topics: string[];
  interaction_habits: string[];
  authenticity_rules: string[];
  boundaries: string[];
}

export interface PersonalTalk {
  id: string;
  authorId: string;
  title: string;
  content: string;
  linkedBookId: string | null;
  progressSnapshot: Record<string, unknown>;
  personaSnapshot: AuthorPersona;
  personaHash: string;
  styleInfluence: "none" | "current_book";
  status: "draft" | "ready" | "published" | "archived";
  sourceJobId: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface AuthorProfile extends AuthorProfileSummary {
  versions?: AuthorVersion[];
  sources?: AuthorSource[];
  bindings?: AuthorBindingSummary[];
}

export interface AuthorBindingAudit {
  binding: {
    book_id: string;
    author_id: string;
    author_name: string;
    version_id: string;
    version_number: number;
    profile_hash: string;
    bound_at: string;
    updated_at: string;
  } | null;
  compiledPolicy: {
    schema_version?: string;
    policy_hash?: string;
    active_rules?: AuthorStyleRule[];
    conflicts?: Array<{source: string; category: string; rule: string; reason: string}>;
    precedence?: string[];
    author_binding?: Record<string, unknown>;
  } | null;
  activeWorkflowPolicy: {
    workflow_id?: string;
    workflow_status?: string;
    policy_hash?: string;
    author_binding?: Record<string, unknown>;
  } | null;
  effectState: "active_and_next" | "next_workflow_only" | "next_workflow" | "unbound";
}

export interface JobArtifactBundle {
  artifact: Record<string, unknown> | null;
  publicDecision: Record<string, unknown>;
  validationTrace: Record<string, unknown>;
  lineage: Record<string, unknown>;
}

export interface PlanningConversationMessage {
  id: string;
  bookId: string;
  scopeType: "new_book" | "book" | "volume" | "chapter" | "chapters" | "workbench";
  scopeId: string;
  role: "user" | "assistant";
  text: string;
  proposal: Record<string, unknown> | null;
  warnings: string[];
  jobId: string;
  createdAt: string;
}

export interface QualityChapterMetrics {
  chapter: number;
  visible_chars: number;
  naturalness_score: number;
  ai_flavor_risk: number;
  dialogue_ratio: number;
  sentence_length_cv: number;
  paragraph_length_cv: number;
  findings: Array<{code: string; severity: "blocker" | "warning"; location?: string; quote?: string; diagnosis: string; repair: string}>;
}

export interface QualityBenchmark {
  id: string;
  bookId: string;
  name: string;
  chapters: number[];
  snapshot: {report?: {book_naturalness_score?: number; book_ai_flavor_risk?: number; chapter_reports?: QualityChapterMetrics[]}};
  createdAt: string;
}

export interface QualityBenchmarkRun {
  id: string;
  benchmarkId: string;
  bookId: string;
  comparison: {
    pairs: Array<{chapter: number; A: {content: string; metrics: QualityChapterMetrics}; B: {content: string; metrics: QualityChapterMetrics}; truth?: {A: "baseline" | "current"; B: "baseline" | "current"}}>;
    baselineReport?: Record<string, unknown>;
    currentReport?: Record<string, unknown>;
  };
  judgments: Record<string, {choice: "A" | "B" | "tie"; rationale: string; judgedAt: string}>;
  createdAt: string;
}

export interface ContextReceipt {
  jobId: string;
  sourceJobId: string;
  runId: string;
  bookId: string;
  chapter: number | null;
  stage: string;
  status: string;
  actionId: string;
  promptHash: string;
  outputHash: string;
  promptEstimatedTokens: number;
  policyHash: string;
  contextBlocks: Array<{key: string; status: "included"; purpose: string}>;
  executableRules: Array<Record<string, unknown>>;
  stageBlueprint: Record<string, unknown>;
  conflicts: Array<Record<string, unknown>>;
  hardRules: unknown;
  precedence: unknown;
  classificationCounts: Record<string, number>;
  unmappedRuleIds: string[];
  withheldForOtherStages: number;
  outputContract: {required: string[]; properties: string[]};
  lineage: Record<string, unknown>;
}

export interface ChapterCockpit {
  bookId: string;
  runId: string;
  chapter: number;
  available: boolean;
  readerContract: Record<string, unknown> | null;
  continuityHandoff: Record<string, unknown> | null;
  constraintApplication: Array<Record<string, unknown>>;
  canonDelta: Record<string, unknown> | null;
  finalValidation: Record<string, unknown> | null;
  qualityGates: Array<{stage: string; passed: boolean | null; summary: string; evidenceCount: number; scorecard: unknown}>;
  notice: string;
}

export interface JobEvent {
  id: number;
  jobId: string;
  level: string;
  kind?: string;
  message: string;
  payload?: Record<string, unknown> | null;
  createdAt: string;
}

export interface WorkflowFeedback {
  id: string;
  runId: string;
  chapter: number | null;
  stage: string;
  content: string;
  status: "pending" | "applied";
  jobId: string | null;
  createdAt: string;
}

export type AgentPlanAction =
  | {type: "run_workflow"; bookId: string; chapters: number[]; autoRun: boolean}
  | {type: "rework_chapter"; bookId: string; chapter: number; feedback: string; autoRun: boolean}
  | {type: "run_next_stage"; runId: string}
  | {type: "retry_job"; jobId: string}
  | {type: "create_revision_brief"; bookId: string; chapter: number; feedback: string}
  | {type: "update_author_preference"; bookId: string; category: string; rule: string; evidence: string; enabled: boolean}
  | {type: "switch_view"; view: string}
  | {type: "select_project"; bookId: string};

export interface AgentPlanArtifact {
  stage: "workbench_agent";
  summary: string;
  reasoning: string[];
  actions: AgentPlanAction[];
  warnings: string[];
}

export interface AgentPlanRecord {
  jobId: string;
  bookId: string;
  status: "pending" | "confirmed" | "rejected" | "executed" | "failed";
  summary: string;
  artifact: {summary?: string; reasoning?: string[]; actions?: AgentPlanAction[]; warnings?: string[]} | Record<string, unknown>;
  createdAt: string;
  confirmedAt: string | null;
  executedAt: string | null;
}

export interface AgentExecutionResult {
  planId: string;
  status: "executed" | "failed";
  executedAt: string;
  actions: Array<{type: string; status: "succeeded" | "skipped" | "failed"; detail: string}>;
}

export interface AuthorPreference {
  id: string;
  bookId: string;
  category: "人物声音" | "对白密度" | "伏笔边界" | "节奏" | "章末" | "去AI味" | "题材偏好";
  rule: string;
  evidence: string;
  enabled: boolean;
  sourceJobId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RevisionBriefRecord {
  id: string;
  bookId: string;
  chapter: number;
  feedback: string;
  sourceJobId: string;
  status: "pending" | "started" | "applied";
  createdAt: string;
  updatedAt: string;
}

export interface ReaderFeedbackEvaluation {
  stage?: "reader_feedback_evaluation";
  verdict?: "actionable" | "needs_clarification";
  severity?: "low" | "medium" | "high" | "structural";
  summary?: string;
  affected_chapters?: number[];
  preserve?: string[];
  changes?: string[];
  risks?: string[];
  compiled_instruction?: string;
  feedback_responses?: Array<{
    feedback_id: string;
    disposition: "accepted" | "partially_accepted" | "rejected" | "needs_clarification";
    interpretation: string;
    reason: string;
    evidence_refs: string[];
    affected_chapters: number[];
  }>;
  evidence?: Array<{evidence_id: string; chapter: number; location: string; quote: string}>;
  chapter_audit?: Array<{chapter: number; verdict: "rewrite_required" | "quality_upgrade"; finding: string; preserve: string[]; rewrite: string[]; evidence_refs: string[]}>;
  proposed_book_rules?: Array<{category: string; rule: string; rationale: string; evidence_refs: string[]; covers_change_indexes: number[]}>;
  execution_directive?: {mode: "targeted" | "full_scope"; chapters: number[]; authority: "user_locked" | "evidence_selected"};
  clarification_questions?: string[];
  [key: string]: unknown;
}

export interface ReaderFeedbackRecord {
  id: string;
  bookId: string;
  scopeType: "book" | "volume" | "chapter";
  scopeId: string;
  content: string;
  status: "evaluating" | "evaluated" | "reworking" | "applied" | "needs_clarification" | "failed";
  evaluation: ReaderFeedbackEvaluation;
  parentFeedbackId: string | null;
  rootFeedbackId: string;
  sequence: number;
  supersededById: string | null;
  contextManifest: {
    schemaVersion?: string;
    lockedAt?: string;
    contextHash?: string;
    primaryChapters?: number[];
    downstreamDependencyChapters?: number[];
    eligibleChapters?: number[];
    chapters?: Array<{chapterNumber: number; title?: string; status?: string; bodyHash?: string; excerptHash?: string; truncated?: boolean}>;
    canon?: {throughChapter?: number | null; hash?: string | null};
    writingPolicy?: {policyHash?: string | null; authorVersionId?: string | null; injectedRuleCount?: number | null};
    feedbackThread?: Array<{feedbackId: string; sequence: number; status: string}>;
    reviewMode?: "targeted" | "full_scope";
    requestedChapters?: number[];
    [key: string]: unknown;
  };
  reviewMode: "targeted" | "full_scope";
  requestedChapters: number[];
  jobId: string | null;
  workflowId: string | null;
  jobSummary?: {id: string; status: string; stage: string; promptHash?: string; outputHash?: string | null; error?: string; startedAt?: string | null; finishedAt?: string | null} | null;
  publicDecision?: Record<string, unknown>;
  validationTrace?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectFile {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  editable: boolean;
  category: string;
  categoryLabel: string;
}

export interface ProjectDetail {
  book: {id: string; title: string; metadata: Record<string, unknown>; updated_at?: string};
  chapters: Array<Record<string, unknown>>;
  workflows: WorkflowSummary[];
  workflowState: Record<string, unknown> | null;
  files: ProjectFile[];
  findings: Array<Record<string, unknown>>;
  jobs: AgentJob[];
  outline: OutlineBundle;
}

export interface FanqieSession {
  status: string;
  writerUrl: string;
  writerName: string;
  visibleWorks: PlatformWork[];
  checkedAt: string;
  message: string;
  accountId: string;
  accountLabel: string;
  lastSyncStatus: string;
}

export interface FanqieAccount {
  id: string;
  label: string;
  active: boolean;
  sessionStatus: string;
  writerName: string;
  message: string;
  lastCheckedAt: string | null;
  lastSyncStatus: string;
  lastSyncAt: string | null;
  archivedAt: string | null;
  browserOpen: boolean;
  workCount: number;
}

export interface PlatformWork {
  platformId: string;
  title: string;
  url: string;
  status: string;
  metrics: Record<string, string | number>;
  syncedAt: string;
}

export interface BatchPreview {
  batch_id: string;
  book_id: string;
  book_title: string;
  status: string;
  chapters: Array<{chapter_number: number; title: string; word_count: number; content_fingerprint: string; scheduled_at?: string | null; operation?: "create" | "update"; platform_chapter_id?: string | null; platform_status?: string | null; platform_title?: string | null; platform_word_count?: number | null}>;
  next_confirmation: string;
  platform_work_id?: string;
  platform_work_title?: string;
  safety?: Record<string, unknown>;
  recovery?: {state: "ready" | "safe_retry" | "reconcile_required"; result_status: string | null; result_exists: boolean; uncertain_chapters: number[]};
}

export interface OneClickBatchResolution {
  batch: BatchPreview | null;
  disposition: "created" | "resumed" | "rebuilt" | "already_submitted";
  message: string;
}

export interface FanqieWriteWindow {
  allowed: boolean;
  timezone: "Asia/Shanghai";
  currentTime: string;
  nextAllowedAt: string | null;
  message: string;
}
