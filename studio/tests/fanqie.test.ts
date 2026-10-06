import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FanqieBrowserService, fanqieWriteWindow, isBrowserProfileInUseError, parseChapterRows, parseVisibleWorks } from "../server/fanqie.js";
import type { PythonBridge } from "../server/python.js";
import { StudioStore } from "../server/store.js";

test("browser lease serializes workflows across service instances and releases on errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-browser-lease-"));
  const store = new StudioStore(root);
  const otherStore = new StudioStore(root);
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  try {
    const service = new FanqieBrowserService(root, store, {} as PythonBridge) as any;
    const other = new FanqieBrowserService(root, otherStore, {} as PythonBridge);
    let nested = false;
    const held = service.withBrowserOperation("test-submit", async () => {
      await service.withBrowserOperation("nested", async () => {nested = true;});
      await gate;
    });
    await Promise.resolve();
    assert.equal(nested, true);
    await assert.rejects(() => service.sync(), {code: "browser_busy"});
    await assert.rejects(() => other.reconcile("batch-any"), {code: "browser_busy"});
    await assert.rejects(() => other.preflightPublish("7675620772693429273"), {code: "browser_busy"});
    assert.throws(() => other.switchAccount(other.accounts()[0].id), {code: "browser_busy"});
    release(); await held;
    await assert.rejects(() => service.withBrowserOperation("failure", async () => {throw new Error("fixture failure");}), /fixture failure/);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM fanqie_operation_lock").get()?.n, 0);
    assert.equal(await service.withBrowserOperation("next", async () => "ready"), "ready");
  } finally { release(); otherStore.db.close(); store.db.close(); await rm(root, {recursive: true, force: true}); }
});

test("an attempted batch with a missing receipt is never safe to retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-missing-receipt-"));
  const store = new StudioStore(root);
  try {
    const service = new FanqieBrowserService(root, store, {} as PythonBridge) as any;
    const preview = {batch_id: "batch-lost", book_id: "demo", chapters: [{chapter_number: 1}]};
    assert.equal((await service.recoveryState(preview)).state, "ready");
    store.setMeta("fanqie_batch_attempted:batch-lost", new Date().toISOString());
    assert.equal((await service.recoveryState(preview)).state, "reconcile_required");
    await assert.rejects(() => service.recoverUncertainResultFromPlatform(preview, "7675620772693429273"), /提交记录缺失/);
  } finally {
    store.db.close();
    await rm(root, {recursive: true, force: true});
  }
});

test("Fanqie chapter writes are disabled before 07:00 Beijing time", () => {
  const before = fanqieWriteWindow(new Date("2026-08-20T16:30:00.000Z")); // 00:30 +08:00
  assert.equal(before.allowed, false);
  assert.equal(before.nextAllowedAt, "2026-08-20T23:00:00.000Z");
  assert.match(before.message, /07:00/);
  const open = fanqieWriteWindow(new Date("2026-08-20T23:00:00.000Z")); // 07:00 +08:00
  assert.equal(open.allowed, true);
  assert.equal(open.nextAllowedAt, null);
});

test("legacy Playwright profile locks are recognized as a recoverable browser ownership error", () => {
  assert.equal(isBrowserProfileInUseError(new Error("Failed to create a ProcessSingleton for your profile directory")), true);
  assert.equal(isBrowserProfileInUseError(new Error("ordinary navigation timeout")), false);
});

