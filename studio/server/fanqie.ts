import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { extname } from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";

import { PythonBridge } from "./python.js";
import { StudioStore } from "./store.js";
import type { FanqieAccount, PlatformChapter, PlatformWork, PublishBatchPreview, PublishPlanOptions } from "./types.js";

const WRITER_HOME = "https://fanqienovel.com/main/writer/home";
const WORKS_URL = "https://fanqienovel.com/main/writer/book-manage";
const HUMAN_VERIFICATION = /验证码|图形验证|滑块|人脸|实名|身份认证|安全验证|风控|captcha/i;
const LOGIN_WORDS = /登录|注册|扫码登录|手机号登录/;
const WRITER_WORDS = /作家中心|作家专区|作品管理|书籍管理|章节管理|创作中心|我的作品|创作首页/;
const EMPTY_WORKS = /暂无作品|还没有作品|创建作品|新建作品|开始创作/;
const sessionStatusText = (status: FanqieAccount["sessionStatus"]) => ({logged_in: "上次已登录", auth_required: "上次需要登录", human_action_required: "上次需要人工验证", unknown: "上次状态未知"})[status];

export interface FanqieWriteWindow {
  allowed: boolean;
  timezone: "Asia/Shanghai";
  currentTime: string;
  nextAllowedAt: string | null;
  message: string;
}

/** Fanqie's chapter review window is 07:00—24:00 Beijing time. */
export function fanqieWriteWindow(now = new Date()): FanqieWriteWindow {
  const chinaMillis = now.getTime() + 8 * 60 * 60 * 1000;
  const china = new Date(chinaMillis);
  const hour = china.getUTCHours();
  const allowed = hour >= 7;
  const currentTime = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(now);
  if (allowed) return {allowed: true, timezone: "Asia/Shanghai", currentTime, nextAllowedAt: null, message: "当前处于番茄章节审核工作时间，可提交"};
  const nextAllowedAt = new Date(Date.UTC(china.getUTCFullYear(), china.getUTCMonth(), china.getUTCDate(), 7) - 8 * 60 * 60 * 1000).toISOString();
  return {allowed: false, timezone: "Asia/Shanghai", currentTime, nextAllowedAt, message: "番茄夜间无法修改或删除章节，请于北京时间 07:00 后提交"};
}

function browserExecutable(): string | null {
  const candidates = [
    process.env.TOMOTA_CHROME_PATH,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter((item): item is string => Boolean(item));
  return candidates.find(existsSync) || null;
}

function isOfficialUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === "fanqienovel.com" || host.endsWith(".fanqienovel.com");
  } catch {
    return false;
  }
}

function assertSafeText(text: string): void {
  if (HUMAN_VERIFICATION.test(text)) throw Object.assign(new Error("页面要求验证码、风控、实名或安全验证；已保留现场，请人工处理"), { code: "human_action_required" });
}

export interface FanqieSession {
  status: "logged_in" | "auth_required" | "human_action_required" | "unknown";
  writerUrl: string;
  writerName: string;
  visibleWorks: PlatformWork[];
  checkedAt: string;
  message: string;
  accountId: string;
  accountLabel: string;
  lastSyncStatus: string;
}

type VisibleAnchor = {href: string; text: string; card: string};
type ChapterRow = {text: string; hrefs: string[]};

const GENERIC_WORK_LABEL = /^(?:点此了解|章节管理|作品管理|书籍管理|我的作品|创建章节|新建章节|作品相关|数据|编辑|查看|详情|更多|待审核|审核中|已发布|连载中|已完结|草稿|审核失败)$/;

function cleanWorkTitle(value: string): string | null {
  const title = value.replace(/\s+/g, " ").trim().replace(/[·•|｜]+$/, "");
  if (title.length < 2 || title.length > 80 || GENERIC_WORK_LABEL.test(title)) return null;
  if (/签约|福利|收入|创作课堂|作家专区/.test(title)) return null;
  return title;
}

