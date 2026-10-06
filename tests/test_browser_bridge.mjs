import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runFanqiePublishJob, readCompleteChapterDirectory, verifyChapterPublication } from "../scripts/fanqie_browser_driver.mjs";


function directoryFixture(numbers = [], titles = {}, id = null) {
  return {text: numbers.length ? "作家中心 章节管理" : "作家中心 暂无章节", total: numbers.length,
    paginated: false, next: false, nextCount: 0, volume: [], customVolumes: [],
    rows: numbers.map(n => ({text: `第${n}章 ${titles[n] || (n === 1 ? "第一章" : "第二章")} 1000 0 已发布`,
      hrefs: [`https://fanqienovel.com/main/writer/7675620772693429273/publish/${id || "767564106685430223" + n}/?enter_from=modifychapter`]}))};
}

for (const failure of ["lost-click", "wrong-body"]) test(`durable submission evidence survives ${failure} and prevents replay`, async () => {
  await withJob(async ({jobPath, resultPath}) => {
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    Object.assign(job, {schema_version: 3, platform_work_id: "7675620772693429273"});
    job.chapters.push({chapter_number: 2, title: "第二章", content: "后章", content_fingerprint: "hash-two"});
    await writeFile(jobPath, JSON.stringify(job));
    let checkpoints = 0;
    const harness = aiDeclarationBrowser({wrongBody: failure === "wrong-body", onSubmit: async () => {
      const checkpoint = JSON.parse(await readFile(resultPath, "utf8"));
      assert.equal(checkpoint.chapters[0].submission_started, true);
      assert.equal(checkpoint.chapters[0].status, "uncertain");
      assert.equal(checkpoint.chapters[1].status, "not_attempted");
      checkpoints++;
      if (failure === "lost-click") throw new Error("remote accepted, connection lost");
    }});
    const options = {browser: harness.browser, jobPath, confirmation: "PUBLISH batch-test", actionConfirmation: "WRITE batch-test",
      chapterConfirmations: {1: "SUBMIT batch-test:1:hash", 2: "SUBMIT batch-test:2:hash-two"}, submit: true};
    const result = await runFanqiePublishJob(options);
    assert.equal(checkpoints, 1);
    assert.equal(result.status, "uncertain");
    assert.equal(result.chapters[1].status, "not_attempted");
    const before = await readFile(resultPath, "utf8");
    await runFanqiePublishJob(options);
    await runFanqiePublishJob({...options, submit: false});
    assert.equal(await readFile(resultPath, "utf8"), before);
    assert.equal(checkpoints, 1);
  });
});

function pagedDirectory(frames, {repeat = false, volumes = false} = {}) {
  let page = 0;
  let scope = 0;
  const frame = () => ({...frames[scope][page], volume: volumes ? [{index: 0, options: [{value: "1", label: "第一卷"}, {value: "2", label: "第二卷"}]}] : []});
  return {url: async () => "https://fanqienovel.com/main/writer/chapter-manage/7675620772693429273",
    playwright: {waitForTimeout: async () => {}, locator: selector => selector === "body"
      ? fakeLocator({onEvaluateAll: async () => frame()})
      : selector === "select" ? {nth: () => ({selectOption: async value => {scope = Number(value) - 1; page = 0;}})}
      : fakeLocator({onClick: async () => {if (!repeat) page++;}})}};
}

test("directory collection traverses pages and native volumes", async () => {
  const first = {...directoryFixture([1]), total: 2, paginated: true, nextCount: 1, next: true};
  const last = {...directoryFixture([2]), total: 2, paginated: true, nextCount: 1};
  const tab = pagedDirectory([[first, last], [directoryFixture([3], {3: "第三章"})]], {volumes: true});
  assert.deepEqual((await readCompleteChapterDirectory(tab, "7675620772693429273")).map(row => row.chapterNumber), [1, 2, 3]);
});

test("incomplete, repeating, changing and duplicate directories fail closed", async () => {
  const first = {...directoryFixture([1]), total: 2, paginated: true, nextCount: 1, next: true};
  for (const frames of [
    [{...first, next: false}],
    [first, {...directoryFixture([2]), total: 3}],
    [first, {...directoryFixture([1]), total: 2}],
    [{...first, total: null}],
  ]) await assert.rejects(() => readCompleteChapterDirectory(pagedDirectory([frames]), "7675620772693429273"));
  await assert.rejects(() => readCompleteChapterDirectory(pagedDirectory([[first]], {repeat: true}), "7675620772693429273"), /未变化/);
});

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

