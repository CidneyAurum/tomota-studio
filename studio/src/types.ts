export interface WorkflowSummary {
  id: string;
  status: string;
  current_chapter: number | null;
  current_stage: string;
  created_at: string;
  updated_at: string;
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
}

export interface JobEvent {
  id: number;
  jobId: string;
  level: string;
  message: string;
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
  chapters: Array<{chapter_number: number; title: string; word_count: number; content_fingerprint: string; scheduled_at?: string | null}>;
  next_confirmation: string;
  platform_work_id?: string;
}