test("one-click batches resume matching content and rebuild mismatched chapter selections", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-one-click-"));
  let store: StudioStore | null = null;
  try {
    const publishDir = join(root, "books", "demo", "publish");
    const jobsDir = join(publishDir, "jobs");
    await mkdir(jobsDir, {recursive: true});
    let releaseCount = 0;
    let activeFingerprints = new Map([[1, "a".repeat(64)], [2, "b".repeat(64)]]);
    const writePreview = async (batchId: string, chapters: number[]) => {
      await writeFile(join(publishDir, `${batchId}.preview.json`), JSON.stringify({
        batch_id: batchId, book_id: "demo", book_title: "本地标题", status: "preview",
        chapters: chapters.map((number) => ({chapter_number: number, title: `第${number}章`, word_count: 1000, content_fingerprint: activeFingerprints.get(number)})),
        next_confirmation: `PUBLISH ${batchId}`,
      }), "utf8");
    };
    const python = {
      async listProjects() { return {value: [{id: "demo", title: "本地标题"}]}; },
      async run(args: string[]) {
        if (args[0] === "release") {
          const batchId = `batch-oneclick-${++releaseCount}`;
          const chapters = String(args[args.indexOf("--chapters") + 1]).split(",").map(Number);
          await writePreview(batchId, chapters);
          return {value: {batch_id: batchId}};
        }
        if (args[0] === "fanqie" && args[1] === "check") {
          const batchId = args[args.indexOf("--batch") + 1];
          const path = join(jobsDir, `${batchId}.json`);
          const preview = JSON.parse(await readFile(join(publishDir, `${batchId}.preview.json`), "utf8"));
          return {value: {chapters: preview.chapters.map((item: {chapter_number: number}) => ({chapter_number: item.chapter_number, content_fingerprint: activeFingerprints.get(item.chapter_number)}))}};
        }
        if (args[0] === "fanqie" && args[1] === "reconcile") return {value: {status: "failed", submitted: [], skipped: [], failed: {1: "uncertain"}}};
        if (args[0] === "fanqie" && args[1] === "abandon") return {value: {batch_id: args[3], status: "superseded", cloud_write_performed: false}};
        throw new Error(`unexpected python call: ${args.join(" ")}`);
      },
    } as unknown as PythonBridge;
    store = new StudioStore(root);
    const service = new FanqieBrowserService(root, store, python);
    (service as unknown as {preflightPublish: () => Promise<Record<string, unknown>>}).preflightPublish = async () => ({status: "ready"});
    const account = service.accounts()[0];
    store.upsertWorks(account.id, [{platformId: "7675620772693429273", title: "本地标题", url: "https://fanqienovel.com/main/writer/chapter-manage/7675620772693429273", status: "连载中", metrics: {}, syncedAt: new Date().toISOString()}]);

    const created = await service.prepareOrResumeBatch("demo", [1], "7675620772693429273", {mode: "immediate"}, new Date("2026-08-20T23:00:00.000Z"));
    assert.equal(created.disposition, "created");
    const resumed = await service.prepareOrResumeBatch("demo", [1], "7675620772693429273", {mode: "immediate"}, new Date("2026-08-20T23:00:00.000Z"));
    assert.equal(resumed.disposition, "resumed");
    assert.equal(resumed.batch?.batch_id, created.batch?.batch_id);

    const legacyPreviewPath = join(publishDir, `${created.batch?.batch_id}.preview.json`);
    const legacyPreview = JSON.parse(await readFile(legacyPreviewPath, "utf8"));
    legacyPreview.chapters[0].scheduled_at = "2026-08-22T20:00:00+08:00";
    await writeFile(legacyPreviewPath, JSON.stringify(legacyPreview), "utf8");
    const immediate = await service.prepareOrResumeBatch("demo", [1], "7675620772693429273", {mode: "scheduled", chaptersPerDay: 2, publishHour: 20}, new Date("2026-08-20T23:00:00.000Z"));
    assert.equal(immediate.disposition, "rebuilt");
    assert.match(immediate.message, /定时排期/);
    assert.equal(immediate.batch?.chapters[0].scheduled_at, null);

    const uncertainPath = join(jobsDir, `${immediate.batch?.batch_id}.result.json`);
    await writeFile(uncertainPath, JSON.stringify({batch_id: immediate.batch?.batch_id, status: "uncertain", chapters: [{chapter_number: 1, status: "uncertain"}]}), "utf8");
    await assert.rejects(
      () => service.prepareOrResumeBatch("demo", [1], "7675620772693429273", {mode: "immediate"}, new Date("2026-08-20T23:00:00.000Z")),
      (error: Error & {code?: string}) => error.code === "platform_verification_required",
    );
    await unlink(uncertainPath);

    const rebuilt = await service.prepareOrResumeBatch("demo", [1, 2], "7675620772693429273", {mode: "immediate"}, new Date("2026-08-20T23:00:00.000Z"));
    assert.equal(rebuilt.disposition, "rebuilt");
    assert.notEqual(rebuilt.batch?.batch_id, immediate.batch?.batch_id);
    assert.deepEqual(rebuilt.batch?.chapters.map((item) => item.chapter_number), [1, 2]);
  } finally {
    store?.db.close();
    await rm(root, {recursive: true, force: true});
  }
});

