import assert from "node:assert/strict";
import {execFileSync, spawn} from "node:child_process";
import {once} from "node:events";
import {existsSync} from "node:fs";
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {isAbsolute, join, relative, resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {test} from "node:test";
import {PythonBridge} from "../server/python.js";
import {RebuildFiles} from "../server/rebuild-files.js";
import {StudioStore} from "../server/store.js";
import {readProjectFile, saveProjectFile} from "../server/projects.js";
import {recoveryDiagnostics} from "../server/runtime-recovery.js";

const repository = resolve(import.meta.dirname, "../..");
process.env.PYTHONPATH = join(repository, "src");
process.env.PYTHONDONTWRITEBYTECODE = "1";
process.env.PYTHONUTF8 = "1";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tomota-cross-transaction-"));
  execFileSync(process.env.TOMOTA_PYTHON || "python", ["-c", `
import sys
from tomota.store import ProjectStore
from tomota.models import ChapterContract
s=ProjectStore(sys.argv[1]); s.create_book('demo','Original',{})
c=ChapterContract('demo',1,'One','Goal','Obstacle','Change',next_first_beat='Next')
s.save_outline_chapters('demo',[c.to_dict()]); s.save_chapter(c,content='Original body.')
`, root], {env: process.env, windowsHide: true});
  const store = new StudioStore(root), python = new PythonBridge(root);
  const originalBody = await readFile(join(root, "books/demo/drafts/chapter-0001.md"), "utf8");
  const output = join(store.dataDir, "jobs", "fixture.json");
  await mkdir(join(store.dataDir, "jobs"), {recursive: true});
  await writeFile(output, "Original Studio artifact.");
  const job = store.createJob({bookId: "demo", runId: "fixture", stage: "draft", chapter: 1, status: "succeeded", promptPath: output, promptHash: "fixture", outputPath: output, retryOf: null});
  const brief = store.saveRevisionBrief({bookId: "demo", chapter: 1, feedback: "Original feedback", sourceJobId: job.id});
  const title = () => {
    const db = new DatabaseSync(join(root, "tomota.db"), {readOnly: true});
    try {return String(db.prepare("SELECT title FROM books WHERE id='demo'").get()!.title);}
    finally {db.close();}
  };
  const rebuild = async () => {
    const preview = await python.previewRebuild("demo", "book", "book");
    return python.withBookTransaction("demo", async transactionId => {
      const rebuilt = (await python.rebuild("demo", "book", "book", String(preview.value.confirmation_phrase))).value;
      return store.purgeRebuiltScope("demo", "book", "book", rebuilt.chapter_numbers as number[], {transactionId});
    });
  };
  const close = async () => {
    store.db.close();
    const parent = await realpath(tmpdir()), target = await realpath(root), rel = relative(parent, target);
    assert.ok(rel.startsWith("tomota-cross-transaction-") && !isAbsolute(rel) && !rel.includes(".."));
    await rm(target, {recursive: true, force: true});
  };
  return {root, store, python, output, brief, title, rebuild, close, originalBody};
}

test("PythonBridge delegates the book id, commits, rolls back, and rejects cross-book nesting", async () => {
  const f = await fixture();
  try {
    await f.python.withBookTransaction("demo", async () => {
      await f.python.updateBook("demo", {title: "Committed", metadata: {}});
      await assert.rejects(f.python.withBookTransaction("other", async () => undefined), /跨作品/);
    });
    assert.equal(f.title(), "Committed");
    await assert.rejects(f.python.withBookTransaction("demo", async () => {
      await f.python.updateBook("demo", {title: "Must roll back", metadata: {}});
      throw new Error("injected operation failure");
    }), /injected operation failure/);
    assert.equal(f.title(), "Committed");
    assert.equal(existsSync(join(f.root, ".planning-staging")), false);
  } finally {await f.close();}
});

test("single-file bridge commits and rolls back actual editor saves without touching siblings or SQL", async () => {
  const f = await fixture();
  const file = join(f.root, "books/demo/drafts/chapter-0001.md"), sibling = join(f.root, "books/demo/drafts/chapter-0002.md");
  try {
    await writeFile(sibling, "Large sibling\n".repeat(100000));
    const current = await readProjectFile(f.root, file);
    await assert.rejects(f.python.withBookTransaction("demo", async () => {
      const diagnostics = await recoveryDiagnostics(f.root, f.python.python);
      assert.equal(diagnostics.entries.length, 1); assert.equal(diagnostics.entries[0].scope, "file");
      const snapshots = await readdir(join(f.root, ".planning-staging"));
      assert.equal(snapshots.length, 1);
      const contents = await readdir(join(f.root, ".planning-staging", snapshots[0]));
      assert.deepEqual(contents.sort(), ["manifest.json", "payload"]);
      assert.equal(await readFile(join(f.root, ".planning-staging", snapshots[0], "payload"), "utf8"), f.originalBody);
      await assert.rejects(f.python.run(["status", "--json"]), /单文件事务/);
      await assert.rejects(f.python.withBookTransaction("demo", async () => undefined), /嵌套/);
      await saveProjectFile(f.root, file, "Tentative save", current.hash);
      await writeFile(sibling, "Independent sibling edit");
      throw new Error("injected editor failure");
    }, {file}), /injected editor failure/);
    assert.equal(await readFile(file, "utf8"), f.originalBody);
    assert.equal(await readFile(sibling, "utf8"), "Independent sibling edit");
    assert.equal(f.title(), "Original"); assert.ok(f.store.getRevisionBrief(f.brief.id));
    const saved = await f.python.withBookTransaction("demo", () => saveProjectFile(f.root, file, "Committed editor save", current.hash), {file});
    assert.equal((await readProjectFile(f.root, file)).hash, saved.hash);
    assert.equal(await readFile(file, "utf8"), "Committed editor save");
    assert.deepEqual((await recoveryDiagnostics(f.root, f.python.python)).entries, []);
    assert.equal(existsSync(join(f.root, ".planning-staging")), false);
  } finally {await f.close();}
});

