import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AgentJob, AgentJobStatus, FanqieAccount, JobEvent, PlatformChapter, PlatformWork, WorkflowFeedback } from "./types.js";

const isoNow = () => new Date().toISOString();

function toAgentJob(row: Record<string, unknown>): AgentJob {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    bookId: String(row.book_id),
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
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.createSchema();
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
        created_at TEXT NOT NULL
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
      CREATE INDEX IF NOT EXISTS idx_platform_chapters_work_number ON platform_chapters(work_id, chapter_number);
      CREATE INDEX IF NOT EXISTS idx_confirmations_target_operation ON operation_confirmations(target_id, operation, consumed_at);
      CREATE INDEX IF NOT EXISTS idx_work_write_previews_book_created ON work_write_previews(book_id, created_at);
    `);
    this.ensureColumn("platform_works", "account_id", "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureColumn("platform_chapters", "account_id", "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureColumn("platform_chapters", "word_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("platform_sync_runs", "account_id", "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureColumn("work_write_previews", "account_id", "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureColumn("fanqie_accounts", "last_sync_status", "TEXT NOT NULL DEFAULT 'idle'");
    this.ensureColumn("fanqie_accounts", "last_sync_at", "TEXT");
    this.ensureColumn("fanqie_accounts", "archived_at", "TEXT");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fanqie_accounts_active ON fanqie_accounts(is_active, updated_at);
      CREATE INDEX IF NOT EXISTS idx_platform_works_account_sync ON platform_works(account_id, synced_at);
      CREATE INDEX IF NOT EXISTS idx_platform_chapters_account_work ON platform_chapters(account_id, work_id, chapter_number);
    `);
    this.db.exec("PRAGMA optimize;");
    this.db.prepare(
      "UPDATE agent_jobs SET status='interrupted', finished_at=?, error=CASE WHEN error='' THEN 'Studio 服务重启，任务未自动推进' ELSE error END WHERE status IN ('queued','running')",
    ).run(isoNow());
  }

  private ensureColumn(table: string, column: string, declaration: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name: string}>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
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

  deleteMeta(key: string): void {
    this.db.prepare("DELETE FROM studio_meta WHERE key=?").run(key);
  }

  createJob(value: Omit<AgentJob, "id" | "createdAt" | "startedAt" | "finishedAt" | "pid" | "exitCode" | "outputHash" | "error">): AgentJob {
    const id = `job-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const createdAt = isoNow();
    this.db.prepare(`
      INSERT INTO agent_jobs(id,run_id,book_id,chapter,stage,status,prompt_path,prompt_hash,output_path,retry_of,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, value.runId, value.bookId, value.chapter, value.stage, value.status, value.promptPath, value.promptHash, value.outputPath, value.retryOf, createdAt);
    return this.getJob(id)!;
  }

  getJob(id: string): AgentJob | null {
    const row = this.db.prepare("SELECT * FROM agent_jobs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? toAgentJob(row) : null;
  }

  listJobs(runId?: string, limit = 60): AgentJob[] {
    const rows = runId
      ? this.db.prepare("SELECT * FROM agent_jobs WHERE run_id=? ORDER BY created_at DESC LIMIT ?").all(runId, limit)
      : this.db.prepare("SELECT * FROM agent_jobs ORDER BY created_at DESC LIMIT ?").all(limit);
    return (rows as Record<string, unknown>[]).map(toAgentJob);
  }

  activeJobForBook(bookId: string): AgentJob | null {
    const row = this.db.prepare("SELECT * FROM agent_jobs WHERE book_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get(bookId) as Record<string, unknown> | undefined;
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

  appendEvent(jobId: string, level: JobEvent["level"], message: string): JobEvent {
    const clean = message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, 12000);
    const createdAt = isoNow();
    const result = this.db.prepare("INSERT INTO job_events(job_id,level,message,created_at) VALUES(?,?,?,?)").run(jobId, level, clean, createdAt);
    return { id: Number(result.lastInsertRowid), jobId, level, message: clean, createdAt };
  }

  listEvents(jobId: string, after = 0): JobEvent[] {
    const rows = this.db.prepare("SELECT * FROM job_events WHERE job_id=? AND id>? ORDER BY id LIMIT 500").all(jobId, after) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: Number(row.id), jobId: String(row.job_id), level: String(row.level) as JobEvent["level"], message: String(row.message), createdAt: String(row.created_at) }));
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

  pendingWorkflowFeedback(runId: string, stage: string, chapter: number | null): WorkflowFeedback[] {
    return this.listWorkflowFeedback(runId, 100).filter((item) => item.status === "pending" && item.stage === stage && item.chapter === chapter).reverse();
  }

  markWorkflowFeedbackApplied(ids: string[], jobId: string): void {
    if (!ids.length) return;
    const statement = this.db.prepare("UPDATE workflow_feedback SET status='applied',job_id=?,applied_at=? WHERE id=? AND status='pending'");
    const now = isoNow();
    for (const id of ids) statement.run(jobId, now, id);
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
    await copyFile(tomotaDb, backupPath);
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

export function safeBookPath(root: string, candidate: string): string {
  const books = resolve(root, "books");
  const target = resolve(candidate);
  if (target !== books && !target.startsWith(books + "\\") && !target.startsWith(books + "/")) throw new Error("文件路径超出 books 工作区");
  return target;
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
