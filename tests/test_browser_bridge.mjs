import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runFanqiePublishJob } from "../scripts/fanqie_browser_driver.mjs";

async function withJob(callback) {
  const directory = await mkdtemp(join(tmpdir(), "tomota-browser-"));
  const jobPath = join(directory, "batch-test.json");
  const resultPath = join(directory, "batch-test.result.json");
  await writeFile(jobPath, JSON.stringify({
    schema_version: 2,
    kind: "fanqie.publish",
    batch_id: "batch-test",
    book_id: "demo",
    book_title: "测试书",
    confirmation_required: "PUBLISH batch-test",
    account_scope: "works_and_chapter_operations_only",
    result_path: resultPath,
    chapters: [{ chapter_number: 1, title: "第一章", content: "正文", content_fingerprint: "hash" }],
  }), "utf8");
  try {
    return await callback({ jobPath, resultPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function browserWithSnapshot(snapshot) {
  const tab = {
    async url() { return "https://fanqienovel.com/main/writer/book-manage"; },
    playwright: { async domSnapshot() { return snapshot; } },
  };
  return { tabs: { async selected() { return tab; } } };
}

function fakeLocator({ count = 1, onClick = async () => {}, onFill = async () => {} } = {}) {
  return {
    async count() { return count; },
    first() { return this; },
    async click() { await onClick(); },
    async fill(value) { await onFill(value); },
  };
}

function interactiveBrowser(initialSnapshot, handlers = {}) {
  let snapshot = initialSnapshot;
  const tab = {
    async url() { return "https://fanqienovel.com/main/writer/book-manage"; },
    playwright: {
      async domSnapshot() { return snapshot; },
      async waitForTimeout() {},
      getByText(value) {
        const text = String(value);
        if (/测试书/.test(text)) return fakeLocator({ onClick: async () => { snapshot = handlers.afterBook || snapshot; } });
        if (/新建章节|新增章节|创建章节|写新章节/.test(text)) return fakeLocator({ count: handlers.allowCreate ? 1 : 0, onClick: async () => { snapshot = handlers.afterCreate || snapshot; } });
        if (/提交审核|保存并发布|发布/.test(text)) return fakeLocator({ count: handlers.allowSubmit ? 1 : 0, onClick: async () => { snapshot = handlers.afterSubmit || snapshot; } });
        if (/确认发布|确认提交/.test(text)) return fakeLocator({ count: 0 });
        return fakeLocator({ count: 0 });
      },
      getByRole(_role, options = {}) {
        const text = String(options.name || "");
        if (/新建章节|新增章节|创建章节|写新章节/.test(text)) return fakeLocator({ count: handlers.allowCreate ? 1 : 0, onClick: async () => { snapshot = handlers.afterCreate || snapshot; } });
        if (/提交审核|保存并发布|发布/.test(text)) return fakeLocator({ count: handlers.allowSubmit ? 1 : 0, onClick: async () => { snapshot = handlers.afterSubmit || snapshot; } });
        return fakeLocator({ count: 0 });
      },
      getByLabel(value) { return /章节标题|标题|正文|章节内容/.test(String(value)) ? fakeLocator() : fakeLocator({ count: 0 }); },
      getByPlaceholder(value) { return /标题|正文|内容/.test(String(value)) ? fakeLocator() : fakeLocator({ count: 0 }); },
      locator(value) { return /input|textarea|contenteditable/.test(String(value)) ? fakeLocator() : fakeLocator({ count: 0 }); },
    },
  };
  return { tabs: { async selected() { return tab; } } };
}

test("bridge stops before any page action when confirmation is missing", async () => {
  await withJob(async ({ jobPath, resultPath }) => {
    const result = await runFanqiePublishJob({ jobPath, confirmation: "" });
    assert.equal(result.status, "blocked");
    assert.match(result.message, /批次确认/);
    assert.equal(JSON.parse(await readFile(resultPath, "utf8")).status, "blocked");
  });
});

test("bridge reports an unauthenticated official page without typing credentials", async () => {
  await withJob(async ({ jobPath }) => {
    const result = await runFanqiePublishJob({
      browser: browserWithSnapshot("登录 注册"),
      jobPath,
      confirmation: "PUBLISH batch-test",
      submit: true,
    });
    assert.equal(result.status, "auth_required");
  });
});

test("bridge stops on human verification text", async () => {
  await withJob(async ({ jobPath }) => {
    const result = await runFanqiePublishJob({
      browser: browserWithSnapshot("作家中心 作品管理 验证码"),
      jobPath,
      confirmation: "PUBLISH batch-test",
      submit: true,
    });
    assert.equal(result.status, "human_action_required");
  });
});

test("bridge requires a distinct action-time write confirmation", async () => {
  await withJob(async ({ jobPath }) => {
    const result = await runFanqiePublishJob({
      browser: browserWithSnapshot("作家中心 作品管理 测试书"),
      jobPath,
      confirmation: "PUBLISH batch-test",
      submit: true,
    });
    assert.equal(result.status, "human_action_required");
    assert.match(result.message, /WRITE batch-test/);
  });
});

test("bridge skips a visible duplicate chapter instead of creating it again", async () => {
  await withJob(async ({ jobPath }) => {
    const result = await runFanqiePublishJob({
      browser: interactiveBrowser("作家中心 作品管理 测试书 第1章 第一章"),
      jobPath,
      confirmation: "PUBLISH batch-test",
      actionConfirmation: "WRITE batch-test",
      chapterConfirmations: { "1": "SUBMIT batch-test:1:hash" },
      submit: true,
    });
    assert.equal(result.status, "submitted");
    assert.equal(result.chapters[0].status, "already_exists");
  });
});

test("bridge stops with uncertain status when submit has no official success feedback", async () => {
  await withJob(async ({ jobPath }) => {
    const result = await runFanqiePublishJob({
      browser: interactiveBrowser("作家中心 作品管理 测试书", {
        afterBook: "作家中心 作品管理",
        allowCreate: true,
        afterCreate: "作家中心 章节管理 章节标题 正文 提交审核",
        allowSubmit: true,
        afterSubmit: "作家中心 章节管理 网络连接中断",
      }),
      jobPath,
      confirmation: "PUBLISH batch-test",
      actionConfirmation: "WRITE batch-test",
      chapterConfirmations: { "1": "SUBMIT batch-test:1:hash" },
      submit: true,
    });
    assert.equal(result.status, "uncertain");
    assert.match(result.message, /未读到官方成功反馈/);
  });
});

test("bridge fails closed when the writer UI no longer exposes the target work", async () => {
  await withJob(async ({ jobPath }) => {
    const browser = interactiveBrowser("作家中心 作品管理 另一本书");
    browser.tabs.selected = async () => {
      const tab = await interactiveBrowser("作家中心 作品管理 另一本书").tabs.selected();
      tab.playwright.getByText = () => fakeLocator({ count: 0 });
      return tab;
    };
    const result = await runFanqiePublishJob({ browser, jobPath, confirmation: "PUBLISH batch-test" });
    assert.equal(result.status, "ui_mismatch");
  });
});

test("schema v3 publish jobs navigate by the bound platform work id", async () => {
  await withJob(async ({ jobPath }) => {
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    job.schema_version = 3;
    job.platform_work_id = "7675620772693429273";
    await writeFile(jobPath, JSON.stringify(job), "utf8");
    let currentUrl = "https://fanqienovel.com/main/writer/book-manage";
    const tab = {
      async url() { return currentUrl; },
      async goto(url) { currentUrl = url; },
      playwright: {
        async domSnapshot() { return "作家中心 章节管理 新建章节"; },
        async waitForTimeout() {},
      },
    };
    const result = await runFanqiePublishJob({browser: {tabs: {async selected() { return tab; }}}, jobPath, confirmation: "PUBLISH batch-test"});
    assert.equal(result.status, "preview");
    assert.equal(currentUrl, "https://fanqienovel.com/main/writer/chapter-manage/7675620772693429273");
  });
});

test("schema v3 publish jobs fail closed without a platform work id", async () => {
  await withJob(async ({ jobPath }) => {
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    job.schema_version = 3;
    await writeFile(jobPath, JSON.stringify(job), "utf8");
    const result = await runFanqiePublishJob({browser: browserWithSnapshot("作家中心 作品管理"), jobPath, confirmation: "PUBLISH batch-test"});
    assert.equal(result.status, "blocked");
    assert.match(result.message, /平台作品 ID/);
  });
});