test("an uncertain result recovers only through the shared full-content verifier", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-delayed-verify-"));
  let store: StudioStore | null = null;
  try {
    const batchId = "batch-delayed-verify";
    const workId = "7675620772693429273";
    const publishDir = join(root, "books", "demo", "publish");
    const jobsDir = join(publishDir, "jobs");
    await mkdir(jobsDir, {recursive: true});
    const preview = {
      batch_id: batchId, book_id: "demo", book_title: "本地标题", status: "preview",
      platform_work_id: workId,
      chapters: [{chapter_number: 5, title: "井下刻痕", word_count: 2160, content_fingerprint: createHash("sha256").update("新正文").digest("hex"), operation: "create"}],
      next_confirmation: `PUBLISH ${batchId}`,
    };
    await writeFile(join(publishDir, `${batchId}.preview.json`), JSON.stringify(preview), "utf8");
    await writeFile(join(jobsDir, `${batchId}.json`), JSON.stringify({...preview, chapters: preview.chapters.map(ch => ({...ch, content: "新正文"}))}), "utf8");
    const resultPath = join(jobsDir, `${batchId}.result.json`);
    await writeFile(resultPath, JSON.stringify({batch_id: batchId, book_id: "demo", status: "uncertain", chapters: [{chapter_number: 5, status: "uncertain", content_fingerprint: createHash("sha256").update("新正文").digest("hex"), preexisting_platform_ids: []}]}), "utf8");
    const python = {
      async listProjects() { return {value: [{id: "demo", title: "本地标题"}]}; },
      async run(args: string[]) {
        if (args[0] === "fanqie" && args[1] === "reconcile") {
          const result = JSON.parse(await readFile(resultPath, "utf8"));
          const submitted = result.chapters.filter((item: {status: string}) => item.status === "submitted").map((item: {chapter_number: number}) => item.chapter_number);
          return {value: {status: result.status, submitted, skipped: [], failed: {}}};
        }
        throw new Error(`unexpected python call: ${args.join(" ")}`);
      },
    } as unknown as PythonBridge;
    store = new StudioStore(root);
    const service = new FanqieBrowserService(root, store, python);
    const internals = service as any;
    const realDriver = await internals.publicationDriver();
    internals.selectedPage = async () => ({});
    internals.browserAdapter = () => ({tabs: {selected: async () => ({})}});
    let verificationCount = 0;
    internals.publicationDriver = async () => ({...realDriver, verifyChapterPublication: async (_tab: unknown, job: any, chapter: any) => {
      verificationCount++;
      assert.equal(chapter.content, "新正文");
      assert.deepEqual(job.preexisting_platform_ids, []);
      return {status: "success", platform_id: "7676514547766657561", platform_verification: {kind: "chapter_content"}};
    }});
    let preflightCount = 0;
    (service as unknown as {preflightPublish: () => Promise<Record<string, unknown>>}).preflightPublish = async () => { preflightCount += 1; return {status: "ready"}; };
    const account = service.accounts()[0];
    store.upsertWorks(account.id, [{platformId: workId, title: "本地标题", url: `https://fanqienovel.com/main/writer/chapter-manage/${workId}`, status: "连载中", metrics: {}, syncedAt: new Date().toISOString()}]);
    store.upsertChapters(account.id, [{platformId: "7676514547766657561", workId, chapterNumber: 5, title: "井下刻痕", status: "已发布", scheduledAt: null, contentHash: "", syncedAt: new Date().toISOString()}]);
    store.setMeta(`fanqie_batch_account:${batchId}`, account.id);
    store.setMeta(`fanqie_batch_work:${batchId}`, workId);
    store.setMeta(`fanqie_book_pending_batch:${account.id}:demo`, batchId);

    const resolution = await service.prepareOrResumeBatch("demo", [5], workId, {mode: "immediate"}, new Date("2026-08-20T23:00:00.000Z"));
    assert.equal(resolution.disposition, "already_submitted");
    assert.equal(resolution.batch, null);
    const repaired = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(repaired.status, "submitted");
    assert.equal(repaired.chapters[0].platform_id, "7676514547766657561");
    assert.equal(repaired.chapters[0].platform_verification.kind, "chapter_content");
    assert.equal(preflightCount, 1);
    assert.equal(verificationCount, 1);
    assert.equal(await service.pendingBatch("demo"), null);
  } finally {
    store?.db.close();
    await rm(root, {recursive: true, force: true});
  }
});