function titleFromRoute(href: string): string | null {
  const match = href.match(/\/chapter-manage\/(\d{10,})&([^?#]+)/);
  if (!match?.[2]) return null;
  try { return cleanWorkTitle(decodeURIComponent(match[2].replace(/\+/g, "%20"))); }
  catch { return null; }
}

function titleFromCard(card: string): string | null {
  const first = card.split(/\r?\n/).map((value) => value.trim()).find(Boolean) || "";
  const beforeMarker = first.split(/\s+(?:征文作品|最近更新|连载中|已完结|待审核|审核中|草稿|\d+\s*章|\d[\d.,万]*\s*字)(?:\s|$)/)[0];
  return cleanWorkTitle(beforeMarker);
}

export function parseVisibleWorks(anchors: VisibleAnchor[], html: string, now = new Date().toISOString()): {works: PlatformWork[]; chapters: PlatformChapter[]} {
  const workMap = new Map<string, PlatformWork>();
  const chapterMap = new Map<string, PlatformChapter>();
  const statusOf = (text: string) => (text.match(/待审核|审核中|已发布|连载中|已完结|草稿|审核失败/) || ["未知"])[0];
  const metricsOf = (text: string) => {
    const metrics: Record<string, string | number> = {};
    for (const [name, pattern] of Object.entries({wordCount: /(?:(?:字数|总字数)\s*([\d.,万]+)|([\d.,万]+)\s*字)/, chapterCount: /(?:(?:章节|章数)\s*(\d+)|(\d+)\s*章)/, readers: /(?:阅读|读者)\s*([\d.,万]+)/})) {
      const match = text.match(pattern); if (match) metrics[name] = match.slice(1).find(Boolean) || "";
    }
    return metrics;
  };
  for (const item of anchors) {
    const workMatch = item.href.match(/\/(?:book-info|chapter-manage)\/(\d{10,})/);
    if (!workMatch) continue;
    const platformId = workMatch[1];
    const title = titleFromRoute(item.href) || cleanWorkTitle(item.text) || titleFromCard(item.card);
    // A route ID by itself is not proof of a visible work. Tooltips such as
    // “点此了解” also contain book-info links and must never become works.
    if (!title) continue;
    const status = statusOf(item.card);
    const prior = workMap.get(platformId);
    if (!prior || titleFromRoute(item.href) || GENERIC_WORK_LABEL.test(prior.title)) {
      workMap.set(platformId, {platformId, title: title.slice(0, 160), url: item.href, status, metrics: metricsOf(item.card), syncedAt: now});
    }
    const chapterMatch = item.card.match(/(?:最近更新[：:]?\s*)?第\s*(\d+)\s*章\s*([^\n]{1,80}?)(?=\s+(?:\d+\s*章|\d[\d.,万]*\s*字|连载中|已完结|待审核|审核中|草稿)|$)/);
    if (chapterMatch && /chapter-manage/.test(item.href)) {
      const chapterId = (item.href.match(/[?&](?:chapterId|itemId)=(\d+)/) || [])[1] || `${platformId}-${chapterMatch[1]}`;
      chapterMap.set(chapterId, {platformId: chapterId, workId: platformId, chapterNumber: Number(chapterMatch[1]), title: chapterMatch[2].trim(), status, scheduledAt: null, contentHash: "", syncedAt: now});
    }
  }
  const jsonPatterns = [
    /"(?:book_id|bookId|book_id_str|bookIdStr)"\s*:\s*"?(\d{10,})"?[\s\S]{0,500}?"(?:book_name|bookName|title)"\s*:\s*"([^"\\]{2,80})"/g,
    /"(?:book_name|bookName|title)"\s*:\s*"([^"\\]{2,80})"[\s\S]{0,500}?"(?:book_id|bookId|book_id_str|bookIdStr)"\s*:\s*"?(\d{10,})"?/g,
  ];
  for (const [index, pattern] of jsonPatterns.entries()) {
    for (const match of html.matchAll(pattern)) {
      const platformId = index === 0 ? match[1] : match[2];
      const title = index === 0 ? match[2] : match[1];
      if (!workMap.has(platformId)) workMap.set(platformId, {platformId, title, url: `https://fanqienovel.com/main/writer/chapter-manage/${platformId}`, status: "未知", metrics: {}, syncedAt: now});
    }
  }
  return {works: [...workMap.values()], chapters: [...chapterMap.values()]};
}

