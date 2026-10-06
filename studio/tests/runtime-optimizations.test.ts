import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {test} from "node:test";
import {api, post, uploadAuthorSource} from "../src/api.js";
import {startPolling} from "../src/polling.js";
import {recoveryDiagnostics} from "../server/runtime-recovery.js";

function deferred<T>() {let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
const flush = async () => {for (let i = 0; i < 10; i++) await Promise.resolve();};

test("polling never overlaps, pauses while hidden and stops even during an outstanding call", async t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  let visible = true, calls = 0;
  const work = deferred<void>();
  const stop = startPolling(async () => {calls++; await work.promise;}, 100, {visible: () => visible, immediate: true});
  assert.equal(calls, 1);
  t.mock.timers.tick(10000); await flush(); assert.equal(calls, 1);
  work.resolve(); await flush();
  visible = false;
  t.mock.timers.tick(100); await flush(); assert.equal(calls, 1);
  visible = true;
  t.mock.timers.tick(100); await flush(); assert.equal(calls, 2);
  stop(); t.mock.timers.tick(10000); await flush(); assert.equal(calls, 2);
  const late = deferred<void>(); let errors = 0;
  const stopLate = startPolling(() => late.promise, 100, {immediate: true, onError: () => errors++});
  stopLate(); late.reject(new Error("late")); await flush();
  t.mock.timers.tick(10000); await flush(); assert.equal(errors, 0);
});

test("polling reports failures and resumes on the next interval", async t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  let calls = 0, errors = 0;
  const stop = startPolling(async () => {if (++calls === 1) throw new Error("offline");}, 100, {onError: () => errors++});
  assert.equal(calls, 0);
  t.mock.timers.tick(100); await flush(); assert.equal(errors, 1);
  t.mock.timers.tick(100); await flush(); assert.equal(calls, 2);
  stop();
});

test("default GETs coalesce only while pending, including shared errors and retry", async t => {
  const queue: Array<ReturnType<typeof deferred<Response>>> = [];
  t.mock.method(globalThis, "fetch", () => {const pending = deferred<Response>(); queue.push(pending); return pending.promise;});
  const first = api("/dedupe"), second = api("/dedupe");
  assert.equal(queue.length, 1);
  queue[0].resolve(Response.json({value: 1}));
  assert.deepEqual(await Promise.all([first, second]), [{value: 1}, {value: 1}]);
  const third = api("/dedupe"); assert.equal(queue.length, 2);
  queue[1].resolve(Response.json({value: 2})); assert.deepEqual(await third, {value: 2});
  const failed = api("/dedupe"), sharedFailure = api("/dedupe");
  const check = Promise.all([assert.rejects(failed, /offline/), assert.rejects(sharedFailure, /offline/)]);
  queue[2].reject(new Error("offline")); await check;
  const retry = api("/dedupe"); assert.equal(queue.length, 4);
  queue[3].resolve(Response.json({value: 3})); await retry;
});

test("custom GET semantics are not merged and mutations invalidate reads before and after completion", async t => {
  const queue: Array<ReturnType<typeof deferred<Response>>> = [];
  t.mock.method(globalThis, "fetch", () => {const pending = deferred<Response>(); queue.push(pending); return pending.promise;});
  const custom = [api("/custom", {headers: {"X-Test": "a"}}), api("/custom", {signal: new AbortController().signal}), api("/custom", {method: "GET"})];
  assert.equal(queue.length, 3);
  queue.splice(0).forEach(q => q.resolve(Response.json({}))); await Promise.all(custom);
  for (const mutate of [() => post("/mutation"), () => uploadAuthorSource("fixture", new File(["fixture"], "test.txt"))]) {
    const old = api("/after-write"), mutation = mutate(), during = api("/after-write");
    assert.equal(queue.length, 3);
    queue[1].resolve(Response.json({})); await mutation;
    const fresh = api("/after-write"); assert.equal(queue.length, 4);
    // Completing an older read must not evict the new in-flight read.
    queue[0].resolve(Response.json({generation: 0})); await old;
    const sharedFresh = api("/after-write"); assert.equal(queue.length, 4);
    queue[2].resolve(Response.json({generation: 1})); queue[3].resolve(Response.json({generation: 2}));
    assert.deepEqual(await fresh, {generation: 2}); assert.deepEqual(await sharedFresh, {generation: 2}); await during;
    queue.length = 0;
  }
});

test("recovery diagnostics are read-only, redact tokens, validate identity and quote recovery paths", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tomota-diagnostics-")));
  const directory = join(root, ".tomota-locks");
  try {
    assert.deepEqual(await recoveryDiagnostics(root, "python"), {entries: [], truncated: false});
    await mkdir(directory);
    const token = "b".repeat(32);
    const marker = (book: string) => join(directory, createHash("sha256").update(`${process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root)}\0${book}`).digest("hex") + ".owner.json");
    const records = [
      {book_id: "active", scope: "file", state: "active"},
      {book_id: "committed", decision: "commit"},
      {book_id: "restored", restored: true},
      {book_id: "bad-snapshot", snapshot: join(root, "outside")},
      {book_id: "bad-scope", scope: "future-format"},
    ];
    for (const record of records) await writeFile(marker(record.book_id), JSON.stringify({token, snapshot: join(root, ".planning-staging", "fixture"), ...record}));
    await writeFile(join(directory, "wrong.owner.json"), "{}");
    const before = await Promise.all((await readdir(directory)).map(async name => [name, await readFile(join(directory, name), "utf8")]));
    const result = await recoveryDiagnostics(root, "C:/fixture's/python.exe", "C:/application's/src");
    assert.equal(result.entries.length, 6);
    assert.equal(result.entries.find(e => e.bookId === "active")?.state, "unconfirmed");
    assert.equal(result.entries.find(e => e.bookId === "active")?.scope, "file");
    assert.equal(result.entries.find(e => e.bookId === "committed")?.state, "committed_cleanup");
    assert.equal(result.entries.find(e => e.bookId === "restored")?.state, "rollback_cleanup");
    assert.equal(result.entries.filter(e => e.state === "invalid").length, 3);
    assert.ok(result.entries.filter(e => e.state === "invalid").every(e => e.command === null));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
    assert.match(result.entries.find(e => e.bookId === "active")!.command!, /fixture''s/);
    assert.match(result.entries.find(e => e.bookId === "active")!.command!, /application''s/);
    const after = await Promise.all((await readdir(directory)).map(async name => [name, await readFile(join(directory, name), "utf8")]));
    assert.deepEqual(after, before);
    for (let i = 0; i < 100; i++) await writeFile(join(directory, `${i}.owner.json`), "bad");
    const capped = await recoveryDiagnostics(root, "python");
    assert.equal(capped.entries.length, 100); assert.equal(capped.truncated, true);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("recovery diagnostics refuse linked marker directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-diagnostics-link-"));
  try {
    const target = join(root, "external"); await mkdir(target);
    await writeFile(join(target, "untouched.txt"), "original");
    await symlink(target, join(root, ".tomota-locks"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(recoveryDiagnostics(root, "python"), /链接/);
    assert.equal(await readFile(join(target, "untouched.txt"), "utf8"), "original");
  } finally {await rm(root, {recursive: true, force: true});}
});
