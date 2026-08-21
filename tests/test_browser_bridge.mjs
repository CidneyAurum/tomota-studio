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

function aiDeclarationBrowser({ canSelectNo = true, onNoClick } = {}) {
  let currentUrl = "https://fanqienovel.com/main/writer/chapter-manage/7675620772693429273";
  let snapshot = "作家中心 章节管理 新建章节";
  let submitClicks = 0;
  const tab = {
    async url() { return currentUrl; },
    async goto(url) { currentUrl = url; },
    playwright: {
      async domSnapshot() { return snapshot; },
      async waitForTimeout() {},
      getByText(value) {
        const text = String(value);
        if (/新建章节|新增章节|创建章节|写新章节/.test(text)) return fakeLocator({onClick: async () => { currentUrl = "https://fanqienovel.com/main/writer/chapter/edit/new"; snapshot = "作家中心 章节标题 正文 下一步 是否使用AI 是 否"; }});
        if (/下一步/.test(text)) return fakeLocator({onClick: async () => { snapshot = canSelectNo ? "作家中心 是否使用AI 是 否" : "作家中心 是否使用AI 是"; }});
        if (/^否$/.test(text)) return fakeLocator({count: canSelectNo ? 1 : 0, onClick: async () => { snapshot = "作家中心 是否使用AI 是 否 已选"; onNoClick?.(); }});
        if (/提交审核|保存并发布|发布/.test(text)) return fakeLocator({onClick: async () => { if (/^提交审核|保存并发布|发布$/.test(text)) submitClicks += 1; snapshot = "作家中心 提交成功"; }});
        return fakeLocator({count: 0});
      },
      getByRole(role, options = {}) {
        const name = String(options.name || role);
        if (/下一步/.test(name)) return fakeLocator({onClick: async () => { snapshot = canSelectNo ? "作家中心 是否使用AI 是 否" : "作家中心 是否使用AI 是"; }});
        if (/否/.test(name)) return fakeLocator({count: canSelectNo ? 1 : 0, onClick: async () => { snapshot = "作家中心 是否使用AI 是 否 已选"; onNoClick?.(); }});
        if (/提交审核|保存并发布|发布/.test(name)) return fakeLocator({onClick: async () => { if (role === "button" && name !== "发布") submitClicks += 1; snapshot = "作家中心 提交成功"; }});
        return fakeLocator({count: 0});
      },
      getByLabel(value) { return /章节标题|标题|正文|章节内容/.test(String(value)) ? fakeLocator() : fakeLocator({count: 0}); },
      getByPlaceholder(value) { return /标题|正文|内容/.test(String(value)) ? fakeLocator() : fakeLocator({count: 0}); },
      locator(value) { return /input|textarea|contenteditable/.test(String(value)) ? fakeLocator() : fakeLocator({count: 0}); },
    },
  };
  return { browser: {tabs: {async selected() { return tab; }}}, submitClicks: () => submitClicks};
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
    job.writer_url = "https://fanqienovel.com/main/writer/chapter-manage/7675620772693429273&%E6%B5%8B%E8%AF%95%E4%B9%A6?type=1";
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
    assert.equal(currentUrl, job.writer_url);
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

test("schema v3 returns to the bound chapter list between multiple uploads", async () => {
  await withJob(async ({jobPath}) => {
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    job.schema_version = 3;
    job.platform_work_id = "7675620772693429273";
    job.writer_url = "https://fanqienovel.com/main/writer/chapter-manage/7675620772693429273&book?type=1";
    job.chapters.push({chapter_number: 2, title: "第二章", content: "正文二", content_fingerprint: "hash-two"});
    await writeFile(jobPath, JSON.stringify(job), "utf8");
    let currentUrl = "https://fanqienovel.com/main/writer/book-manage";
    let snapshot = "作家中心 章节管理 新建章节";
    let creates = 0;
    const tab = {
      async url() { return currentUrl; },
      async goto(url) { currentUrl = url; snapshot = "作家中心 章节管理 新建章节"; },
      playwright: {
        async domSnapshot() { return snapshot; },
        async waitForTimeout() {},
        getByText(value) {
          const text = String(value);
          if (/新建章节|新增章节|创建章节|写新章节/.test(text)) return fakeLocator({onClick: async () => { creates += 1; currentUrl = `https://fanqienovel.com/main/writer/chapter/edit/${creates}`; snapshot = "作家中心 章节管理 章节标题 正文 提交审核"; }});
          if (/提交审核|保存并发布|发布/.test(text)) return fakeLocator({onClick: async () => { snapshot = "作家中心 章节管理 提交成功"; }});
          return fakeLocator({count: 0});
        },
        getByRole(role, options = {}) { return this.getByText(String(options.name || role)); },
        getByLabel(value) { return /章节标题|标题|正文|章节内容/.test(String(value)) ? fakeLocator() : fakeLocator({count: 0}); },
        getByPlaceholder(value) { return /标题|正文|内容/.test(String(value)) ? fakeLocator() : fakeLocator({count: 0}); },
        locator(value) { return /input|textarea|contenteditable/.test(String(value)) ? fakeLocator() : fakeLocator({count: 0}); },
      },
    };
    const result = await runFanqiePublishJob({
      browser: {tabs: {async selected() { return tab; }}},
      jobPath,
      confirmation: "PUBLISH batch-test",
      actionConfirmation: "WRITE batch-test",
      chapterConfirmations: {"1": "SUBMIT batch-test:1:hash", "2": "SUBMIT batch-test:2:hash-two"},
      submit: true,
    });
    assert.equal(result.status, "submitted");
    assert.equal(result.chapters.length, 2);
    assert.equal(creates, 2);
  });
});

test("schema v3 updates an existing published chapter through the two-step editor", async () => {
  await withJob(async ({jobPath}) => {
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    job.schema_version = 3;
    job.platform_work_id = "7675620772693429273";
    job.writer_url = "https://fanqienovel.com/main/writer/chapter-manage/7675620772693429273&book?type=1";
    job.chapters[0] = {...job.chapters[0], operation: "update", platform_chapter_id: "7675641066854302233", local_platform_id: "7675641066854302233", modify_url: "https://fanqienovel.com/main/writer/7675620772693429273/publish/7675641066854302233/?enter_from=modifychapter", source_fingerprint: "source-hash"};
    await writeFile(jobPath, JSON.stringify(job), "utf8");
    let currentUrl = "https://fanqienovel.com/main/writer/book-manage";
    let snapshot = "作家中心 章节管理 新建章节";
    let title = "";
    let content = "";
    const tab = {
      async url() { return currentUrl; },
      async goto(url) { currentUrl = url; snapshot = url.includes("modifychapter") ? "作家中心 已保存 正文字数 下一步" : "作家中心 章节管理 新建章节"; },
      playwright: {
        async domSnapshot() { return snapshot; },
        async waitForTimeout() {},
        getByRole(role, options = {}) {
          const name = String(options.name || role);
          if (/下一步/.test(name)) return fakeLocator({onClick: async () => { snapshot = "作家中心 取消 提交"; }});
          if (/提交/.test(name)) return fakeLocator({onClick: async () => { snapshot = "作家中心 修改成功"; }});
          return fakeLocator({count: 0});
        },
        getByText(value) { return this.getByRole("button", {name: value}); },
        getByLabel() { return fakeLocator({count: 0}); },
        getByPlaceholder(value) { return /标题/.test(String(value)) ? fakeLocator({onFill: async (value) => { title = value; }}) : fakeLocator({count: 0}); },
        locator(value) { return /contenteditable/.test(String(value)) ? fakeLocator({onFill: async (value) => { content = value; }}) : fakeLocator({count: 0}); },
      },
    };
    const result = await runFanqiePublishJob({
      browser: {tabs: {async selected() { return tab; }}},
      jobPath,
      confirmation: "PUBLISH batch-test",
      actionConfirmation: "WRITE batch-test",
      chapterConfirmations: {"1": "SUBMIT batch-test:1:hash"},
      submit: true,
    });
    assert.equal(result.status, "submitted");
    assert.equal(result.chapters[0].status, "updated");
    assert.equal(result.chapters[0].platform_id, "7675641066854302233");
    assert.equal(title, "第一章");
    assert.equal(content, "正文");
  });
});

test("one-click submission declares no AI usage before submitting", async () => {
  await withJob(async ({jobPath}) => {
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    job.schema_version = 3;
    job.platform_work_id = "7675620772693429273";
    job.writer_url = "https://fanqienovel.com/main/writer/chapter-manage/7675620772693429273";
    await writeFile(jobPath, JSON.stringify(job), "utf8");
    const harness = aiDeclarationBrowser();
    const result = await runFanqiePublishJob({
      browser: harness.browser,
      jobPath,
      confirmation: "PUBLISH batch-test",
      actionConfirmation: "WRITE batch-test",
      chapterConfirmations: {"1": "SUBMIT batch-test:1:hash"},
      submit: true,
    });
    assert.equal(result.status, "submitted");
    assert.equal(result.chapters[0].ai_usage_declared, true);
    assert.equal(result.chapters[0].ai_usage_value, "no");
    assert.ok(harness.submitClicks() >= 1);
  });
});

test("one-click submission stops when the AI declaration cannot select no", async () => {
  await withJob(async ({jobPath}) => {
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    job.schema_version = 3;
    job.platform_work_id = "7675620772693429273";
    job.writer_url = "https://fanqienovel.com/main/writer/chapter-manage/7675620772693429273";
    await writeFile(jobPath, JSON.stringify(job), "utf8");
    const harness = aiDeclarationBrowser({canSelectNo: false});
    const result = await runFanqiePublishJob({
      browser: harness.browser,
      jobPath,
      confirmation: "PUBLISH batch-test",
      actionConfirmation: "WRITE batch-test",
      chapterConfirmations: {"1": "SUBMIT batch-test:1:hash"},
      submit: true,
    });
    assert.equal(result.status, "ui_mismatch");
    assert.match(result.message, /是否使用 AI/);
    assert.equal(harness.submitClicks(), 0);
  });
});