test("rebuild SQL failure after real file staging restores both stores and all files", async () => {
  const f = await fixture();
  try {
    f.store.db.exec("CREATE TEMP TRIGGER fail_commit BEFORE INSERT ON book_transaction_commits BEGIN SELECT RAISE(FAIL,'injected decision failure'); END");
    await assert.rejects(f.rebuild(), /injected decision failure/);
    assert.ok(f.store.getRevisionBrief(f.brief.id));
    assert.equal(await readFile(f.output, "utf8"), "Original Studio artifact.");
    assert.equal(await readFile(join(f.root, "books/demo/drafts/chapter-0001.md"), "utf8"), f.originalBody);
    assert.equal(existsSync(join(f.store.dataDir, "rebuild-staging")), false);
    f.store.db.exec("DROP TRIGGER fail_commit");
    await f.rebuild();
    assert.equal(f.store.getRevisionBrief(f.brief.id), null);
    assert.equal(existsSync(f.output), false);
  } finally {await f.close();}
});

test("a file staging exception restores SQL rows and both Python and Studio files", async t => {
  const f = await fixture();
  const stage = RebuildFiles.prototype.stage;
  t.mock.method(RebuildFiles.prototype, "stage", function(this: RebuildFiles) {
    stage.call(this);
    throw new Error("injected post-rename failure");
  });
  try {
    await assert.rejects(f.rebuild(), /injected post-rename failure/);
    assert.ok(f.store.getRevisionBrief(f.brief.id));
    assert.equal(await readFile(f.output, "utf8"), "Original Studio artifact.");
    assert.equal(await readFile(join(f.root, "books/demo/drafts/chapter-0001.md"), "utf8"), f.originalBody);
  } finally {t.mock.restoreAll(); await f.close();}
});

test("cleanup failure after durable SQL commit never rolls Python back", async t => {
  const f = await fixture();
  t.mock.method(RebuildFiles.prototype, "discard", () => {throw new Error("injected cleanup failure");});
  try {
    const result = await f.rebuild();
    assert.ok(result.cleanupPending);
    assert.equal(f.store.getRevisionBrief(f.brief.id), null);
    assert.equal(existsSync(join(f.root, "books/demo/drafts/chapter-0001.md")), false);
    // The coordinator independently finishes the deferred cleanup.
    assert.equal(existsSync(result.cleanupPending), false);
    assert.equal(existsSync(join(f.root, ".planning-staging")), false);
  } finally {t.mock.restoreAll(); await f.close();}
});

test("an exception after Studio commit reports committed state, not a fictitious rollback", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.python.withBookTransaction("demo", async transactionId => {
      await f.python.updateBook("demo", {title: "Durable result", metadata: {}});
      f.store.purgeRebuiltScope("demo", "book", "book", [1], {transactionId});
      throw new Error("lost response after commit");
    }), /操作已提交/);
    assert.equal(f.title(), "Durable result");
    assert.equal(f.store.getRevisionBrief(f.brief.id), null);
    assert.equal(existsSync(f.output), false);
    assert.equal(existsSync(join(f.root, ".planning-staging")), false);
  } finally {await f.close();}
});

test("Studio schema initialization waits for a short-lived writer in another process", {timeout: 15000}, async () => {
  const f = await fixture();
  let contender: StudioStore | undefined;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
import {DatabaseSync} from 'node:sqlite';
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE; CREATE TABLE transaction_lock_probe(value TEXT); INSERT INTO transaction_lock_probe VALUES('committed');");
process.stdout.write('ready\\n');
setTimeout(() => {db.exec('COMMIT'); db.close();}, 1200);
`, join(f.root, "studio.db")], {windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
  let logs = "";
  child.stderr.on("data", value => {logs += value;});
  const exited = once(child, "exit");
  try {
    const ready = await Promise.race([
      once(child.stdout, "data"),
      exited.then(() => {throw new Error(`Lock fixture exited before readiness: ${logs}`);}),
    ]);
    assert.match(String(ready[0]), /ready/);
    contender = new StudioStore(f.root);
    assert.equal(contender.db.prepare("PRAGMA busy_timeout").get()!.timeout, 5000);
    assert.equal(contender.db.prepare("SELECT value FROM transaction_lock_probe").get()!.value, "committed");
    assert.equal((await exited)[0], 0, logs);
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
    contender?.db.close();
    await f.close();
  }
});