test("a legacy one-chapter result can never claim an entire multi-chapter batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-batch-coverage-"));
  let store: StudioStore | null = null;
  try {
    const batchId = "batch-coverage";
    const workId = "7675620772693429273";
    const jobsDir = join(root, "books", "demo", "publish", "jobs");
    await mkdir(jobsDir, {recursive: true});
    const preview = {
      batch_id: batchId, book_id: "demo", book_title: "本地标题", status: "preview", platform_work_id: workId,
      chapters: [1, 2, 3].map((chapter_number) => ({chapter_number, title: `第${chapter_number}章`, word_count: 1000, content_fingerprint: String(chapter_number).repeat(64), operation: "create"})),
      next_confirmation: `PUBLISH ${batchId}`,
    };
    await writeFile(join(jobsDir, `${batchId}.json`), JSON.stringify({...preview, chapters: preview.chapters.map(ch => ({...ch, content: "新正文"}))}), "utf8");
    const resultPath = join(jobsDir, `${batchId}.result.json`);
    await writeFile(resultPath, JSON.stringify({batch_id: batchId, status: "submitted", chapters: [{chapter_number: 1, status: "submitted"}]}), "utf8");
    const python = {async listProjects() { return {value: [{id: "demo", title: "本地标题"}]}; }} as unknown as PythonBridge;
    store = new StudioStore(root);
    const service = new FanqieBrowserService(root, store, python);
    const before = await readFile(resultPath, "utf8");
    await assert.rejects(() => (service as any).recoverUncertainResultFromPlatform(preview, workId), /身份|指纹/);
    assert.equal(await readFile(resultPath, "utf8"), before);
  } finally {
    store?.db.close();
    await rm(root, {recursive: true, force: true});
  }
});

test("an existing update chapter is not proof that new replacement text was saved", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-update-proof-"));
  let store: StudioStore | null = null;
  try {
    const batchId = "batch-update-proof";
    const workId = "7675620772693429273";
    const chapterId = "7676514547766657561";
    const jobsDir = join(root, "books", "demo", "publish", "jobs");
    await mkdir(jobsDir, {recursive: true});
    const preview = {
      batch_id: batchId, book_id: "demo", book_title: "本地标题", status: "preview", platform_work_id: workId,
      chapters: [{chapter_number: 5, title: "井下刻痕", word_count: 1500, content_fingerprint: createHash("sha256").update("新正文").digest("hex"), operation: "update", platform_chapter_id: chapterId}],
      next_confirmation: `PUBLISH ${batchId}`,
    };
    await writeFile(join(jobsDir, `${batchId}.json`), JSON.stringify({...preview, chapters: preview.chapters.map(ch => ({...ch, content: "新正文"}))}), "utf8");
    const resultPath = join(jobsDir, `${batchId}.result.json`);
    await writeFile(resultPath, JSON.stringify({batch_id: batchId, book_id: "demo", status: "uncertain", chapters: [{chapter_number: 5, status: "uncertain", content_fingerprint: createHash("sha256").update("新正文").digest("hex"), preexisting_platform_ids: []}]}), "utf8");
    const python = {async listProjects() { return {value: [{id: "demo", title: "本地标题"}]}; }} as unknown as PythonBridge;
    store = new StudioStore(root);
    const service = new FanqieBrowserService(root, store, python);
    (service as unknown as {preflightPublish: () => Promise<Record<string, unknown>>}).preflightPublish = async () => ({status: "ready"});
    const internal = service as any;
    const realDriver = await internal.publicationDriver();
    internal.selectedPage = async () => ({});
    internal.browserAdapter = () => ({tabs: {selected: async () => ({})}});
    let checks = 0;
    internal.publicationDriver = async () => ({...realDriver, verifyChapterPublication: async (_tab: unknown, _job: unknown, chapter: any) => {
      checks++;
      assert.equal(chapter.content, "新正文");
      return {status: "uncertain", message: "同字数旧正文不匹配"};
    }});
    const account = service.accounts()[0];
    store.upsertChapters(account.id, [{platformId: chapterId, workId, chapterNumber: 5, title: "井下刻痕", status: "已发布", wordCount: 1500, scheduledAt: null, contentHash: "", syncedAt: new Date().toISOString()}]);
    const recovered = await (service as unknown as {recoverUncertainResultFromPlatform: (preview: unknown, workId: string) => Promise<{matched: number[]; uncertain: number[]}>}).recoverUncertainResultFromPlatform(preview, workId);
    assert.equal(checks, 1);
    assert.deepEqual(recovered.matched, []);
    assert.deepEqual(recovered.uncertain, [5]);
    assert.equal(JSON.parse(await readFile(resultPath, "utf8")).status, "uncertain");
  } finally {
    store?.db.close();
    await rm(root, {recursive: true, force: true});
  }
});

