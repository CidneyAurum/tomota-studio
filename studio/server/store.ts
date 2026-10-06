import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RebuildFiles } from "./rebuild-files.js";

import type { AgentExecutionResult, AgentJob, AgentJobStatus, AgentPlanRecord, AgentPlanStatus, AuthorPreference, FanqieAccount, JobEvent, ModelProviderKind, ModelProviderRecord, ModelRole, ModelRouteRecord, PersonalTalkRecord, PlanningConversationMessage, PlatformChapter, PlatformWork, ReaderFeedbackRecord, RevisionBriefRecord, WorkflowFeedback } from "./types.js";

const isoNow = () => new Date().toISOString();
const GIB = 1024 ** 3;
const DEFAULT_SNAPSHOT_MAX_BYTES = 20 * GIB;
const DEFAULT_SNAPSHOT_RESERVE_BYTES = 1024 ** 3;

function snapshotSqlite(source: string, destination: string): void {
  // SQLite reads committed WAL pages as well as the main file. Never copy a
  // live database with filesystem copyFile(), even for one-off migrations.
  const db = new DatabaseSync(source, {readOnly: true});
  try { db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`); }
  finally { db.close(); }
  const snapshot = new DatabaseSync(destination, {readOnly: true});
  try {
    const checks = snapshot.prepare("PRAGMA quick_check").all();
    if (checks.length !== 1 || checks[0].quick_check !== "ok") throw new Error("SQLite 备份完整性校验失败");
  } finally { snapshot.close(); }
}

export type WorkspaceSnapshot = {id: string; path: string; createdAt: string; sizeBytes: number};
export type EvidenceObservationKind = "style" | "world" | "character" | "structure";
export type EvidenceStatus = "grounded" | "ambiguous" | "invalid" | "legacy_unresolved";
export interface EvidenceRecord {
  id: string;
  authorId: string;
  runId: string;
  sourceId: string;
  sourceHash: string;
  sourceSnapshotId: string;
  batchId: string;
  segmentId: string | null;
  chapterId: string | null;
  phaseId: string | null;
  startUtf8: number;
  endUtf8: number;
  lineStart: number;
  lineEnd: number;
  exactQuote: string;
  quoteHash: string;
  axis: string;
  observationKind: EvidenceObservationKind;
  contextBefore: string | null;
  contextAfter: string | null;
  status: EvidenceStatus;
  createdAt: string;
}
export type DistillationPortraitLevel = "segment" | "phase" | "work";
export interface DistillationPortraitRecord {
  id: string;
  authorId: string;
  runId: string;
  sourceId: string;
  level: DistillationPortraitLevel;
  scopeId: string;
  parentScopeId: string | null;
  inputHash: string;
  profile: Record<string, unknown>;
  outputHash: string;
  createdAt: string;
}
export type WorkspaceSnapshotPolicy = {
  encrypted: false;
  retentionCount: number;
  maxTotalBytes: number;
  reserveFreeBytes: number;
  availableBytes: number;
  currentTotalBytes: number;
  estimatedSnapshotBytes: number;
  canCreate: boolean;
  blockedReason: string;
};

function configuredBytes(name: string, fallback: number): number {
  const value = Number(process.env[name] || "");
  return Number.isFinite(value) && value > 0 ? Math.floor(value * GIB) : fallback;
}

async function pathSize(path: string): Promise<number> {
  try {
    const info = await stat(path);
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) return 0;
    const children = await readdir(path, {withFileTypes: true});
    return (await Promise.all(children.map((item) => pathSize(join(path, item.name))))).reduce((sum, value) => sum + value, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function toEvidence(row: Record<string, unknown>): EvidenceRecord {
  return {
    id: String(row.id), authorId: String(row.author_id), runId: String(row.linked_run_id || row.run_id),
    sourceId: String(row.source_id), sourceHash: String(row.source_hash), sourceSnapshotId: String(row.source_snapshot_id || ""),
    batchId: String(row.batch_id), segmentId: row.segment_id === null ? null : String(row.segment_id),
    chapterId: row.chapter_id === null ? null : String(row.chapter_id), phaseId: row.phase_id === null ? null : String(row.phase_id),
    startUtf8: Number(row.start_utf8), endUtf8: Number(row.end_utf8),
    lineStart: Number(row.line_start), lineEnd: Number(row.line_end),
    exactQuote: String(row.exact_quote), quoteHash: String(row.quote_hash),
    axis: String(row.axis), observationKind: String(row.observation_kind) as EvidenceObservationKind,
    contextBefore: row.context_before === null ? null : String(row.context_before),
    contextAfter: row.context_after === null ? null : String(row.context_after),
    status: String(row.status) as EvidenceStatus, createdAt: String(row.created_at),
  };
}

function toDistillationPortrait(row: Record<string, unknown>): DistillationPortraitRecord {
  let profile: Record<string, unknown> = {};
  try {
    const value = JSON.parse(String(row.profile_json || "{}")) as unknown;
    if (value && !Array.isArray(value) && typeof value === "object") profile = value as Record<string, unknown>;
  } catch { profile = {}; }
  return {
    id: String(row.id), authorId: String(row.author_id), runId: String(row.run_id), sourceId: String(row.source_id),
    level: String(row.level) as DistillationPortraitLevel, scopeId: String(row.scope_id),
    parentScopeId: row.parent_scope_id === null ? null : String(row.parent_scope_id),
    inputHash: String(row.input_hash), profile, outputHash: String(row.output_hash), createdAt: String(row.created_at),
  };
}

function toAgentJob(row: Record<string, unknown>): AgentJob {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    bookId: String(row.book_id),
    scopeType: String(row.scope_type || "book") as AgentJob["scopeType"],
    scopeId: String(row.scope_id || row.book_id || ""),
    actionId: String(row.action_id || ""),
    chapter: row.chapter === null ? null : Number(row.chapter),
    stage: String(row.stage),
    status: String(row.status) as AgentJobStatus,
    promptPath: String(row.prompt_path || ""),
    promptHash: String(row.prompt_hash || ""),
    outputPath: String(row.output_path || ""),
    outputHash: String(row.output_hash || ""),
    pid: row.pid === null ? null : Number(row.pid),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    retryOf: row.retry_of === null ? null : String(row.retry_of),
    error: String(row.error || ""),
    createdAt: String(row.created_at),
    startedAt: row.started_at === null ? null : String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
  };
}

function toPlanningMessage(row: Record<string, unknown>): PlanningConversationMessage {
  let proposal: Record<string, unknown> | null = null;
  let warnings: string[] = [];
  try {
    const parsed = JSON.parse(String(row.proposal_json || "null")) as unknown;
    if (parsed && !Array.isArray(parsed) && typeof parsed === "object") proposal = parsed as Record<string, unknown>;
  } catch { proposal = null; }
  try {
    const parsed = JSON.parse(String(row.warnings_json || "[]")) as unknown;
    if (Array.isArray(parsed)) warnings = parsed.map(String);
  } catch { warnings = []; }
  return {
    id: String(row.id), bookId: String(row.book_id),
    scopeType: String(row.scope_type) as PlanningConversationMessage["scopeType"], scopeId: String(row.scope_id),
    role: String(row.role) as PlanningConversationMessage["role"], text: String(row.text), proposal, warnings,
    jobId: String(row.job_id || ""), createdAt: String(row.created_at),
  };
}

export class StudioStore {
  readonly root: string;
  readonly dataDir: string;
  readonly dbPath: string;
  readonly db: DatabaseSync;

  constructor(root: string) {
    this.root = resolve(root);
    this.dataDir = join(this.root, ".tomota-studio");
    this.dbPath = join(this.root, "studio.db");
    this.db = new DatabaseSync(this.dbPath);
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
      this.createSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS studio_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        book_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        manifest_hash TEXT NOT NULL DEFAULT '',
        legacy INTEGER NOT NULL DEFAULT 1,
        indexed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_jobs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        book_id TEXT NOT NULL,
        chapter INTEGER,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt_path TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        output_path TEXT NOT NULL,
        output_hash TEXT NOT NULL DEFAULT '',
        pid INTEGER,
        exit_code INTEGER,
        retry_of TEXT,
        scope_type TEXT NOT NULL DEFAULT 'book',
        scope_id TEXT NOT NULL DEFAULT '',
        action_id TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'log',
        payload TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_results (
        job_id TEXT PRIMARY KEY,
        public_decision TEXT NOT NULL DEFAULT '{}',
        validation_trace TEXT NOT NULL DEFAULT '{}',
        lineage TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_feedback (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        book_id TEXT NOT NULL,
        chapter INTEGER,
        stage TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        job_id TEXT,
        created_at TEXT NOT NULL,
        applied_at TEXT
      );
      CREATE TABLE IF NOT EXISTS author_preferences (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        category TEXT NOT NULL,
        rule TEXT NOT NULL,
        evidence TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        source_job_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS revision_briefs (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        chapter INTEGER NOT NULL,
        feedback TEXT NOT NULL,
        source_job_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reader_feedback (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        evaluation_json TEXT NOT NULL DEFAULT '{}',
        parent_feedback_id TEXT,
        root_feedback_id TEXT NOT NULL DEFAULT '',
        sequence INTEGER NOT NULL DEFAULT 1,
        superseded_by_id TEXT,
        context_manifest_json TEXT NOT NULL DEFAULT '{}',
        review_mode TEXT NOT NULL DEFAULT '',
        requested_chapters_json TEXT NOT NULL DEFAULT '[]',
        job_id TEXT,
        workflow_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS personal_talks (
        id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        linked_book_id TEXT,
        progress_snapshot_json TEXT NOT NULL DEFAULT '{}',
        persona_snapshot_json TEXT NOT NULL DEFAULT '{}',
        persona_hash TEXT NOT NULL DEFAULT '',
        style_influence TEXT NOT NULL DEFAULT 'none',
        status TEXT NOT NULL DEFAULT 'draft',
        source_job_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        published_at TEXT
      );
      CREATE TABLE IF NOT EXISTS planning_messages (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        proposal_json TEXT NOT NULL DEFAULT 'null',
        warnings_json TEXT NOT NULL DEFAULT '[]',
        job_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(book_id,scope_type,scope_id,job_id,role)
      );
      CREATE TABLE IF NOT EXISTS agent_plans (
        job_id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        artifact TEXT NOT NULL,
        created_at TEXT NOT NULL,
        confirmed_at TEXT,
        executed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_execution_results (
        plan_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        executed_at TEXT NOT NULL,
        actions TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_providers (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        base_url TEXT NOT NULL,
        encrypted_api_key TEXT NOT NULL DEFAULT '',
        models_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'unchecked',
        error TEXT NOT NULL DEFAULT '',
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_routes (
        role TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL DEFAULT 'agy',
        model_id TEXT NOT NULL DEFAULT '',
        fallback_enabled INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quality_benchmarks (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        name TEXT NOT NULL,
        chapter_numbers_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quality_benchmark_runs (
        id TEXT PRIMARY KEY,
        benchmark_id TEXT NOT NULL,
        book_id TEXT NOT NULL,
        comparison_json TEXT NOT NULL,
        judgments_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS platform_works (
        platform_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL DEFAULT 'legacy',
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS platform_chapters (
        platform_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL DEFAULT 'legacy',
        work_id TEXT NOT NULL,
        chapter_number INTEGER,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        word_count INTEGER NOT NULL DEFAULT 0,
        scheduled_at TEXT,
        content_hash TEXT NOT NULL DEFAULT '',
        synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS platform_sync_runs (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL DEFAULT 'legacy',
        status TEXT NOT NULL,
        work_count INTEGER NOT NULL DEFAULT 0,
        chapter_count INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS operation_confirmations (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        target_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS work_write_previews (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL DEFAULT 'legacy',
        book_id TEXT NOT NULL,
        platform_work_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        executed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS fanqie_accounts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        profile_directory TEXT NOT NULL UNIQUE,
        is_active INTEGER NOT NULL DEFAULT 0,
        session_status TEXT NOT NULL DEFAULT 'unknown',
        writer_name TEXT NOT NULL DEFAULT '',
        writer_url TEXT NOT NULL DEFAULT 'https://fanqienovel.com/main/writer/home',
        message TEXT NOT NULL DEFAULT '',
        last_checked_at TEXT,
        last_sync_status TEXT NOT NULL DEFAULT 'idle',
        last_sync_at TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_jobs_book_status ON agent_jobs(book_id, status);
      CREATE INDEX IF NOT EXISTS idx_agent_jobs_run_created ON agent_jobs(run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events(job_id, id);
      CREATE INDEX IF NOT EXISTS idx_workflow_feedback_pending ON workflow_feedback(run_id,stage,chapter,status,created_at);
      CREATE INDEX IF NOT EXISTS idx_reader_feedback_scope ON reader_feedback(book_id,scope_type,scope_id,created_at);
      CREATE INDEX IF NOT EXISTS idx_personal_talks_author_updated ON personal_talks(author_id,updated_at);
      CREATE INDEX IF NOT EXISTS idx_planning_messages_scope ON planning_messages(book_id,scope_type,scope_id,created_at);
      CREATE INDEX IF NOT EXISTS idx_quality_benchmarks_book ON quality_benchmarks(book_id,created_at);
      CREATE INDEX IF NOT EXISTS idx_quality_runs_benchmark ON quality_benchmark_runs(benchmark_id,created_at);
      CREATE INDEX IF NOT EXISTS idx_model_providers_updated ON model_providers(updated_at);
      CREATE INDEX IF NOT EXISTS idx_platform_chapters_work_number ON platform_chapters(work_id, chapter_number);
      CREATE INDEX IF NOT EXISTS idx_confirmations_target_operation ON operation_confirmations(target_id, operation, consumed_at);
      CREATE INDEX IF NOT EXISTS idx_work_write_previews_book_created ON work_write_previews(book_id, created_at);
      CREATE TABLE IF NOT EXISTS evidence_ledger (
        id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        source_snapshot_id TEXT NOT NULL DEFAULT '',
        batch_id TEXT NOT NULL,
        segment_id TEXT,
        chapter_id TEXT,
        phase_id TEXT,
        start_utf8 INTEGER NOT NULL,
        end_utf8 INTEGER NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        exact_quote TEXT NOT NULL,
        quote_hash TEXT NOT NULL,
        axis TEXT NOT NULL,
        observation_kind TEXT NOT NULL,
        context_before TEXT,
        context_after TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_ledger_run ON evidence_ledger(run_id);
      CREATE INDEX IF NOT EXISTS idx_evidence_ledger_source ON evidence_ledger(author_id, source_id);
      CREATE TABLE IF NOT EXISTS evidence_run_links (
        run_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        PRIMARY KEY(run_id,evidence_id),
        FOREIGN KEY(evidence_id) REFERENCES evidence_ledger(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_run_links_evidence ON evidence_run_links(evidence_id);
      CREATE TABLE IF NOT EXISTS distillation_portraits (
        id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        level TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        parent_scope_id TEXT,
        input_hash TEXT NOT NULL,
        profile_json TEXT NOT NULL,
        output_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, source_id, level, scope_id)
      );
      CREATE INDEX IF NOT EXISTS idx_distillation_portraits_run ON distillation_portraits(run_id,source_id,level);
      CREATE TABLE IF NOT EXISTS distillation_source_cache (
        author_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        pipeline_revision TEXT NOT NULL,
        evidence_run_id TEXT NOT NULL,
        read_outputs_json TEXT NOT NULL,
        phase_portraits_json TEXT NOT NULL,
        work_profile_path TEXT NOT NULL,
        work_profile_hash TEXT NOT NULL,
        source_structure_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(author_id,source_id,source_hash,pipeline_revision)
      );
    `);
    this.db.prepare("INSERT OR IGNORE INTO evidence_run_links(run_id,evidence_id,linked_at) SELECT run_id,id,created_at FROM evidence_ledger").run();
    this.ensureColumn("platform_works", "account_id", "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureColumn("platform_chapters", "account_id", "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureColumn("platform_chapters", "word_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("platform_sync_runs", "account_id", "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureColumn("work_write_previews", "account_id", "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureColumn("fanqie_accounts", "last_sync_status", "TEXT NOT NULL DEFAULT 'idle'");
    this.ensureColumn("fanqie_accounts", "last_sync_at", "TEXT");
    this.ensureColumn("fanqie_accounts", "archived_at", "TEXT");
    this.ensureColumn("job_events", "kind", "TEXT NOT NULL DEFAULT 'log'");
    this.ensureColumn("job_events", "payload", "TEXT");
    this.ensureColumn("agent_jobs", "scope_type", "TEXT NOT NULL DEFAULT 'book'");
    this.ensureColumn("agent_jobs", "scope_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("agent_jobs", "action_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("agent_jobs", "verify_group_key", "TEXT");
    this.ensureColumn("reader_feedback", "parent_feedback_id", "TEXT");
    this.ensureColumn("reader_feedback", "root_feedback_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("reader_feedback", "sequence", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("reader_feedback", "superseded_by_id", "TEXT");
    this.ensureColumn("reader_feedback", "context_manifest_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("reader_feedback", "review_mode", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("reader_feedback", "requested_chapters_json", "TEXT NOT NULL DEFAULT '[]'");
    this.migrateReaderFeedbackThreads();
    this.db.prepare("UPDATE agent_jobs SET scope_id=book_id WHERE scope_id='' AND scope_type='book'").run();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fanqie_accounts_active ON fanqie_accounts(is_active, updated_at);
      CREATE INDEX IF NOT EXISTS idx_platform_works_account_sync ON platform_works(account_id, synced_at);
      CREATE INDEX IF NOT EXISTS idx_platform_chapters_account_work ON platform_chapters(account_id, work_id, chapter_number);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_jobs_verify_group_key ON agent_jobs(verify_group_key) WHERE verify_group_key IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS author_preferences_read_only_insert BEFORE INSERT ON author_preferences BEGIN
        SELECT RAISE(ABORT, 'legacy author_preferences is read-only');
      END;
      CREATE TRIGGER IF NOT EXISTS author_preferences_read_only_update BEFORE UPDATE ON author_preferences BEGIN
        SELECT RAISE(ABORT, 'legacy author_preferences is read-only');
      END;
      CREATE TRIGGER IF NOT EXISTS author_preferences_read_only_delete BEFORE DELETE ON author_preferences BEGIN
        SELECT RAISE(ABORT, 'legacy author_preferences is read-only');
      END;
    `);
    this.ensureColumn("revision_briefs", "claim", "TEXT NOT NULL DEFAULT ''");
    this.db.exec("UPDATE revision_briefs SET claim='' WHERE status='pending'");
    this.db.exec(`CREATE TABLE IF NOT EXISTS job_finalizations (
      job_id TEXT PRIMARY KEY REFERENCES agent_jobs(id) ON DELETE CASCADE,
      claim TEXT NOT NULL, started_at TEXT NOT NULL
    ); DELETE FROM job_finalizations; PRAGMA optimize;`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS book_transaction_commits (
      transaction_id TEXT PRIMARY KEY, book_id TEXT NOT NULL, committed_at TEXT NOT NULL
    )`);
    const insertRoute = this.db.prepare("INSERT OR IGNORE INTO model_routes(role,provider_id,model_id,fallback_enabled,updated_at) VALUES(?,?,?,?,?)");
    for (const role of ["generation", "review", "workbench"] as const) insertRoute.run(role, "agy", "", 0, isoNow());
    insertRoute.run("review_arbitration", "inherit_review", "", 0, isoNow());
    this.db.prepare(
      "UPDATE agent_jobs SET status='interrupted', finished_at=?, error=CASE WHEN error='' THEN 'Studio 服务重启，任务未自动推进' ELSE error END WHERE status IN ('queued','running')",
    ).run(isoNow());
    this.db.prepare(
      "UPDATE agent_jobs SET status='interrupted', finished_at=?, error='旧版候选人工选择已停用；重试后将由盲审自动仲裁' WHERE status='awaiting_choice' AND stage='candidate_blind_review'",
    ).run(isoNow());
  }

  private ensureColumn(table: string, column: string, declaration: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name: string}>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }

  claimJobFinalization(jobId: string, claim: string, recoveryStatus?: string): boolean {
    if (this.db.prepare("SELECT 1 FROM job_finalizations WHERE job_id=? AND claim=?").get(jobId, claim)) return true;
    return this.db.prepare(`INSERT OR IGNORE INTO job_finalizations(job_id,claim,started_at)
      SELECT id,?,? FROM agent_jobs WHERE id=? AND (status IN ('queued','running') OR status=?)`)
      .run(claim, isoNow(), jobId, recoveryStatus || "").changes === 1;
  }

  releaseJobFinalization(jobId: string, claim: string): void {
    this.db.prepare("DELETE FROM job_finalizations WHERE job_id=? AND claim=?").run(jobId, claim);
  }

  isJobFinalizing(jobId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM job_finalizations WHERE job_id=?").get(jobId));
  }

  private migrateReaderFeedbackThreads(): void {
    const rows = this.db.prepare("SELECT id,book_id,scope_type,scope_id,status,root_feedback_id FROM reader_feedback ORDER BY book_id,scope_type,scope_id,created_at").all() as Array<Record<string, unknown>>;
    const groups = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows) {
      const key = `${row.book_id}\u0000${row.scope_type}\u0000${row.scope_id}`;
      groups.set(key, [...(groups.get(key) || []), row]);
    }
    const update = this.db.prepare("UPDATE reader_feedback SET parent_feedback_id=?,root_feedback_id=?,sequence=? WHERE id=?");
    const supersede = this.db.prepare("UPDATE reader_feedback SET superseded_by_id=? WHERE id=? AND superseded_by_id IS NULL");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const group of groups.values()) {
        let prior: {id: string; root: string; sequence: number; status: string} | null = null;
        for (const row of group) {
          const id = String(row.id);
          if (String(row.root_feedback_id || "")) {
            prior = {id, root: String(row.root_feedback_id), sequence: Number((this.db.prepare("SELECT sequence FROM reader_feedback WHERE id=?").get(id) as {sequence?: number})?.sequence || 1), status: String(row.status)};
            continue;
          }
          const startNew: boolean = prior === null || ["reworking", "applied"].includes(prior.status);
          const previous = prior;
          const root: string = startNew ? id : previous!.root;
          const sequence: number = startNew ? 1 : previous!.sequence + 1;
          update.run(startNew ? null : previous!.id, root, sequence, id);
          if (!startNew) supersede.run(id, previous!.id);
          prior = {id, root, sequence, status: String(row.status)};
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM studio_meta WHERE key=?").get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(
      "INSERT INTO studio_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    ).run(key, value, isoNow());
  }

  successfulStageDurations(stage: string, limit = 31): number[] {
    const rows = this.db.prepare("SELECT started_at,finished_at FROM agent_jobs WHERE stage=? AND status='succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT ?")
      .all(stage, Math.max(1, Math.min(200, limit))) as Array<{started_at: string; finished_at: string}>;
    return rows.map((row) => Math.round((new Date(row.finished_at).getTime() - new Date(row.started_at).getTime()) / 1000)).filter((value) => Number.isFinite(value) && value >= 0);
  }

  stageMetrics(): Array<{stage: string; total: number; succeeded: number; failed: number; timedOut: number; retries: number; firstPassRate: number; medianSeconds: number | null; p95Seconds: number | null}> {
    const rows = this.db.prepare("SELECT stage,status,retry_of,started_at,finished_at FROM agent_jobs ORDER BY created_at").all() as Array<Record<string, unknown>>;
    const groups = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows) groups.set(String(row.stage), [...(groups.get(String(row.stage)) || []), row]);
    return [...groups.entries()].map(([stage, items]) => {
      const durations = items.filter((item) => item.started_at && item.finished_at).map((item) => Math.max(0, Math.round((new Date(String(item.finished_at)).getTime() - new Date(String(item.started_at)).getTime()) / 1000))).sort((a, b) => a - b);
      const fresh = items.filter((item) => !item.retry_of);
      const firstPass = fresh.filter((item) => item.status === "succeeded").length;
      return {
        stage, total: items.length, succeeded: items.filter((item) => item.status === "succeeded").length,
        failed: items.filter((item) => ["failed", "auth_required", "interrupted"].includes(String(item.status))).length,
        timedOut: items.filter((item) => item.status === "timeout").length, retries: items.filter((item) => Boolean(item.retry_of)).length,
        firstPassRate: fresh.length ? Math.round(firstPass / fresh.length * 1000) / 10 : 0,
        medianSeconds: durations.length ? durations[Math.floor(durations.length / 2)] : null,
        p95Seconds: durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * .95) - 1)] : null,
      };
    }).sort((left, right) => right.total - left.total);
  }

  async listWorkspaceSnapshots(): Promise<WorkspaceSnapshot[]> {
    const backupRoot = join(this.root, "backups");
    if (!existsSync(backupRoot)) return [];
    const entries = await readdir(backupRoot, {withFileTypes: true});
    const snapshots: WorkspaceSnapshot[] = [];
    for (const entry of entries.filter((item) => item.isDirectory() && item.name.startsWith("studio-"))) {
      const path = join(backupRoot, entry.name);
      const info = await stat(path);
      snapshots.push({id: entry.name, path, createdAt: info.birthtime.toISOString(), sizeBytes: await pathSize(path)});
    }
    return snapshots.sort((left, right) => right.id.localeCompare(left.id));
  }

  async workspaceSnapshotPolicy(retain = 7, overrides: {maxTotalBytes?: number; reserveFreeBytes?: number} = {}): Promise<WorkspaceSnapshotPolicy> {
    const backupRoot = resolve(this.root, "backups");
    await mkdir(backupRoot, {recursive: true});
    const snapshots = await this.listWorkspaceSnapshots();
    const maxTotalBytes = Math.max(1, Math.floor(overrides.maxTotalBytes ?? configuredBytes("TOMOTA_BACKUP_MAX_GB", DEFAULT_SNAPSHOT_MAX_BYTES)));
    const reserveFreeBytes = Math.max(0, Math.floor(overrides.reserveFreeBytes ?? configuredBytes("TOMOTA_BACKUP_RESERVE_GB", DEFAULT_SNAPSHOT_RESERVE_BYTES)));
    const sources = [this.dbPath, `${this.dbPath}-wal`, join(this.root, "tomota.db"), join(this.root, "tomota.db-wal"), this.dataDir,
      ...["books", "authors", "config", "library", "audit"].map((name) => join(this.root, name))];
    const rawSourceBytes = (await Promise.all(sources.map(pathSize))).reduce((sum, value) => sum + value, 0);
    const estimatedSnapshotBytes = Math.max(1024 ** 2, Math.ceil(rawSourceBytes * 1.15));
    const disk = await statfs(backupRoot, {bigint: true});
    const availableBytes = Number(disk.bavail * disk.bsize);
    const currentTotalBytes = snapshots.reduce((sum, item) => sum + item.sizeBytes, 0);
    let blockedReason = "";
    if (estimatedSnapshotBytes > maxTotalBytes) blockedReason = `预计快照 ${estimatedSnapshotBytes} 字节超过总容量上限 ${maxTotalBytes} 字节`;
    else if (availableBytes < estimatedSnapshotBytes + reserveFreeBytes) blockedReason = `磁盘可用空间不足：创建后必须至少保留 ${reserveFreeBytes} 字节空闲空间`;
    return {
      encrypted: false,
      retentionCount: Math.max(1, Math.floor(retain)),
      maxTotalBytes,
      reserveFreeBytes,
      availableBytes,
      currentTotalBytes,
      estimatedSnapshotBytes,
      canCreate: !blockedReason,
      blockedReason,
    };
  }

  async createWorkspaceSnapshot(retain = 7, overrides: {maxTotalBytes?: number; reserveFreeBytes?: number} = {}): Promise<{snapshot: WorkspaceSnapshot; snapshots: WorkspaceSnapshot[]; policy: WorkspaceSnapshotPolicy}> {
    const backupRoot = resolve(this.root, "backups");
    await mkdir(backupRoot, {recursive: true});
    const before = await this.workspaceSnapshotPolicy(retain, overrides);
    if (!before.canCreate) throw new Error(`无法创建整库快照：${before.blockedReason}`);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const id = `studio-${stamp}`;
    const temporary = resolve(backupRoot, `.${id}.tmp`);
    const target = resolve(backupRoot, id);
    if (relative(backupRoot, temporary).startsWith("..") || relative(backupRoot, target).startsWith("..")) throw new Error("备份路径越界");
    await mkdir(temporary, {recursive: true});
    try {
      const dbSnapshot = join(temporary, "studio.db");
      this.db.exec("PRAGMA wal_checkpoint(FULL)");
      this.db.exec(`VACUUM INTO '${dbSnapshot.replaceAll("'", "''")}'`);
      if (existsSync(join(this.root, "tomota.db"))) {
        snapshotSqlite(join(this.root, "tomota.db"), join(temporary, "tomota.db"));
      }
      if (existsSync(this.dataDir)) await cp(this.dataDir, join(temporary, "artifacts"), {recursive: true});
      const directories = ["books", "authors", "config", "library", "audit"];
      for (const name of directories) {
        if (existsSync(join(this.root, name))) await cp(join(this.root, name), join(temporary, name), {recursive: true});
      }
      await writeFile(join(temporary, "snapshot.json"), JSON.stringify({
        schema_version: 3,
        created_at: isoNow(),
        source_root: this.root,
        includes: ["studio.db", "tomota.db", ".tomota-studio", ...directories],
        directory_mapping: {"artifacts": ".tomota-studio"},
        security: {
          content_encryption: "none",
          warning: "作品正文、大纲、Canon 与任务产物为未加密本地文件；不要复制到不可信网盘、U 盘或共享目录。",
          provider_keys: "studio.db 中仅包含当前 Windows 用户 DPAPI 密文，不包含 API Key 明文",
        },
      }, null, 2), "utf8");
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, {recursive: true, force: true});
      throw error;
    }
    let snapshots = await this.listWorkspaceSnapshots();
    const created = snapshots.find((item) => item.id === id);
    if (!created) throw new Error("快照写入完成但无法重新读取清单");
    if (created.sizeBytes > before.maxTotalBytes) {
      await rm(target, {recursive: true, force: true});
      throw new Error(`快照实际大小超过总容量上限；已撤销本次快照，未删除旧快照`);
    }
    let retainedBytes = 0;
    let retainedCount = 0;
    const staleSnapshots: WorkspaceSnapshot[] = [];
    for (const snapshot of snapshots) {
      const fitsCount = retainedCount < before.retentionCount;
      const fitsBudget = retainedBytes + snapshot.sizeBytes <= before.maxTotalBytes;
      if (fitsCount && fitsBudget) {
        retainedCount += 1;
        retainedBytes += snapshot.sizeBytes;
      } else staleSnapshots.push(snapshot);
    }
    for (const stale of staleSnapshots) {
      const resolved = resolve(stale.path);
      if (relative(backupRoot, resolved).startsWith("..")) throw new Error("备份清理路径越界");
      await rm(resolved, {recursive: true, force: true});
    }
    snapshots = await this.listWorkspaceSnapshots();
    return {snapshot: snapshots.find((item) => item.id === id)!, snapshots, policy: await this.workspaceSnapshotPolicy(retain, overrides)};
  }

  insertEvidence(record: EvidenceRecord): void {
    const existing = this.getEvidence(record.id);
    if (existing) {
      const stableFields: Array<keyof EvidenceRecord> = [
        "authorId", "sourceId", "sourceHash", "sourceSnapshotId", "batchId",
        "startUtf8", "endUtf8", "exactQuote", "quoteHash", "axis", "observationKind",
      ];
      if (stableFields.some((field) => existing[field] !== record[field])) {
        throw new Error(`证据账本编号冲突：${record.id}`);
      }
      this.db.prepare("INSERT OR IGNORE INTO evidence_run_links(run_id,evidence_id,linked_at) VALUES(?,?,?)").run(record.runId, record.id, isoNow());
      return;
    }
    this.db.prepare(`
      INSERT INTO evidence_ledger(id, author_id, run_id, source_id, source_hash, source_snapshot_id, batch_id, segment_id, chapter_id, phase_id, start_utf8, end_utf8, line_start, line_end, exact_quote, quote_hash, axis, observation_kind, context_before, context_after, status, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(record.id, record.authorId, record.runId, record.sourceId, record.sourceHash, record.sourceSnapshotId, record.batchId, record.segmentId, record.chapterId, record.phaseId, record.startUtf8, record.endUtf8, record.lineStart, record.lineEnd, record.exactQuote, record.quoteHash, record.axis, record.observationKind, record.contextBefore, record.contextAfter, record.status, record.createdAt);
    this.db.prepare("INSERT INTO evidence_run_links(run_id,evidence_id,linked_at) VALUES(?,?,?)").run(record.runId, record.id, isoNow());
  }

  insertEvidenceBatch(records: EvidenceRecord[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) this.insertEvidence(record);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getEvidence(id: string): EvidenceRecord | null {
    const row = this.db.prepare("SELECT * FROM evidence_ledger WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? toEvidence(row) : null;
  }

  listEvidenceByRun(runId: string): EvidenceRecord[] {
    return (this.db.prepare("SELECT e.*,l.run_id AS linked_run_id FROM evidence_ledger e JOIN evidence_run_links l ON l.evidence_id=e.id WHERE l.run_id=? ORDER BY e.source_id,e.start_utf8").all(runId) as Array<Record<string, unknown>>).map(toEvidence);
  }

  listEvidenceByIds(ids: string[], runId?: string): EvidenceRecord[] {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return [];
    const placeholders = unique.map(() => "?").join(",");
    const rows = this.db.prepare(runId
      ? `SELECT e.*,l.run_id AS linked_run_id FROM evidence_ledger e JOIN evidence_run_links l ON l.evidence_id=e.id WHERE e.id IN (${placeholders}) AND l.run_id=?`
      : `SELECT * FROM evidence_ledger WHERE id IN (${placeholders})`)
      .all(...unique, ...(runId ? [runId] : [])) as Array<Record<string, unknown>>;
    const byId = new Map(rows.map((row) => [String(row.id), toEvidence(row)]));
    return unique.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  }

  linkEvidenceRun(sourceRunId: string, targetRunId: string, sourceId: string): number {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO evidence_run_links(run_id,evidence_id,linked_at)
      SELECT ?,e.id,? FROM evidence_ledger e
      JOIN evidence_run_links l ON l.evidence_id=e.id
      WHERE l.run_id=? AND e.source_id=?
    `).run(targetRunId, isoNow(), sourceRunId, sourceId);
    return Number(result.changes || 0);
  }

  saveDistillationSourceCache(value: {
    authorId: string; sourceId: string; sourceHash: string; pipelineRevision: string; evidenceRunId: string;
    readOutputs: string[]; phasePortraits: Record<string, string>; workProfilePath: string; workProfileHash: string;
    sourceStructure: Record<string, unknown>;
  }): void {
    this.db.prepare(`
      INSERT INTO distillation_source_cache(author_id,source_id,source_hash,pipeline_revision,evidence_run_id,read_outputs_json,phase_portraits_json,work_profile_path,work_profile_hash,source_structure_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(author_id,source_id,source_hash,pipeline_revision) DO UPDATE SET
        evidence_run_id=excluded.evidence_run_id,read_outputs_json=excluded.read_outputs_json,
        phase_portraits_json=excluded.phase_portraits_json,work_profile_path=excluded.work_profile_path,
        work_profile_hash=excluded.work_profile_hash,source_structure_json=excluded.source_structure_json,created_at=excluded.created_at
    `).run(
      value.authorId, value.sourceId, value.sourceHash, value.pipelineRevision, value.evidenceRunId,
      JSON.stringify(value.readOutputs), JSON.stringify(value.phasePortraits), value.workProfilePath,
      value.workProfileHash, JSON.stringify(value.sourceStructure), isoNow(),
    );
  }

  getDistillationSourceCache(authorId: string, sourceId: string, sourceHash: string, pipelineRevision: string): {
    authorId: string; sourceId: string; sourceHash: string; pipelineRevision: string; evidenceRunId: string;
    readOutputs: string[]; phasePortraits: Record<string, string>; workProfilePath: string; workProfileHash: string;
    sourceStructure: Record<string, unknown>;
  } | null {
    const row = this.db.prepare("SELECT * FROM distillation_source_cache WHERE author_id=? AND source_id=? AND source_hash=? AND pipeline_revision=?")
      .get(authorId, sourceId, sourceHash, pipelineRevision) as Record<string, unknown> | undefined;
    if (!row) return null;
    try {
      return {
        authorId: String(row.author_id), sourceId: String(row.source_id), sourceHash: String(row.source_hash),
        pipelineRevision: String(row.pipeline_revision), evidenceRunId: String(row.evidence_run_id),
        readOutputs: JSON.parse(String(row.read_outputs_json || "[]")) as string[],
        phasePortraits: JSON.parse(String(row.phase_portraits_json || "{}")) as Record<string, string>,
        workProfilePath: String(row.work_profile_path), workProfileHash: String(row.work_profile_hash),
        sourceStructure: JSON.parse(String(row.source_structure_json || "{}")) as Record<string, unknown>,
      };
    } catch { return null; }
  }

  saveDistillationPortrait(record: DistillationPortraitRecord): void {
    this.db.prepare(`
      INSERT INTO distillation_portraits(id,author_id,run_id,source_id,level,scope_id,parent_scope_id,input_hash,profile_json,output_hash,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id,source_id,level,scope_id) DO UPDATE SET
        parent_scope_id=excluded.parent_scope_id,input_hash=excluded.input_hash,
        profile_json=excluded.profile_json,output_hash=excluded.output_hash,created_at=excluded.created_at
    `).run(
      record.id, record.authorId, record.runId, record.sourceId, record.level, record.scopeId,
      record.parentScopeId, record.inputHash, JSON.stringify(record.profile), record.outputHash, record.createdAt,
    );
  }

  listDistillationPortraits(runId: string, sourceId?: string, level?: DistillationPortraitLevel): DistillationPortraitRecord[] {
    const conditions = ["run_id=?"];
    const parameters: Array<string> = [runId];
    if (sourceId) { conditions.push("source_id=?"); parameters.push(sourceId); }
    if (level) { conditions.push("level=?"); parameters.push(level); }
    return (this.db.prepare(`SELECT * FROM distillation_portraits WHERE ${conditions.join(" AND ")} ORDER BY source_id,level,scope_id`).all(...parameters) as Array<Record<string, unknown>>).map(toDistillationPortrait);
  }

  listModelProviders(): ModelProviderRecord[] {
    return (this.db.prepare("SELECT * FROM model_providers ORDER BY created_at").all() as Array<Record<string, unknown>>).map((row) => {
      let models: string[] = [];
      try {
        const parsed = JSON.parse(String(row.models_json || "[]")) as unknown;
        if (Array.isArray(parsed)) models = [...new Set(parsed.map(String).filter(Boolean))];
      } catch { models = []; }
      return {
        id: String(row.id), label: String(row.label), kind: String(row.kind) as ModelProviderKind,
        baseUrl: String(row.base_url), apiKeyConfigured: Boolean(String(row.encrypted_api_key || "")), models,
        status: String(row.status) as ModelProviderRecord["status"], error: String(row.error || ""),
        lastCheckedAt: row.last_checked_at === null ? null : String(row.last_checked_at),
        createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      };
    });
  }

  getModelProvider(id: string): ModelProviderRecord | null {
    return this.listModelProviders().find((item) => item.id === id) || null;
  }

  getEncryptedModelProviderKey(id: string): string {
    const row = this.db.prepare("SELECT encrypted_api_key FROM model_providers WHERE id=?").get(id) as {encrypted_api_key?: string} | undefined;
    return String(row?.encrypted_api_key || "");
  }

  saveModelProvider(value: {id?: string; label: string; kind: ModelProviderKind; baseUrl: string; encryptedApiKey?: string}): ModelProviderRecord {
    const now = isoNow();
    const id = value.id || `provider-${randomUUID()}`;
    const prior = this.getModelProvider(id);
    if (prior) {
      if (value.encryptedApiKey !== undefined) {
        this.db.prepare("UPDATE model_providers SET label=?,kind=?,base_url=?,encrypted_api_key=?,models_json='[]',status='unchecked',error='',updated_at=? WHERE id=?")
          .run(value.label, value.kind, value.baseUrl, value.encryptedApiKey, now, id);
      } else {
        this.db.prepare("UPDATE model_providers SET label=?,kind=?,base_url=?,models_json='[]',status='unchecked',error='',updated_at=? WHERE id=?")
          .run(value.label, value.kind, value.baseUrl, now, id);
      }
    } else {
      this.db.prepare("INSERT INTO model_providers(id,label,kind,base_url,encrypted_api_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
        .run(id, value.label, value.kind, value.baseUrl, value.encryptedApiKey || "", now, now);
    }
    return this.getModelProvider(id)!;
  }

  updateModelProviderProbe(id: string, value: {models?: string[]; status: "ready" | "error"; error?: string}): ModelProviderRecord {
    if (!this.getModelProvider(id)) throw new Error("模型供应商不存在");
    const models = value.models === undefined ? undefined : JSON.stringify([...new Set(value.models.map(String).filter(Boolean))]);
    if (models === undefined) this.db.prepare("UPDATE model_providers SET status=?,error=?,last_checked_at=?,updated_at=? WHERE id=?").run(value.status, value.error || "", isoNow(), isoNow(), id);
    else this.db.prepare("UPDATE model_providers SET models_json=?,status=?,error=?,last_checked_at=?,updated_at=? WHERE id=?").run(models, value.status, value.error || "", isoNow(), isoNow(), id);
    return this.getModelProvider(id)!;
  }

  deleteModelProvider(id: string): void {
    const used = this.db.prepare("SELECT role FROM model_routes WHERE provider_id=?").all(id) as Array<{role: string}>;
    if (used.length) throw new Error(`供应商仍被 ${used.map((item) => item.role).join("、")} 使用，请先切回本地 AGY`);
    if (!this.getModelProvider(id)) throw new Error("模型供应商不存在");
    this.db.prepare("DELETE FROM model_providers WHERE id=?").run(id);
  }

  listModelRoutes(): ModelRouteRecord[] {
    return (this.db.prepare("SELECT * FROM model_routes ORDER BY CASE role WHEN 'generation' THEN 1 WHEN 'review' THEN 2 WHEN 'workbench' THEN 3 ELSE 4 END").all() as Array<Record<string, unknown>>).map((row) => ({
      role: String(row.role) as ModelRole, providerId: String(row.provider_id), modelId: String(row.model_id || ""),
      fallbackEnabled: Boolean(row.fallback_enabled), updatedAt: String(row.updated_at),
    }));
  }

  getModelRoute(role: ModelRole): ModelRouteRecord {
    const found = this.listModelRoutes().find((item) => item.role === role);
    return found || {role, providerId: "agy", modelId: "", fallbackEnabled: false, updatedAt: isoNow()};
  }

  saveModelRoute(value: {role: ModelRole; providerId: string; modelId: string; fallbackEnabled?: boolean}): ModelRouteRecord {
    if (value.providerId === "inherit_review" && value.role !== "review_arbitration") throw new Error("只有审查仲裁可以跟随审查模型");
    if (!["agy", "inherit_review"].includes(value.providerId)) {
      const provider = this.getModelProvider(value.providerId);
      if (!provider) throw new Error("模型供应商不存在");
      if (!value.modelId || !provider.models.includes(value.modelId)) throw new Error("所选模型不在供应商最近拉取的模型列表中");
      if (!provider.apiKeyConfigured) throw new Error("供应商尚未配置 API Key");
    }
    this.db.prepare("INSERT INTO model_routes(role,provider_id,model_id,fallback_enabled,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(role) DO UPDATE SET provider_id=excluded.provider_id,model_id=excluded.model_id,fallback_enabled=excluded.fallback_enabled,updated_at=excluded.updated_at")
      .run(value.role, value.providerId, ["agy", "inherit_review"].includes(value.providerId) ? "" : value.modelId, value.fallbackEnabled === true ? 1 : 0, isoNow());
    return this.getModelRoute(value.role);
  }

  purgeRebuiltScope(bookId: string, scopeType: "chapter" | "volume" | "book", scopeId: string, chapterNumbers: number[], options: {dryRun?: boolean; transactionId?: string} = {}): {deletedRows: number; removedTables: string[]; cleanupPending?: string} {
    const selected = new Set(chapterNumbers.map(Number).filter((item) => Number.isInteger(item) && item > 0));
    const scoped = scopeType !== "book";
    const scopeLabel = `${scopeType}/${scopeId}`;
    const failClosed = (message: string): never => {
      throw new Error(`重建清理拒绝继续（${scopeLabel}）：${message}；该表没有足够的范围血缘，未删除任何 Studio 数据`);
    };
    const parseJsonObject = (raw: unknown): Record<string, unknown> => {
      try {
        const value = JSON.parse(String(raw || "{}")) as unknown;
        return value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : {};
      } catch { return {}; }
    };
    const parseChapterScope = (value: unknown): Set<number> | null => {
      const raw = String(value || "");
      const match = raw.match(/^chapters-(\d+(?:-\d+)*)$/);
      if (!match) return null;
      const numbers = match[1].split("-").map(Number);
      return numbers.every((item) => Number.isInteger(item) && item > 0) ? new Set(numbers) : null;
    };

    const allJobs = this.db.prepare("SELECT * FROM agent_jobs WHERE book_id=?").all(bookId) as Array<Record<string, unknown>>;
    const jobScopeNumbers = (row: Record<string, unknown>): Set<number> | null => {
      const rowScopeType = String(row.scope_type || "");
      if (rowScopeType !== "chapters") return null;
      return parseChapterScope(row.scope_id);
    };
    const affectedJob = (row: Record<string, unknown>): boolean => {
      const chapter = row.chapter === null || row.chapter === undefined ? null : Number(row.chapter);
      const rowScopeType = String(row.scope_type || "book");
      const rowScopeId = String(row.scope_id || "");
      const numbers = jobScopeNumbers(row);
      if (numbers) return [...numbers].some((item) => selected.has(item));
      return (chapter !== null && selected.has(chapter)) || (rowScopeType === scopeType && rowScopeId === scopeId);
    };
    if (scoped) {
      for (const row of allJobs) {
        const numbers = jobScopeNumbers(row);
        if (numbers && [...numbers].some((item) => selected.has(item)) && ![...numbers].every((item) => selected.has(item))) {
          failClosed(`任务 ${String(row.id)} 同时覆盖选中与未选章节`);
        }
        if (String(row.scope_type || "") === "chapters" && !numbers) {
          failClosed(`任务 ${String(row.id)} 的章节范围编号无法解析`);
        }
      }
    }
    const affectedJobRows = scoped ? allJobs.filter(affectedJob) : allJobs;
    if (scoped) {
      const ambiguous = allJobs.filter((row) => {
        const chapter = row.chapter === null || row.chapter === undefined ? null : Number(row.chapter);
        const rowScopeType = String(row.scope_type || "book");
        const rowScopeId = String(row.scope_id || "");
        const affected = affectedJob(row);
        if (affected) return false;
        // A chapter-less book job can contain a whole-book plan or workflow;
        // it cannot be safely attributed to only one rebuilt range.
        return chapter === null && rowScopeType === "book";
      });
      if (ambiguous.length) failClosed(`存在 ${ambiguous.length} 个无章节范围的全书任务`);
    }
    const jobIds = affectedJobRows.map((row) => String(row.id));
    const selectedJobIdSet = new Set(jobIds);
    const protectedJobPaths = new Set<string>();
    if (scoped) {
      for (const row of allJobs) {
        if (selectedJobIdSet.has(String(row.id))) continue;
        for (const value of [row.prompt_path, row.output_path]) {
          if (value && String(value) !== "pending") protectedJobPaths.add(resolve(String(value)));
        }
      }
    }
    const allPlans = this.db.prepare("SELECT * FROM agent_plans WHERE book_id=?").all(bookId) as Array<Record<string, unknown>>;
    const plans = scoped ? allPlans.filter((row) => selectedJobIdSet.has(String(row.job_id))) : allPlans;
    const ambiguousPlans = scoped ? allPlans.filter((row) => !selectedJobIdSet.has(String(row.job_id))) : [];
    // Plans carry no independent scope columns.  A plan not linked to a
    // selected chapter job must remain untouched; a selected plan is safe to
    // remove because its source job is the only available provenance.
    void ambiguousPlans;

    const allWorkflowFeedback = this.db.prepare("SELECT * FROM workflow_feedback WHERE book_id=?").all(bookId) as Array<Record<string, unknown>>;
    const workflowFeedbackRows = scoped
      ? allWorkflowFeedback.filter((row) => row.chapter !== null && selected.has(Number(row.chapter)))
      : allWorkflowFeedback;
    if (scoped && allWorkflowFeedback.some((row) => row.chapter === null)) failClosed("存在无章节归属的工作流反馈");
    if (scoped) {
      const selectedRunIds = new Set(workflowFeedbackRows.map((row) => String(row.run_id || "")).filter(Boolean));
      if (allWorkflowFeedback.some((row) => selectedRunIds.has(String(row.run_id || "")) && (row.chapter === null || !selected.has(Number(row.chapter))))) {
        failClosed("同一工作流反馈运行同时覆盖选中与未选章节");
      }
    }

    const allFeedbackRows = this.db.prepare("SELECT * FROM reader_feedback WHERE book_id=?").all(bookId) as Array<Record<string, unknown>>;
    const affectedFeedback = (row: Record<string, unknown>): boolean => {
      const rowType = String(row.scope_type || "");
      const rowId = String(row.scope_id || "");
      if (scopeType === "chapter") return rowType === "chapter" && rowId === scopeId;
      if (rowType === "volume" && rowId === scopeId) return true;
      return rowType === "chapter" && selected.has(Number(rowId));
    };
    const feedbackRows = scoped ? allFeedbackRows.filter(affectedFeedback) : allFeedbackRows;
    if (scoped && allFeedbackRows.some((row) => {
      const rowType = String(row.scope_type || "");
      return rowType === "book" || (scopeType === "chapter" && rowType === "volume" && String(row.scope_id || "") !== scopeId);
    })) {
      failClosed("存在全书或更高层级的读者反馈，无法证明不会影响本次范围");
    }
    if (scoped && feedbackRows.length) {
      const roots = new Set(feedbackRows.map((row) => String(row.root_feedback_id || row.id || "")).filter(Boolean));
      if (allFeedbackRows.some((row) => roots.has(String(row.root_feedback_id || row.id || "")) && !affectedFeedback(row))) {
        failClosed("同一读者反馈线程同时覆盖选中与未选范围");
      }
    }

    const allRevisionRows = this.db.prepare("SELECT * FROM revision_briefs WHERE book_id=?").all(bookId) as Array<Record<string, unknown>>;
    const revisionRows = scoped ? allRevisionRows.filter((row) => selected.has(Number(row.chapter))) : allRevisionRows;

    const allPlanningRows = this.db.prepare("SELECT * FROM planning_messages WHERE book_id=?").all(bookId) as Array<Record<string, unknown>>;
    const planningAffected = (row: Record<string, unknown>): boolean => {
      const rowType = String(row.scope_type || "");
      const rowId = String(row.scope_id || "");
      if (rowType === scopeType && rowId === scopeId) return true;
      if (rowType === "chapter") return selected.has(Number(rowId));
      if (rowType === "chapters") {
        const chapters = parseChapterScope(rowId);
        if (!chapters) failClosed(`规划对话 ${String(row.id)} 的章节范围编号无法解析`);
        const overlaps = [...chapters!].some((item) => selected.has(item));
        if (overlaps && ![...chapters!].every((item) => selected.has(item))) failClosed(`规划对话 ${String(row.id)} 同时覆盖选中与未选章节`);
        return overlaps;
      }
      return false;
    };
    const planningRows = scoped ? allPlanningRows.filter(planningAffected) : allPlanningRows;
    if (scoped && allPlanningRows.some((row) => ["book", "new_book", "workbench"].includes(String(row.scope_type || "")))) {
      failClosed("存在全书级规划对话，无法安全拆分到局部重建范围");
    }
    if (scoped && scopeType === "chapter" && allPlanningRows.some((row) => String(row.scope_type || "") === "volume")) {
      failClosed("存在卷级规划对话，无法安全拆分到单章");
    }

    const allBenchmarks = this.db.prepare("SELECT * FROM quality_benchmarks WHERE book_id=?").all(bookId) as Array<Record<string, unknown>>;
    const benchmarkChapters = (row: Record<string, unknown>): Set<number> | null => {
      try {
        const value = JSON.parse(String(row.chapter_numbers_json || "[]")) as unknown;
        return Array.isArray(value) ? new Set(value.map(Number).filter((item) => Number.isInteger(item) && item > 0)) : null;
      } catch { return null; }
    };
    const benchmarks = scoped ? allBenchmarks.filter((row) => {
      const chapters = benchmarkChapters(row);
      if (!chapters) failClosed(`质量基线 ${String(row.id)} 的章节快照无法解析`);
      const overlaps = [...chapters!].some((item) => selected.has(item));
      if (overlaps && ![...chapters!].every((item) => selected.has(item))) failClosed(`质量基线 ${String(row.id)} 同时覆盖选中与未选章节`);
      return overlaps;
    }) : allBenchmarks;
    const benchmarkIds = new Set(benchmarks.map((row) => String(row.id)));
    const allBenchmarkRuns = this.db.prepare("SELECT * FROM quality_benchmark_runs WHERE book_id=?").all(bookId) as Array<Record<string, unknown>>;
    const benchmarkRuns = scoped ? allBenchmarkRuns.filter((row) => benchmarkIds.has(String(row.benchmark_id))) : allBenchmarkRuns;

    const allTalks = this.db.prepare("SELECT * FROM personal_talks WHERE linked_book_id=?").all(bookId) as Array<Record<string, unknown>>;
    const snapshotChapterNumbers = (snapshot: Record<string, unknown>): Set<number> | null => {
      const values: number[] = [];
      for (const key of ["chapter_numbers", "chapters"]) {
        if (Array.isArray(snapshot[key])) values.push(...(snapshot[key] as unknown[]).map(Number));
      }
      if (Array.isArray(snapshot.chapter_contracts)) {
        values.push(...(snapshot.chapter_contracts as unknown[]).map((item) => Number(
          item && typeof item === "object" ? (item as Record<string, unknown>).chapter_number : NaN,
        )));
      }
      const clean = values.filter((item) => Number.isInteger(item) && item > 0);
      return clean.length ? new Set(clean) : null;
    };
    const talks = scoped ? allTalks.filter((row) => {
      const snapshot = parseJsonObject(row.progress_snapshot_json);
      const explicit = snapshotChapterNumbers(snapshot);
      if (explicit) {
        const overlaps = [...explicit].some((item) => selected.has(item));
        if (overlaps && ![...explicit].every((item) => selected.has(item))) {
          failClosed(`个人谈 ${String(row.id)} 同时覆盖选中与未选章节`);
        }
        return overlaps;
      }
      const through = Number(snapshot.progressed_through);
      if (!Number.isInteger(through) || through < 0) failClosed(`个人谈 ${String(row.id)} 缺少可验证的进度快照`);
      if ([...selected].every((item) => item > through)) return false;
      failClosed(`个人谈 ${String(row.id)} 的进度快照无法精确归属到本次重建章节`);
    }) : allTalks;

    const previewRows = this.db.prepare("SELECT * FROM work_write_previews WHERE book_id=?").all(bookId) as Array<Record<string, unknown>>;
    if (scoped && previewRows.length) failClosed("存在全书级番茄资料写入预览，无法证明与局部重建无关");
    const previewIds = previewRows.map((row) => String(row.id));
    const metaRows = this.db.prepare("SELECT key,value FROM studio_meta").all() as Array<{key: string; value: string}>;
    const batchIds = new Set<string>();
    const metaKeysToDelete = new Set<string>();
    for (const row of metaRows) {
      const key = String(row.key);
      if (key.startsWith("fanqie_book_work:") || key.startsWith("fanqie_book_pending_batch:")) {
        const parts = key.split(":");
        if (parts.length === 3 && parts[2] === bookId) {
          metaKeysToDelete.add(key);
          if (key.startsWith("fanqie_book_pending_batch:") && row.value) batchIds.add(String(row.value));
        }
      }
      if (key.startsWith("fanqie_batch_intent:")) {
        const intent = parseJsonObject(row.value);
        if (String(intent.bookId || "") === bookId) batchIds.add(key.slice("fanqie_batch_intent:".length));
      }
    }
    for (const batchId of batchIds) {
      for (const prefix of ["fanqie_batch_account:", "fanqie_batch_work:", "fanqie_batch_intent:", "fanqie_batch_attempted:"]) metaKeysToDelete.add(`${prefix}${batchId}`);
    }

    const jobFilePaths = new Set<string>();
    const protectedRunIds = new Set(allJobs.filter((row) => !selectedJobIdSet.has(String(row.id))).map((row) => String(row.run_id || "")));
    for (const row of affectedJobRows) {
      for (const value of [row.prompt_path, row.output_path]) {
        if (value && String(value) !== "pending" && !protectedJobPaths.has(resolve(String(value)))) jobFilePaths.add(resolve(String(value)));
      }
      const jobId = String(row.id);
      jobFilePaths.add(join(this.dataDir, "jobs", `${jobId}.json`));
      jobFilePaths.add(join(this.dataDir, "jobs", `${jobId}.agy.log`));
      const runId = String(row.run_id || "");
      if (runId && !protectedRunIds.has(runId)) jobFilePaths.add(join(this.dataDir, "planning-drafts", `${runId}.foundation-contract.json`));
    }
    const talkFilePaths = talks.map((row) => join(this.root, "authors", String(row.author_id), "personal-talks", `${String(row.id)}.json`));
    if (!scoped) {
      jobFilePaths.add(join(this.dataDir, "reader-feedback", bookId));
      for (const entry of [
        `fanqie-session-${bookId}-`,
      ]) {
        if (existsSync(this.dataDir)) {
          // Session artifacts include the account id; only the exact book
          // prefix is removed, leaving every account's other books intact.
          for (const name of readdirSync(this.dataDir)) if (name.startsWith(entry)) jobFilePaths.add(join(this.dataDir, name));
        }
      }
    }

    const executionPlanIds = plans.map((row) => String(row.job_id));
    const affectedJobJson = JSON.stringify(jobIds);
    const affectedPlanJson = JSON.stringify(executionPlanIds);
    const affectedBenchmarkJson = JSON.stringify([...benchmarkIds]);
    const workflowFeedbackCount = workflowFeedbackRows.length;
    const executionResultCount = executionPlanIds.length
      ? Number((this.db.prepare("SELECT COUNT(*) AS count FROM agent_execution_results WHERE plan_id IN (SELECT value FROM json_each(?))").get(affectedPlanJson) as {count: number}).count)
      : 0;
    const deletedRows = affectedJobRows.length
      + (jobIds.length ? Number((this.db.prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id IN (SELECT value FROM json_each(?))").get(affectedJobJson) as {count: number}).count) : 0)
      + (jobIds.length ? Number((this.db.prepare("SELECT COUNT(*) AS count FROM job_results WHERE job_id IN (SELECT value FROM json_each(?))").get(affectedJobJson) as {count: number}).count) : 0)
      + plans.length + workflowFeedbackCount + executionResultCount + feedbackRows.length + revisionRows.length + planningRows.length
      + previewRows.length + talks.length + benchmarks.length + benchmarkRuns.length;
    const removedTables: string[] = [];
    const transactionId = options.transactionId || randomUUID().replaceAll("-", "");
    let files: RebuildFiles | undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (jobIds.length) {
        this.db.prepare("DELETE FROM job_events WHERE job_id IN (SELECT value FROM json_each(?))").run(affectedJobJson);
        this.db.prepare("DELETE FROM job_results WHERE job_id IN (SELECT value FROM json_each(?))").run(affectedJobJson);
        this.db.prepare("DELETE FROM agent_jobs WHERE id IN (SELECT value FROM json_each(?))").run(affectedJobJson);
        removedTables.push("agent_jobs", "job_events", "job_results");
      }
      if (plans.length) {
        this.db.prepare("DELETE FROM agent_execution_results WHERE plan_id IN (SELECT value FROM json_each(?))").run(affectedPlanJson);
        this.db.prepare("DELETE FROM agent_plans WHERE job_id IN (SELECT value FROM json_each(?))").run(affectedPlanJson);
        removedTables.push("agent_plans", "agent_execution_results");
      }
      if (workflowFeedbackRows.length) this.db.prepare("DELETE FROM workflow_feedback WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(workflowFeedbackRows.map((row) => String(row.id))));
      removedTables.push("workflow_feedback");
      if (scopeType === "book") {
        this.db.prepare("DELETE FROM reader_feedback WHERE book_id=?").run(bookId);
        this.db.prepare("DELETE FROM revision_briefs WHERE book_id=?").run(bookId);
        // This legacy table is intentionally read-only during normal use, but
        // a full permanent rebuild must not leave old book-writing rules in a
        // hidden Studio database.  Drop and recreate only the delete guard in
        // the same transaction.
        this.db.exec("DROP TRIGGER IF EXISTS author_preferences_read_only_delete");
        this.db.prepare("DELETE FROM author_preferences WHERE book_id=?").run(bookId);
        this.db.exec(`CREATE TRIGGER author_preferences_read_only_delete BEFORE DELETE ON author_preferences BEGIN
          SELECT RAISE(ABORT, 'legacy author_preferences is read-only');
        END`);
        removedTables.push("author_preferences");
      } else {
        const feedbackIds = (feedbackRows as Array<Record<string, unknown>>).map((row) => String(row.id));
        if (feedbackIds.length) this.db.prepare("DELETE FROM reader_feedback WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(feedbackIds));
        this.db.prepare("DELETE FROM revision_briefs WHERE book_id=? AND chapter IN (SELECT value FROM json_each(?))").run(bookId, JSON.stringify(chapterNumbers));
      }
      removedTables.push("reader_feedback", "revision_briefs");
      if (planningRows.length) this.db.prepare("DELETE FROM planning_messages WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(planningRows.map((row) => String(row.id))));
      removedTables.push("planning_messages");
      if (previewIds.length) {
        this.db.prepare("DELETE FROM operation_confirmations WHERE target_id IN (SELECT value FROM json_each(?))").run(JSON.stringify(previewIds));
      }
      this.db.prepare("DELETE FROM operation_confirmations WHERE target_id=?").run(bookId);
      if (batchIds.size) this.db.prepare("DELETE FROM operation_confirmations WHERE target_id IN (SELECT value FROM json_each(?))").run(JSON.stringify([...batchIds]));
      if (metaKeysToDelete.size) this.db.prepare("DELETE FROM studio_meta WHERE key IN (SELECT value FROM json_each(?))").run(JSON.stringify([...metaKeysToDelete]));
      if (previewIds.length) this.db.prepare("DELETE FROM work_write_previews WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(previewIds));
      if (talks.length) this.db.prepare("DELETE FROM personal_talks WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(talks.map((row) => String(row.id))));
      if (benchmarkRuns.length) this.db.prepare("DELETE FROM quality_benchmark_runs WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(benchmarkRuns.map((row) => String(row.id))));
      if (benchmarkIds.size) this.db.prepare("DELETE FROM quality_benchmarks WHERE id IN (SELECT value FROM json_each(?))").run(affectedBenchmarkJson);
      removedTables.push("work_write_previews", "operation_confirmations", "studio_meta", "personal_talks", "quality_benchmarks", "quality_benchmark_runs");
      if (options.dryRun) this.db.exec("ROLLBACK");
      else {
        files = new RebuildFiles(this.root, bookId, transactionId, [...jobFilePaths, ...talkFilePaths]);
        files.stage();
        this.db.prepare("INSERT INTO book_transaction_commits(transaction_id,book_id,committed_at) VALUES(?,?,?)").run(transactionId, bookId, isoNow());
        this.db.exec("COMMIT");
      }
    } catch (error) {
      this.db.exec("ROLLBACK");
      try { files?.rollback(); }
      catch (recoveryError) { throw new Error(`${error}; Studio 文件恢复未完成：${recoveryError}`); }
      throw error;
    }
    if (options.dryRun) return {deletedRows, removedTables: [...new Set(removedTables)]};
    // Past the durable decision, cleanup failure must NEVER trigger a Python
    // rollback. Report retained staging explicitly and let recovery retry it.
    try { files?.discard(); }
    catch { return {deletedRows, removedTables: [...new Set(removedTables)], cleanupPending: files!.directory}; }
    return {deletedRows, removedTables: [...new Set(removedTables)]};
  }

  deleteMeta(key: string): void {
    this.db.prepare("DELETE FROM studio_meta WHERE key=?").run(key);
  }

  createJob(value: Omit<AgentJob, "id" | "createdAt" | "startedAt" | "finishedAt" | "pid" | "exitCode" | "outputHash" | "error">): AgentJob {
    const id = `job-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const createdAt = isoNow();
    this.db.prepare(`
      INSERT INTO agent_jobs(id,run_id,book_id,chapter,stage,status,prompt_path,prompt_hash,output_path,retry_of,scope_type,scope_id,action_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, value.runId, value.bookId, value.chapter, value.stage, value.status,
      value.promptPath, value.promptHash, value.outputPath, value.retryOf,
      value.scopeType || "book", value.scopeId || value.bookId, value.actionId || "", createdAt,
    );
    return this.getJob(id)!;
  }

  // 原子领取一个分维度复核组：INSERT OR IGNORE + 部分唯一索引，只有成功插入的调用者
  // 才真正创建任务；changes=0 表示该组已被另一任务领取，返回现有 job 而非重复创建。
  createVerifyGroupJob(value: Omit<AgentJob, "id" | "createdAt" | "startedAt" | "finishedAt" | "pid" | "exitCode" | "outputHash" | "error">, groupKey: string): {claimed: boolean; job: AgentJob | null} {
    const id = `job-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const createdAt = isoNow();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO agent_jobs(id,run_id,book_id,chapter,stage,status,prompt_path,prompt_hash,output_path,retry_of,scope_type,scope_id,action_id,verify_group_key,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, value.runId, value.bookId, value.chapter, value.stage, value.status,
      value.promptPath, value.promptHash, value.outputPath, value.retryOf,
      value.scopeType || "book", value.scopeId || value.bookId, value.actionId || "", groupKey, createdAt,
    );
    if (result.changes === 0) {
      const existingRow = this.db.prepare("SELECT id FROM agent_jobs WHERE verify_group_key=?").get(groupKey) as {id: string} | undefined;
      return {claimed: false, job: existingRow ? this.getJob(existingRow.id) : null};
    }
    return {claimed: true, job: this.getJob(id)!};
  }

  getJob(id: string): AgentJob | null {
    const row = this.db.prepare("SELECT * FROM agent_jobs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? toAgentJob(row) : null;
  }

  listJobs(runId?: string, limit = 60): AgentJob[] {
    const rows = runId
      ? this.db.prepare("SELECT * FROM agent_jobs WHERE run_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?").all(runId, limit)
      : this.db.prepare("SELECT * FROM agent_jobs ORDER BY created_at DESC,rowid DESC LIMIT ?").all(limit);
    return (rows as Record<string, unknown>[]).map(toAgentJob);
  }

  listJobsForBook(bookId: string, limit = 100): AgentJob[] {
    const rows = this.db.prepare("SELECT * FROM agent_jobs WHERE book_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?")
      .all(bookId, limit) as Record<string, unknown>[];
    return rows.map(toAgentJob);
  }

  activeJobForBook(bookId: string): AgentJob | null {
    const row = this.db.prepare("SELECT * FROM agent_jobs WHERE book_id=? AND status IN ('queued','running','awaiting_choice') ORDER BY created_at DESC LIMIT 1").get(bookId) as Record<string, unknown> | undefined;
    return row ? toAgentJob(row) : null;
  }

  activePlanningJobForBook(bookId: string): AgentJob | null {
    const row = this.db.prepare(`
      SELECT * FROM agent_jobs
      WHERE book_id=? AND status IN ('queued','running','awaiting_choice') AND stage LIKE 'planning_%'
      ORDER BY created_at DESC LIMIT 1
    `).get(bookId) as Record<string, unknown> | undefined;
    return row ? toAgentJob(row) : null;
  }

  activeJobForScope(scopeType: "book" | "author" | "system", scopeId: string): AgentJob | null {
    const row = this.db.prepare("SELECT * FROM agent_jobs WHERE scope_type=? AND scope_id=? AND status IN ('queued','running','awaiting_choice') ORDER BY created_at DESC LIMIT 1")
      .get(scopeType, scopeId) as Record<string, unknown> | undefined;
    return row ? toAgentJob(row) : null;
  }

  updateJob(id: string, patch: Partial<{status: AgentJobStatus; pid: number | null; exitCode: number | null; outputHash: string; error: string; startedAt: string; finishedAt: string}>): AgentJob {
    const columns: Record<string, string> = {
      status: "status", pid: "pid", exitCode: "exit_code", outputHash: "output_hash",
      error: "error", startedAt: "started_at", finishedAt: "finished_at",
    };
    const entries = Object.entries(patch).filter(([key]) => columns[key]);
    if (entries.length) {
      const sql = entries.map(([key]) => `${columns[key]}=?`).join(",");
      this.db.prepare(`UPDATE agent_jobs SET ${sql} WHERE id=?`).run(...entries.map(([, value]) => value), id);
    }
    const job = this.getJob(id);
    if (!job) throw new Error(`agent job does not exist: ${id}`);
    return job;
  }

  appendEvent(jobId: string, level: JobEvent["level"], message: string, kind: JobEvent["kind"] = "log", payload: Record<string, unknown> | null = null): JobEvent {
    const clean = message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, 12000);
    const createdAt = isoNow();
    const cleanPayload = payload ? JSON.stringify(payload).slice(0, 100_000) : null;
    const result = this.db.prepare("INSERT INTO job_events(job_id,level,message,kind,payload,created_at) VALUES(?,?,?,?,?,?)")
      .run(jobId, level, clean, kind, cleanPayload, createdAt);
    return { id: Number(result.lastInsertRowid), jobId, level, kind, payload, message: clean, createdAt };
  }

  listEvents(jobId: string, after = 0): JobEvent[] {
    const rows = this.db.prepare("SELECT * FROM job_events WHERE job_id=? AND id>? ORDER BY id LIMIT 500").all(jobId, after) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      let payload: Record<string, unknown> | null = null;
      if (row.payload) {
        try { payload = JSON.parse(String(row.payload)) as Record<string, unknown>; } catch { payload = null; }
      }
      return {
        id: Number(row.id), jobId: String(row.job_id), level: String(row.level) as JobEvent["level"],
        kind: String(row.kind || "log") as JobEvent["kind"], payload, message: String(row.message), createdAt: String(row.created_at),
      };
    });
  }

  saveJobResult(jobId: string, value: {
    publicDecision?: Record<string, unknown>;
    validationTrace?: Record<string, unknown>;
    lineage?: Record<string, unknown>;
  }): void {
    const current = this.getJobResult(jobId);
    const publicDecision = value.publicDecision ?? current.publicDecision;
    const validationTrace = value.validationTrace ?? current.validationTrace;
    const lineage = value.lineage ?? current.lineage;
    this.db.prepare(`
      INSERT INTO job_results(job_id,public_decision,validation_trace,lineage,updated_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(job_id) DO UPDATE SET
        public_decision=excluded.public_decision,
        validation_trace=excluded.validation_trace,
        lineage=excluded.lineage,
        updated_at=excluded.updated_at
    `).run(jobId, JSON.stringify(publicDecision), JSON.stringify(validationTrace), JSON.stringify(lineage), isoNow());
  }

  getJobResult(jobId: string): {
    publicDecision: Record<string, unknown>;
    validationTrace: Record<string, unknown>;
    lineage: Record<string, unknown>;
  } {
    const row = this.db.prepare("SELECT * FROM job_results WHERE job_id=?").get(jobId) as Record<string, unknown> | undefined;
    const parse = (raw: unknown): Record<string, unknown> => {
      try {
        const value = JSON.parse(String(raw || "{}")) as unknown;
        return value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : {};
      } catch { return {}; }
    };
    return {
      publicDecision: parse(row?.public_decision),
      validationTrace: parse(row?.validation_trace),
      lineage: parse(row?.lineage),
    };
  }

  addWorkflowFeedback(runId: string, bookId: string, stage: string, chapter: number | null, content: string): WorkflowFeedback {
    const id = `feedback-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const createdAt = isoNow();
    this.db.prepare("INSERT INTO workflow_feedback(id,run_id,book_id,chapter,stage,content,status,created_at) VALUES(?,?,?,?,?,?,'pending',?)")
      .run(id, runId, bookId, chapter, stage, content, createdAt);
    return this.listWorkflowFeedback(runId).find((item) => item.id === id)!;
  }

  listWorkflowFeedback(runId: string, limit = 30): WorkflowFeedback[] {
    const rows = this.db.prepare("SELECT * FROM workflow_feedback WHERE run_id=? ORDER BY created_at DESC LIMIT ?").all(runId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id), runId: String(row.run_id), bookId: String(row.book_id),
      chapter: row.chapter === null ? null : Number(row.chapter), stage: String(row.stage), content: String(row.content),
      status: String(row.status) as WorkflowFeedback["status"], jobId: row.job_id === null ? null : String(row.job_id),
      createdAt: String(row.created_at), appliedAt: row.applied_at === null ? null : String(row.applied_at),
    }));
  }

  savePlanningMessage(value: {
    bookId: string;
    scopeType: PlanningConversationMessage["scopeType"];
    scopeId: string;
    role: PlanningConversationMessage["role"];
    text: string;
    proposal?: Record<string, unknown> | null;
    warnings?: string[];
    jobId: string;
  }): PlanningConversationMessage {
    const id = `planning-message-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    this.db.prepare(`
      INSERT INTO planning_messages(id,book_id,scope_type,scope_id,role,text,proposal_json,warnings_json,job_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(book_id,scope_type,scope_id,job_id,role) DO UPDATE SET
        text=excluded.text,proposal_json=excluded.proposal_json,warnings_json=excluded.warnings_json
    `).run(
      id, value.bookId, value.scopeType, value.scopeId, value.role, value.text,
      JSON.stringify(value.proposal || null), JSON.stringify(value.warnings || []), value.jobId, isoNow(),
    );
    const row = this.db.prepare("SELECT * FROM planning_messages WHERE book_id=? AND scope_type=? AND scope_id=? AND job_id=? AND role=?")
      .get(value.bookId, value.scopeType, value.scopeId, value.jobId, value.role) as Record<string, unknown>;
    return toPlanningMessage(row);
  }

  listPlanningMessages(bookId: string, scopeType: PlanningConversationMessage["scopeType"], scopeId: string, limit = 80): PlanningConversationMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT pm.*,pm.rowid AS sequence_row,
          (SELECT MIN(anchor.created_at) FROM planning_messages anchor
           WHERE anchor.book_id=pm.book_id AND anchor.scope_type=pm.scope_type AND anchor.scope_id=pm.scope_id AND anchor.job_id=pm.job_id) AS anchor_created_at
        FROM planning_messages pm
        WHERE pm.book_id=? AND pm.scope_type=? AND pm.scope_id=?
        ORDER BY anchor_created_at DESC,pm.rowid DESC LIMIT ?
      ) ORDER BY anchor_created_at,CASE role WHEN 'user' THEN 0 ELSE 1 END,sequence_row
    `).all(bookId, scopeType, scopeId, limit) as Array<Record<string, unknown>>;
    return rows.map(toPlanningMessage);
  }

  planningConversationScopeForJob(jobId: string): {bookId: string; scopeType: PlanningConversationMessage["scopeType"]; scopeId: string} | null {
    const row = this.db.prepare("SELECT book_id,scope_type,scope_id FROM planning_messages WHERE job_id=? ORDER BY created_at LIMIT 1").get(jobId) as Record<string, unknown> | undefined;
    return row ? {bookId: String(row.book_id), scopeType: String(row.scope_type) as PlanningConversationMessage["scopeType"], scopeId: String(row.scope_id)} : null;
  }

  clearPlanningMessages(bookId: string, scopeType: PlanningConversationMessage["scopeType"], scopeId: string): number {
    return Number(this.db.prepare("DELETE FROM planning_messages WHERE book_id=? AND scope_type=? AND scope_id=?").run(bookId, scopeType, scopeId).changes);
  }

  purgePlanningConversationArtifacts(
    bookId: string,
    scopeType: Exclude<PlanningConversationMessage["scopeType"], "workbench">,
    scopeId: string,
  ): {deletedMessages: number; deletedJobs: number; deletedFiles: number} {
    const bookJobs = this.listJobsForBook(bookId, 50_000);
    const matchesScope = (job: AgentJob): boolean => {
      const lineage = this.getJobResult(job.id).lineage;
      let planningScope = String(lineage.planningScope || "");
      let snapshot = lineage.planningContextSnapshot;
      // 审查任务可能没有直接 planningScope/快照，从 producer 任务推导，避免孤立审查任务遗漏。
      // 遍历全部 producer，任一仍存活即尝试归属；第一个丢失时第二个仍能救回。
      if ((!planningScope || !snapshot) && lineage.producerJobIds) {
        for (const rawId of Object.values(lineage.producerJobIds as Record<string, unknown> || {})) {
          const producer = bookJobs.find((item) => item.id === String(rawId || ""));
          if (!producer) continue;
          const producerLineage = this.getJobResult(producer.id).lineage;
          if (!planningScope && producerLineage.planningScope) planningScope = String(producerLineage.planningScope);
          if (!snapshot && producerLineage.planningContextSnapshot) snapshot = producerLineage.planningContextSnapshot;
          if (planningScope && snapshot) break;
        }
      }
      if (!planningScope) planningScope = /^planning_/.test(job.stage) ? job.stage.replace(/^planning_/, "") : "";
      if (planningScope !== scopeType) return false;
      if (scopeType === "book" || scopeType === "new_book") return true;
      const selected = snapshot && !Array.isArray(snapshot) && typeof snapshot === "object"
        ? (snapshot as Record<string, unknown>).selected_ids : null;
      const selectedRecord = selected && !Array.isArray(selected) && typeof selected === "object" ? selected as Record<string, unknown> : {};
      if (scopeType === "chapters") {
        const ids = Array.isArray(selectedRecord.ids) ? selectedRecord.ids.map(String).sort((left, right) => Number(left) - Number(right)) : [];
        const expected = scopeId.split(",").map((item) => item.trim()).filter(Boolean).sort((left, right) => Number(left) - Number(right));
        return ids.length > 0 && JSON.stringify(ids) === JSON.stringify(expected);
      }
      return String(selectedRecord.id || "") === scopeId;
    };
    const selectedRunIds = new Set(bookJobs.filter(matchesScope).map((job) => job.runId));
    const selectedJobs = bookJobs.filter((job) => selectedRunIds.has(job.runId));
    const active = selectedJobs.find((job) => ["queued", "running", "awaiting_choice"].includes(job.status));
    if (active) throw new Error(`当前范围仍有规划任务（${active.id}）正在运行，请先停止任务`);

    const jobIds = selectedJobs.map((job) => job.id);
    const filePaths = new Set<string>();
    for (const job of selectedJobs) {
      for (const path of [job.promptPath, job.outputPath]) if (path && path !== "pending") filePaths.add(resolve(path));
      const lineage = this.getJobResult(job.id).lineage;
      if (lineage.planningSourcePromptPath) filePaths.add(resolve(String(lineage.planningSourcePromptPath)));
      filePaths.add(join(this.dataDir, "jobs", `${job.id}.json`));
      filePaths.add(join(this.dataDir, "jobs", `${job.id}.agy.log`));
    }
    for (const runId of selectedRunIds) filePaths.add(join(this.dataDir, "planning-drafts", `${runId}.foundation-contract.json`));

    // 先删文件再删数据库：文件被占用或删除失败时保留 DB 索引，可重试（修复清理非原子）。
    const rootPath = resolve(this.root);
    let deletedFiles = 0;
    const failedFiles: string[] = [];
    for (const path of filePaths) {
      const relativePath = relative(rootPath, path);
      if (relativePath === ".." || relativePath.startsWith("..") || isAbsolute(relativePath) || !existsSync(path)) continue;
      try {
        rmSync(path, {recursive: true});
        deletedFiles += 1;
      } catch {
        failedFiles.push(path);
      }
    }
    if (failedFiles.length) throw new Error(`部分文件无法删除（可能被占用），已保留数据库索引以便重试：${failedFiles.length} 项`);

    let deletedMessages = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (jobIds.length) {
        const encoded = JSON.stringify(jobIds);
        // Old Studio builds sometimes stored book scope as the book id rather
        // than the canonical "book" value. Delete by provenance as well as by
        // scope so those orphan anchors cannot repopulate any inspector tab.
        deletedMessages += Number(this.db.prepare("DELETE FROM planning_messages WHERE job_id IN (SELECT value FROM json_each(?))").run(encoded).changes);
        this.db.prepare("DELETE FROM job_events WHERE job_id IN (SELECT value FROM json_each(?))").run(encoded);
        this.db.prepare("DELETE FROM job_results WHERE job_id IN (SELECT value FROM json_each(?))").run(encoded);
        this.db.prepare("DELETE FROM agent_jobs WHERE id IN (SELECT value FROM json_each(?))").run(encoded);
      }
      deletedMessages += Number(this.db.prepare("DELETE FROM planning_messages WHERE book_id=? AND scope_type=? AND scope_id=?").run(bookId, scopeType, scopeId).changes);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {deletedMessages, deletedJobs: selectedJobs.length, deletedFiles};
  }

  saveQualityBenchmark(value: {bookId: string; name: string; chapters: number[]; snapshot: Record<string, unknown>}): Record<string, unknown> {
    const benchmarkId = `quality-base-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const now = isoNow();
    this.db.prepare("INSERT INTO quality_benchmarks(id,book_id,name,chapter_numbers_json,snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(benchmarkId, value.bookId, value.name, JSON.stringify(value.chapters), JSON.stringify(value.snapshot), now, now);
    return this.getQualityBenchmark(benchmarkId)!;
  }

  getQualityBenchmark(benchmarkId: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT * FROM quality_benchmarks WHERE id=?").get(benchmarkId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id), bookId: String(row.book_id), name: String(row.name),
      chapters: JSON.parse(String(row.chapter_numbers_json || "[]")) as number[],
      snapshot: JSON.parse(String(row.snapshot_json || "{}")) as Record<string, unknown>,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  listQualityBenchmarks(bookId: string): Record<string, unknown>[] {
    const rows = this.db.prepare("SELECT id FROM quality_benchmarks WHERE book_id=? ORDER BY created_at DESC").all(bookId) as Array<{id?: unknown}>;
    return rows.map((row) => this.getQualityBenchmark(String(row.id))!).filter(Boolean);
  }

  saveQualityBenchmarkRun(value: {benchmarkId: string; bookId: string; comparison: Record<string, unknown>}): Record<string, unknown> {
    const runId = `quality-run-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const now = isoNow();
    this.db.prepare("INSERT INTO quality_benchmark_runs(id,benchmark_id,book_id,comparison_json,judgments_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(runId, value.benchmarkId, value.bookId, JSON.stringify(value.comparison), "{}", now, now);
    return this.getQualityBenchmarkRun(runId)!;
  }

  getQualityBenchmarkRun(runId: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT * FROM quality_benchmark_runs WHERE id=?").get(runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id), benchmarkId: String(row.benchmark_id), bookId: String(row.book_id),
      comparison: JSON.parse(String(row.comparison_json || "{}")) as Record<string, unknown>,
      judgments: JSON.parse(String(row.judgments_json || "{}")) as Record<string, unknown>,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  listQualityBenchmarkRuns(bookId: string, limit = 20): Record<string, unknown>[] {
    const rows = this.db.prepare("SELECT id FROM quality_benchmark_runs WHERE book_id=? ORDER BY created_at DESC LIMIT ?").all(bookId, limit) as Array<{id?: unknown}>;
    return rows.map((row) => this.getQualityBenchmarkRun(String(row.id))!).filter(Boolean);
  }

  saveQualityJudgment(runId: string, chapter: number, choice: "A" | "B" | "tie", rationale: string): Record<string, unknown> {
    const current = this.getQualityBenchmarkRun(runId);
    if (!current) throw new Error("质量对照运行不存在");
    const judgments = {...current.judgments as Record<string, unknown>, [String(chapter)]: {choice, rationale, judgedAt: isoNow()}};
    this.db.prepare("UPDATE quality_benchmark_runs SET judgments_json=?,updated_at=? WHERE id=?").run(JSON.stringify(judgments), isoNow(), runId);
    return this.getQualityBenchmarkRun(runId)!;
  }

  pendingWorkflowFeedback(runId: string, stage: string, chapter: number | null): WorkflowFeedback[] {
    return this.listWorkflowFeedback(runId, 100).filter((item) => item.status === "pending" && item.stage === stage && item.chapter === chapter).reverse();
  }

  markWorkflowFeedbackApplied(ids: string[], jobId: string): void {
    if (!ids.length) return;
    const statement = this.db.prepare("UPDATE workflow_feedback SET status='applied',job_id=?,applied_at=? WHERE id=? AND status='pending'");
    const now = isoNow();
    for (const id of ids) statement.run(jobId, now, id);
  }

  saveAgentPlan(job: AgentJob, artifact: Record<string, unknown>): AgentPlanRecord {
    const record: AgentPlanRecord = {
      jobId: job.id, bookId: job.bookId, status: "pending",
      summary: String(artifact.summary || ""), artifact,
      createdAt: isoNow(), confirmedAt: null, executedAt: null,
    };
    this.db.prepare("INSERT INTO agent_plans(job_id,book_id,status,summary,artifact,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(job_id) DO NOTHING")
      .run(record.jobId, record.bookId, record.status, record.summary, JSON.stringify(record.artifact), record.createdAt);
    return this.getAgentPlan(job.id)!;
  }

  getAgentPlan(jobId: string): AgentPlanRecord | null {
    const row = this.db.prepare("SELECT * FROM agent_plans WHERE job_id=?").get(jobId) as Record<string, unknown> | undefined;
    if (!row) return null;
    let artifact: Record<string, unknown> = {};
    try { artifact = JSON.parse(String(row.artifact)) as Record<string, unknown>; } catch { artifact = {}; }
    return {
      jobId: String(row.job_id), bookId: String(row.book_id), status: String(row.status) as AgentPlanStatus,
      summary: String(row.summary), artifact, createdAt: String(row.created_at),
      confirmedAt: row.confirmed_at ? String(row.confirmed_at) : null,
      executedAt: row.executed_at ? String(row.executed_at) : null,
    };
  }

  updateAgentPlanStatus(jobId: string, status: AgentPlanStatus): AgentPlanRecord {
    const field = status === "rejected" || status === "executed" || status === "failed" ? "executed_at" : "confirmed_at";
    const now = isoNow();
    this.db.prepare(`UPDATE agent_plans SET status=?,${field}=? WHERE job_id=?`).run(status, now, jobId);
    const plan = this.getAgentPlan(jobId);
    if (!plan) throw new Error("代理计划不存在");
    return plan;
  }

  claimAgentPlan(jobId: string, status: "confirmed" | "rejected"): AgentPlanRecord {
    const field = status === "confirmed" ? "confirmed_at" : "executed_at";
    const claimed = this.db.prepare(`UPDATE agent_plans SET status=?,${field}=? WHERE job_id=? AND status='pending'`)
      .run(status, isoNow(), jobId);
    if (claimed.changes !== 1) throw new Error("该计划已被处理，不能重复执行或拒绝");
    return this.getAgentPlan(jobId)!;
  }

  saveAgentExecutionResult(result: AgentExecutionResult): AgentExecutionResult {
    this.db.prepare("INSERT OR REPLACE INTO agent_execution_results(plan_id,status,executed_at,actions) VALUES(?,?,?,?)")
      .run(result.planId, result.status, result.executedAt, JSON.stringify(result.actions));
    return result;
  }

  getAgentExecutionResult(planId: string): AgentExecutionResult | null {
    const row = this.db.prepare("SELECT * FROM agent_execution_results WHERE plan_id=?").get(planId) as Record<string, unknown> | undefined;
    if (!row) return null;
    let actions: AgentExecutionResult["actions"] = [];
    try { actions = JSON.parse(String(row.actions)) as AgentExecutionResult["actions"]; } catch { actions = []; }
    return {planId: String(row.plan_id), status: String(row.status) as AgentExecutionResult["status"], executedAt: String(row.executed_at), actions};
  }

  addAuthorPreference(value: Omit<AuthorPreference, "id" | "createdAt" | "updatedAt">): AuthorPreference {
    const id = `pref-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const now = isoNow();
    this.db.prepare("INSERT INTO author_preferences(id,book_id,category,rule,evidence,enabled,source_job_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, value.bookId, value.category, value.rule, value.evidence, value.enabled ? 1 : 0, value.sourceJobId, now, now);
    return this.listAuthorPreferences(value.bookId).find((item) => item.id === id)!;
  }

  listAuthorPreferences(bookId: string): AuthorPreference[] {
    const rows = this.db.prepare("SELECT * FROM author_preferences WHERE book_id=? ORDER BY created_at DESC").all(bookId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id), bookId: String(row.book_id), category: String(row.category) as AuthorPreference["category"],
      rule: String(row.rule), evidence: String(row.evidence), enabled: Boolean(row.enabled),
      sourceJobId: row.source_job_id === null ? null : String(row.source_job_id),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }));
  }

  updateAuthorPreference(preferenceId: string, value: Partial<Pick<AuthorPreference, "category" | "rule" | "evidence" | "enabled">>): AuthorPreference {
    const current = this.db.prepare("SELECT * FROM author_preferences WHERE id=?").get(preferenceId) as Record<string, unknown> | undefined;
    if (!current) throw new Error("作者偏好不存在");
    const next = {
      category: value.category ?? String(current.category),
      rule: value.rule ?? String(current.rule),
      evidence: value.evidence ?? String(current.evidence),
      enabled: value.enabled ?? Boolean(current.enabled),
    };
    this.db.prepare("UPDATE author_preferences SET category=?,rule=?,evidence=?,enabled=?,updated_at=? WHERE id=?")
      .run(next.category, next.rule, next.evidence, next.enabled ? 1 : 0, isoNow(), preferenceId);
    const updated = this.listAuthorPreferences(String(current.book_id)).find((item) => item.id === preferenceId);
    if (!updated) throw new Error("作者偏好更新失败");
    return updated;
  }

  deleteAuthorPreference(preferenceId: string): AuthorPreference {
    const current = this.db.prepare("SELECT * FROM author_preferences WHERE id=?").get(preferenceId) as Record<string, unknown> | undefined;
    if (!current) throw new Error("作者偏好不存在");
    this.db.prepare("DELETE FROM author_preferences WHERE id=?").run(preferenceId);
    return {
      id: String(current.id), bookId: String(current.book_id), category: String(current.category) as AuthorPreference["category"],
      rule: String(current.rule), evidence: String(current.evidence), enabled: Boolean(current.enabled),
      sourceJobId: current.source_job_id === null ? null : String(current.source_job_id),
      createdAt: String(current.created_at), updatedAt: String(current.updated_at),
    };
  }

  saveRevisionBrief(value: {bookId: string; chapter: number; feedback: string; sourceJobId: string}): RevisionBriefRecord {
    const id = `brief-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const now = isoNow();
    this.db.prepare("INSERT INTO revision_briefs(id,book_id,chapter,feedback,source_job_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, value.bookId, value.chapter, value.feedback, value.sourceJobId, "pending", now, now);
    return this.getRevisionBrief(id)!;
  }

  getRevisionBrief(briefId: string): RevisionBriefRecord | null {
    const row = this.db.prepare("SELECT * FROM revision_briefs WHERE id=?").get(briefId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id), bookId: String(row.book_id), chapter: Number(row.chapter), feedback: String(row.feedback),
      sourceJobId: String(row.source_job_id), status: String(row.status) as RevisionBriefRecord["status"],
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  listRevisionBriefs(bookId: string, limit = 20): RevisionBriefRecord[] {
    const rows = this.db.prepare("SELECT * FROM revision_briefs WHERE book_id=? ORDER BY created_at DESC LIMIT ?").all(bookId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id), bookId: String(row.book_id), chapter: Number(row.chapter), feedback: String(row.feedback),
      sourceJobId: String(row.source_job_id), status: String(row.status) as RevisionBriefRecord["status"],
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }));
  }

  updateRevisionBriefStatus(briefId: string, status: RevisionBriefRecord["status"]): RevisionBriefRecord {
    this.db.prepare("UPDATE revision_briefs SET status=?,updated_at=? WHERE id=?").run(status, isoNow(), briefId);
    const brief = this.getRevisionBrief(briefId);
    if (!brief) throw new Error("返工方案不存在");
    return brief;
  }

  claimRevisionBrief(briefId: string, claim: string): boolean {
    return this.db.prepare("UPDATE revision_briefs SET claim=? WHERE id=? AND status='pending' AND claim=''").run(claim, briefId).changes === 1;
  }

  releaseRevisionBrief(briefId: string, claim: string): void {
    this.db.prepare("UPDATE revision_briefs SET claim='' WHERE id=? AND claim=?").run(briefId, claim);
  }

  createReaderFeedback(value: {bookId: string; scopeType: ReaderFeedbackRecord["scopeType"]; scopeId: string; content: string; parentFeedbackId?: string | null; reviewMode?: ReaderFeedbackRecord["reviewMode"]}): ReaderFeedbackRecord {
    const id = `reader-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const now = isoNow();
    const parent = value.parentFeedbackId ? this.getReaderFeedback(value.parentFeedbackId) : null;
    if (value.parentFeedbackId && !parent) throw new Error("要承接的反馈不存在");
    if (parent && (parent.bookId !== value.bookId || parent.scopeType !== value.scopeType || parent.scopeId !== value.scopeId)) throw new Error("只能承接同一作品、同一范围的反馈");
    if (parent?.supersededById) throw new Error("这条反馈已有后续补充，请从反馈线程的最新一轮继续");
    if (parent && ["reworking", "applied"].includes(parent.status)) throw new Error("该反馈已经进入返工，新的意见请开启新反馈线程");
    const rootFeedbackId = parent?.rootFeedbackId || parent?.id || id;
    const sequence = parent ? parent.sequence + 1 : 1;
    this.db.prepare(`INSERT INTO reader_feedback(
      id,book_id,scope_type,scope_id,content,status,parent_feedback_id,root_feedback_id,sequence,review_mode,created_at,updated_at
    ) VALUES(?,?,?,?,?,'evaluating',?,?,?,?,?,?)`)
      .run(id, value.bookId, value.scopeType, value.scopeId, value.content, parent?.id || null, rootFeedbackId, sequence, value.reviewMode || "targeted", now, now);
    return this.getReaderFeedback(id)!;
  }

  getReaderFeedback(feedbackId: string): ReaderFeedbackRecord | null {
    const row = this.db.prepare("SELECT * FROM reader_feedback WHERE id=?").get(feedbackId) as Record<string, unknown> | undefined;
    if (!row) return null;
    let evaluation: Record<string, unknown> = {};
    let contextManifest: Record<string, unknown> = {};
    let requestedChapters: number[] = [];
    try { evaluation = JSON.parse(String(row.evaluation_json || "{}")) as Record<string, unknown>; } catch { evaluation = {}; }
    try { contextManifest = JSON.parse(String(row.context_manifest_json || "{}")) as Record<string, unknown>; } catch { contextManifest = {}; }
    try { requestedChapters = (JSON.parse(String(row.requested_chapters_json || "[]")) as unknown[]).map(Number).filter(Number.isInteger); } catch { requestedChapters = []; }
    const content = String(row.content);
    const legacyFullScope = !String(row.review_mode || "") && !/(?:不要|无需|不必|禁止).{0,8}(?:全文|全部|所有|全章|全书).{0,8}(?:重写|重修|重构|回炉)/.test(content)
      && /(?:(?:全文|全篇|全书|全部|所有|现有|已有|前\s*\d+\s*章).{0,18}(?:审查|检查|重写|重修|重构|回炉)|(?:完全|全部).{0,8}(?:重构|重写|重修).{0,12}(?:\d+\s*章|章节|现有|已有))/.test(content);
    const reviewMode = (String(row.review_mode || "") || (legacyFullScope ? "full_scope" : "targeted")) as ReaderFeedbackRecord["reviewMode"];
    if (!requestedChapters.length && reviewMode === "full_scope" && Array.isArray(contextManifest.eligibleChapters)) requestedChapters = contextManifest.eligibleChapters.map(Number).filter(Number.isInteger);
    return {
      id: String(row.id), bookId: String(row.book_id), scopeType: String(row.scope_type) as ReaderFeedbackRecord["scopeType"],
      scopeId: String(row.scope_id), content, status: String(row.status) as ReaderFeedbackRecord["status"],
      evaluation, parentFeedbackId: row.parent_feedback_id ? String(row.parent_feedback_id) : null,
      rootFeedbackId: String(row.root_feedback_id || row.id), sequence: Number(row.sequence || 1),
      supersededById: row.superseded_by_id ? String(row.superseded_by_id) : null, contextManifest,
      reviewMode, requestedChapters,
      jobId: row.job_id ? String(row.job_id) : null, workflowId: row.workflow_id ? String(row.workflow_id) : null,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  listReaderFeedback(bookId: string, scopeType?: ReaderFeedbackRecord["scopeType"], scopeId?: string, limit = 30): ReaderFeedbackRecord[] {
    const rows = scopeType
      ? this.db.prepare("SELECT id FROM reader_feedback WHERE book_id=? AND scope_type=? AND scope_id=? ORDER BY created_at DESC LIMIT ?").all(bookId, scopeType, scopeId || "", limit)
      : this.db.prepare("SELECT id FROM reader_feedback WHERE book_id=? ORDER BY created_at DESC LIMIT ?").all(bookId, limit);
    return (rows as Array<{id: string}>).map((row) => this.getReaderFeedback(String(row.id))!).filter(Boolean);
  }

  readerFeedbackThread(feedbackId: string): ReaderFeedbackRecord[] {
    const current = this.getReaderFeedback(feedbackId);
    if (!current) throw new Error("读后反馈不存在");
    const rows = this.db.prepare("SELECT id FROM reader_feedback WHERE root_feedback_id=? ORDER BY sequence,created_at").all(current.rootFeedbackId) as Array<{id: string}>;
    return rows.map((row) => this.getReaderFeedback(row.id)!).filter(Boolean);
  }

  linkReaderFeedback(parentFeedbackId: string, childFeedbackId: string): void {
    const parent = this.getReaderFeedback(parentFeedbackId);
    const child = this.getReaderFeedback(childFeedbackId);
    if (!parent || !child || child.parentFeedbackId !== parent.id || child.rootFeedbackId !== parent.rootFeedbackId) throw new Error("反馈承接关系无效");
    this.db.prepare("UPDATE reader_feedback SET superseded_by_id=?,updated_at=? WHERE id=? AND superseded_by_id IS NULL").run(child.id, isoNow(), parent.id);
  }

  updateReaderFeedback(feedbackId: string, patch: {status?: ReaderFeedbackRecord["status"]; evaluation?: Record<string, unknown>; contextManifest?: Record<string, unknown>; reviewMode?: ReaderFeedbackRecord["reviewMode"]; requestedChapters?: number[]; supersededById?: string | null; jobId?: string | null; workflowId?: string | null}): ReaderFeedbackRecord {
    const current = this.getReaderFeedback(feedbackId);
    if (!current) throw new Error("读后反馈不存在");
    this.db.prepare("UPDATE reader_feedback SET status=?,evaluation_json=?,context_manifest_json=?,review_mode=?,requested_chapters_json=?,superseded_by_id=?,job_id=?,workflow_id=?,updated_at=? WHERE id=?")
      .run(
        patch.status ?? current.status, JSON.stringify(patch.evaluation ?? current.evaluation), JSON.stringify(patch.contextManifest ?? current.contextManifest),
        patch.reviewMode ?? current.reviewMode, JSON.stringify(patch.requestedChapters ?? current.requestedChapters),
        patch.supersededById === undefined ? current.supersededById : patch.supersededById,
        patch.jobId === undefined ? current.jobId : patch.jobId, patch.workflowId === undefined ? current.workflowId : patch.workflowId,
        isoNow(), feedbackId,
      );
    return this.getReaderFeedback(feedbackId)!;
  }

  listFanqieAccounts(includeArchived = false): FanqieAccount[] {
    const rows = this.db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM platform_works w WHERE w.account_id=a.id) AS work_count
      FROM fanqie_accounts a ${includeArchived ? "" : "WHERE a.archived_at IS NULL"} ORDER BY a.is_active DESC, a.created_at`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id), label: String(row.label), profileDirectory: String(row.profile_directory), active: Boolean(row.is_active),
      sessionStatus: String(row.session_status) as FanqieAccount["sessionStatus"], writerName: String(row.writer_name || ""),
      writerUrl: String(row.writer_url || "https://fanqienovel.com/main/writer/home"), message: String(row.message || ""),
      lastCheckedAt: row.last_checked_at ? String(row.last_checked_at) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      lastSyncStatus: String(row.last_sync_status || "idle"), lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null,
      archivedAt: row.archived_at ? String(row.archived_at) : null, workCount: Number(row.work_count || 0),
    }));
  }

  activeFanqieAccount(): FanqieAccount | null {
    return this.listFanqieAccounts().find((item) => item.active) || this.listFanqieAccounts()[0] || null;
  }

  createFanqieAccount(label: string, profileDirectory: string, requestedId?: string): FanqieAccount {
    const id = requestedId || `fq-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const now = isoNow();
    const first = this.listFanqieAccounts().length === 0;
    if (first) this.db.prepare("UPDATE fanqie_accounts SET is_active=0").run();
    this.db.prepare("INSERT INTO fanqie_accounts(id,label,profile_directory,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(id, label.trim().slice(0, 32) || "番茄账号", profileDirectory, first ? 1 : 0, now, now);
    return this.listFanqieAccounts().find((item) => item.id === id)!;
  }

  switchFanqieAccount(accountId: string): FanqieAccount {
    const found = this.listFanqieAccounts().find((item) => item.id === accountId);
    if (!found) throw new Error("番茄账号不存在");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE fanqie_accounts SET is_active=0").run();
      this.db.prepare("UPDATE fanqie_accounts SET is_active=1,updated_at=? WHERE id=?").run(isoNow(), accountId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.activeFanqieAccount()!;
  }

  renameFanqieAccount(accountId: string, label: string): FanqieAccount {
    const clean = label.trim().replace(/\s+/g, " ").slice(0, 32);
    if (!clean) throw new Error("账号名称不能为空");
    const result = this.db.prepare("UPDATE fanqie_accounts SET label=?,updated_at=? WHERE id=? AND archived_at IS NULL").run(clean, isoNow(), accountId);
    if (!result.changes) throw new Error("番茄账号不存在或已归档");
    return this.listFanqieAccounts().find((item) => item.id === accountId)!;
  }

  archiveFanqieAccount(accountId: string): FanqieAccount {
    const accounts = this.listFanqieAccounts();
    const found = accounts.find((item) => item.id === accountId);
    if (!found) throw new Error("番茄账号不存在");
    if (accounts.length <= 1) throw new Error("至少保留一个番茄账号");
    const now = isoNow();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE fanqie_accounts SET archived_at=?,is_active=0,updated_at=? WHERE id=?").run(now, now, accountId);
      if (found.active) {
        const next = accounts.find((item) => item.id !== accountId)!;
        this.db.prepare("UPDATE fanqie_accounts SET is_active=1,updated_at=? WHERE id=?").run(now, next.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {...found, active: false, archivedAt: now, updatedAt: now};
  }

  updateFanqieAccountSession(accountId: string, value: {status: FanqieAccount["sessionStatus"]; writerName: string; writerUrl: string; message: string; checkedAt: string}): void {
    this.db.prepare("UPDATE fanqie_accounts SET session_status=?,writer_name=?,writer_url=?,message=?,last_checked_at=?,updated_at=? WHERE id=?")
      .run(value.status, value.writerName, value.writerUrl, value.message, value.checkedAt, isoNow(), accountId);
  }

  updateFanqieAccountSync(accountId: string, status: string): void {
    this.db.prepare("UPDATE fanqie_accounts SET last_sync_status=?,last_sync_at=?,updated_at=? WHERE id=?")
      .run(status, isoNow(), isoNow(), accountId);
  }

  upsertWorks(accountId: string, works: PlatformWork[]): void {
    const statement = this.db.prepare(`
      INSERT INTO platform_works(platform_id,account_id,title,url,status,metrics_json,synced_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(platform_id) DO UPDATE SET account_id=excluded.account_id,title=excluded.title,url=excluded.url,status=excluded.status,metrics_json=excluded.metrics_json,synced_at=excluded.synced_at
    `);
    for (const work of works) statement.run(work.platformId, accountId, work.title, work.url, work.status, JSON.stringify(work.metrics), work.syncedAt);
  }

  listWorks(accountId?: string): PlatformWork[] {
    const id = accountId || this.activeFanqieAccount()?.id || "legacy";
    return (this.db.prepare("SELECT * FROM platform_works WHERE account_id=? ORDER BY synced_at DESC,title").all(id) as Array<Record<string, unknown>>).map((row) => ({
      platformId: String(row.platform_id), title: String(row.title), url: String(row.url), status: String(row.status),
      metrics: JSON.parse(String(row.metrics_json || "{}")), syncedAt: String(row.synced_at),
    }));
  }

  upsertChapters(accountId: string, chapters: PlatformChapter[]): void {
    const statement = this.db.prepare(`
      INSERT INTO platform_chapters(platform_id,account_id,work_id,chapter_number,title,status,word_count,scheduled_at,content_hash,synced_at) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(platform_id) DO UPDATE SET account_id=excluded.account_id,work_id=excluded.work_id,chapter_number=excluded.chapter_number,title=excluded.title,status=excluded.status,word_count=excluded.word_count,scheduled_at=excluded.scheduled_at,content_hash=excluded.content_hash,synced_at=excluded.synced_at
    `);
    for (const chapter of chapters) statement.run(chapter.platformId, accountId, chapter.workId, chapter.chapterNumber, chapter.title, chapter.status, Number(chapter.wordCount || 0), chapter.scheduledAt, chapter.contentHash, chapter.syncedAt);
  }

  replaceWorkChapters(accountId: string, workId: string, chapters: PlatformChapter[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM platform_chapters WHERE account_id=? AND work_id=?").run(accountId, workId);
      this.upsertChapters(accountId, chapters);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  listChapters(workId?: string, accountId?: string): PlatformChapter[] {
    const id = accountId || this.activeFanqieAccount()?.id || "legacy";
    const rows = workId
      ? this.db.prepare("SELECT * FROM platform_chapters WHERE account_id=? AND work_id=? ORDER BY chapter_number,title").all(id, workId)
      : this.db.prepare("SELECT * FROM platform_chapters WHERE account_id=? ORDER BY synced_at DESC").all(id);
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      platformId: String(row.platform_id), workId: String(row.work_id), chapterNumber: row.chapter_number === null ? null : Number(row.chapter_number),
      title: String(row.title), status: String(row.status), scheduledAt: row.scheduled_at === null ? null : String(row.scheduled_at),
      wordCount: Number(row.word_count || 0), contentHash: String(row.content_hash || ""), syncedAt: String(row.synced_at),
    }));
  }

  startSync(accountId: string): string {
    const id = `sync-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    this.db.prepare("INSERT INTO platform_sync_runs(id,account_id,status,started_at) VALUES(?,?,'running',?)").run(id, accountId, isoNow());
    return id;
  }

  finishSync(id: string, status: string, workCount: number, chapterCount: number, message: string): void {
    this.db.prepare("UPDATE platform_sync_runs SET status=?,work_count=?,chapter_count=?,message=?,finished_at=? WHERE id=?").run(status, workCount, chapterCount, message, isoNow(), id);
  }

  recordConfirmation(operation: string, targetId: string, token: string): string {
    const id = `confirm-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    this.db.prepare("INSERT INTO operation_confirmations(id,operation,target_id,token_hash,created_at) VALUES(?,?,?,?,?)")
      .run(id, operation, targetId, createHash("sha256").update(token).digest("hex"), isoNow());
    return id;
  }

  consumeConfirmation(operation: string, targetId: string, token: string): boolean {
    const hash = createHash("sha256").update(token).digest("hex");
    const row = this.db.prepare("SELECT id FROM operation_confirmations WHERE operation=? AND target_id=? AND token_hash=? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1")
      .get(operation, targetId, hash) as { id?: string } | undefined;
    if (!row?.id) return false;
    this.db.prepare("UPDATE operation_confirmations SET consumed_at=? WHERE id=?").run(isoNow(), row.id);
    return true;
  }

  consumeConfirmations(items: Array<{operation: string; targetId: string; token: string}>): boolean {
    if (!items.length) return false;
    const selected: string[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of items) {
        const hash = createHash("sha256").update(item.token).digest("hex");
        const row = this.db.prepare("SELECT id FROM operation_confirmations WHERE operation=? AND target_id=? AND token_hash=? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1")
          .get(item.operation, item.targetId, hash) as {id?: string} | undefined;
        if (!row?.id || selected.includes(row.id)) {
          this.db.exec("ROLLBACK");
          return false;
        }
        selected.push(row.id);
      }
      const consumedAt = isoNow();
      const update = this.db.prepare("UPDATE operation_confirmations SET consumed_at=? WHERE id=? AND consumed_at IS NULL");
      for (const id of selected) {
        const result = update.run(consumedAt, id);
        if (Number(result.changes) !== 1) throw new Error("即时确认已被其他操作使用");
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  private personalTalk(row: Record<string, unknown> | undefined): PersonalTalkRecord | null {
    if (!row) return null;
    const parse = (value: unknown) => {
      try { const parsed = JSON.parse(String(value || "{}")); return parsed && !Array.isArray(parsed) && typeof parsed === "object" ? parsed as Record<string, unknown> : {}; }
      catch { return {}; }
    };
    return {
      id: String(row.id), authorId: String(row.author_id), title: String(row.title), content: String(row.content),
      linkedBookId: row.linked_book_id ? String(row.linked_book_id) : null,
      progressSnapshot: parse(row.progress_snapshot_json), personaSnapshot: parse(row.persona_snapshot_json),
      personaHash: String(row.persona_hash || ""), styleInfluence: String(row.style_influence || "none") as PersonalTalkRecord["styleInfluence"],
      status: String(row.status || "draft") as PersonalTalkRecord["status"], sourceJobId: row.source_job_id ? String(row.source_job_id) : null,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), publishedAt: row.published_at ? String(row.published_at) : null,
    };
  }

  listPersonalTalks(authorId: string): PersonalTalkRecord[] {
    const rows = this.db.prepare("SELECT * FROM personal_talks WHERE author_id=? ORDER BY updated_at DESC,id DESC").all(authorId) as Record<string, unknown>[];
    return rows.map((row) => this.personalTalk(row)!).filter(Boolean);
  }

  getPersonalTalk(talkId: string): PersonalTalkRecord | null {
    return this.personalTalk(this.db.prepare("SELECT * FROM personal_talks WHERE id=?").get(talkId) as Record<string, unknown> | undefined);
  }

  savePersonalTalk(value: {
    id?: string; authorId: string; title: string; content: string; linkedBookId?: string | null;
    progressSnapshot?: Record<string, unknown>; personaSnapshot?: Record<string, unknown>; personaHash?: string;
    styleInfluence?: "none" | "current_book"; status?: PersonalTalkRecord["status"]; sourceJobId?: string | null;
  }): PersonalTalkRecord {
    const current = value.id ? this.getPersonalTalk(value.id) : null;
    if (current && current.authorId !== value.authorId) throw new Error("个人谈不属于当前作者");
    const id = current?.id || `talk-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const now = isoNow();
    const status = value.status || current?.status || "draft";
    const publishedAt = status === "published" ? current?.publishedAt || now : current?.publishedAt || null;
    this.db.prepare(`
      INSERT INTO personal_talks(id,author_id,title,content,linked_book_id,progress_snapshot_json,persona_snapshot_json,persona_hash,style_influence,status,source_job_id,created_at,updated_at,published_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,linked_book_id=excluded.linked_book_id,
        progress_snapshot_json=excluded.progress_snapshot_json,persona_snapshot_json=excluded.persona_snapshot_json,
        persona_hash=excluded.persona_hash,style_influence=excluded.style_influence,status=excluded.status,
        source_job_id=excluded.source_job_id,updated_at=excluded.updated_at,published_at=excluded.published_at
    `).run(
      id, value.authorId, value.title, value.content, value.linkedBookId ?? current?.linkedBookId ?? null,
      JSON.stringify(value.progressSnapshot ?? current?.progressSnapshot ?? {}), JSON.stringify(value.personaSnapshot ?? current?.personaSnapshot ?? {}),
      value.personaHash ?? current?.personaHash ?? "", value.styleInfluence ?? current?.styleInfluence ?? "none", status,
      value.sourceJobId ?? current?.sourceJobId ?? null, current?.createdAt || now, now, publishedAt,
    );
    return this.getPersonalTalk(id)!;
  }

  deletePersonalTalk(authorId: string, talkId: string): PersonalTalkRecord {
    const current = this.getPersonalTalk(talkId);
    if (!current || current.authorId !== authorId) throw new Error("个人谈不存在");
    this.db.prepare("DELETE FROM personal_talks WHERE id=? AND author_id=?").run(talkId, authorId);
    return current;
  }

  deletePersonalTalksByAuthor(authorId: string): number {
    const result = this.db.prepare("DELETE FROM personal_talks WHERE author_id=?").run(authorId);
    return Number(result.changes);
  }

  createWorkWrite(accountId: string, bookId: string, platformWorkId: string, payload: Record<string, unknown>, payloadHash: string): Record<string, unknown> {
    const id = `write-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const createdAt = isoNow();
    this.db.prepare("INSERT INTO work_write_previews(id,account_id,book_id,platform_work_id,payload_json,payload_hash,status,created_at) VALUES(?,?,?,?,?,?,'preview',?)")
      .run(id, accountId, bookId, platformWorkId, JSON.stringify(payload), payloadHash, createdAt);
    return { id, accountId, bookId, platformWorkId, payload, payloadHash, status: "preview", createdAt, confirmation: `WRITE ${id}` };
  }

  getWorkWrite(id: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT * FROM work_write_previews WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id), accountId: String(row.account_id || "legacy"), bookId: String(row.book_id), platformWorkId: String(row.platform_work_id),
      payload: JSON.parse(String(row.payload_json)), payloadHash: String(row.payload_hash), status: String(row.status),
      result: JSON.parse(String(row.result_json || "{}")), createdAt: String(row.created_at), executedAt: row.executed_at ? String(row.executed_at) : null,
      confirmation: `WRITE ${String(row.id)}`,
    };
  }

  finishWorkWrite(id: string, status: string, result: Record<string, unknown>): void {
    this.db.prepare("UPDATE work_write_previews SET status=?,result_json=?,executed_at=? WHERE id=?")
      .run(status, JSON.stringify(result), isoNow(), id);
  }
}

async function walkFiles(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...await walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

export async function initializeWorkspace(store: StudioStore): Promise<{manifestPath: string; backupPath: string | null; fileCount: number}> {
  await mkdir(store.dataDir, { recursive: true });
  await mkdir(join(store.dataDir, "backups"), { recursive: true });
  await mkdir(join(store.dataDir, "jobs"), { recursive: true });
  const booksDir = join(store.root, "books");
  const bookEntries = existsSync(booksDir) ? await readdir(booksDir, { withFileTypes: true }) : [];
  for (const entry of bookEntries.filter((item) => item.isDirectory() && !item.isSymbolicLink())) {
    store.db.prepare(`
      INSERT INTO projects(book_id,path,legacy,indexed_at) VALUES(?,?,1,?)
      ON CONFLICT(book_id) DO UPDATE SET path=excluded.path,indexed_at=excluded.indexed_at
    `).run(entry.name, join(booksDir, entry.name), isoNow());
  }
  const existing = store.getMeta("migration_v1");
  if (existing) {
    const value = JSON.parse(existing) as {manifestPath: string; backupPath: string | null; fileCount: number};
    return value;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let backupPath: string | null = null;
  const tomotaDb = join(store.root, "tomota.db");
  if (existsSync(tomotaDb)) {
    backupPath = join(store.dataDir, "backups", `tomota-${stamp}.db`);
    snapshotSqlite(tomotaDb, backupPath);
  }
  const files = (await walkFiles(booksDir)).sort();
  const inventory = [];
  for (const file of files) {
    const bytes = await readFile(file);
    const info = await stat(file);
    inventory.push({ path: relative(store.root, file).replaceAll("\\", "/"), size: info.size, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const manifest = { schemaVersion: 1, createdAt: isoNow(), root: store.root, databaseBackup: backupPath, files: inventory };
  const manifestPath = join(store.dataDir, `inventory-${stamp}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  const manifestHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  for (const entry of bookEntries.filter((item) => item.isDirectory() && !item.isSymbolicLink())) {
    store.db.prepare("UPDATE projects SET manifest_hash=? WHERE book_id=?").run(manifestHash, entry.name);
  }
  const result = { manifestPath, backupPath, fileCount: inventory.length };
  store.setMeta("migration_v1", JSON.stringify(result));
  return result;
}

export async function initializeAuthorLayerBackup(store: StudioStore): Promise<{tomotaDb: string | null; studioDb: string}> {
  const existing = store.getMeta("migration_v2_author_backup");
  if (existing) return JSON.parse(existing) as {tomotaDb: string | null; studioDb: string};
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(store.dataDir, "backups");
  await mkdir(backupDir, {recursive: true});
  const tomotaSource = join(store.root, "tomota.db");
  const tomotaDb = existsSync(tomotaSource) ? join(backupDir, `tomota-author-layer-${stamp}.db`) : null;
  if (tomotaDb) snapshotSqlite(tomotaSource, tomotaDb);
  const studioDb = join(backupDir, `studio-author-layer-${stamp}.db`);
  store.db.exec(`VACUUM INTO '${studioDb.replaceAll("'", "''")}'`);
  const value = {tomotaDb, studioDb};
  store.setMeta("migration_v2_author_backup", JSON.stringify(value));
  return value;
}

export function safeBookPath(root: string, candidate: string): string {
  const books = resolve(root, "books");
  const target = resolve(candidate);
  if (target !== books && !target.startsWith(books + "\\") && !target.startsWith(books + "/")) throw new Error("文件路径超出 books 工作区");
  let current = books;
  for (const part of ["", ...relative(books, target).split(/[\\/]/).filter(Boolean)]) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("文件路径包含符号链接或目录联接，不能访问");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
