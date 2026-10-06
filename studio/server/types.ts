export type AgentJobStatus =
  | "queued"
  | "running"
  | "auth_required"
  | "interrupted"
  | "succeeded"
  | "awaiting_choice"
  | "failed"
  | "cancelled"
  | "timeout";

export interface AgentJob {
  id: string;
  runId: string;
  bookId: string;
  scopeType?: "book" | "author" | "system";
  scopeId?: string;
  actionId?: string;
  chapter: number | null;
  stage: string;
  status: AgentJobStatus;
  promptPath: string;
  promptHash: string;
  outputPath: string;
  outputHash: string;
  pid: number | null;
  exitCode: number | null;
  retryOf: string | null;
  error: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobEvent {
  id: number;
  jobId: string;
  level: "info" | "stdout" | "stderr" | "error";
  kind: "status" | "assistant_text" | "tool_event" | "usage" | "result" | "log";
  message: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
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

export interface WorkflowFeedback {
  id: string;
  runId: string;
  bookId: string;
  chapter: number | null;
  stage: string;
  content: string;
  status: "pending" | "applied";
  jobId: string | null;
  createdAt: string;
  appliedAt: string | null;
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

export interface ReaderFeedbackRecord {
  id: string;
  bookId: string;
  scopeType: "book" | "volume" | "chapter";
  scopeId: string;
  content: string;
  status: "evaluating" | "evaluated" | "reworking" | "applied" | "needs_clarification" | "failed";
  evaluation: Record<string, unknown>;
  parentFeedbackId: string | null;
  rootFeedbackId: string;
  sequence: number;
  supersededById: string | null;
  contextManifest: Record<string, unknown>;
  reviewMode: "targeted" | "full_scope";
  requestedChapters: number[];
  jobId: string | null;
  workflowId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalTalkRecord {
  id: string;
  authorId: string;
  title: string;
  content: string;
  linkedBookId: string | null;
  progressSnapshot: Record<string, unknown>;
  personaSnapshot: Record<string, unknown>;
  personaHash: string;
  styleInfluence: "none" | "current_book";
  status: "draft" | "ready" | "published" | "archived";
  sourceJobId: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export type AgentPlanStatus = "pending" | "confirmed" | "rejected" | "executed" | "failed";

export interface AgentPlanRecord {
  jobId: string;
  bookId: string;
  status: AgentPlanStatus;
  summary: string;
  artifact: Record<string, unknown>;
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

export interface FanqieAccount {
  id: string;
  label: string;
  profileDirectory: string;
  active: boolean;
  sessionStatus: "logged_in" | "auth_required" | "human_action_required" | "unknown";
  writerName: string;
  writerUrl: string;
  message: string;
  lastCheckedAt: string | null;
  lastSyncStatus: string;
  lastSyncAt: string | null;
  archivedAt: string | null;
  browserOpen?: boolean;
  workCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublishPlanOptions {
  mode: "immediate" | "scheduled";
  chaptersPerDay?: number;
  publishHour?: number;
  startAt?: string | null;
}

export interface PlatformWork {
  platformId: string;
  title: string;
  url: string;
  status: string;
  metrics: Record<string, string | number>;
  syncedAt: string;
}

export interface PlatformChapter {
  platformId: string;
  workId: string;
  chapterNumber: number | null;
  title: string;
  status: string;
  wordCount?: number;
  scheduledAt: string | null;
  contentHash: string;
  syncedAt: string;
}

export interface PublishBatchPreview {
  batch_id: string;
  book_id: string;
  book_title: string;
  status: string;
  chapters: Array<{
    chapter_number: number;
    title: string;
    word_count: number;
    content_fingerprint: string;
    scheduled_at?: string | null;
    operation?: "create" | "update";
    platform_chapter_id?: string | null;
    platform_status?: string | null;
    platform_title?: string | null;
    platform_word_count?: number | null;
  }>;
  next_confirmation: string;
  platform_work_id?: string;
  platform_work_title?: string;
  safety?: {
    account_id: string;
    ai_usage_required: boolean;
    ai_usage_value: "no";
    create_and_update_paths: string[];
  };
  recovery?: {
    state: "ready" | "safe_retry" | "reconcile_required";
    result_status: string | null;
    result_exists: boolean;
    uncertain_chapters: number[];
  };
}

export interface OneClickBatchResolution {
  batch: PublishBatchPreview | null;
  disposition: "created" | "resumed" | "rebuilt" | "already_submitted";
  message: string;
}