export function parseChapterRows(rows: ChapterRow[], workId: string, now = new Date().toISOString()): PlatformChapter[] {
  const chapters = new Map<string, PlatformChapter>();
  for (const row of rows) {
    const match = row.text.replace(/\s+/g, " ").trim().match(/^第\s*(\d+)\s*章\s+(.+?)\s+([\d,]+)\s+\d+\s+(已发布|审核中|待审核|草稿|审核失败)(?:\s+(.+))?$/);
    if (!match) continue;
    const modify = row.hrefs.find((href) => /\/publish\/\d+\//.test(href));
    const preview = row.hrefs.find((href) => /\/preview\//.test(href));
    const platformId = (modify?.match(/\/publish\/(\d+)\//) || preview?.match(/&(\d+)(?:[/?#]|$)/) || [])[1];
    if (!platformId) continue;
    chapters.set(platformId, {
      platformId,
      workId,
      chapterNumber: Number(match[1]),
      title: match[2].trim(),
      status: match[4],
      wordCount: Number(match[3].replaceAll(",", "")),
      scheduledAt: null,
      contentHash: "",
      syncedAt: now,
    });
  }
  return [...chapters.values()].sort((left, right) => Number(left.chapterNumber || 0) - Number(right.chapterNumber || 0));
}

export class FanqieBrowserService {
  private readonly root: string;
  private readonly store: StudioStore;
  private readonly python: PythonBridge;
  private readonly contexts = new Map<string, BrowserContext>();

  constructor(root: string, store: StudioStore, python: PythonBridge) {
    this.root = resolve(root);
    this.store = store;
    this.python = python;
    if (!this.store.activeFanqieAccount()) {
      this.store.createFanqieAccount("番茄账号 1", this.legacyProfileDirectory(), "legacy");
    }
  }

  availability(): {browserInstalled: boolean; executable: string | null; profileDirectory: string; accountCount: number; credentialAccess: "disabled"} {
    const executable = browserExecutable();
    return { browserInstalled: Boolean(executable), executable, profileDirectory: this.activeAccount().profileDirectory, accountCount: this.store.listFanqieAccounts().length, credentialAccess: "disabled" };
  }

  private legacyProfileDirectory(): string {
    const base = process.env.LOCALAPPDATA || join(this.store.dataDir, "browser-profile");
    return join(base, "TomotaStudio", "fanqie-profile");
  }

  private profilesBase(): string {
    const base = process.env.LOCALAPPDATA || join(this.store.dataDir, "browser-profile");
    return join(base, "TomotaStudio", "fanqie-profiles");
  }

  private activeAccount(): FanqieAccount {
    const account = this.store.activeFanqieAccount();
    if (!account) throw new Error("尚未创建番茄账号");
    return account;
  }

  accounts(): FanqieAccount[] {
    return this.store.listFanqieAccounts().map((account) => ({...account, browserOpen: this.contexts.has(account.id)}));
  }

  createAccount(label: string): FanqieAccount {
    const id = `fq-${createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 10)}`;
    const account = this.store.createFanqieAccount(label || `番茄账号 ${this.accounts().length + 1}`, join(this.profilesBase(), id), id);
    return this.switchAccount(account.id);
  }

  switchAccount(accountId: string): FanqieAccount {
    return this.store.switchFanqieAccount(accountId);
  }

  renameAccount(accountId: string, label: string): FanqieAccount {
    return {...this.store.renameFanqieAccount(accountId, label), browserOpen: this.contexts.has(accountId)};
  }

  async closeAccount(accountId: string): Promise<void> {
    const context = this.contexts.get(accountId);
    if (context) await context.close();
  }

  async archiveAccount(accountId: string, confirmation: string): Promise<FanqieAccount> {
    const expected = `ARCHIVE ${accountId}`;
    if (confirmation !== expected) throw new Error(`确认文本不匹配，需要：${expected}`);
    await this.closeAccount(accountId);
    return this.store.archiveFanqieAccount(accountId);
  }

  private async ensureBrowser(): Promise<BrowserContext> {
    const account = this.activeAccount();
    const existing = this.contexts.get(account.id);
    if (existing) return existing;
    const executablePath = browserExecutable();
    if (!executablePath) throw new Error("未找到 Chrome 或 Edge，无法启动专用可见浏览器");
    const profile = account.profileDirectory;
    await mkdir(profile, { recursive: true });
    const context = await chromium.launchPersistentContext(profile, {
      executablePath,
      headless: false,
      viewport: null,
      args: ["--start-maximized", "--no-first-run", "--no-default-browser-check"],
    });
    this.contexts.set(account.id, context);
    context.once("close", () => { this.contexts.delete(account.id); });
    return context;
  }

  private async selectedPage(create = true): Promise<Page> {
    const context = await this.ensureBrowser();
    const official = context.pages().find((page) => isOfficialUrl(page.url()));
    const page = official || context.pages()[0] || (create ? await context.newPage() : null);
    if (!page) throw new Error("专用浏览器中没有可用页面");
    return page;
  }

  async openLogin(): Promise<FanqieSession> {
    const page = await this.selectedPage();
    if (!isOfficialUrl(page.url())) await page.goto(WRITER_HOME, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", {timeout: 8_000}).catch(() => undefined);
    await page.waitForTimeout(900);
    await page.bringToFront();
    return this.session();
  }

  async session(): Promise<FanqieSession> {
    const account = this.activeAccount();
    if (!this.contexts.get(account.id)) {
      return { status: "unknown", writerUrl: account.writerUrl || WRITER_HOME, writerName: account.writerName, visibleWorks: this.store.listWorks(account.id), checkedAt: new Date().toISOString(), message: account.lastCheckedAt ? `当前专用会话未打开；${sessionStatusText(account.sessionStatus)}，请重新检查` : "这个账号的专用浏览器尚未打开", accountId: account.id, accountLabel: account.label, lastSyncStatus: account.lastSyncStatus };
    }
    const page = await this.selectedPage(false);
    const url = page.url();
    if (!isOfficialUrl(url)) return this.makeSession(account, "unknown", url, "", "当前页面不是番茄官方域名");
    const text = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
    if (HUMAN_VERIFICATION.test(text)) return this.makeSession(account, "human_action_required", url, "", "需要人工完成验证码或安全验证");
    const login = /\/login(?:[/?#]|$)/.test(url) || (LOGIN_WORDS.test(text) && !/\/main\/writer\/(?:home|book|chapter|data)/.test(url));
    const writerRoute = /\/main\/writer\/(?:home|book|chapter|data)/.test(url);
    const loggedIn = !login && writerRoute && (WRITER_WORDS.test(text) || text.trim().length > 40);
    return this.makeSession(account, loggedIn ? "logged_in" : "auth_required", url, this.detectWriterName(text), loggedIn ? "账号已登录" : "请在可见浏览器中扫码或确认登录");
  }

  private makeSession(account: FanqieAccount, status: FanqieSession["status"], writerUrl: string, writerName: string, message: string, lastSyncStatus = account.lastSyncStatus, visibleWorks = this.store.listWorks(account.id)): FanqieSession {
    const checkedAt = new Date().toISOString();
    const result = {status, writerUrl, writerName, visibleWorks, checkedAt, message, accountId: account.id, accountLabel: account.label, lastSyncStatus};
    this.store.updateFanqieAccountSession(account.id, {status, writerName, writerUrl, message, checkedAt});
    return result;
  }

  async sync(bookIds: string[] = []): Promise<{session: FanqieSession; works: PlatformWork[]; chapters: PlatformChapter[]; syncId: string}> {
    const account = this.activeAccount();
    const syncId = this.store.startSync(account.id);
    try {
      const page = await this.selectedPage();
      await page.goto(WRITER_HOME, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(900);
      let session = await this.session();
      if (session.status !== "logged_in") {
        this.store.finishSync(syncId, session.status, 0, 0, session.message);
        this.store.updateFanqieAccountSync(account.id, session.status);
        return {session, works: [], chapters: [], syncId};
      }
      const managementLink = page.locator('a[href*="/main/writer/"]').filter({hasText: /作品管理|我的作品|书籍管理/}).first();
      if (await managementLink.count().catch(() => 0)) await managementLink.click().catch(() => undefined);
      else await page.goto(WORKS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForLoadState("networkidle", {timeout: 8_000}).catch(() => undefined);
      await page.waitForTimeout(900);
      const text = await page.locator("body").innerText({ timeout: 10_000 });
      assertSafeText(text);
      if (/\/login(?:[/?#]|$)/.test(page.url()) || (LOGIN_WORDS.test(text) && !/\/main\/writer\/(?:home|book|chapter|data)/.test(page.url()))) {
        this.store.finishSync(syncId, "auth_required", 0, 0, "登录已失效");
        this.store.updateFanqieAccountSync(account.id, "auth_required");
        return { session: await this.session(), works: [], chapters: [], syncId };
      }
      const anchors = await page.locator('a[href*="/book-info/"],a[href*="/chapter-manage/"]').evaluateAll((nodes) => nodes.map((node) => {
        const anchor = node as HTMLAnchorElement;
        const card = anchor.closest(".home-book-item,.book-item-info,.info-content,[class*=home-book-item],tr,li");
        const clean = (value: string | null | undefined) => String(value || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
        return {href: anchor.href, text: clean(anchor.innerText || anchor.textContent), card: clean((card as HTMLElement | null)?.innerText || card?.textContent)};
      }));
      const parsed = parseVisibleWorks(anchors, await page.content(), new Date().toISOString());
      const chapterDetails: PlatformChapter[] = [];
      for (const work of parsed.works) {
        const targetUrl = isOfficialUrl(work.url) && work.url.includes(work.platformId)
          ? work.url
          : `https://fanqienovel.com/main/writer/chapter-manage/${work.platformId}`;
        await page.goto(targetUrl, {waitUntil: "domcontentloaded", timeout: 30_000});
        await page.waitForLoadState("networkidle", {timeout: 8_000}).catch(() => undefined);
        await page.waitForTimeout(500);
        const chapterText = await page.locator("body").innerText({timeout: 10_000});
        assertSafeText(chapterText);
        if (/\/login(?:[/?#]|$)/.test(page.url()) || !page.url().includes(work.platformId)) continue;
        const rows = await page.locator("tr").evaluateAll((nodes) => nodes.map((node) => {
          const element = node as HTMLElement;
          return {
            text: String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim(),
            hrefs: [...element.querySelectorAll("a[href]")].map((anchor) => (anchor as HTMLAnchorElement).href),
          };
        }));
        chapterDetails.push(...parseChapterRows(rows, work.platformId, new Date().toISOString()));
      }
      const priorWorks = this.store.listWorks(account.id);
      const explicitEmpty = EMPTY_WORKS.test(text);
      const works = parsed.works.length || explicitEmpty ? parsed.works : priorWorks;
      const detailedChapters = chapterDetails.length ? chapterDetails : parsed.chapters;
      const priorChapters = this.store.listChapters(undefined, account.id);
      const priorById = new Map(priorChapters.map((chapter) => [chapter.platformId, chapter]));
      for (const chapter of detailedChapters) chapter.contentHash = priorById.get(chapter.platformId)?.contentHash || chapter.contentHash;
      const chapters = detailedChapters.length || explicitEmpty ? detailedChapters : priorChapters;
      if (parsed.works.length) this.store.upsertWorks(account.id, parsed.works);
      if (chapterDetails.length) {
        for (const work of parsed.works) this.store.replaceWorkChapters(account.id, work.platformId, chapterDetails.filter((chapter) => chapter.workId === work.platformId));
      } else if (parsed.chapters.length) this.store.upsertChapters(account.id, parsed.chapters);
      const recognized = parsed.works.length > 0 || explicitEmpty;
      const syncMessage = recognized ? `已同步 ${works.length} 部作品` : "账号已登录，但当前页面没有暴露可识别的作品列表；已保留上次结果";
      this.store.finishSync(syncId, recognized ? "succeeded" : "ui_changed", works.length, chapters.length, syncMessage);
      this.store.updateFanqieAccountSync(account.id, recognized ? "succeeded" : "ui_changed");
      session = this.makeSession(account, "logged_in", page.url(), this.detectWriterName(text), syncMessage, recognized ? "succeeded" : "ui_changed", works);
      await this.recordSessions(bookIds, { ...session, visibleWorks: works });
      return { session: { ...session, visibleWorks: works }, works, chapters, syncId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.finishSync(syncId, String((error as {code?: string})?.code || "failed"), 0, 0, message);
      this.store.updateFanqieAccountSync(account.id, String((error as {code?: string})?.code || "failed"));
      throw error;
    }
  }

  private async recordSessions(bookIds: string[], session: FanqieSession): Promise<void> {
    for (const bookId of bookIds.filter((item) => /^[A-Za-z0-9_-]+$/.test(item))) {
      const path = join(this.store.dataDir, `fanqie-session-${bookId}-${session.accountId}.json`);
      const artifact = {
        status: session.status,
        writer_url: session.writerUrl,
        writer_name: session.writerName,
        visible_works: session.visibleWorks.map((work) => ({ title: work.title, platform_work_id: work.platformId, status: work.status, metrics: work.metrics })),
        checked_at: session.checkedAt,
        note: "只记录页面可见会话状态，不记录 Cookie、Token、密码、验证码或二维码内容",
      };
      await writeFile(path, JSON.stringify(artifact, null, 2), "utf8");
      await this.python.recordFanqieSession(bookId, path);
    }
  }

  async prepareBatch(bookId: string, chapters: number[], platformWorkId: string, options: PublishPlanOptions = {mode: "scheduled"}): Promise<PublishBatchPreview> {
    if (!/^\d{10,}$/.test(platformWorkId)) throw new Error("请选择当前账号同步到的番茄作品");
    const account = this.activeAccount();
    const platformWork = this.store.listWorks(account.id).find((work) => work.platformId === platformWorkId);
    if (!platformWork) throw new Error("目标作品不属于当前账号的已同步作品，请先重新同步");
    await this.preflightPublish(platformWorkId);
    const mode = options.mode === "immediate" ? "immediate" : "scheduled";
    const args = ["release", "--book-id", bookId, "--chapters", chapters.join(","), "--schedule-mode", mode, "--json"];
    if (mode === "scheduled") {
      const perDay = Math.min(5, Math.max(1, Number(options.chaptersPerDay || 2)));
      const hour = Math.min(23, Math.max(0, Number(options.publishHour ?? 20)));
      args.push("--chapters-per-day", String(perDay), "--publish-hour", String(hour));
      if (options.startAt) args.push("--start-at", String(options.startAt));
    }
    const result = await this.python.run<Record<string, unknown>>(args);
    const batchId = String(result.value.batch_id || "");
    if (!batchId) throw new Error("Tomota 未返回发布批次编号");
    const path = join(this.root, "books", bookId, "publish", `${batchId}.preview.json`);
    const preview = JSON.parse(await readFile(path, "utf8")) as PublishBatchPreview;
    const platformChapters = this.store.listChapters(platformWorkId, account.id);
    preview.chapters = preview.chapters.map((chapter) => {
      const platformChapter = platformChapters.find((item) => item.chapterNumber === chapter.chapter_number);
      return platformChapter ? {
        ...chapter,
        operation: "update" as const,
        scheduled_at: null,
        platform_chapter_id: platformChapter.platformId,
        platform_status: platformChapter.status,
        platform_title: platformChapter.title,
        platform_word_count: platformChapter.wordCount || 0,
      } : {...chapter, operation: "create" as const};
    });
    preview.platform_work_id = platformWorkId;
    preview.platform_work_title = platformWork.title;
    await writeFile(path, JSON.stringify(preview, null, 2), "utf8");
    this.store.setMeta(`fanqie_batch_account:${batchId}`, account.id);
    this.store.setMeta(`fanqie_batch_work:${batchId}`, platformWorkId);
    this.store.setMeta(`fanqie_book_work:${account.id}:${bookId}`, platformWorkId);
    this.store.setMeta(`fanqie_book_pending_batch:${account.id}:${bookId}`, batchId);
    return preview;
  }

  async pendingBatch(bookId: string): Promise<PublishBatchPreview | null> {
    if (!/^[A-Za-z0-9_-]+$/.test(bookId)) throw new Error("作品编号无效");
    const account = this.activeAccount();
    const batchId = this.store.getMeta(`fanqie_book_pending_batch:${account.id}:${bookId}`);
    if (!batchId) return null;
    if (this.store.getMeta(`fanqie_batch_account:${batchId}`) !== account.id) return null;
    const path = join(this.root, "books", bookId, "publish", `${batchId}.preview.json`);
    if (!existsSync(path)) return null;
    const preview = JSON.parse(await readFile(path, "utf8")) as PublishBatchPreview;
    return preview.status === "preview" ? preview : null;
  }

  async preflightPublish(platformWorkId: string): Promise<Record<string, unknown>> {
    if (!/^\d{10,}$/.test(platformWorkId)) throw new Error("请选择当前账号同步到的番茄作品");
    const account = this.activeAccount();
    const work = this.store.listWorks(account.id).find((item) => item.platformId === platformWorkId);
    if (!work) throw new Error("目标作品不属于当前账号的已同步作品，请先重新同步");
    const targetUrl = isOfficialUrl(work.url) && work.url.includes(platformWorkId)
      ? work.url
      : `https://fanqienovel.com/main/writer/chapter-manage/${platformWorkId}`;
    const page = await this.selectedPage();
    await page.goto(targetUrl, {waitUntil: "domcontentloaded", timeout: 30_000});
    await page.waitForLoadState("networkidle", {timeout: 8_000}).catch(() => undefined);
    await page.waitForTimeout(600);
    const text = await page.locator("body").innerText({timeout: 10_000});
    assertSafeText(text);
    if (/\/login(?:[/?#]|$)/.test(page.url()) || (LOGIN_WORDS.test(text) && !WRITER_WORDS.test(text))) {
      throw Object.assign(new Error("番茄登录已失效，请在可见浏览器完成登录后重试"), {code: "auth_required"});
    }
    if (!page.url().includes(platformWorkId) || !WRITER_WORDS.test(text)) {
      throw Object.assign(new Error("未能进入当前批次绑定的作品章节页，请先重新同步"), {code: "ui_mismatch"});
    }
    const createEntry = await this.firstLocator([
      page.getByRole("button", {name: /新建章节|新增章节|创建章节|写新章节/}),
      page.getByRole("link", {name: /新建章节|新增章节|创建章节|写新章节/}),
      page.getByText(/新建章节|新增章节|创建章节|写新章节/),
    ]);
    if (!createEntry) throw Object.assign(new Error("番茄章节页未识别到“新建章节”入口；页面可能已改版，未创建发布批次"), {code: "ui_mismatch"});
    return {status: "ready", platformWorkId, targetUrl: page.url(), message: "登录、目标作品与新建章节入口均已核验"};
  }

  async inspectChapterPage(platformWorkId: string): Promise<Record<string, unknown>> {
    await this.preflightPublish(platformWorkId);
    const page = await this.selectedPage(false);
    const controls = await page.locator("a,button").evaluateAll((nodes) => nodes.map((node) => {
      const element = node as HTMLElement;
      const anchor = node instanceof HTMLAnchorElement ? node : null;
      return {
        tag: element.tagName.toLowerCase(),
        text: String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
        href: anchor?.href || "",
      };
    }).filter((item) => item.text && /章|编辑|修改|发布|草稿|审核/.test(item.text)).slice(0, 120));
    const rows = await page.locator('tr,li,[class*="chapter" i],[class*="catalog" i]').evaluateAll((nodes) => nodes.map((node) => {
      const element = node as HTMLElement;
      return {
        tag: element.tagName.toLowerCase(),
        className: String(element.className || "").slice(0, 160),
        text: String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500),
        hrefs: [...element.querySelectorAll("a[href]")].map((anchor) => (anchor as HTMLAnchorElement).href).slice(0, 8),
      };
    }).filter((item) => item.text && /第?\s*\d+\s*章|编辑|修改|已发布|草稿|审核/.test(item.text)).slice(0, 120));
    return {status: "ready", platformWorkId, url: page.url(), controls, rows};
  }

  async inspectChapterEditor(platformWorkId: string, platformChapterId: string, advance = false): Promise<Record<string, unknown>> {
    if (!/^\d{10,}$/.test(platformWorkId) || !/^\d{10,}$/.test(platformChapterId)) throw new Error("平台作品或章节编号无效");
    const chapter = this.store.listChapters(platformWorkId, this.activeAccount().id).find((item) => item.platformId === platformChapterId);
    if (!chapter) throw new Error("该章节不属于当前账号同步到的目标作品");
    const page = await this.selectedPage();
    const url = `https://fanqienovel.com/main/writer/${platformWorkId}/publish/${platformChapterId}/?enter_from=modifychapter`;
    await page.goto(url, {waitUntil: "domcontentloaded", timeout: 30_000});
    await page.waitForLoadState("networkidle", {timeout: 8_000}).catch(() => undefined);
    await page.waitForTimeout(2_500);
    let text = await page.locator("body").innerText({timeout: 10_000});
    assertSafeText(text);
    if (/\/login(?:[/?#]|$)/.test(page.url()) || !page.url().includes(platformChapterId)) throw Object.assign(new Error("未能进入已绑定章节的修改页"), {code: "auth_required"});
    if (advance) {
      const next = page.getByRole("button", {name: /^下一步$/}).first();
      if (!(await next.count())) throw Object.assign(new Error("修改页未识别到“下一步”按钮"), {code: "ui_mismatch"});
      await next.click();
      await page.waitForTimeout(1_000);
      text = await page.locator("body").innerText({timeout: 10_000});
      assertSafeText(text);
    }
    const fields = await page.locator('input,textarea,[contenteditable="true"]').evaluateAll((nodes) => nodes.map((node) => {
      const element = node as HTMLElement;
      return {
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type") || "",
        name: element.getAttribute("name") || "",
        placeholder: element.getAttribute("placeholder") || "",
        ariaLabel: element.getAttribute("aria-label") || "",
        className: String(element.className || "").slice(0, 180),
        contenteditable: element.getAttribute("contenteditable") || "",
        textLength: String(element.innerText || "").length,
      };
    }).slice(0, 80));
    const buttons = await page.locator("button").evaluateAll((nodes) => nodes.map((node) => String((node as HTMLElement).innerText || node.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 80));
    const frames = page.frames().map((frame) => ({name: frame.name(), url: frame.url()}));
    return {status: "ready", step: advance ? "submit" : "editor", platformWorkId, platformChapterId, url: page.url(), bodyPreview: text.replace(/\s+/g, " ").trim().slice(0, 1400), fields, buttons, frames};
  }

  async prepareWorkWrite(bookId: string, platformWorkId: string, requested: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!/^[A-Za-z0-9_-]+$/.test(bookId) || !/^\d{10,}$/.test(platformWorkId)) throw new Error("作品编号无效");
    const project = (await this.python.project(bookId)).value as {book?: {title?: string; metadata?: Record<string, unknown>}};
    if (!project.book) throw new Error("本地作品不存在");
    const payload: Record<string, unknown> = {};
    const title = String(requested.title ?? project.book.title ?? "").trim();
    const synopsis = String(requested.synopsis ?? project.book.metadata?.synopsis ?? "").trim();
    const tags = Array.isArray(requested.tags) ? requested.tags.map(String).map((item) => item.trim()).filter(Boolean) : String(requested.tags || project.book.metadata?.genre || "").split(/[\/,，]/).map((item) => item.trim()).filter(Boolean);
    if (!title || title.length > 40) throw new Error("作品标题必须为 1—40 个字符");
    if (!synopsis || synopsis.length > 2000) throw new Error("作品简介必须为 1—2000 个字符");
    payload.title = title;
    payload.synopsis = synopsis;
    payload.tags = tags.slice(0, 10);
    const coverPath = String(requested.coverPath || "").trim();
    if (coverPath) {
      const cover = resolve(coverPath);
      const assets = resolve(this.root, "books", bookId, "assets");
      if ((!cover.startsWith(assets + "\\") && !cover.startsWith(assets + "/")) || !existsSync(cover) || ![".png", ".jpg", ".jpeg", ".webp"].includes(extname(cover).toLowerCase())) throw new Error("封面必须是当前作品 assets 目录中的 PNG/JPG/WEBP 文件");
      const bytes = await readFile(cover);
      payload.coverPath = cover;
      payload.coverHash = createHash("sha256").update(bytes).digest("hex");
    }
    const account = this.activeAccount();
    const currentWork = this.store.listWorks(account.id).find((item) => item.platformId === platformWorkId);
    if (!currentWork) throw new Error("目标作品不属于当前账号的已同步作品，请先重新同步");
    const material = JSON.stringify({bookId, platformWorkId, payload});
    const preview = this.store.createWorkWrite(account.id, bookId, platformWorkId, payload, createHash("sha256").update(material).digest("hex"));
    this.store.setMeta(`fanqie_book_work:${account.id}:${bookId}`, platformWorkId);
    return { ...preview, current: currentWork || null, changedFields: ["title", "synopsis", "tags", ...(coverPath ? ["cover"] : [])] };
  }

  async executeWorkWrite(operationId: string, confirmation: string): Promise<Record<string, unknown>> {
    const preview = this.store.getWorkWrite(operationId);
    if (!preview) throw new Error("作品资料写入预览不存在");
    if (preview.status !== "preview") throw new Error(`该写入预览已经处理：${String(preview.status)}`);
    if (preview.accountId !== this.activeAccount().id) throw new Error("当前番茄账号与写入预览不一致，请切回生成预览时的账号");
    if (!this.store.consumeConfirmation("write", operationId, confirmation)) throw new Error(`缺少即时确认：WRITE ${operationId}`);
    const payload = preview.payload as Record<string, unknown>;
    if (payload.coverPath) {
      const bytes = await readFile(String(payload.coverPath));
      if (createHash("sha256").update(bytes).digest("hex") !== payload.coverHash) throw new Error("封面文件在确认后发生变化，已停止写入");
    }
    const page = await this.selectedPage();
    const targetUrl = `https://fanqienovel.com/main/writer/book-info/${String(preview.platformWorkId)}?isEdit=1`;
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const before = await page.locator("body").innerText({ timeout: 10_000 });
    assertSafeText(before);
    if (/\/login(?:\?|$)/.test(page.url()) || (LOGIN_WORDS.test(before) && !WRITER_WORDS.test(before))) throw Object.assign(new Error("登录已失效，请在可见浏览器重新扫码确认"), { code: "auth_required" });
    if (!WRITER_WORDS.test(before)) throw Object.assign(new Error("未识别到番茄作品资料编辑页，未进行填写"), { code: "ui_mismatch" });
    const titleField = await this.firstLocator([page.getByLabel(/作品名称|书名|作品标题/), page.getByPlaceholder(/作品名称|书名|作品标题/), page.locator('input[name*="title" i]')]);
    const synopsisField = await this.firstLocator([page.getByLabel(/作品简介|简介/), page.getByPlaceholder(/作品简介|请输入简介/), page.locator('textarea[name*="intro" i], textarea[name*="desc" i]')]);
    const tagField = Array.isArray(payload.tags) && payload.tags.length ? await this.firstLocator([page.getByLabel(/标签|作品标签/), page.getByPlaceholder(/标签|作品标签/), page.locator('input[name*="tag" i]')]) : null;
    const coverField = payload.coverPath ? await this.firstLocator([page.locator('input[type="file"][accept*="image"]'), page.locator('input[type="file"]')]) : null;
    const saveButton = await this.firstLocator([page.getByRole("button", {name: /保存|提交审核|确认修改/}), page.getByText(/保存|提交审核|确认修改/)]);
    if (!titleField || !synopsisField || (Array.isArray(payload.tags) && payload.tags.length > 0 && !tagField) || (payload.coverPath && !coverField) || !saveButton) throw Object.assign(new Error("作品资料页面字段结构发生变化，未进行填写"), { code: "ui_mismatch" });
    await titleField.fill(String(payload.title));
    await synopsisField.fill(String(payload.synopsis));
    if (tagField) await tagField.fill((payload.tags as string[]).join("，"));
    if (coverField) await coverField.setInputFiles(String(payload.coverPath));
    await saveButton.click();
    await page.waitForTimeout(800);
    const confirmButton = await this.firstLocator([page.getByRole("button", {name: /确认提交|确认修改|确定/})]);
    if (confirmButton) { await confirmButton.click(); await page.waitForTimeout(800); }
    const after = await page.locator("body").innerText({ timeout: 10_000 });
    assertSafeText(after);
    const success = /保存成功|修改成功|提交成功|已提交审核|审核中/.test(after);
    const result = { operationId, platformWorkId: preview.platformWorkId, status: success ? "submitted" : "uncertain", payloadHash: preview.payloadHash, message: success ? "已读到平台成功或审核状态" : "写入后未读到明确成功反馈；请先同步平台状态，不要重复提交" };
    this.store.finishWorkWrite(operationId, String(result.status), result);
    return result;
  }

  confirm(operation: "publish" | "write" | "submit", batchId: string, token: string, chapter?: number, hash?: string): {confirmationId: string; expected: string} {
    const expected = operation === "publish" ? `PUBLISH ${batchId}` : operation === "write" ? `WRITE ${batchId}` : `SUBMIT ${batchId}:${chapter}:${String(hash || "").slice(0, 12)}`;
    if (token !== expected) throw new Error(`确认文本不匹配，需要：${expected}`);
    return { confirmationId: this.store.recordConfirmation(operation, batchId, token), expected };
  }

  async executeBatch(batchId: string, confirmation: string, actionConfirmation: string, chapterConfirmations: Record<string, string>): Promise<Record<string, unknown>> {
    const writeWindow = fanqieWriteWindow();
    if (!writeWindow.allowed) throw Object.assign(new Error(writeWindow.message), {code: "time_window_blocked", writeWindow});
    const accountId = this.store.getMeta(`fanqie_batch_account:${batchId}`);
    if (accountId && accountId !== this.activeAccount().id) throw new Error("当前番茄账号与发布批次不一致，请切回生成批次时的账号");
    const batchSearch = await this.findBatch(batchId);
    const preview = batchSearch.preview;
    const expectedPublish = `PUBLISH ${batchId}`;
    const expectedWrite = `WRITE ${batchId}`;
    if (confirmation !== expectedPublish || actionConfirmation !== expectedWrite) throw new Error("上传确认与当前批次不一致，请重新核对批次");
    const confirmationItems = [
      {operation: "publish", targetId: batchId, token: confirmation},
      {operation: "write", targetId: batchId, token: actionConfirmation},
    ];
    for (const chapter of preview.chapters) {
      const token = chapterConfirmations[String(chapter.chapter_number)] || "";
      const expected = `SUBMIT ${batchId}:${chapter.chapter_number}:${String(chapter.content_fingerprint).slice(0, 12)}`;
      if (token !== expected) throw new Error(`第 ${chapter.chapter_number} 章的上传确认与当前正文不一致，请重新生成预览`);
      confirmationItems.push({operation: "submit", targetId: batchId, token});
    }
    const platformWorkId = this.store.getMeta(`fanqie_batch_work:${batchId}`);
    if (!platformWorkId || !/^\d{10,}$/.test(platformWorkId)) throw new Error("发布批次没有绑定明确的平台作品，已停止");
    const platformWork = this.store.listWorks(this.activeAccount().id).find((work) => work.platformId === platformWorkId);
    if (!platformWork) throw new Error("批次绑定的作品不在当前账号同步结果中，请先重新同步");
    const exported = await this.python.run<{job: string}>(["fanqie", "export", "--batch", batchId, "--confirm", confirmation, "--json"]);
    const jobPath = resolve(String(exported.value.job));
    const publishRoot = resolve(this.root, "books");
    if (!jobPath.startsWith(publishRoot + "\\") && !jobPath.startsWith(publishRoot + "/")) throw new Error("发布任务路径越界，已停止");
    const job = JSON.parse(await readFile(jobPath, "utf8")) as Record<string, unknown>;
    job.schema_version = 3;
    job.platform_work_id = platformWorkId;
    job.writer_url = isOfficialUrl(platformWork.url) && platformWork.url.includes(platformWorkId)
      ? platformWork.url
      : `https://fanqienovel.com/main/writer/chapter-manage/${platformWorkId}`;
    if (!Array.isArray(job.chapters)) throw new Error("发布任务缺少章节内容，已停止");
    job.chapters = (job.chapters as Array<Record<string, unknown>>).map((chapter) => {
      const planned = preview.chapters.find((item) => item.chapter_number === Number(chapter.chapter_number));
      if (!planned) throw new Error(`第 ${String(chapter.chapter_number)} 章不在当前替换预览中`);
      if (planned.operation !== "update" || !planned.platform_chapter_id) return {...chapter, operation: "create"};
      return {
        ...chapter,
        operation: "update",
        scheduled_at: null,
        local_platform_id: planned.platform_chapter_id,
        platform_chapter_id: planned.platform_chapter_id,
        modify_url: `https://fanqienovel.com/main/writer/${platformWorkId}/publish/${planned.platform_chapter_id}/?enter_from=modifychapter`,
      };
    });
    await writeFile(jobPath, JSON.stringify(job, null, 2), "utf8");
    if (!this.store.consumeConfirmations(confirmationItems)) throw new Error("本次一键上传确认已失效，请重新点击上传");
    const page = await this.selectedPage();
    const bridge = this.browserAdapter(page);
    const driverUrl = new URL("../../scripts/fanqie_browser_driver.mjs", import.meta.url);
    const driver = await import(driverUrl.href) as {runFanqiePublishJob: (options: Record<string, unknown>) => Promise<Record<string, unknown>>};
    const result = await driver.runFanqiePublishJob({ browser: bridge, jobPath, confirmation, actionConfirmation, chapterConfirmations, submit: true });
    const resultStatus = String(result.status || "failed");
    if (["submitted", "partial"].includes(resultStatus)) {
      await this.python.run(["fanqie", "reconcile", "--batch", batchId, "--json"], { allowExitCodes: [2] });
    }
    if (resultStatus === "submitted" && this.store.getMeta(`fanqie_book_pending_batch:${this.activeAccount().id}:${preview.book_id}`) === batchId) {
      this.store.deleteMeta(`fanqie_book_pending_batch:${this.activeAccount().id}:${preview.book_id}`);
    }
    return result;
  }

  async reconcile(batchId: string): Promise<Record<string, unknown>> {
    return (await this.python.run<Record<string, unknown>>(["fanqie", "reconcile", "--batch", batchId, "--json"], { allowExitCodes: [2] })).value;
  }

  private async findBatch(batchId: string): Promise<{preview: PublishBatchPreview; path: string}> {
    const projects = (await this.python.listProjects()).value;
    for (const project of projects) {
      const path = join(this.root, "books", project.id, "publish", `${batchId}.preview.json`);
      if (existsSync(path)) return { preview: JSON.parse(await readFile(path, "utf8")) as PublishBatchPreview, path };
    }
    throw new Error("发布批次预览不存在");
  }

  private browserAdapter(page: Page): Record<string, unknown> {
    const wrapPage = (target: Page) => ({
      url: async () => target.url(),
      goto: async (url: string) => { if (!isOfficialUrl(url)) throw new Error("拒绝打开非番茄官方域名"); await target.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }); },
      playwright: {
        domSnapshot: async () => target.locator("body").innerText({ timeout: 10_000 }),
        waitForTimeout: async ({timeoutMs}: {timeoutMs: number}) => target.waitForTimeout(timeoutMs),
        getByText: (text: string | RegExp, options?: {exact?: boolean}) => target.getByText(text, options),
        getByRole: (role: Parameters<Page["getByRole"]>[0], options?: Parameters<Page["getByRole"]>[1]) => target.getByRole(role, options),
        getByLabel: (text: string | RegExp) => target.getByLabel(text),
        getByPlaceholder: (text: string | RegExp) => target.getByPlaceholder(text),
        locator: (selector: string) => target.locator(selector),
      },
    });
    return {
      tabs: {
        selected: async () => wrapPage(page),
        new: async () => wrapPage(await page.context().newPage()),
      },
    };
  }

  private async firstLocator(locators: Locator[]): Promise<Locator | null> {
    for (const locator of locators) {
      try { if (await locator.count()) return locator.first(); } catch { /* fail closed after trying documented alternatives */ }
    }
    return null;
  }

  private detectWriterName(text: string): string {
    const afterNotification = text.match(/消息通知\s+([^\s]{2,20})/);
    const explicit = text.match(/(?:作者|作家)[：:]\s*([^\s]{2,20})/);
    const name = afterNotification?.[1] || explicit?.[1] || "";
    return /^(?:专区|中心|课堂|福利)$/.test(name) ? "" : name;
  }

  private extractMetrics(text: string): Record<string, string | number> {
    const metrics: Record<string, string | number> = {};
    for (const [name, pattern] of Object.entries({ wordCount: /(?:字数|总字数)\s*([\d.,万]+)/, chapterCount: /(?:章节|章数)\s*(\d+)/, readers: /(?:阅读|读者)\s*([\d.,万]+)/ })) {
      const match = text.match(pattern);
      if (match) metrics[name] = match[1];
    }
    return metrics;
  }
}
