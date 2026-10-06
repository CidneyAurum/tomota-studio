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

import { readFile, open, rename } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";

export async function persistPublicationResult(path, result) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try { await handle.writeFile(JSON.stringify(result, null, 2), "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
}

const OFFICIAL_HOST = "fanqienovel.com";
const DEFAULT_WRITER_URL = "https://fanqienovel.com/main/writer/book-manage";
const HUMAN_VERIFICATION = /验证码|图形验证|滑块|人脸|实名|身份认证|安全验证|风控|captcha/i;
const LOGIN_WORDS = /登录|注册/;
const WRITER_WORDS = /作家中心|作品管理|书籍管理|新建章节|新增章节|章节管理/;

function canonicalWorkUrl(platformWorkId) {
  return `https://fanqienovel.com/main/writer/chapter-manage/${String(platformWorkId || "")}`;
}

export async function runFanqiePublishJob({ browser, jobPath, confirmation = "", actionConfirmation = "", chapterConfirmations = {}, submit = false } = {}) {
  const job = JSON.parse(await readFile(jobPath, "utf8"));
  const resultPath = job.result_path || jobPath.replace(/\.json$/i, ".result.json");
  const result = {
    schema_version: job.schema_version >= 3 ? 3 : 2,
    batch_id: job.batch_id,
    book_id: job.book_id,
    status: "failed",
    chapters: [],
    message: "",
  };

  // Never erase evidence from an earlier process, even when a caller retries
  // directly instead of using Studio's recovery screen.
  {
    try {
      const prior = JSON.parse(await readFile(resultPath, "utf8"));
      if (prior.batch_id !== job.batch_id || prior.book_id !== job.book_id || !Array.isArray(prior.chapters)) throw new Error("invalid receipt");
      if (prior.chapters.some(item => item.submission_started || ["uncertain", "submitted", "updated", "already_exists", "skipped"].includes(item.status))) {
        return {...prior, status: "uncertain", message: "批次已有提交证据，必须先核验平台结果，禁止直接重放"};
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error("已有发布回执无法安全读取，禁止覆盖或重放");
    }
  }
  const record = (chapter, patch) => {
    let item = result.chapters.find(item => item.chapter_number === chapter.chapter_number);
    if (!item) {
      item = {chapter_number: chapter.chapter_number, content_fingerprint: chapter.content_fingerprint, source_fingerprint: chapter.source_fingerprint};
      result.chapters.push(item);
    }
    Object.assign(item, patch);
    return item;
  };

  const finish = async (patch = {}) => {
    Object.assign(result, patch);
    if (submit && Array.isArray(job.chapters)) {
      const seen = new Set(result.chapters.map((item) => Number(item.chapter_number)));
      for (const chapter of job.chapters) {
        if (seen.has(Number(chapter.chapter_number))) continue;
        result.chapters.push({
          chapter_number: chapter.chapter_number,
          status: "not_attempted",
          content_fingerprint: chapter.content_fingerprint,
          source_fingerprint: chapter.source_fingerprint,
          platform_id: chapter.platform_chapter_id,
          message: "前序章节尚未获得可靠提交结果，本章未执行",
        });
      }
      const terminal = new Set(["submitted", "updated", "scheduled", "already_exists", "skipped"]);
      const allResolved = result.chapters.length === job.chapters.length && result.chapters.every((item) => terminal.has(String(item.status || "")));
      if (result.status === "submitted" && !allResolved) {
        result.status = result.chapters.some((item) => terminal.has(String(item.status || ""))) ? "partial" : "failed";
        result.message = "批次并未覆盖全部锁定章节，已阻止误报整批成功";
      }
    }
    if (result.chapters.some(item => item.status === "uncertain")) {
      result.status = result.chapters.some(item => ["submitted", "updated"].includes(item.status)) ? "partial" : "uncertain";
    }
    await persistPublicationResult(resultPath, result);
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
      const targetUrl = canonicalWorkUrl(job.platform_work_id);
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
    if (job.schema_version >= 3) {
      const directory = await readCompleteChapterDirectory(tab, job.platform_work_id);
      job.preexisting_platform_ids = directory.map(item => item.platformId);
    }
    // Persist the initial complete coverage before any editor action.
    for (const chapter of job.chapters) record(chapter, {status: "not_attempted", submission_started: false});
    result.status = "partial";
    await persistPublicationResult(resultPath, result);
    for (const chapter of job.chapters) {
      const submissionTrace = [];
      const updating = chapter.operation === "update";
      // Return to the bound work's chapter list before every chapter.  Fanqie
      // may leave the browser on an editor or success page after submission;
      // relying on that incidental state breaks the second chapter in a batch.
      if (job.schema_version >= 3) {
        const targetUrl = canonicalWorkUrl(job.platform_work_id);
        if ((await tab.url()) !== targetUrl) {
          await tab.goto(targetUrl);
          await tab.playwright.waitForTimeout({ timeoutMs: 1_500 });
          snapshot = await tab.playwright.domSnapshot();
          assertSafePage(snapshot);
        }
      }
      if (chapter.local_platform_id && !updating && job.schema_version < 3) {
        record(chapter, {
          chapter_number: chapter.chapter_number,
          status: "skipped",
          platform_id: chapter.local_platform_id,
          content_fingerprint: chapter.content_fingerprint,
          source_fingerprint: chapter.source_fingerprint,
          message: "本地已有平台章节记录，按幂等规则跳过",
        });
        await persistPublicationResult(resultPath, result);
        continue;
      }
      const existing = !updating && (job.schema_version >= 3
        ? (await readCompleteChapterDirectory(tab, job.platform_work_id)).some(item => item.chapterNumber === chapter.chapter_number)
        : findVisibleChapter(snapshot, chapter));
      if (existing) {
        if (job.schema_version >= 3) return finish({status: "blocked", message: `第 ${chapter.chapter_number} 章已存在，不能把他人或旧稿当作本次提交结果`});
        record(chapter, {
          chapter_number: chapter.chapter_number,
          status: "already_exists",
          platform_id: existing.platform_id,
          content_fingerprint: chapter.content_fingerprint,
          source_fingerprint: chapter.source_fingerprint,
          message: "页面已显示同编号/同标题章节，按幂等规则跳过",
        });
        await persistPublicationResult(resultPath, result);
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
        if (job.schema_version >= 3) {
          // The chapter list exposes a stable official create route.
          const createUrl = `https://fanqienovel.com/main/writer/${job.platform_work_id}/publish/?enter_from=newchapter`;
          await tab.goto(createUrl);
        } else {
          const createButton = await firstLocator(tab, [
            tab.playwright.getByRole("link", {name: /新建章节|新增章节|创建章节|写新章节/}),
            tab.playwright.getByRole("button", {name: /新建章节|新增章节|创建章节|写新章节/}),
            tab.playwright.getByText(/新建章节|新增章节|创建章节|写新章节/),
          ]);
          if (!createButton) return finish({status: "ui_mismatch", message: `未找到新建章节入口，第 ${chapter.chapter_number} 章停止`});
          await createButton.click();
        }
        await tab.playwright.waitForTimeout({ timeoutMs: 1_500 });
        snapshot = await tab.playwright.domSnapshot();
        assertSafePage(snapshot);
        if ((job.schema_version >= 3 && !(await tab.url()).includes(`/${job.platform_work_id}/publish/`)) || isLoginPage(snapshot)) {
          return finish({status: isLoginPage(snapshot) ? "auth_required" : "ui_mismatch", message: `未能进入第 ${chapter.chapter_number} 章的新建编辑页`});
        }
      }

      const titleLocators = [
        tab.playwright.getByPlaceholder(/章节标题|请输入标题/),
        tab.playwright.locator('input[placeholder="请输入标题"]'),
        tab.playwright.locator('input.serial-editor-input-hint-area'),
        tab.playwright.locator('input[name*="title" i]'),
        tab.playwright.getByLabel(/章节标题|标题/),
      ];
      const contentLocators = [
        // Fanqie mounts several auxiliary ProseMirror editors (outline and
        // inspiration panels) beside the actual chapter body.  Bind the body
        // through its stable editor container before considering generic
        // accessible fallbacks, otherwise an off-screen helper can receive
        // the chapter text.
        tab.playwright.locator('.serial-editor-content .ProseMirror[contenteditable="true"]'),
        tab.playwright.locator('.serial-editor-container .ProseMirror[contenteditable="true"]'),
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
      if (!updating) {
        const chapterNumberField = await firstLocator(tab, [
          tab.playwright.locator('input.serial-input:not(.serial-editor-input-hint-area)'),
          tab.playwright.locator('input.byte-input-size-default:not([placeholder])'),
        ]);
        if (!chapterNumberField) return finish({status: "ui_mismatch", message: `未识别到新建章节的章序号输入框，第 ${chapter.chapter_number} 章停止`});
        await chapterNumberField.fill(String(chapter.chapter_number));
      }
      await titleField.fill(chapter.title);
      await fillRichChapterContent(tab, contentField, chapter.content, chapter.chapter_number);

      // The editor saves asynchronously after a large body fill.  A click made
      // during that save is silently ignored even though the button remains
      // enabled, so wait for the public save indicator and retry only this
      // pre-submit transition when the editor remains on screen.
      const advance = await advanceEditorToSubmission(tab, chapter, submissionTrace);
      if (advance.status === "ui_mismatch") {
        return finish({status: "ui_mismatch", message: advance.message, chapters: result.chapters, submission_trace: submissionTrace});
      }
      const beforeSubmit = async () => {
        record(chapter, {status: "uncertain", submission_started: true, submission_started_at: new Date().toISOString(),
          platform_id: chapter.platform_chapter_id, preexisting_platform_ids: job.preexisting_platform_ids || [], submission_trace: submissionTrace});
        result.status = "uncertain";
        // Failure to durably record intent must prevent the irreversible click.
        await persistPublicationResult(resultPath, result);
      };
      let submission = await completeSubmissionFlow(tab, chapter, {updating, trace: submissionTrace, beforeSubmit});
      if (submission.status === "success" && submission.feedback) {
        chapter.submission_ack = {kind: "platform_submit_feedback", platform_work_id: job.platform_work_id,
          platform_chapter_id: chapter.platform_chapter_id, chapter_number: chapter.chapter_number,
          content_fingerprint: chapter.content_fingerprint, evidence: submission.feedback, observed_at: new Date().toISOString()};
        record(chapter, {submission_ack: chapter.submission_ack});
        await persistPublicationResult(resultPath, result);
      }
      if (submission.status === "ui_mismatch") {
        return finish({status: "ui_mismatch", message: submission.message, chapters: result.chapters, submission_trace: submissionTrace});
      }
      // Toasts and matching titles are not proof: re-read identity, status,
      // and the complete saved body for both creates and replacements.
      if (job.schema_version >= 3 && ["success", "uncertain"].includes(submission.status)) {
        const verification = await verifyChapterPublication(tab, job, chapter, submissionTrace);
        submission = verification.status === "success"
          ? {...submission, ...verification}
          : {...submission, status: "uncertain", message: verification.message};
      }
      if (submission.status !== "success") {
        record(chapter, {status: "uncertain", submission_trace: submissionTrace});
        return finish({
          status: result.chapters.length ? "partial" : "uncertain",
          message: submission.message || `第 ${chapter.chapter_number} 章提交后未读到官方成功反馈，未继续下一章`,
        });
      }
      record(chapter, {
        chapter_number: chapter.chapter_number,
        status: updating ? "updated" : "submitted",
        platform_id: submission.platform_id || chapter.platform_chapter_id,
        platform_verification: submission.platform_verification,
        content_fingerprint: chapter.content_fingerprint,
        source_fingerprint: chapter.source_fingerprint,
        scheduled_at: null,
        ai_usage_declared: true,
        ai_usage_value: "no",
        ai_declaration: submission.aiDeclaration.status,
        submission_trace: submissionTrace,
        message: submission.message || "已读到官方成功反馈",
      });
      result.status = "partial";
      await persistPublicationResult(resultPath, result);
    }

    const hasFailure = result.chapters.some((item) => !["submitted", "updated", "scheduled", "already_exists", "skipped"].includes(item.status));
    return finish({ status: hasFailure ? "partial" : "submitted", message: "批次逐章处理完成" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error?.code || "ui_mismatch";
    return finish({ status: code, message });
  }
}

function richTextParagraphs(value) {
  return String(value || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function normalizeRichText(value) {
  return richTextParagraphs(value).join("\n");
}

async function fillRichChapterContent(tab, contentField, content, chapterNumber) {
  const paragraphs = richTextParagraphs(content);
  if (!paragraphs.length) {
    throw Object.assign(new Error(`第 ${chapterNumber} 章正文为空，未写入平台`), {code: "blocked"});
  }

  // Playwright's fill() writes a plain string into contenteditable.  Fanqie's
  // ProseMirror integration only commits the first paragraph of a multi-line
  // fill to its document model, even though the browser can briefly paint all
  // of the text.  Enter the document as real paragraph transactions so the
  // public word count, autosave and validation state all see the same body.
  await contentField.click();
  await contentField.press("Control+A");
  await contentField.press("Backspace");
  for (let index = 0; index < paragraphs.length; index += 1) {
    await contentField.pressSequentially(paragraphs[index]);
    if (index < paragraphs.length - 1) await contentField.press("Enter");
  }

  const expected = paragraphs.join("\n");
  let actual = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    actual = normalizeRichText(await contentField.innerText());
    if (actual === expected) return;
    await tab.playwright.waitForTimeout({timeoutMs: 250});
  }

  const expectedLength = expected.replace(/\s/g, "").length;
  const actualLength = actual.replace(/\s/g, "").length;
  throw Object.assign(new Error(
    `第 ${chapterNumber} 章正文写入校验失败：本地 ${expectedLength} 字，番茄编辑器仅识别 ${actualLength} 字；已停止在编辑页，未进入发布`,
  ), {code: "ui_mismatch"});
}

async function locateEditorNext(tab) {
  return firstLocator(tab, [
    // The create editor can show a three-step onboarding tour whose button is
    // also named “下一步”.  These first three locators bind the real header
    // action and exclude the tour's guide-card-footer-btn.
    tab.playwright.locator('button[data-apm-action="core_chain_long_story_next_confirm"]'),
    tab.playwright.locator("button.auto-editor-next"),
    tab.playwright.locator(".publish-header-right button.publish-button"),
  ]);
}

function recordSubmissionTrace(trace, state, action, evidence = "") {
  const previous = trace[trace.length - 1];
  if (previous?.state === state && previous?.action === action && previous?.evidence === evidence) return;
  trace.push({at: new Date().toISOString(), state, action, evidence: String(evidence || "").slice(0, 240)});
}

async function visibleFeedbackText(tab) {
  try {
    return await tab.playwright.locator([
      '[role="alert"]:visible',
      '[role="status"]:visible',
      '.arco-message:visible',
      '.arco-notification:visible',
      '.byte-message:visible',
      '.byte-notification:visible',
    ].join(",")).evaluateAll((nodes) => nodes.map((node) => String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean).join("\n"));
  } catch {
    return "";
  }
}

async function observeSubmissionState(tab, {finalClicked = false} = {}) {
  const snapshot = await tab.playwright.domSnapshot();
  assertSafePage(snapshot);

  // Once the irreversible confirmation has been clicked, a visible platform
  // result outranks stale modal controls.  Fanqie's dialog subtree can remain
  // mounted for a few render frames after the success toast appears.
  if (finalClicked) {
    const feedback = await visibleFeedbackText(tab);
    if (/发布成功|提交成功|修改成功|修改已提交|已提交审核|定时发布成功/.test(feedback)) {
      return {state: "success_feedback", snapshot, control: null, evidence: feedback};
    }
  }

  // Detect the foreground workflow from exact visible actions.  This avoids
  // treating editor copy, help text or an onboarding card as a workflow state.
  const confirmPublish = await firstLocator(tab, [
    tab.playwright.getByRole("button", {name: /^确认发布$/}),
    tab.playwright.getByText(/^确认发布$/),
  ]);
  if (confirmPublish) return {state: "publish_settings", snapshot, control: confirmPublish, evidence: "确认发布"};

  const basicDetection = await firstLocator(tab, [
    tab.playwright.getByRole("button", {name: /^仅基础检测$/}),
    tab.playwright.getByText(/^仅基础检测$/),
  ]);
  if (basicDetection) return {state: "detection_choice", snapshot, control: basicDetection, evidence: "仅基础检测"};

  const warningSubmit = await firstLocator(tab, [
    tab.playwright.getByRole("button", {name: /^提交$/}),
    tab.playwright.getByText(/^提交$/),
  ]);
  if (warningSubmit && /发布提示/.test(snapshot) && /错别字|是否确定提交/.test(snapshot)) {
    return {state: "typo_warning", snapshot, control: warningSubmit, evidence: "发布提示/提交"};
  }

  const editorNext = await locateEditorNext(tab);
  if (editorNext) return {state: "editor", snapshot, control: editorNext, evidence: "右上角下一步"};

  return {state: finalClicked ? "awaiting_platform" : "transitioning", snapshot, control: null, evidence: "未出现可执行前台控件"};
}

async function advanceEditorToSubmission(tab, chapter, trace = []) {
  // Give the ProseMirror autosave debounce a full quiet period.  The header
  // can retain an “已保存” label from the blank/previous draft while the last
  // paragraph transaction is still queued; clicking at that point can open
  // the dialog with a body that has not been durably committed yet.
  await tab.playwright.waitForTimeout({timeoutMs: 2_500});
  let nextButton = null;
  let snapshot = "";
  let sawHeaderNext = false;
  for (let wait = 0; wait < 24; wait += 1) {
    const observation = await observeSubmissionState(tab);
    snapshot = observation.snapshot;
    if (observation.state !== "editor" && observation.state !== "transitioning") {
      recordSubmissionTrace(trace, observation.state, "observed", observation.evidence);
      return {status: "advanced", message: "已进入提交步骤", trace};
    }
    nextButton = observation.state === "editor" ? observation.control : null;
    sawHeaderNext ||= Boolean(nextButton);
    if (nextButton && /已保存到云端|已保存|保存成功/.test(snapshot)) break;
    await tab.playwright.waitForTimeout({timeoutMs: 500});
  }
  if (!nextButton) {
    return /下一步/.test(snapshot)
      ? {status: "ui_mismatch", message: `第 ${chapter.chapter_number} 章只识别到新手引导的“下一步”，没有找到右上角发布按钮；已停止，未点击引导或最终发布`}
      : {status: "not_present", message: "页面未使用两步提交"};
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    // The header is re-rendered during save/validation.  If it disappears,
    // wait for the same stable header selector to return; never fall back to
    // another button merely because it has the same visible text.
    for (let wait = 0; wait < 12 && !nextButton; wait += 1) {
      const observation = await observeSubmissionState(tab);
      snapshot = observation.snapshot;
      if (observation.state !== "editor" && observation.state !== "transitioning") {
        recordSubmissionTrace(trace, observation.state, "observed", observation.evidence);
        return {status: "advanced", message: "已进入提交步骤", trace};
      }
      nextButton = observation.state === "editor" ? observation.control : null;
      if (!nextButton) await tab.playwright.waitForTimeout({timeoutMs: 250});
    }
    if (!nextButton) continue;
    await nextButton.click();
    recordSubmissionTrace(trace, "editor", "click_next", "右上角下一步");
    nextButton = null;
    for (let wait = 0; wait < 8; wait += 1) {
      await tab.playwright.waitForTimeout({timeoutMs: 500});
      const observation = await observeSubmissionState(tab);
      snapshot = observation.snapshot;
      if (observation.state !== "editor" && observation.state !== "transitioning") {
        recordSubmissionTrace(trace, observation.state, "observed", observation.evidence);
        return {status: "advanced", message: "已进入提交步骤", trace};
      }
    }
    // A swallowed pre-save click is safe to retry: this button only opens the
    // review dialogs and is not the final cloud-write confirmation.
  }
  return {status: "ui_mismatch", message: `第 ${chapter.chapter_number} 章正文已写入${sawHeaderNext ? "并识别到右上角按钮" : ""}，但“下一步”连续 3 次未进入发布设置；已停止在编辑页，未点击新手引导或最终发布`};
}

async function completeSubmissionFlow(tab, chapter, {updating = false, trace = [], beforeSubmit = async () => {}} = {}) {
  let aiDeclaration = {status: "not_present", message: "页面未显示 AI 使用声明"};
  let finalClicked = false;
  let lastAction = "";
  let unknownFrames = 0;
  for (let step = 0; step < 80; step += 1) {
    await tab.playwright.waitForTimeout({timeoutMs: step === 0 ? 500 : 350});
    const observation = await observeSubmissionState(tab, {finalClicked});
    recordSubmissionTrace(trace, observation.state, "observed", observation.evidence);

    if (observation.state === "success_feedback") {
      return {status: "success", aiDeclaration, feedback: observation.evidence, message: "已读到当前提交的官方成功反馈", trace};
    }
    if (observation.state === "typo_warning") {
      if (lastAction === "warning_submit") continue;
      await observation.control.click();
      lastAction = "warning_submit";
      recordSubmissionTrace(trace, observation.state, lastAction, "提交错别字提示");
      continue;
    }
    if (observation.state === "detection_choice") {
      if (lastAction === "basic_detection") continue;
      await observation.control.click();
      lastAction = "basic_detection";
      recordSubmissionTrace(trace, observation.state, lastAction, "仅基础检测");
      continue;
    }
    if (observation.state === "publish_settings") {
      if (finalClicked) continue;
      aiDeclaration = await ensureAiUsageDisabled(tab, chapter.chapter_number);
      if (aiDeclaration.status === "ui_mismatch") return {status: "ui_mismatch", aiDeclaration, message: aiDeclaration.message, trace};
      recordSubmissionTrace(trace, observation.state, "declare_ai_no", aiDeclaration.message);
      if (/发布成功|提交成功|修改成功|修改已提交|已提交审核/.test(await visibleFeedbackText(tab))) {
        return {status: "ui_mismatch", aiDeclaration, message: "最终提交前仍存在旧成功提示，无法绑定本次结果，已停止", trace};
      }
      await beforeSubmit();
      finalClicked = true;
      await observation.control.click();
      lastAction = "confirm_publish";
      recordSubmissionTrace(trace, observation.state, lastAction, updating ? "确认修改" : "确认发布");
      continue;
    }
    if (observation.state === "awaiting_platform") {
      unknownFrames = 0;
      continue;
    }
    unknownFrames += 1;
    if (unknownFrames >= 20) return {status: "ui_mismatch", aiDeclaration, message: `第 ${chapter.chapter_number} 章连续多次未识别到可执行的提交步骤；已停止，最后状态：${observation.state}`, trace};
  }
  return {status: finalClicked ? "uncertain" : "ui_mismatch", aiDeclaration, message: finalClicked ? `第 ${chapter.chapter_number} 章确认发布后尚未读到平台落库证据，转入目录核验` : `第 ${chapter.chapter_number} 章未完成发布设置`, trace};
}

const DIRECTORY_NEXT = '.arco-pagination-item-next,.byte-pagination-next,[aria-label="下一页"],[title="下一页"]';

async function directoryFrame(tab, workId) {
  const url = new URL(await tab.url());
  if (url.protocol !== 'https:' || url.hostname !== OFFICIAL_HOST || url.pathname.replace(/\/$/, '') !== `/main/writer/chapter-manage/${workId}`) throw new Error("目录作品身份不匹配");
  const frame = await tab.playwright.locator("body").evaluateAll((nodes) => {
    const root = nodes[0];
    if (!root) return null;
    const visible = node => Boolean(node.getClientRects().length);
    const text = root.innerText || "";
    const totals = [...root.querySelectorAll('.arco-pagination-total,.byte-pagination-total,.ant-pagination-total-text')].filter(visible).map(n => n.textContent || "");
    const totalText = totals.join(" ") || text.match(/共\s*[\d,]+\s*(?:章|条)/)?.[0] || "";
    const totalMatch = totalText.match(/(?:共|总计|total)\s*([\d,]+)/i);
    const next = [...root.querySelectorAll('.arco-pagination-item-next,.byte-pagination-next,[aria-label="下一页"],[title="下一页"]')].filter(visible);
    const selects = [...root.querySelectorAll('select')];
    const volume = selects.map((node, index) => ({index, options: [...node.options].map(o => ({value: o.value, label: o.textContent || ""}))}))
      .filter(item => item.options.some(o => /分卷|第.+卷|默认卷|作品相关/.test(o.label)));
    const customVolumes = [...root.querySelectorAll('.arco-select,[role="combobox"]')].map((node, index) => ({node, index}))
      .filter(({node}) => visible(node) && !node.parentElement?.closest('.arco-select,[role="combobox"]') && /卷/.test((node.textContent || "") + (node.getAttribute('aria-label') || "") + (node.getAttribute('placeholder') || "")))
      .map(({index}) => index);
    return {text, total: totalMatch ? Number(totalMatch[1].replaceAll(',', '')) : null,
      paginated: Boolean(root.querySelector('.arco-pagination,.byte-pagination,.ant-pagination,[aria-label="分页"]')),
      next: next.length === 1 && !next[0].disabled && next[0].getAttribute('aria-disabled') !== 'true' && !/disabled/.test(next[0].className),
      nextCount: next.length, volume, customVolumes,
      rows: [...root.querySelectorAll('tr')].filter(visible).map(node => ({text: (node.innerText || '').replace(/\s+/g, ' ').trim(), hrefs: [...node.querySelectorAll('a[href]')].map(a => a.href)}))};
  });
  if (!frame || !Array.isArray(frame.rows)) throw new Error("无法读取完整章节目录结构");
  assertSafePage(frame.text);
  if (isLoginPage(frame.text)) throw new Error("目录读取时登录已失效");
  return frame;
}

/** Read every page of every supported volume; never replace a cache with a
 * partial list. Unknown filters/pagination or changing totals fail closed.
 * All actions here only change the visible chapter-list filters.
 */
export async function readCompleteChapterDirectory(tab, workId) {
  if (!/^\d{10,}$/.test(String(workId))) throw new Error("目录作品编号无效");
  let frame = await directoryFrame(tab, workId);
  if (frame.volume.length > 1 || frame.customVolumes.length > 1) throw new Error("分卷筛选结构不明确，停止目录同步");
  if (frame.customVolumes.length) {
    await tab.playwright.locator('.arco-select,[role="combobox"]').nth(frame.customVolumes[0]).click();
    const all = tab.playwright.getByRole('option', {name: /^全部分卷$|^全部章节$|^全部卷$/});
    if (await all.count() !== 1) throw new Error("自定义分卷筛选无法切换全部分卷，停止目录同步");
    await all.click();
    await tab.playwright.waitForTimeout({timeoutMs: 500});
    frame = await directoryFrame(tab, workId);
  }
  const volume = frame.volume[0];
  const allVolume = volume?.options.find(o => /^全部分卷$|^全部章节$|^全部卷$/.test(o.label.trim()));
  const scopes = volume ? (allVolume ? [allVolume] : volume.options.filter(o => o.value && !/请选择/.test(o.label))) : [null];
  if (!scopes.length) throw new Error("分卷列表为空，无法证明目录完整");
  const chapters = new Map();
  const numbers = new Set();
  for (const scope of scopes) {
    if (scope) {
      await tab.playwright.locator('select').nth(volume.index).selectOption(scope.value);
      await tab.playwright.waitForTimeout({timeoutMs: 500});
    }
    const seenPages = new Set();
    let expectedTotal;
    let count = 0;
    for (let pageNumber = 0; ; pageNumber++) {
      if (pageNumber >= 500) throw new Error("目录超过安全分页上限");
      frame = await directoryFrame(tab, workId);
      if (frame.paginated && (frame.total === null || frame.nextCount !== 1)) throw new Error("分页缺少总数或明确的下一页控件");
      if (expectedTotal === undefined) expectedTotal = frame.total;
      if (expectedTotal !== frame.total) throw new Error("读取期间章节总数变化，请重新同步");
      const key = JSON.stringify(frame.rows);
      if (seenPages.has(key)) throw new Error("目录分页没有推进，拒绝使用部分结果");
      seenPages.add(key);
      for (const row of frame.rows) {
        if (!/^第\s*\d+\s*章/.test(row.text)) continue;
        const match = row.text.match(/^第\s*(\d+)\s*章\s+(.+?)\s+([\d,]+)\s+\d+\s+(已发布|审核中|待审核|草稿|审核失败)(?:\s+.*)?$/);
        const href = row.hrefs.find(value => {
          try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === OFFICIAL_HOST && new RegExp(`/writer/${workId}/publish/\\d{10,}/`).test(url.pathname); } catch { return false; }
        });
        const id = href?.match(/\/publish\/(\d+)\//)?.[1];
        if (!match || !id) throw new Error("目录有无法解析或缺少绑定 ID 的章节，停止同步");
        const number = Number(match[1]);
        if (chapters.has(id) || numbers.has(number)) throw new Error("目录含重复章节 ID 或章号，停止同步");
        chapters.set(id, {platformId: id, workId: String(workId), chapterNumber: number, title: match[2], wordCount: Number(match[3].replaceAll(',', '')), status: match[4], contentHash: '', scheduledAt: null, syncedAt: new Date().toISOString()});
        numbers.add(number); count++;
      }
      if (!frame.next) {
        if (expectedTotal !== null && expectedTotal !== count) throw new Error(`目录不完整：预期 ${expectedTotal} 章，实际 ${count} 章`);
        if (!count && !/暂无章节|还没有章节|尚未创建章节|创建第一章/.test(frame.text)) throw new Error("空目录缺少明确的无章节提示");
        break;
      }
      await tab.playwright.locator(DIRECTORY_NEXT.split(',').map(selector => `${selector}:visible`).join(',')).click();
      let changed = false;
      for (let wait = 0; wait < 20; wait++) {
        await tab.playwright.waitForTimeout({timeoutMs: 250});
        if (JSON.stringify((await directoryFrame(tab, workId)).rows) !== key) { changed = true; break; }
      }
      if (!changed) throw new Error("点击下一页后目录未变化，停止同步");
    }
  }
  return [...chapters.values()].sort((a, b) => a.chapterNumber - b.chapterNumber);
}

/** The same proof standard is used immediately after a click and after restart. */
export async function verifyChapterPublication(tab, job, chapter, trace = []) {
  const workId = String(job.platform_work_id || '');
  if (chapter.operation === 'update') {
    const ack = chapter.submission_ack;
    if (!ack || ack.kind !== 'platform_submit_feedback' || ack.platform_work_id !== workId
      || ack.platform_chapter_id !== chapter.platform_chapter_id || ack.chapter_number !== chapter.chapter_number
      || ack.content_fingerprint !== chapter.content_fingerprint
      || !/发布成功|提交成功|修改成功|修改已提交|已提交审核/.test(ack.evidence || '')) {
      return {status: 'uncertain', message: '替换章节缺少本次最终提交的成功反馈；编辑器自动保存不等于正式提交，禁止重发'};
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    await tab.goto(`${canonicalWorkUrl(workId)}?_tomota_verify=${Date.now()}-${attempt}`);
    await tab.playwright.waitForTimeout({timeoutMs: 1500});
    const rows = await readCompleteChapterDirectory(tab, workId);
    const remote = rows.find(row => row.chapterNumber === Number(chapter.chapter_number));
    if (!remote || !['已发布', '审核中', '待审核'].includes(remote.status) || remote.title.trim() !== chapter.title.trim()) continue;
    if (chapter.platform_chapter_id && remote.platformId !== chapter.platform_chapter_id) continue;
    if (chapter.operation !== 'update' && (!Array.isArray(job.preexisting_platform_ids) || job.preexisting_platform_ids.includes(remote.platformId))) continue;
    const verification = await verifyUpdatedChapterInEditor(tab, job, {...chapter, platform_chapter_id: remote.platformId,
      modify_url: `https://fanqienovel.com/main/writer/${workId}/publish/${remote.platformId}/?enter_from=modifychapter`}, trace);
    if (verification.status !== 'success') continue;
    return {...verification, platform_id: remote.platformId, platform_verification: {
      kind: 'chapter_content', platform_work_id: workId, platform_chapter_id: remote.platformId,
      chapter_number: chapter.chapter_number, title: remote.title, status: remote.status,
      content_fingerprint: chapter.content_fingerprint,
      submission_ack: chapter.submission_ack,
      normalized_content_hash: createHash('sha256').update(normalizeRichText(chapter.content)).digest('hex'), verified_at: new Date().toISOString(),
    }};
  }
  return {status: 'uncertain', message: `第 ${chapter.chapter_number} 章尚未同时核实远端身份、提交状态及完整正文；不重新提交`};
}

async function verifyUpdatedChapterInEditor(tab, job, chapter, trace = []) {
  const modifyUrl = String(chapter.modify_url || "");
  if (!isOfficialUrl(modifyUrl) || !modifyUrl.includes(String(job.platform_work_id || "")) || !modifyUrl.includes(String(chapter.platform_chapter_id || ""))) {
    return {status: "not_found", message: `第 ${chapter.chapter_number} 章缺少可核验的绑定修改地址`};
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const separator = modifyUrl.includes("?") ? "&" : "?";
    await tab.goto(`${modifyUrl}${separator}_tomota_verify=${Date.now()}-${attempt}`);
    await tab.playwright.waitForTimeout({timeoutMs: attempt === 0 ? 1_800 : 2_200});
    const snapshot = await tab.playwright.domSnapshot();
    assertSafePage(snapshot);
    if (isLoginPage(snapshot)) return {status: "auth_required", message: `第 ${chapter.chapter_number} 章提交后登录态失效，无法回读正文`};
    const titleField = await firstLocator(tab, [
      tab.playwright.getByPlaceholder(/章节标题|请输入标题/),
      tab.playwright.locator('input[placeholder="请输入标题"]'),
      tab.playwright.locator('input.serial-editor-input-hint-area'),
      tab.playwright.locator('input[name*="title" i]'),
    ]);
    const contentField = await firstLocator(tab, [
      tab.playwright.locator('.serial-editor-content .ProseMirror[contenteditable="true"]'),
      tab.playwright.locator('.serial-editor-container .ProseMirror[contenteditable="true"]'),
      tab.playwright.locator('.ProseMirror[contenteditable="true"]'),
      tab.playwright.locator('[contenteditable="true"]'),
      tab.playwright.locator('textarea'),
    ]);
    if (!titleField || !contentField) {
      recordSubmissionTrace(trace, "editor_verify_wait", `attempt_${attempt + 1}`, "正文编辑器尚未挂载");
      continue;
    }
    const title = await titleField.inputValue().catch(async () => String(await titleField.textContent() || ""));
    const content = await contentField.evaluate((node) => "value" in node ? String(node.value || "") : String(node.innerText || node.textContent || ""));
    if (String(title).trim() === String(chapter.title).trim() && normalizeRichText(content) === normalizeRichText(chapter.content)) {
      recordSubmissionTrace(trace, "editor_verified", "exact_content_match", `第 ${chapter.chapter_number} 章标题与正文逐段一致`);
      return {status: "success", message: `已回读第 ${chapter.chapter_number} 章编辑页并确认正文完整写入`};
    }
    recordSubmissionTrace(trace, "editor_verify_wait", `attempt_${attempt + 1}`, "平台回读正文尚未与锁定稿一致");
  }
  return {status: "not_found", message: `第 ${chapter.chapter_number} 章已点击确认修改，但回读正文未与锁定稿完全一致；未记为成功，也未继续下一章`};
}

async function ensureAiUsageDisabled(tab, chapterNumber) {
  const snapshot = await tab.playwright.domSnapshot();
  const declaration = /是否.{0,6}AI|AI.{0,6}(?:辅助|声明|创作|生成)|使用AI|人工智能.{0,6}(?:辅助|声明|创作)|内容.{0,6}AI/i.test(snapshot);
  if (!declaration) return {status: "not_present", message: "页面未显示 AI 使用声明"};

  const negativeLocators = [
    tab.playwright.getByRole("radio", {name: /^否$|^不使用$|^未使用$/}),
    tab.playwright.getByLabel(/^否|^不使用|^未使用|^没有使用/),
    tab.playwright.locator('input[type="radio"][value="no" i], input[type="radio"][value="false" i]'),
    tab.playwright.getByRole("button", {name: /^否|^不使用|^未使用|^没有使用/}),
    tab.playwright.getByText(/^否$/),
    tab.playwright.getByText(/^否(?:$|[\s,，)）])/),
  ];
  let negative = null;
  // The modal text is painted before its custom radio becomes actionable.
  // Poll the same documented controls for a bounded window instead of
  // treating one hydration frame as a changed submission schema.
  for (let attempt = 0; attempt < 12 && !negative; attempt += 1) {
    negative = await firstLocator(tab, negativeLocators);
    if (!negative) await tab.playwright.waitForTimeout({timeoutMs: 250});
  }
  if (!negative) {
    return {
      status: "ui_mismatch",
      message: `第 ${chapterNumber} 章要求声明“是否使用 AI”，但页面未提供可确认的“否”选项，已停止提交`,
    };
  }
  await negative.click();
  await tab.playwright.waitForTimeout({timeoutMs: 300});
  const nextSnapshot = await tab.playwright.domSnapshot();
  if (!await isNegativeChoiceSelected(tab, negative, nextSnapshot)) {
    return {
      status: "ui_mismatch",
      message: `第 ${chapterNumber} 章“是否使用 AI”未能确认已选择“否”，已停止提交`,
    };
  }
  return {status: "declared_no", message: "已确认“是否使用 AI”选择“否”"};
}

export async function isNegativeChoiceSelected(_tab, control, _snapshot) {
  try {
    if (typeof control.isChecked === "function") return await control.isChecked();
  } catch { /* custom labels may not expose isChecked */ }
  try {
    return await control.evaluate((node) => {
      const element = node.closest?.('label,[role="radio"],.arco-radio') || node;
      const input = element.matches?.('input[type="radio"]') ? element : element.querySelector?.('input[type="radio"]');
      if (input) return input.checked === true;
      const checked = element.getAttribute?.('aria-checked');
      if (checked === 'true' || checked === 'false') return checked === 'true';
      return element.getAttribute?.('data-state') === 'checked' || element.classList?.contains('arco-radio-checked') === true;
    });
  } catch { return false; }
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
