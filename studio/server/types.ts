export type AgentJobStatus =
  | "queued"
  | "running"
  | "auth_required"
  | "interrupted"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface AgentJob {
  id: string;
  runId: string;
  bookId: string;
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
  message: string;
  createdAt: string;
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
}
