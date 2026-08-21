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
      const configuredUrl = String(job.writer_url || "");
      const targetUrl = isOfficialUrl(configuredUrl) && configuredUrl.includes(String(job.platform_work_id))
        ? configuredUrl
        : `https://fanqienovel.com/main/writer/chapter-manage/${job.platform_work_id}`;
      await tab.goto(targetUrl);
      await tab.playwright.waitForTimeout({ timeoutMs: 1_500 });
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
      const updating = chapter.operation === "update";
      // Return to the bound work's chapter list before every chapter.  Fanqie
      // may leave the browser on an editor or success page after submission;
      // relying on that incidental state breaks the second chapter in a batch.
      if (job.schema_version >= 3) {
        const configuredUrl = String(job.writer_url || "");
        const targetUrl = isOfficialUrl(configuredUrl) && configuredUrl.includes(String(job.platform_work_id))
          ? configuredUrl
          : `https://fanqienovel.com/main/writer/chapter-manage/${job.platform_work_id}`;
        if ((await tab.url()) !== targetUrl) {
          await tab.goto(targetUrl);
          await tab.playwright.waitForTimeout({ timeoutMs: 1_500 });
          snapshot = await tab.playwright.domSnapshot();
          assertSafePage(snapshot);
        }
      }
      if (chapter.local_platform_id && !updating) {
        result.chapters.push({
          chapter_number: chapter.chapter_number,
          status: "skipped",
          platform_id: chapter.local_platform_id,
          content_fingerprint: chapter.content_fingerprint,
          source_fingerprint: chapter.source_fingerprint,
          message: "本地已有平台章节记录，按幂等规则跳过",
        });
        continue;
      }
      const existing = !updating && findVisibleChapter(snapshot, chapter);
      if (existing) {
        result.chapters.push({
          chapter_number: chapter.chapter_number,
          status: "already_exists",
          platform_id: existing.platform_id,
          content_fingerprint: chapter.content_fingerprint,
          source_fingerprint: chapter.source_fingerprint,
          message: "页面已显示同编号/同标题章节，按幂等规则跳过",
        });
        continue;
      }

      const expectedChapter = `SUBMIT ${job.batch_id}:${chapter.chapter_number}:${String(chapter.content_fingerprint).slice(0, 12)}`;
      if (chapterConfirmations[String(chapter.chapter_number)] !== expectedChapter) {
        return finish({ status: "human_action_required", message: `第 ${chapter.chapter_number} 章提交前需要即时确认：${expectedChapter}` });
      }

      if (updating) {
        const modifyUrl = String(chapter.modify_url || "");
        if (!/^\d{10,}$/.test(String(chapter.platform_chapter_id || "")) || !isOfficialUrl(modifyUrl) || !modifyUrl.includes(String(job.platform_work_id)) || !modifyUrl.includes(String(chapter.platform_chapter_id))) {
          return finish({status: "blocked", message: `第 ${chapter.chapter_number} 章缺少受绑定的平台修改地址`});
        }
        await tab.goto(modifyUrl);
        // The chapter editor is hydrated after the document load event.  On
        // the real writer site the shell can be visible for more than 500 ms
        // before the title input and ProseMirror body are mounted.
        await tab.playwright.waitForTimeout({timeoutMs: 2_500});
        snapshot = await tab.playwright.domSnapshot();
        assertSafePage(snapshot);
        if (!(await tab.url()).includes(String(chapter.platform_chapter_id)) || isLoginPage(snapshot)) {
          return finish({status: isLoginPage(snapshot) ? "auth_required" : "ui_mismatch", message: `未能进入第 ${chapter.chapter_number} 章的修改页`});
        }
      } else {
        const createButton = await firstLocator(tab, [
          tab.playwright.getByText(/新建章节|新增章节|创建章节|写新章节/),
          tab.playwright.getByRole("button", { name: /新建章节|新增章节|创建章节|写新章节/ }),
        ]);
        if (!createButton) return finish({ status: "ui_mismatch", message: `未找到新建章节入口，第 ${chapter.chapter_number} 章停止` });
        await createButton.click();
        await tab.playwright.waitForTimeout({ timeoutMs: 1_500 });
        snapshot = await tab.playwright.domSnapshot();
        assertSafePage(snapshot);
      }

      const titleLocators = [
        tab.playwright.getByLabel(/章节标题|标题/),
        tab.playwright.getByPlaceholder(/章节标题|请输入标题/),
        tab.playwright.locator('input[placeholder="请输入标题"]'),
        tab.playwright.locator('input[name*="title" i]'),
      ];
      const contentLocators = [
        tab.playwright.getByLabel(/正文|章节内容/),
        tab.playwright.getByPlaceholder(/正文|请输入正文|章节内容/),
        tab.playwright.locator('.ProseMirror[contenteditable="true"]'),
        tab.playwright.locator('[contenteditable="true"]'),
        tab.playwright.locator("textarea"),
      ];
      let titleField = null;
      let contentField = null;
      // Network/cache state makes the editor mount time variable.  Poll the
      // documented fields instead of treating one early lookup as a schema
      // change; the loop remains read-only and bounded.
      for (let attempt = 0; attempt < 20 && (!titleField || !contentField); attempt += 1) {
        titleField ||= await firstLocator(tab, titleLocators);
        contentField ||= await firstLocator(tab, contentLocators);
        if (!titleField || !contentField) await tab.playwright.waitForTimeout({timeoutMs: 500});
      }
      if (!titleField || !contentField) {
        return finish({ status: "ui_mismatch", message: `未能稳定识别第 ${chapter.chapter_number} 章的标题或正文输入框，已停止` });
      }
      await titleField.fill(chapter.title);
      await contentField.fill(chapter.content);

      // The current Fanqie editor uses a two-step flow: editing first, then a
      // submission dialog.  Older fixtures/pages may expose submit directly,
      // so the transition remains optional and fail-closed at the final step.
      const nextButton = await firstLocator(tab, [
        tab.playwright.getByRole("button", {name: /^下一步$/}),
        tab.playwright.getByText(/^下一步$/),
      ]);
      if (nextButton) {
        await nextButton.click();
        // The submission pane is lazy-mounted and its button appears after
        // Fanqie's local autosave/validation pass finishes.
        await tab.playwright.waitForTimeout({timeoutMs: 2_500});
        snapshot = await tab.playwright.domSnapshot();
        assertSafePage(snapshot);
      }

      if (chapter.scheduled_at && !updating) {
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
        tab.playwright.getByRole("button", { name: /^(?:提交|提交审核|发布|保存并发布|确认修改|提交修改)$/ }),
        tab.playwright.getByText(/^(?:提交|提交审核|保存并发布|确认修改|提交修改|发布)$/),
      ]);
      if (!submitButton) return finish({ status: "ui_mismatch", message: `未找到第 ${chapter.chapter_number} 章提交按钮，已停止` });
      await submitButton.click();
      await tab.playwright.waitForTimeout({ timeoutMs: 800 });
      snapshot = await tab.playwright.domSnapshot();
      assertSafePage(snapshot);

      const confirmButton = await firstLocator(tab, [
        tab.playwright.getByRole("button", { name: /确认发布|确认提交|确定/ }),
        tab.playwright.getByText(/确认发布|确认提交/),
      ]);
      if (confirmButton) {
        await confirmButton.click();
        await tab.playwright.waitForTimeout({ timeoutMs: 300 });
      }
      // Do not treat the chapter's pre-existing “已发布” badge as proof that
      // this edit was accepted.  Poll for an explicit result of the current
      // submission so a stale page cannot produce a false positive.
      let success = false;
      for (let attempt = 0; attempt < 16; attempt += 1) {
        await tab.playwright.waitForTimeout({timeoutMs: 250});
        snapshot = await tab.playwright.domSnapshot();
        assertSafePage(snapshot);
        if (/发布成功|提交成功|修改成功|修改已提交|已提交审核|审核中|定时发布成功/.test(snapshot)) {
          success = true;
          break;
        }
      }
      if (!success) {
        return finish({
          status: result.chapters.length ? "partial" : "uncertain",
          message: `第 ${chapter.chapter_number} 章提交后未读到官方成功反馈，未继续下一章`,
          chapters: result.chapters.concat([{ chapter_number: chapter.chapter_number, status: "uncertain", content_fingerprint: chapter.content_fingerprint, source_fingerprint: chapter.source_fingerprint, platform_id: chapter.platform_chapter_id }]),
        });
      }
      result.chapters.push({
        chapter_number: chapter.chapter_number,
        status: updating ? "updated" : chapter.scheduled_at ? "scheduled" : "submitted",
        platform_id: updating ? chapter.platform_chapter_id : undefined,
        content_fingerprint: chapter.content_fingerprint,
        source_fingerprint: chapter.source_fingerprint,
        scheduled_at: chapter.scheduled_at,
        message: "已读到官方成功反馈",
      });
    }

    const hasFailure = result.chapters.some((item) => !["submitted", "updated", "scheduled", "already_exists", "skipped"].includes(item.status));
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
      const count = await locator.count();
      for (let index = 0; index < count; index += 1) {
        const candidate = typeof locator.nth === "function" ? locator.nth(index) : locator.first();
        try {
          if (typeof candidate.isVisible === "function" && !(await candidate.isVisible())) continue;
          if (typeof candidate.isEnabled === "function" && !(await candidate.isEnabled())) continue;
        } catch {
          // Lightweight test adapters may not implement visibility checks.
        }
        return candidate;
      }
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