test("publish previews lock the AI declaration to no and fail closed on stale batches", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-batch-preview-"));
  let store: StudioStore | null = null;
  try {
    const publishDir = join(root, "books", "demo", "publish");
    await mkdir(publishDir, {recursive: true});
    const batchId = "batch-test-123";
    let releaseArgs: string[] = [];
    await writeFile(join(publishDir, `${batchId}.preview.json`), JSON.stringify({
      batch_id: batchId, book_id: "demo", book_title: "本地标题", status: "preview",
      chapters: [{chapter_number: 1, title: "第一章", word_count: 1000, content_fingerprint: "a".repeat(64)}],
      next_confirmation: `PUBLISH ${batchId}`,
    }), "utf8");
    const python = {
      async listProjects() { return {value: [{id: "demo", title: "本地标题"}]}; },
      async run(args: string[]) {
        if (args[0] === "release") { releaseArgs = [...args]; return {value: {batch_id: batchId}}; }
        if (args[0] === "fanqie" && args[1] === "abandon") return {value: {batch_id: batchId, book_id: "demo", status: "superseded", cloud_write_performed: false}};
        throw new Error(`unexpected python call: ${args.join(" ")}`);
      },
    } as unknown as PythonBridge;
    store = new StudioStore(root);
    const service = new FanqieBrowserService(root, store, python);
    (service as unknown as {preflightPublish: () => Promise<Record<string, unknown>>}).preflightPublish = async () => ({ok: true});
    const account = service.accounts()[0];
    store.upsertWorks(account.id, [{platformId: "7675620772693429273", title: "本地标题", url: "https://fanqienovel.com/main/writer/chapter-manage/7675620772693429273", status: "连载中", metrics: {}, syncedAt: new Date().toISOString()}]);
    const preview = await service.prepareBatch("demo", [1], "7675620772693429273", {mode: "scheduled", chaptersPerDay: 5, publishHour: 23, startAt: "2026-08-30"}, new Date("2026-08-20T23:00:00.000Z"));
    assert.equal(releaseArgs[releaseArgs.indexOf("--schedule-mode") + 1], "immediate");
    assert.equal(releaseArgs.includes("--chapters-per-day"), false);
    assert.equal(releaseArgs.includes("--publish-hour"), false);
    assert.equal(preview.chapters[0].scheduled_at, null);
    assert.equal(preview.safety?.account_id, account.id);
    assert.equal(preview.safety?.ai_usage_required, true);
    assert.equal(preview.safety?.ai_usage_value, "no");
    assert.deepEqual(preview.safety?.create_and_update_paths, ["create:1"]);
    await assert.rejects(
      () => service.prepareBatch("demo", [1], "7675620772693429273", {mode: "immediate"}, new Date("2026-08-20T23:00:00.000Z")),
      (error: Error & {code?: string}) => error.code === "pending_batch_exists",
    );
    assert.equal((await service.pendingBatch("demo"))?.batch_id, batchId);
    const abandoned = await service.abandonBatch(batchId);
    assert.equal(abandoned.status, "superseded");
    assert.equal(await service.pendingBatch("demo"), null);
    await assert.rejects(
      () => service.prepareBatch("demo", [1], "7675620772693429273", {mode: "immediate"}, new Date("2026-08-20T16:30:00.000Z")),
      (error: Error & {code?: string}) => error.code === "time_window_blocked",
    );
  } finally {
    store?.db.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(root, {recursive: true, force: true});
  }
});

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
    const account = service.accounts()[0];
    store.upsertWorks(account.id, [{platformId: "7675620772693429273", title: "本地标题", url: "https://fanqienovel.com/main/writer/chapter-manage/7675620772693429273", status: "连载中", metrics: {}, syncedAt: new Date().toISOString()}]);
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

test("chapter management rows resolve published chapter ids and titles", () => {
  const chapters = parseChapterRows([
    {text: "第4章 旧抄本 1534 0 已发布 2026-08-20 07:53", hrefs: ["https://fanqienovel.com/main/writer/preview/7675620772693429273&7675893913663586840", "https://fanqienovel.com/main/writer/7675620772693429273/publish/7675893913663586840/?enter_from=modifychapter"]},
    {text: "章节名称 字数 错别字 审核状态 发布时间 操作", hrefs: []},
  ], "7675620772693429273", "2026-08-20T00:00:00.000Z");
  assert.deepEqual(chapters.map((item) => ({id: item.platformId, number: item.chapterNumber, title: item.title, status: item.status})), [
    {id: "7675893913663586840", number: 4, title: "旧抄本", status: "已发布"},
  ]);
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
