/*
 * Fanqie browser bridge.
 *
 * This module is intentionally not a standalone Playwright launcher.  Import
 * it in the Codex Browser session and pass the already-connected `browser`
 * binding to runFanqiePublishJob(). It never reads cookies, local storage,
 * passwords or browser profiles.
 *
 * Example (inside the browser session):
 *   const { runFanqiePublishJob } = await import("C:/path/to/tomota/scripts/fanqie_browser_driver.mjs");
 *   await runFanqiePublishJob({
 *     browser,
 *     jobPath: "C:/path/to/tomota/books/demo/publish/jobs/batch-....json",
 *     confirmation: "PUBLISH batch-....",
 *     submit: true,
 *   });
 */

import { readFile, writeFile } from "node:fs/promises";

const OFFICIAL_HOST = "fanqienovel.com";
const DEFAULT_WRITER_URL = "https://fanqienovel.com/main/writer/book-manage";
const HUMAN_VERIFICATION = /验证码|图形验证|滑块|人脸|实名|身份认证|安全验证|风控|captcha/i;
const LOGIN_WORDS = /登录|注册/;
const WRITER_WORDS = /作家中心|作品管理|书籍管理|新建章节|新增章节|章节管理/;

export async function runFanqiePublishJob({ browser, jobPath, confirmation = "", actionConfirmation = "", chapterConfirmations = {}, submit = false } = {}) {
  const job = JSON.parse(await readFile(jobPath, "utf8"));
  const resultPath = job.result_path || jobPath.replace(/\.json$/i, ".result.json");
  const result = {
    schema_version: 2,
    batch_id: job.batch_id,
    book_id: job.book_id,
    status: "failed",
    chapters: [],
    message: "",
  };

  const finish = async (patch = {}) => {
    Object.assign(result, patch);
    await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");
    return result;
  };

  if (confirmation !== job.confirmation_required) {
    return finish({ status: "blocked", message: `需要一次性批次确认：${job.confirmation_required}` });
  }
  if (!Array.isArray(job.chapters) || !job.batch_id || !job.book_id) {
    return finish({ status: "blocked", message: "发布任务文件结构无效" });
  }
  if (![2, 3].includes(job.schema_version) || job.account_scope !== "works_and_chapter_operations_only") {
    return finish({ status: "blocked", message: "发布任务缺少作品运营范围声明或有效 schema_version" });
  }
  if (job.schema_version >= 3 && !/^\d{10,}$/.test(String(job.platform_work_id || ""))) {
    return finish({ status: "blocked", message: "发布任务没有绑定明确的平台作品 ID" });
  }
  if (!browser) {
    return finish({ status: "blocked", message: "未提供已连接的官方浏览器会话" });
  }

  let tab;
  try {
    tab = await browser.tabs.selected();
    if (!tab) tab = await browser.tabs.new();
    const currentUrl = await tab.url();
    if (!isOfficialUrl(currentUrl)) {
      await tab.goto(job.writer_url || DEFAULT_WRITER_URL);
    }
    let snapshot = await tab.playwright.domSnapshot();
    assertSafePage(snapshot);
    if (isLoginPage(snapshot)) {
      return finish({ status: "auth_required", message: "官方作家后台未登录，请先在本机浏览器手动登录" });
    }
    if (!WRITER_WORDS.test(snapshot)) {
      return finish({ status: "ui_mismatch", message: "未识别到番茄作家后台，已停止并保留浏览器现场" });
    }
    if (submit) {
      const expectedWrite = `WRITE ${job.batch_id}`;
      if (actionConfirmation !== expectedWrite) {
        return finish({ status: "human_action_required", message: `浏览器实际写入前需要即时确认：${expectedWrite}` });
      }
    }

    if (job.schema_version >= 3) {
      const targetUrl = `https://fanqienovel.com/main/writer/chapter-manage/${job.platform_work_id}`;
      await tab.goto(targetUrl);
      await tab.playwright.waitForTimeout({ timeoutMs: 500 });
      snapshot = await tab.playwright.domSnapshot();
      assertSafePage(snapshot);
      const targetCurrentUrl = await tab.url();
      if (!targetCurrentUrl.includes(String(job.platform_work_id)) || isLoginPage(snapshot) || !WRITER_WORDS.test(snapshot)) {
        return finish({ status: isLoginPage(snapshot) ? "auth_required" : "ui_mismatch", message: "未能进入批次绑定的目标作品，未录入任何章节" });
      }
    } else {
      const bookLocator = await firstLocator(tab, [
        tab.playwright.getByText(job.book_title, { exact: true }),
        tab.playwright.getByText(new RegExp(escapeRegExp(job.book_title))),
      ]);
      if (!bookLocator) {
        return finish({ status: "ui_mismatch", message: `未找到作品《${job.book_title}》，未录入任何章节` });
      }
      await bookLocator.click();
      await tab.playwright.waitForTimeout({ timeoutMs: 300 });
      snapshot = await tab.playwright.domSnapshot();
      assertSafePage(snapshot);
    }

    if (!submit) {
      return finish({ status: "preview", message: "已识别登录态和作品；未填写、未保存、未提交" });
    }
    for (const chapter of job.chapters) {
      if (chapter.local_platform_id) {
        result.chapters.push({
          chapter_number: chapter.chapter_number,
          status: "skipped",
          platform_id: chapter.local_platform_id,
          content_fingerprint: chapter.content_fingerprint,
          message: "本地已有平台章节记录，按幂等规则跳过",
        });
        continue;
      }
      const existing = findVisibleChapter(snapshot, chapter);
      if (existing) {
        result.chapters.push({
          chapter_number: chapter.chapter_number,
          status: "already_exists",
          platform_id: existing.platform_id,
          content_fingerprint: chapter.content_fingerprint,
          message: "页面已显示同编号/同标题章节，按幂等规则跳过",
        });
        continue;
      }

      const expectedChapter = `SUBMIT ${job.batch_id}:${chapter.chapter_number}:${String(chapter.content_fingerprint).slice(0, 12)}`;
      if (chapterConfirmations[String(chapter.chapter_number)] !== expectedChapter) {
        return finish({ status: "human_action_required", message: `第 ${chapter.chapter_number} 章提交前需要即时确认：${expectedChapter}` });
      }

      const createButton = await firstLocator(tab, [
        tab.playwright.getByText(/新建章节|新增章节|创建章节|写新章节/),
        tab.playwright.getByRole("button", { name: /新建章节|新增章节|创建章节|写新章节/ }),
      ]);
      if (!createButton) return finish({ status: "ui_mismatch", message: `未找到新建章节入口，第 ${chapter.chapter_number} 章停止` });
      await createButton.click();
      await tab.playwright.waitForTimeout({ timeoutMs: 300 });
      snapshot = await tab.playwright.domSnapshot();
      assertSafePage(snapshot);

      const titleField = await firstLocator(tab, [
        tab.playwright.getByLabel(/章节标题|标题/),
        tab.playwright.getByPlaceholder(/章节标题|请输入标题/),
        tab.playwright.locator('input[name*="title" i]'),
      ]);
      const contentField = await firstLocator(tab, [
        tab.playwright.getByLabel(/正文|章节内容/),
        tab.playwright.getByPlaceholder(/正文|请输入正文|章节内容/),
        tab.playwright.locator('[contenteditable="true"]'),
        tab.playwright.locator("textarea"),
      ]);
      if (!titleField || !contentField) {
        return finish({ status: "ui_mismatch", message: `未能稳定识别第 ${chapter.chapter_number} 章的标题或正文输入框，已停止` });
      }
      await titleField.fill(chapter.title);
      await contentField.fill(chapter.content);

      if (chapter.scheduled_at) {
        const scheduleButton = await firstLocator(tab, [
          tab.playwright.getByText(/定时发布|定时/),
          tab.playwright.getByRole("button", { name: /定时发布|定时/ }),
        ]);
        if (!scheduleButton) return finish({ status: "ui_mismatch", message: `第 ${chapter.chapter_number} 章需要定时，但页面未识别到定时入口` });
        await scheduleButton.click();
        const scheduleField = await firstLocator(tab, [
          tab.playwright.locator('input[type="datetime-local"]'),
          tab.playwright.getByLabel(/发布时间|定时时间/),
          tab.playwright.getByPlaceholder(/发布时间|定时时间/),
        ]);
        if (!scheduleField) return finish({ status: "ui_mismatch", message: `第 ${chapter.chapter_number} 章需要定时，但页面未识别到时间输入框` });
        await scheduleField.fill(toLocalDateTime(chapter.scheduled_at));
      }

      const submitButton = await firstLocator(tab, [
        tab.playwright.getByRole("button", { name: /提交审核|发布|保存并发布/ }),
        tab.playwright.getByText(/提交审核|保存并发布|发布/),
      ]);
      if (!submitButton) return finish({ status: "ui_mismatch", message: `未找到第 ${chapter.chapter_number} 章提交按钮，已停止` });
      await submitButton.click();
      await tab.playwright.waitForTimeout({ timeoutMs: 500 });
      snapshot = await tab.playwright.domSnapshot();
      assertSafePage(snapshot);

      const confirmButton = await firstLocator(tab, [
        tab.playwright.getByRole("button", { name: /确认发布|确认提交|确定/ }),
        tab.playwright.getByText(/确认发布|确认提交/),
      ]);
      if (confirmButton) {
        await confirmButton.click();
        await tab.playwright.waitForTimeout({ timeoutMs: 500 });
        snapshot = await tab.playwright.domSnapshot();
        assertSafePage(snapshot);
      }
      const success = /发布成功|提交成功|审核中|已发布|定时发布成功/.test(snapshot);
      if (!success) {
        return finish({
          status: result.chapters.length ? "partial" : "uncertain",
          message: `第 ${chapter.chapter_number} 章提交后未读到官方成功反馈，未继续下一章`,
          chapters: result.chapters.concat([{ chapter_number: chapter.chapter_number, status: "uncertain", content_fingerprint: chapter.content_fingerprint }]),
        });
      }
      result.chapters.push({
        chapter_number: chapter.chapter_number,
        status: chapter.scheduled_at ? "scheduled" : "submitted",
        content_fingerprint: chapter.content_fingerprint,
        scheduled_at: chapter.scheduled_at,
        message: "已读到官方成功反馈",
      });
    }

    const hasFailure = result.chapters.some((item) => !["submitted", "scheduled", "already_exists", "skipped"].includes(item.status));
    return finish({ status: hasFailure ? "partial" : "submitted", message: "批次逐章处理完成" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error?.code || "ui_mismatch";
    return finish({ status: code, message });
  }
}

function isOfficialUrl(value) {
  if (!value) return false;
  try {
    return new URL(value).hostname === OFFICIAL_HOST || new URL(value).hostname.endsWith(`.${OFFICIAL_HOST}`);
  } catch {
    return false;
  }
}

function isLoginPage(snapshot) {
  return LOGIN_WORDS.test(snapshot) && !WRITER_WORDS.test(snapshot);
}

function assertSafePage(snapshot) {
  if (HUMAN_VERIFICATION.test(snapshot)) {
    const error = new Error("页面要求验证码、实名、人脸认证或安全验证，已停止；请人工处理后重新运行");
    error.code = "human_action_required";
    throw error;
  }
}

async function firstLocator(tab, locators) {
  for (const locator of locators) {
    try {
      if ((await locator.count()) > 0) return locator.first();
    } catch {
      // A selector that is not supported by the current page is not a reason
      // to guess; try the next documented locator and fail closed if none fit.
    }
  }
  return null;
}

function findVisibleChapter(snapshot, chapter) {
  const title = escapeRegExp(chapter.title);
  const number = escapeRegExp(String(chapter.chapter_number));
  const marker = new RegExp(`(?:第\\s*${number}\\s*章|\\b${number}\\b)[\\s\\S]{0,80}${title}|${title}[\\s\\S]{0,80}(?:第\\s*${number}\\s*章|\\b${number}\\b)`);
  return marker.test(snapshot) ? { platform_id: undefined } : null;
}

function escapeRegExp(value) {
  const special = new Set([".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);
  return Array.from(String(value), (char) => special.has(char) ? "\\" + char : char).join("");
}

function toLocalDateTime(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value).replace("T", " ").slice(0, 16);
  const pad = (number) => String(number).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}