function fakeLocator({
  count = 1,
  initialText = "",
  onClick = async () => {},
  onFill = async () => {},
  onPress = async () => {},
  onPressSequentially = async () => {},
  onEvaluateAll = async () => "",
  onInnerText,
  isChecked,
} = {}) {
  let text = initialText;
  let selectAll = false;
  return {
    ...(isChecked ? {isChecked} : {}),
    async count() { return count; },
    first() { return this; },
    async click() { await onClick(); },
    async fill(value) { text = String(value); await onFill(value); },
    async press(key) {
      if (key === "Control+A") selectAll = true;
      else if (key === "Backspace" && selectAll) { text = ""; selectAll = false; }
      else if (key === "Enter") text += "\n";
      await onPress(key);
    },
    async pressSequentially(value) { text += String(value); await onPressSequentially(value); },
    async innerText() { return onInnerText ? onInnerText() : text; },
    async inputValue() { return text; },
    async textContent() { return text; },
    async evaluate(callback) { return callback({value: text, innerText: text, textContent: text}); },
    async evaluateAll() { return onEvaluateAll(); },
  };
}

function aiDeclarationBrowser({ canSelectNo = true, directoryReflectsPublish = true, onNoClick, onSubmit, wrongBody = false } = {}) {
  let currentUrl = "https://fanqienovel.com/main/writer/chapter-manage/7675620772693429273";
  let snapshot = "作家中心 章节管理 新建章节";
  let submitClicks = 0;
  let published = false;
  const titleField = fakeLocator();
  const bodyField = fakeLocator();
  const tab = {
    async url() { return currentUrl; },
    async goto(url) {
      currentUrl = url;
      if (wrongBody && /modifychapter/.test(url)) await bodyField.fill("错字");
      snapshot = /enter_from=newchapter/.test(url)
        ? "作家中心 章节标题 正文 下一步 是否使用AI 是 否"
        : published && directoryReflectsPublish ? "作家中心 章节管理 第1章 第一章" : "作家中心 章节管理 新建章节";
    },
    playwright: {
      async domSnapshot() { return snapshot; },
      async waitForTimeout() {},
      getByText(value) {
        const text = String(value);
        if (/新建章节|新增章节|创建章节|写新章节/.test(text)) return fakeLocator({onClick: async () => { currentUrl = "https://fanqienovel.com/main/writer/chapter/edit/new"; snapshot = "作家中心 章节标题 正文 下一步 是否使用AI 是 否"; }});
        if (/下一步/.test(text)) return fakeLocator({onClick: async () => { snapshot = canSelectNo ? "作家中心 是否使用AI 是 否" : "作家中心 是否使用AI 是"; }});
        if (/^否$/.test(text)) return fakeLocator({count: canSelectNo ? 1 : 0, isChecked: async () => snapshot.includes("否 已选"), onClick: async () => { snapshot = "作家中心 是否使用AI 是 否 已选"; onNoClick?.(); }});
        if (/提交审核|保存并发布|发布/.test(text)) return fakeLocator({onClick: async () => { if (/^提交审核|保存并发布|发布$/.test(text)) submitClicks += 1; published = true; snapshot = "作家中心 提交成功"; await onSubmit?.(); }});
        return fakeLocator({count: 0});
      },
      getByRole(role, options = {}) {
        const name = String(options.name || role);
        if (/下一步/.test(name)) return fakeLocator({onClick: async () => { snapshot = canSelectNo ? "作家中心 是否使用AI 是 否" : "作家中心 是否使用AI 是"; }});
        if (/否/.test(name)) return fakeLocator({count: canSelectNo ? 1 : 0, isChecked: async () => snapshot.includes("否 已选"), onClick: async () => { snapshot = "作家中心 是否使用AI 是 否 已选"; onNoClick?.(); }});
        if (/提交审核|保存并发布|发布/.test(name)) return fakeLocator({onClick: async () => { if (role === "button" && name !== "发布") submitClicks += 1; published = true; snapshot = "作家中心 提交成功"; await onSubmit?.(); }});
        return fakeLocator({count: 0});
      },
      getByLabel(value) { return /章节标题|标题|正文|章节内容/.test(String(value)) ? (/标题/.test(String(value)) ? titleField : bodyField) : fakeLocator({count: 0}); },
      getByPlaceholder(value) { return /标题|正文|内容/.test(String(value)) ? (/标题/.test(String(value)) ? titleField : bodyField) : fakeLocator({count: 0}); },
      locator(value) {
        const selector = String(value);
        if (selector === "body") return fakeLocator({onEvaluateAll: async () => directoryFixture(published && directoryReflectsPublish ? [1] : [])});
        if (/role="alert"|role="status"|arco-message|notification|byte-message/.test(selector)) return fakeLocator({onEvaluateAll: async () => /提交成功/.test(snapshot) ? "提交成功" : ""});
        if (/core_chain_long_story_next_confirm|auto-editor-next|publish-header-right/.test(selector)) return fakeLocator({onClick: async () => { snapshot = canSelectNo ? "作家中心 是否使用AI 是 否" : "作家中心 是否使用AI 是"; }});
        return /input|textarea|contenteditable/.test(selector) ? (/contenteditable|textarea/.test(selector) ? bodyField : titleField) : fakeLocator({count: 0});
      },
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
    assert.match(result.message, /尚未读到平台落库证据/);
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
    assert.equal(currentUrl, "https://fanqienovel.com/main/writer/chapter-manage/7675620772693429273");
  });
});

