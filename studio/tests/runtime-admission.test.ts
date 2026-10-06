/** Regressions for F17/F18, promoted from the 2026-09-28 audit.
 * Run from studio: node --import tsx --test tests/runtime-admission.test.ts
 * All writes are under a fresh OS temp directory. No model/browser is invoked.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, writeFile, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, relative, isAbsolute} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {StudioStore, initializeWorkspace, initializeAuthorLayerBackup} from '../server/store.js';
import {AntigravityRunner} from '../server/antigravity.js';

async function cleanup(root: string) {
  const parent = await realpath(tmpdir());
  const child = await realpath(root);
  const rel = relative(parent, child);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && rel.startsWith('tomota-audit-20260928-'));
  await rm(child, {recursive: true, force: true});
}

for (const dual of [false, true]) {
  test(`F17: concurrent starts must reserve one ${dual ? 'dual-candidate group' : 'ordinary job'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'tomota-audit-20260928-'));
    const store = new StudioStore(root);
    const launches: string[] = [];
    let actionCalls = 0;
    try {
      const prompt = join(root, 'fixture.prompt.md');
      await writeFile(prompt, 'Isolated fixture. Never call a model.');
      const action = {book_id: 'fixture', stage: 'chapter_design', chapter: 1, prompt_path: prompt,
        action_id: 'fixture-action', ...(dual ? {candidate_mode: 'dual_blind'} : {})};
      const python = {
        workflowStatus: async () => ({value: {book_id: 'fixture', status: 'running'}}),
        nextAction: async () => { actionCalls++; return {value: action}; },
      };
      const runner = new AntigravityRunner(root, store, python as never, {executable: process.execPath});
      // Keep the real admission and persistence code; replace only execution.
      (runner as any).launch = (job: {id: string}) => {
        launches.push(job.id);
        store.updateJob(job.id, {status: 'running'});
      };
      const results = await Promise.all(Array.from({length: 4}, () => runner.startContinuous('fixture-run')));
      assert.equal(new Set(results.map(result => result.job?.id)).size, 1);
      assert.equal(actionCalls, 1, 'nextAction is inside the admission boundary');
      const jobs = store.listJobs(undefined, 100).filter(job => job.bookId === 'fixture');
      const priorLaunches = launches.length;
      await runner.startContinuous('fixture-run');
      assert.equal(launches.length, priorLaunches, 'control: sequential re-entry should reuse active work');
      assert.equal(actionCalls, 1, 'active work must not regenerate its action packet');
      console.log(JSON.stringify({probe: 'F17', dual, requests: 4, jobs: jobs.length, launches: launches.length,
        groups: [...new Set(jobs.map(job => store.getJobResult(job.id).lineage.candidateGroup).filter(Boolean))]}));
      assert.equal(launches.length, dual ? 2 : 1, 'same-book concurrent entry created duplicate model work');
      assert.equal(new Set(jobs.map(job => store.getJobResult(job.id).lineage.candidateGroup).filter(Boolean)).size, dual ? 1 : 0);
    } finally {store.db.close(); await cleanup(root);}
  });
}

test('F18: both migration backups must contain committed WAL data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tomota-audit-20260928-'));
  const core = new DatabaseSync(join(root, 'tomota.db'));
  const store = new StudioStore(root);
  try {
    core.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES (\'checkpointed\'); PRAGMA wal_checkpoint(TRUNCATE);');
    core.exec("INSERT INTO fixture VALUES ('committed-in-wal')");
    const live = core.prepare('SELECT value FROM fixture ORDER BY rowid').all();
    const workspace = await initializeWorkspace(store);
    const author = await initializeAuthorLayerBackup(store);
    const backups = [workspace.backupPath!, author.tomotaDb!].map(path => {
      const db = new DatabaseSync(path, {readOnly: true});
      try {return {path, rows: db.prepare('SELECT value FROM fixture ORDER BY rowid').all(), check: db.prepare('PRAGMA quick_check').get()};}
      finally {db.close();}
    });
    // Control: the repaired daily-snapshot path includes the same pending WAL.
    const daily = await store.createWorkspaceSnapshot();
    const copied = new DatabaseSync(join(daily.snapshot.path, 'tomota.db'), {readOnly: true});
    let dailyRows;
    try {dailyRows = copied.prepare('SELECT value FROM fixture ORDER BY rowid').all();} finally {copied.close();}
    assert.deepEqual(dailyRows, live);
    console.log(JSON.stringify({probe: 'F18', live, backups, dailyRows}));
    for (const backup of backups) assert.deepEqual(backup.rows, live, 'migration copy silently loses committed WAL rows');
  } finally {store.db.close(); core.close(); await cleanup(root);}
});

test('book admission releases errors and keeps different books independent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tomota-audit-20260928-'));
  const store = new StudioStore(root);
  try {
    const prompt = join(root, 'prompt.md'); await writeFile(prompt, 'Fixture only.');
    let actionCalls = 0;
    const python = {
      workflowStatus: async (run: string) => ({value: {book_id: run, status: 'running'}}),
      nextAction: async (run: string) => {
        actionCalls++;
        if (actionCalls === 1) throw new Error('fixture nextAction failed');
        return {value: {book_id: run, stage: 'draft', chapter: 1, prompt_path: prompt}};
      },
    };
    const runner = new AntigravityRunner(root, store, python as never, {executable: process.execPath});
    (runner as any).launch = (job: {id: string}) => store.updateJob(job.id, {status: 'running'});
    const failures = await Promise.allSettled(Array.from({length: 4}, () => runner.startContinuous('book-a')));
    assert.equal(actionCalls, 1);
    assert.ok(failures.every(result => result.status === 'rejected'));
    assert.equal(store.listJobs().length, 0);
    assert.equal(runner.activity().active, 0, 'failed admission must not leave the service busy');
    assert.ok((await runner.startContinuous('book-a')).job);

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    python.nextAction = async (run: string) => {
      if (run === 'slow-book') { entered(); await gate; }
      return {value: {book_id: run, stage: 'draft', chapter: 1, prompt_path: prompt}};
    };
    const slow = runner.startContinuous('slow-book');
    try {
      await started;
      assert.equal(runner.activity().active, 2, 'the first running book and the pending start both block idle snapshots');
      await assert.rejects(runner.startPlanning({bookId: 'slow-book', scope: 'new_book', mode: 'fill', instruction: '', context: {}}), /正在启动/);
      await assert.rejects(runner.startReaderFeedbackEvaluation({bookId: 'slow-book', feedbackId: 'fixture', scopeType: 'book', scopeId: 'slow-book', content: '', context: {}, eligibleChapters: []}), /正在启动/);
      assert.ok((await runner.startContinuous('fast-book')).job, 'another book need not wait');
    } finally { release(); await slow; }
  } finally { store.db.close(); await cleanup(root); }
});

test('failed migration snapshots do not mark migration complete and can be retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tomota-audit-20260928-'));
  const store = new StudioStore(root);
  const source = join(root, 'tomota.db');
  try {
    await writeFile(source, 'not a SQLite database');
    await assert.rejects(initializeWorkspace(store));
    await assert.rejects(initializeAuthorLayerBackup(store));
    assert.ok(!store.getMeta('migration_v1'));
    assert.ok(!store.getMeta('migration_v2_author_backup'));
    await rm(source); // This test's explicitly named, non-database fixture only.
    const db = new DatabaseSync(source);
    db.exec('CREATE TABLE fixture(value TEXT)'); db.close();
    const workspace = await initializeWorkspace(store);
    const author = await initializeAuthorLayerBackup(store);
    assert.deepEqual(await initializeWorkspace(store), workspace);
    assert.deepEqual(await initializeAuthorLayerBackup(store), author);
  } finally { store.db.close(); await cleanup(root); }
});
