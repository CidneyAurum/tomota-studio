import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { initializeWorkspace, safeBookPath, StudioStore } from "../server/store.js";

test("migration backs up the database and inventories existing books without changing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-store-"));
  try {
    await mkdir(join(root, "books", "demo", "drafts"), { recursive: true });
    const draft = join(root, "books", "demo", "drafts", "chapter-0001.md");
    await writeFile(draft, "原稿不会被修改\n", "utf8");
    await writeFile(join(root, "tomota.db"), "database-snapshot", "utf8");
    const before = createHash("sha256").update(await readFile(draft)).digest("hex");
    const store = new StudioStore(root);
    const migration = await initializeWorkspace(store);
    assert.ok(migration.backupPath);
    assert.equal((await readFile(migration.backupPath!, "utf8")), "database-snapshot");
    assert.equal(createHash("sha256").update(await readFile(draft)).digest("hex"), before);
    const manifest = JSON.parse(await readFile(migration.manifestPath, "utf8"));
    assert.equal(manifest.files[0].sha256, before);
    const second = await initializeWorkspace(store);
    assert.equal(second.manifestPath, migration.manifestPath);
    store.db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("book path guard rejects traversal outside the books directory", () => {
  const root = join(tmpdir(), "tomota-safe-root");
  assert.throws(() => safeBookPath(root, join(root, "tomota.db")), /超出 books/);
  assert.equal(safeBookPath(root, join(root, "books", "demo", "drafts", "one.md")), join(root, "books", "demo", "drafts", "one.md"));
});

test("confirmation tokens are single-use and stored by hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-confirm-"));
  try {
    const store = new StudioStore(root);
    store.recordConfirmation("publish", "batch-one", "PUBLISH batch-one");
    assert.equal(store.consumeConfirmation("publish", "batch-one", "wrong"), false);
    assert.equal(store.consumeConfirmation("publish", "batch-one", "PUBLISH batch-one"), true);
    assert.equal(store.consumeConfirmation("publish", "batch-one", "PUBLISH batch-one"), false);
    const row = store.db.prepare("SELECT token_hash FROM operation_confirmations LIMIT 1").get() as {token_hash: string};
    assert.notEqual(row.token_hash, "PUBLISH batch-one");
    store.db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("batch confirmations are consumed atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-confirm-batch-"));
  try {
    const store = new StudioStore(root);
    store.recordConfirmation("publish", "batch-two", "PUBLISH batch-two");
    store.recordConfirmation("write", "batch-two", "WRITE batch-two");
    const items = [
      {operation: "publish", targetId: "batch-two", token: "PUBLISH batch-two"},
      {operation: "write", targetId: "batch-two", token: "WRITE batch-two"},
      {operation: "submit", targetId: "batch-two", token: "SUBMIT batch-two:1:abcdef123456"},
    ];
    assert.equal(store.consumeConfirmations(items), false);
    assert.equal(store.consumeConfirmation("publish", "batch-two", "PUBLISH batch-two"), true, "failed group must not consume earlier rows");
    store.recordConfirmation("publish", "batch-two", "PUBLISH batch-two");
    store.recordConfirmation("submit", "batch-two", "SUBMIT batch-two:1:abcdef123456");
    assert.equal(store.consumeConfirmations(items), true);
    assert.equal(store.consumeConfirmations(items), false, "successful group remains single-use");
    store.db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authoritative chapter sync replaces inferred placeholder ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-chapter-sync-"));
  try {
    const store = new StudioStore(root);
    const account = store.createFanqieAccount("账号", join(root, "profile"), "account-one");
    const base = {workId: "7675620772693429273", chapterNumber: 4, title: "旧抄本", status: "已发布", wordCount: 1534, scheduledAt: null, contentHash: "", syncedAt: new Date().toISOString()};
    store.upsertChapters(account.id, [{...base, platformId: "7675620772693429273-4"}]);
    store.replaceWorkChapters(account.id, base.workId, [{...base, platformId: "7675893913663586840"}]);
    assert.deepEqual(store.listChapters(base.workId, account.id).map((item) => item.platformId), ["7675893913663586840"]);
    store.db.close();
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