test("multi-chapter results explicitly retain every unattempted chapter", async () => {
  await withJob(async ({jobPath, resultPath}) => {
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    job.chapters.push({chapter_number: 2, title: "第二章", content: "正文二", content_fingerprint: "hash-2"});
    await writeFile(jobPath, JSON.stringify(job), "utf8");
    const result = await runFanqiePublishJob({jobPath, confirmation: "", submit: true});
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.chapters.map((item) => [item.chapter_number, item.status]), [[1, "not_attempted"], [2, "not_attempted"]]);
    assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")).chapters.map((item) => item.chapter_number), [1, 2]);
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
  await withJob(async ({jobPath, resultPath}) => {
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    job.schema_version = 3;
    job.platform_work_id = "7675620772693429273";
    job.writer_url = "https://fanqienovel.com/main/writer/chapter-manage/7675620772693429273&book?type=1";
    job.chapters.push({chapter_number: 2, title: "第二章", content: "正文二", content_fingerprint: "hash-two"});
    await writeFile(jobPath, JSON.stringify(job), "utf8");
    let currentUrl = "https://fanqienovel.com/main/writer/book-manage";
    let snapshot = "作家中心 章节管理 新建章节";
    let creates = 0;
    const chapterNumbers = [];
    const publishedNumbers = new Set();
    let activeChapterNumber = 0;
    const titleField = fakeLocator();
    const bodyField = fakeLocator();
    const tab = {
      async url() { return currentUrl; },
      async goto(url) {
        if (/enter_from=newchapter/.test(url) && creates === 1) {
          const checkpoint = JSON.parse(await readFile(resultPath, "utf8"));
          assert.equal(checkpoint.chapters[0].status, "submitted");
          assert.equal(checkpoint.chapters[0].platform_verification.kind, "chapter_content");
          assert.equal(checkpoint.chapters[1].status, "not_attempted");
        }
        currentUrl = url;
        if (/enter_from=newchapter/.test(url)) { creates += 1; snapshot = "作家中心 章节标题 正文 提交审核"; }
        else snapshot = `作家中心 章节管理 新建章节 ${[...publishedNumbers].map((number) => `第${number}章 ${number === 1 ? "第一章" : "第二章"}`).join(" ")}`;
      },
      playwright: {
        async domSnapshot() { return snapshot; },
        async waitForTimeout() {},
        getByText(value) {
          const text = String(value);
          if (/提交审核|保存并发布|发布/.test(text)) return fakeLocator({onClick: async () => { publishedNumbers.add(activeChapterNumber); snapshot = "作家中心 章节管理 提交成功"; }});
          return fakeLocator({count: 0});
        },
        getByRole(role, options = {}) { return this.getByText(String(options.name || role)); },
        getByLabel(value) { return /章节标题|标题|正文|章节内容/.test(String(value)) ? titleField : fakeLocator({count: 0}); },
        getByPlaceholder(value) { return /标题|正文|内容/.test(String(value)) ? titleField : fakeLocator({count: 0}); },
        locator(value) {
          if (value === "body") return fakeLocator({onEvaluateAll: async () => directoryFixture([...publishedNumbers])});
          if (/contenteditable|textarea/.test(String(value))) return bodyField;
          if (/serial-input:not/.test(String(value))) return fakeLocator({onFill: async (number) => { activeChapterNumber = Number(number); chapterNumbers.push(number); }});
          return /input|textarea|contenteditable/.test(String(value)) ? titleField : fakeLocator({count: 0});
        },
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
    assert.deepEqual(chapterNumbers, ["1", "2"]);
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
          if (/下一步/.test(name)) return fakeLocator({onClick: async () => { snapshot = "作家中心 取消 确认发布"; }});
          // The real 2026 Fanqie update pane labels its final action
          // “确认发布”, not the older generic “提交” button.
          if (/确认发布/.test(name)) return fakeLocator({onClick: async () => { snapshot = "作家中心 修改成功"; }});
          return fakeLocator({count: 0});
        },
        getByText(value) { return this.getByRole("button", {name: value}); },
        getByLabel() { return fakeLocator({count: 0}); },
        getByPlaceholder(value) { return /标题/.test(String(value)) ? fakeLocator({initialText: title, onFill: async (value) => { title = value; }}) : fakeLocator({count: 0}); },
        locator(value) {
          const selector = String(value);
          if (selector === "body") return fakeLocator({onEvaluateAll: async () => directoryFixture([1], {}, "7675641066854302233")});
          if (/role="alert"|role="status"|arco-message|notification|byte-message/.test(selector)) return fakeLocator({onEvaluateAll: async () => /修改成功/.test(snapshot) ? "修改成功" : ""});
          if (/core_chain_long_story_next_confirm|auto-editor-next|publish-header-right/.test(selector)) return fakeLocator({onClick: async () => { snapshot = "作家中心 取消 确认发布"; }});
          return /contenteditable/.test(selector) ? fakeLocator({initialText: content, onPressSequentially: async (value) => { content += value; }}) : fakeLocator({count: 0});
        },
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

test("current Fanqie create flow ignores the onboarding next button and submits from the header", async () => {
  await withJob(async ({jobPath}) => {
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    job.schema_version = 3;
    job.platform_work_id = "7675620772693429273";
    job.writer_url = "https://fanqienovel.com/main/writer/chapter-manage/7675620772693429273&book?type=1";
    job.chapters[0].content = "第一段正文\n\n第二段正文";
    await writeFile(jobPath, JSON.stringify(job), "utf8");
    let currentUrl = job.writer_url;
    let snapshot = "作家中心 章节管理 新建章节";
    const sequence = [];
    const titleField = fakeLocator();
    let headerClicks = 0;
    let published = false;
    let bodyFillCalls = 0;
    let typedBody = "";
    const bodyLocator = fakeLocator({
      onFill: async () => { bodyFillCalls += 1; },
      onPress: async (key) => {
        if (key === "Backspace") typedBody = "";
        else if (key === "Enter") typedBody += "\n";
      },
      onPressSequentially: async (value) => { typedBody += value; },
      onInnerText: () => typedBody,
    });
    const action = (kind, next, onClick) => fakeLocator({isChecked: kind === "ai-no" ? async () => snapshot.includes("否 已选") : undefined, onClick: async () => { sequence.push(kind); onClick?.(); snapshot = next; }});
    const locate = (value) => {
      const name = String(value);
      if (/仅基础检测/.test(name) && /仅基础检测/.test(snapshot)) return action("basic", "作家中心 发布设置 是否使用AI 是 否 定时发布 取消 确认发布");
      if (/\^否\$|不使用|未使用/.test(name) && /是否使用AI/.test(snapshot)) return action("ai-no", "作家中心 发布设置 是否使用AI 是 否 已选 定时发布 取消 确认发布");
      if (/确认发布/.test(name) && /确认发布/.test(snapshot)) return action("confirm-publish", "作家中心 提交成功", () => { published = true; });
      if (/\^提交\$/.test(name) && /发布提示/.test(snapshot)) return action("warning-submit", "作家中心 请选择内容检测方式 全面检测 基础检测（不限次数） 仅基础检测 全面检测");
      return fakeLocator({count: 0});
    };
    const tab = {
      async url() { return currentUrl; },
      async goto(url) {
        currentUrl = url;
        snapshot = /enter_from=newchapter/.test(url)
          ? "作家中心 新手引导 1/3 下一步 章节标题 正文 下一步 番茄审核工作时间是7:00-24:00，夜间发文会卡在审核中状态"
          : published ? "作家中心 章节管理 第1章 第一章" : "作家中心 章节管理 新建章节";
      },
      playwright: {
        async domSnapshot() { return snapshot; },
        async waitForTimeout() {},
        getByRole(_role, options = {}) { return /下一步/.test(String(options.name)) ? action("guide-next", "作家中心 新手引导 2/3 下一步 章节标题 正文 下一步") : locate(options.name); },
        getByText(value) { return locate(value); },
        getByLabel() { return fakeLocator({count: 0}); },
        getByPlaceholder(value) { return /标题/.test(String(value)) ? titleField : fakeLocator({count: 0}); },
        locator(value) {
          const selector = String(value);
          if (selector === "body") return fakeLocator({onEvaluateAll: async () => directoryFixture(published ? [1] : [])});
          if (/role="alert"|role="status"|arco-message|notification|byte-message/.test(selector)) return fakeLocator({onEvaluateAll: async () => /提交成功/.test(snapshot) ? "提交成功" : ""});
          if (/core_chain_long_story_next_confirm|auto-editor-next|publish-header-right/.test(selector)) return fakeLocator({onClick: async () => {
            headerClicks += 1;
            if (headerClicks === 1) {
              sequence.push("header-next-not-ready");
              snapshot = "作家中心 已保存到云端 新手引导 1/3 下一步 章节标题 正文 下一步 番茄审核工作时间是7:00-24:00，夜间发文会卡在审核中状态";
            } else {
              sequence.push("header-next");
              snapshot = "作家中心 发布提示 检测到你还有错别字未修改，是否确定提交？ 取消 提交 番茄审核工作时间是7:00-24:00，夜间发文会卡在审核中状态";
            }
          }});
          if (/contenteditable/.test(selector)) return bodyLocator;
          if (/serial-input:not/.test(selector)) return fakeLocator();
          return fakeLocator({count: 0});
        },
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
    assert.deepEqual(sequence, ["header-next-not-ready", "header-next", "warning-submit", "basic", "ai-no", "confirm-publish"]);
    assert.equal(bodyFillCalls, 0);
    assert.equal(typedBody, "第一段正文\n第二段正文");
    assert.equal(result.chapters[0].ai_usage_value, "no");
  });
});

test("one-click submission declares no AI usage and ignores legacy schedules", async () => {
  await withJob(async ({jobPath}) => {
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    job.schema_version = 3;
    job.platform_work_id = "7675620772693429273";
    job.writer_url = "https://fanqienovel.com/main/writer/chapter-manage/7675620772693429273";
    job.chapters[0].scheduled_at = "2026-08-22T20:00:00+08:00";
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
    assert.equal(result.chapters[0].status, "submitted");
    assert.equal(result.chapters[0].scheduled_at, null);
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

test("a success-looking response is not accepted when the new chapter is absent from the platform directory", async () => {
  await withJob(async ({jobPath}) => {
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    job.schema_version = 3;
    job.platform_work_id = "7675620772693429273";
    job.writer_url = "https://fanqienovel.com/main/writer/chapter-manage/7675620772693429273";
    await writeFile(jobPath, JSON.stringify(job), "utf8");
    const harness = aiDeclarationBrowser({directoryReflectsPublish: false});
    const result = await runFanqiePublishJob({
      browser: harness.browser,
      jobPath,
      confirmation: "PUBLISH batch-test",
      actionConfirmation: "WRITE batch-test",
      chapterConfirmations: {"1": "SUBMIT batch-test:1:hash"},
      submit: true,
    });
    assert.equal(result.status, "uncertain");
    assert.equal(result.chapters[0].status, "uncertain");
    assert.match(result.message, /尚未同时核实/);
  });
});
