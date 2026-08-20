import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FanqieBrowserService, parseVisibleWorks } from "../server/fanqie.js";
import type { PythonBridge } from "../server/python.js";
import { StudioStore } from "../server/store.js";

test("metadata and cover writes require a hashed preview and a current unchanged cover", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-work-write-"));
  try {
    const assets = join(root, "books", "demo", "assets");
    await mkdir(assets, { recursive: true });
    const coverPath = join(assets, "cover.png");
    await writeFile(coverPath, "first-cover", "utf8");
    const python = {
      async project() { return { value: {book: {title: "本地标题", metadata: {synopsis: "本地简介", genre: "奇幻/悬疑"}}} }; },
    } as unknown as PythonBridge;
    const store = new StudioStore(root);
    const service = new FanqieBrowserService(root, store, python);
    const preview = await service.prepareWorkWrite("demo", "7675620772693429273", {coverPath});
    assert.match(String(preview.id), /^write-/);
    assert.equal(preview.confirmation, `WRITE ${preview.id}`);
    assert.ok(preview.payloadHash);
    store.recordConfirmation("write", String(preview.id), String(preview.confirmation));
    await writeFile(coverPath, "changed-after-confirmation", "utf8");
    await assert.rejects(() => service.executeWorkWrite(String(preview.id), String(preview.confirmation)), /封面文件在确认后发生变化/);
    store.db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("visible Fanqie routes and embedded page data both resolve stable works", () => {
  const parsed = parseVisibleWorks([
    {href: "https://fanqienovel.com/main/writer/book-info/7675620772693429273?isEdit=1", text: "点此了解", card: "签约后可解锁更多作者福利"},
    {href: "https://fanqienovel.com/main/writer/chapter-manage/7675620772693429273&%E7%AC%AC%E5%8D%81%E4%B8%89%E5%93%8D%E5%90%8E%EF%BC%8C%E6%AD%BB%E5%8E%BB%E7%9A%84%E5%B0%91%E5%A5%B3%E5%AF%84%E6%9D%A5%E4%BA%86%E4%BF%A1?type=1", text: "章节管理", card: "第十三响后，死去的少女寄来了信\n征文作品\n最近更新：第4章 旧抄本\n4章 9757字 连载中"},
  ], 'window.__DATA__={"book_id":"7000000000000000001","book_name":"第二本书"}', "2026-08-20T00:00:00.000Z");
  assert.equal(parsed.works.length, 2);
  assert.equal(parsed.works.find((item) => item.platformId === "7675620772693429273")?.title, "第十三响后，死去的少女寄来了信");
  assert.equal(parsed.works.find((item) => item.platformId === "7675620772693429273")?.metrics.chapterCount, "4");
  assert.equal(parsed.works.find((item) => item.platformId === "7000000000000000001")?.title, "第二本书");
});

test("generic signing tooltip links are never accepted as platform works", () => {
  const parsed = parseVisibleWorks([
    {href: "https://fanqienovel.com/main/writer/book-info/7675620772693429273?isEdit=1", text: "点此了解", card: "完成签约后，作品可获得更多推荐"},
  ], "", "2026-08-20T00:00:00.000Z");
  assert.deepEqual(parsed.works, []);
});

test("Fanqie accounts keep browser profiles and synchronized works isolated", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-accounts-"));
  try {
    const store = new StudioStore(root);
    const python = {} as PythonBridge;
    const service = new FanqieBrowserService(root, store, python);
    const first = service.accounts()[0];
    store.upsertWorks(first.id, [{platformId: "7000000000000000001", title: "账号一作品", url: "https://fanqienovel.com", status: "连载中", metrics: {}, syncedAt: new Date().toISOString()}]);
    const second = service.createAccount("副账号");
    store.upsertWorks(second.id, [{platformId: "7000000000000000002", title: "账号二作品", url: "https://fanqienovel.com", status: "草稿", metrics: {}, syncedAt: new Date().toISOString()}]);
    assert.notEqual(first.profileDirectory, second.profileDirectory);
    assert.deepEqual(store.listWorks(second.id).map((item) => item.title), ["账号二作品"]);
    service.switchAccount(first.id);
    assert.deepEqual(store.listWorks(first.id).map((item) => item.title), ["账号一作品"]);
    const renamed = service.renameAccount(first.id, "主账号");
    assert.equal(renamed.label, "主账号");
    await assert.rejects(() => service.archiveAccount(first.id, "ARCHIVE wrong"), /确认文本不匹配/);
    await service.archiveAccount(first.id, `ARCHIVE ${first.id}`);
    assert.deepEqual(service.accounts().map((item) => item.id), [second.id]);
    assert.equal(store.listFanqieAccounts(true).find((item) => item.id === first.id)?.archivedAt !== null, true);
    assert.equal(service.accounts()[0].active, true);
    store.db.close();
  } finally { await rm(root, {recursive: true, force: true}); }
});
