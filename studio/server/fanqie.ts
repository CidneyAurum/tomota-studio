import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { extname } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";

import { PythonBridge } from "./python.js";
import { StudioStore } from "./store.js";
import type { FanqieAccount, OneClickBatchResolution, PlatformChapter, PlatformWork, PublishBatchPreview, PublishPlanOptions } from "./types.js";

const WRITER_HOME = "https://fanqienovel.com/main/writer/home";
const WORKS_URL = "https://fanqienovel.com/main/writer/book-manage";
const HUMAN_VERIFICATION = /验证码|图形验证|滑块|人脸|实名|身份认证|安全验证|风控|captcha/i;
const LOGIN_WORDS = /登录|注册|扫码登录|手机号登录/;
const WRITER_WORDS = /作家中心|作家专区|作品管理|书籍管理|章节管理|创作中心|我的作品|创作首页/;
const EMPTY_WORKS = /暂无作品|还没有作品|创建作品|新建作品|开始创作/;
const sessionStatusText = (status: FanqieAccount["sessionStatus"]) => ({logged_in: "上次已登录", auth_required: "上次需要登录", human_action_required: "上次需要人工验证", unknown: "上次状态未知"})[status];
const execFileAsync = promisify(execFile);

type BrowserMarker = {schemaVersion: 1; accountId: string; profileDirectory: string; port: number};

export function isBrowserProfileInUseError(error: unknown): boolean {
  return /ProcessSingleton|profile.+(?:in use|正在使用|被占用)|user data directory is already in use|Failed to create a ProcessSingleton/i.test(error instanceof Error ? error.message : String(error));
}

async function profileBrowserProcessIds(profileDirectory: string): Promise<number[]> {
  const target = resolve(profileDirectory).toLowerCase();
  if (process.platform === "win32") {
    const script = [
      "$target = $env:TOMOTA_FANQIE_PROFILE.ToLowerInvariant()",
      "$items = Get-CimInstance Win32_Process | Where-Object {",
      "  $_.Name -match '^(chrome|msedge)\\.exe$' -and $_.CommandLine -and",
      "  $_.CommandLine.ToLowerInvariant().Contains($target) -and $_.CommandLine -notmatch '--type='",
      "} | Select-Object -ExpandProperty ProcessId",
      "@($items) | ConvertTo-Json -Compress",
    ].join("\n");
    const {stdout} = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      env: {...process.env, TOMOTA_FANQIE_PROFILE: target},
      windowsHide: true,
      timeout: 10_000,
    });
    const parsed = JSON.parse(stdout.trim() || "[]") as number | number[];
    return (Array.isArray(parsed) ? parsed : [parsed]).map(Number).filter((value) => Number.isInteger(value) && value > 0);
  }
  const {stdout} = await execFileAsync("ps", ["-eo", "pid=,args="], {encoding: "utf8", timeout: 10_000});
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || !/(?:chrome|chromium|msedge)/i.test(match[2]) || /--type=/.test(match[2]) || !match[2].toLowerCase().includes(target)) return [];
    return [Number(match[1])];
  });
}

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

function canonicalWorkUrl(platformWorkId: string): string {
  if (!/^\d{10,}$/.test(platformWorkId)) throw new Error("番茄作品编号无效");
  return `https://fanqienovel.com/main/writer/chapter-manage/${platformWorkId}`;
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
  private readonly browsers = new Map<string, Browser>();

  constructor(root: string, store: StudioStore, python: PythonBridge) {
    this.root = resolve(root);
    this.store = store;
    this.python = python;
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS fanqie_operation_lock (
      id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, pid INTEGER NOT NULL, operation TEXT NOT NULL)`);
    if (!this.store.activeFanqieAccount()) {
      this.store.createFanqieAccount("番茄账号 1", this.legacyProfileDirectory(), "legacy");
    }
    // Every public workflow that navigates or changes publication state shares
    // one lease. Nested calls reuse it; unrelated requests fail before touching
    // the browser. The DB claim also covers a second Studio process.
    for (const name of ["openLogin", "session", "sync", "prepareBatch", "prepareOrResumeBatch", "preflightPublish",
      "inspectChapterPage", "inspectChapterEditor", "prepareWorkWrite", "executeWorkWrite", "executeBatch",
      "reconcile", "abandonBatch", "closeAccount", "takeoverAccount", "archiveAccount"] as const) {
      const original = (this[name] as Function).bind(this);
      (this as any)[name] = (...args: unknown[]) => this.withBrowserOperation(name, () => original(...args));
    }
  }

  private readonly operationScope = new AsyncLocalStorage<{active: boolean}>();

  private clearDeadBrowserOwner(): void {
    const row = this.store.db.prepare("SELECT token,pid FROM fanqie_operation_lock WHERE id=1").get() as {token: string; pid: number} | undefined;
    if (!row) return;
    try { process.kill(row.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") this.store.db.prepare("DELETE FROM fanqie_operation_lock WHERE id=1 AND token=?").run(row.token);
    }
  }

  private assertBrowserIdle(): void {
    if (this.operationScope.getStore()?.active) return;
    this.clearDeadBrowserOwner();
    if (this.store.db.prepare("SELECT 1 FROM fanqie_operation_lock WHERE id=1").get()) {
      throw Object.assign(new Error("番茄浏览器正在执行其他操作，请结束后重试"), {code: "browser_busy"});
    }
  }

  private async withBrowserOperation<T>(operation: string, action: () => Promise<T>): Promise<T> {
    if (this.operationScope.getStore()?.active) return action();
    this.clearDeadBrowserOwner();
    const token = randomUUID();
    const claimed = this.store.db.prepare("INSERT OR IGNORE INTO fanqie_operation_lock(id,token,pid,operation) VALUES(1,?,?,?)").run(token, process.pid, operation);
    if (!claimed.changes) throw Object.assign(new Error("番茄浏览器正在执行其他操作，请结束后重试"), {code: "browser_busy"});
    const scope = {active: true};
    try { return await this.operationScope.run(scope, action); }
    finally {
      scope.active = false;
      this.store.db.prepare("DELETE FROM fanqie_operation_lock WHERE id=1 AND token=?").run(token);
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
    this.assertBrowserIdle();
    if (this.executingAccount) throw new Error("发布执行中不能创建并切换账号，请等待本次执行结束");
    const id = `fq-${createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 10)}`;
    const account = this.store.createFanqieAccount(label || `番茄账号 ${this.accounts().length + 1}`, join(this.profilesBase(), id), id);
    return this.switchAccount(account.id);
  }

  switchAccount(accountId: string): FanqieAccount {
    this.assertBrowserIdle();
    if (this.executingAccount && accountId !== this.executingAccount) throw new Error("发布执行中不能切换账号，请等待本次执行结束");
    return this.store.switchFanqieAccount(accountId);
  }

  renameAccount(accountId: string, label: string): FanqieAccount {
    return {...this.store.renameFanqieAccount(accountId, label), browserOpen: this.contexts.has(accountId)};
  }

  async closeAccount(accountId: string): Promise<void> {
    if (accountId === this.executingAccount) throw new Error("发布执行中不能关闭账号浏览器");
    const browser = this.browsers.get(accountId);
    if (browser) {
      await browser.close().catch(() => undefined);
      this.browsers.delete(accountId);
      this.contexts.delete(accountId);
      return;
    }
    const context = this.contexts.get(accountId);
    if (context) await context.close();
  }

  async takeoverAccount(accountId: string, confirmation: string): Promise<{status: "ready"; closedProcesses: number[]; session: FanqieSession}> {
    const account = this.store.listFanqieAccounts(true).find((item) => item.id === accountId);
    if (!account || account.archivedAt) throw new Error("番茄账号不存在或已经归档");
    if (account.id !== this.activeAccount().id) throw new Error("请先切换到需要接管的番茄账号");
    const expected = `TAKEOVER ${account.id}`;
    if (confirmation !== expected) throw new Error(`接管确认不匹配，需要：${expected}`);
    await this.closeAccount(account.id);
    const processIds = await profileBrowserProcessIds(account.profileDirectory);
    for (const processId of processIds) {
      try { process.kill(processId); } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== "ESRCH") throw error;
      }
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await profileBrowserProcessIds(account.profileDirectory)).length) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    }
    await this.ensureBrowser();
    return {status: "ready", closedProcesses: processIds, session: await this.session()};
  }

  async archiveAccount(accountId: string, confirmation: string): Promise<FanqieAccount> {
    const expected = `ARCHIVE ${accountId}`;
    if (confirmation !== expected) throw new Error(`确认文本不匹配，需要：${expected}`);
    await this.closeAccount(accountId);
    return this.store.archiveFanqieAccount(accountId);
  }

  private markerPath(account: FanqieAccount): string {
    return join(account.profileDirectory, "tomota-browser.json");
  }

  private deterministicCdpPort(accountId: string, offset = 0): number {
    const seed = Number.parseInt(createHash("sha256").update(accountId).digest("hex").slice(0, 8), 16);
    return 45200 + ((seed + offset) % 700);
  }

  private async readMarker(account: FanqieAccount): Promise<BrowserMarker | null> {
    try {
      const marker = JSON.parse(await readFile(this.markerPath(account), "utf8")) as BrowserMarker;
      if (marker.schemaVersion !== 1 || marker.accountId !== account.id || resolve(marker.profileDirectory) !== resolve(account.profileDirectory) || !Number.isInteger(marker.port)) return null;
      return marker;
    } catch { return null; }
  }

  private async cdpAvailable(port: number): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(700)});
      if (!response.ok) return false;
      const value = await response.json() as {Browser?: string; webSocketDebuggerUrl?: string};
      return /Chrome|Chromium|Edg/i.test(String(value.Browser || "")) && Boolean(value.webSocketDebuggerUrl);
    } catch { return false; }
  }

  private async browserMarker(account: FanqieAccount): Promise<BrowserMarker> {
    const stored = await this.readMarker(account);
    if (stored) return stored;
    let port = this.deterministicCdpPort(account.id);
    for (let offset = 0; offset < 20 && await this.cdpAvailable(port); offset += 1) port = this.deterministicCdpPort(account.id, offset + 1);
    if (await this.cdpAvailable(port)) throw Object.assign(new Error("Tomota 专用浏览器调试端口均被占用，请关闭冲突程序后重试"), {code: "browser_port_conflict"});
    const marker: BrowserMarker = {schemaVersion: 1, accountId: account.id, profileDirectory: resolve(account.profileDirectory), port};
    await writeFile(this.markerPath(account), JSON.stringify(marker, null, 2), "utf8");
    return marker;
  }

  private rememberBrowser(accountId: string, browser: Browser, context: BrowserContext): BrowserContext {
    this.browsers.set(accountId, browser);
    this.contexts.set(accountId, context);
    browser.once("disconnected", () => {
      if (this.browsers.get(accountId) === browser) this.browsers.delete(accountId);
      if (this.contexts.get(accountId) === context) this.contexts.delete(accountId);
    });
    return context;
  }

  private async connectBrowser(account: FanqieAccount, marker: BrowserMarker): Promise<BrowserContext | null> {
    if (!await this.cdpAvailable(marker.port)) return null;
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${marker.port}`);
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => undefined);
      throw new Error("Tomota 专用浏览器没有可用上下文");
    }
    return this.rememberBrowser(account.id, browser, context);
  }

  private async launchBrowser(account: FanqieAccount, marker: BrowserMarker, executablePath: string): Promise<BrowserContext> {
    const child = spawn(executablePath, [
      `--user-data-dir=${account.profileDirectory}`,
      `--remote-debugging-port=${marker.port}`,
      "--remote-debugging-address=127.0.0.1",
      "--start-maximized",
      "--no-first-run",
      "--no-default-browser-check",
      // The dedicated profile may be taken over after an interrupted Studio
      // process.  Chrome's restore bubble can cover the page header for the
      // human observer even though CDP clicks still reach the renderer.
      "--hide-crash-restore-bubble",
      "about:blank",
    ], {stdio: "ignore", windowsHide: false});
    let spawnError: Error | null = null;
    child.once("error", (error) => { spawnError = error; });
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      const connected = await this.connectBrowser(account, marker).catch(() => null);
      if (connected) return connected;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
    const owners = await profileBrowserProcessIds(account.profileDirectory).catch(() => []);
    if (owners.length) {
      throw Object.assign(new Error("番茄专用浏览器正由另一条 Tomota Studio 进程占用；可以接管这个专用会话后继续，不会关闭你的日常 Chrome"), {
        code: "browser_profile_in_use",
        accountId: account.id,
        takeoverConfirmation: `TAKEOVER ${account.id}`,
      });
    }
    throw new Error("Tomota 已启动专用浏览器，但未能建立本机控制连接；请检查 Chrome/Edge 是否被安全软件阻止");
  }

  private async ensureBrowser(): Promise<BrowserContext> {
    const account = this.activeAccount();
    const existing = this.contexts.get(account.id);
    if (existing) return existing;
    const executablePath = browserExecutable();
    if (!executablePath) throw new Error("未找到 Chrome 或 Edge，无法启动专用可见浏览器");
    const profile = account.profileDirectory;
    await mkdir(profile, { recursive: true });
    const marker = await this.browserMarker(account);
    const connected = await this.connectBrowser(account, marker);
    if (connected) return connected;
    const legacyOwners = await profileBrowserProcessIds(account.profileDirectory).catch(() => []);
    if (legacyOwners.length) {
      throw Object.assign(new Error("番茄专用浏览器正由另一条 Tomota Studio 进程占用；可以接管这个专用会话后继续，不会关闭你的日常 Chrome"), {
        code: "browser_profile_in_use", accountId: account.id, takeoverConfirmation: `TAKEOVER ${account.id}`,
      });
    }
    try { return await this.launchBrowser(account, marker, executablePath); }
    catch (error) {
      if (isBrowserProfileInUseError(error)) {
        throw Object.assign(new Error("番茄专用浏览器正由另一条 Tomota Studio 进程占用；可以接管这个专用会话后继续，不会关闭你的日常 Chrome"), {
          code: "browser_profile_in_use", accountId: account.id, takeoverConfirmation: `TAKEOVER ${account.id}`,
        });
      }
      throw error;
    }
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
      const marker = await this.readMarker(account);
      if (marker) await this.connectBrowser(account, marker).catch(() => null);
    }
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
      for (const work of parsed.works) work.url = canonicalWorkUrl(work.platformId);
      const chapterDetails: PlatformChapter[] = [];
      for (const work of parsed.works) {
        const targetUrl = canonicalWorkUrl(work.platformId);
        await page.goto(targetUrl, {waitUntil: "domcontentloaded", timeout: 30_000});
        await page.waitForLoadState("networkidle", {timeout: 8_000}).catch(() => undefined);
        await page.waitForTimeout(500);
        const chapterText = await page.locator("body").innerText({timeout: 10_000});
        assertSafeText(chapterText);
        if (/\/login(?:[/?#]|$)/.test(page.url()) || !page.url().includes(work.platformId)) throw new Error("目录登录或作品身份变化");
        chapterDetails.push(...await this.completeDirectory(page, work.platformId));
      }
      const priorWorks = this.store.listWorks(account.id);
      const explicitEmpty = EMPTY_WORKS.test(text);
      const works = parsed.works.length || explicitEmpty ? parsed.works : priorWorks;
      const detailedChapters = parsed.works.length ? chapterDetails : parsed.chapters;
      const priorChapters = this.store.listChapters(undefined, account.id);
      const priorById = new Map(priorChapters.map((chapter) => [chapter.platformId, chapter]));
      for (const chapter of detailedChapters) chapter.contentHash = priorById.get(chapter.platformId)?.contentHash || chapter.contentHash;
      const chapters = parsed.works.length || detailedChapters.length || explicitEmpty ? detailedChapters : priorChapters;
      if (parsed.works.length) this.store.upsertWorks(account.id, parsed.works);
      if (parsed.works.length) {
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

  async prepareBatch(bookId: string, chapters: number[], platformWorkId: string, _options: PublishPlanOptions = {mode: "immediate"}, now = new Date(), preflighted = false): Promise<PublishBatchPreview> {
    if (!/^\d{10,}$/.test(platformWorkId)) throw new Error("请选择当前账号同步到的番茄作品");
    const account = this.activeAccount();
    const platformWork = this.store.listWorks(account.id).find((work) => work.platformId === platformWorkId);
    if (!platformWork) throw new Error("目标作品不属于当前账号的已同步作品，请先重新同步");
    const writeWindow = fanqieWriteWindow(now);
    if (!writeWindow.allowed) throw Object.assign(new Error(writeWindow.message), {code: "time_window_blocked", writeWindow});
    if (this.store.getMeta(`fanqie_book_pending_batch:${account.id}:${bookId}`)) {
      throw Object.assign(new Error("当前作品已有待确认发布批次；请先完成、同步或重新生成该批次，避免旧批次混入新内容"), {code: "pending_batch_exists"});
    }
    if (!preflighted) await this.preflightPublish(platformWorkId);
    const args = ["release", "--book-id", bookId, "--chapters", chapters.join(","), "--schedule-mode", "immediate", "--json"];
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
      } : {...chapter, operation: "create" as const, scheduled_at: null};
    });
    preview.platform_work_id = platformWorkId;
    preview.platform_work_title = platformWork.title;
    preview.safety = {
      account_id: account.id,
      ai_usage_required: true,
      ai_usage_value: "no",
      create_and_update_paths: preview.chapters.map((chapter) => chapter.operation === "update" ? `update:${chapter.platform_chapter_id}` : `create:${chapter.chapter_number}`),
    };
    await writeFile(path, JSON.stringify(preview, null, 2), "utf8");
    this.store.setMeta(`fanqie_batch_account:${batchId}`, account.id);
    this.store.setMeta(`fanqie_batch_work:${batchId}`, platformWorkId);
    this.store.setMeta(`fanqie_book_work:${account.id}:${bookId}`, platformWorkId);
    this.store.setMeta(`fanqie_book_pending_batch:${account.id}:${bookId}`, batchId);
    this.store.setMeta(`fanqie_batch_intent:${batchId}`, JSON.stringify({bookId, platformWorkId, chapters: [...new Set(chapters)].sort((left, right) => left - right), options: {mode: "immediate"}}));
    return preview;
  }

  private resultPath(preview: PublishBatchPreview): string {
    return join(this.root, "books", preview.book_id, "publish", "jobs", `${preview.batch_id}.result.json`);
  }

  /**
   * Turn a click-time "uncertain" result into durable evidence from the
   * platform directory.  Fanqie's success toast and chapter directory are
   * eventually consistent, so a successful write may become visible only
   * after the browser driver has returned.  We only repair an item when its
   * immutable batch target matches the live directory exactly.
   */
  private async recoverUncertainResultFromPlatform(preview: PublishBatchPreview, platformWorkId: string): Promise<{
    result: Record<string, unknown> | null;
    matched: number[];
    remaining: number[];
    uncertain: number[];
    notAttempted: number[];
  }> {
    const resultPath = this.resultPath(preview);
    const boundAccount = this.store.getMeta(`fanqie_batch_account:${preview.batch_id}`);
    if (boundAccount && boundAccount !== this.activeAccount().id) throw new Error("提交核验必须使用批次绑定账号");
    if (!existsSync(resultPath)) throw new Error("提交记录缺失，无法证明未发送；请先人工核实平台，禁止自动重试");
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    if (result.batch_id !== preview.batch_id || result.book_id !== preview.book_id || !Array.isArray(result.chapters)) throw new Error("提交回执身份或章节结构无效");
    const jobPath = join(this.root, "books", preview.book_id, "publish", "jobs", `${preview.batch_id}.json`);
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    if (job.batch_id !== preview.batch_id || job.book_id !== preview.book_id || job.platform_work_id !== platformWorkId || !Array.isArray(job.chapters)) throw new Error("原始提交任务缺失或身份不符");
    const numbers = new Set<number>();
    for (const item of result.chapters) {
      const planned = preview.chapters.find(ch => ch.chapter_number === item.chapter_number);
      if (!planned || numbers.has(item.chapter_number) || item.content_fingerprint !== planned.content_fingerprint) throw new Error("提交回执章节或指纹不符");
      numbers.add(item.chapter_number);
    }
    for (const planned of preview.chapters) {
      const frozen = job.chapters.find((ch: Record<string, unknown>) => ch.chapter_number === planned.chapter_number);
      if (!frozen || frozen.content_fingerprint !== planned.content_fingerprint || typeof frozen.content !== "string"
        || createHash("sha256").update(frozen.content).digest("hex") !== planned.content_fingerprint
        || frozen.title !== planned.title || (frozen.operation || "create") !== (planned.operation || "create")
        || frozen.platform_chapter_id !== planned.platform_chapter_id) throw new Error("原始提交正文或远端身份与锁定预览不符");
      if (!numbers.has(planned.chapter_number)) result.chapters.push({chapter_number: planned.chapter_number, content_fingerprint: planned.content_fingerprint, status: "uncertain", message: "缺失回执不能证明未发送"});
    }
    const terminal = new Set(["submitted", "updated", "scheduled", "already_exists", "skipped"]);
    const candidates = result.chapters.filter((item: Record<string, any>) =>
      item.status === "uncertain" || (item.submission_started && !terminal.has(item.status)) ||
      (terminal.has(item.status) && (item.platform_verification?.kind !== "chapter_content" ||
        (preview.chapters.find(ch => ch.chapter_number === item.chapter_number)?.operation === "update" && !item.submission_ack))));
    const matched: number[] = [];
    if (candidates.length) {
      await this.preflightPublish(platformWorkId);
      const driver = await this.publicationDriver();
      const bridge = this.browserAdapter(await this.selectedPage()) as any;
      const tab = await bridge.tabs.selected();
      for (const item of candidates) {
        item.status = "uncertain";
        const frozen = job.chapters.find((ch: Record<string, unknown>) => ch.chapter_number === item.chapter_number);
        const proof = await driver.verifyChapterPublication(tab, {...job, preexisting_platform_ids: item.preexisting_platform_ids}, {...frozen, submission_ack: item.submission_ack});
        if (proof.status !== "success") { item.message = proof.message; continue; }
        Object.assign(item, {status: frozen.operation === "update" ? "updated" : "submitted", submission_started: true,
          platform_id: proof.platform_id, platform_verification: proof.platform_verification, message: "远端身份、提交状态和完整正文核验通过"});
        matched.push(item.chapter_number);
        await driver.persistPublicationResult(resultPath, result);
      }
    }
    const remaining = result.chapters.filter((item: any) => !terminal.has(item.status)).map((item: any) => Number(item.chapter_number));
    const uncertain = result.chapters.filter((item: any) => item.status === "uncertain").map((item: any) => Number(item.chapter_number));
    const notAttempted = result.chapters.filter((item: any) => item.status === "not_attempted").map((item: any) => Number(item.chapter_number));
    result.status = remaining.length ? (result.chapters.some((item: any) => terminal.has(item.status)) ? "partial" : uncertain.length ? "uncertain" : "failed") : "submitted";
    await (await this.publicationDriver()).persistPublicationResult(resultPath, result);
    return {result, matched, remaining, uncertain, notAttempted};
  }

  private async publicationDriver(): Promise<any> {
    return import(new URL("../../scripts/fanqie_browser_driver.mjs", import.meta.url).href);
  }

  private async completeDirectory(page: Page, workId: string): Promise<PlatformChapter[]> {
    const bridge = this.browserAdapter(page) as any;
    return (await this.publicationDriver()).readCompleteChapterDirectory(await bridge.tabs.selected(), workId);
  }

  private async recoveryState(preview: PublishBatchPreview): Promise<NonNullable<PublishBatchPreview["recovery"]>> {
    const path = this.resultPath(preview);
    if (!existsSync(path)) return {state: this.store.getMeta(`fanqie_batch_attempted:${preview.batch_id}`) || existsSync(path.replace(/\.result\.json$/, ".started.json")) ? "reconcile_required" : "ready", result_status: null, result_exists: false, uncertain_chapters: []};
    try {
      const result = JSON.parse(await readFile(path, "utf8")) as {status?: string; chapters?: Array<{chapter_number?: number; status?: string; submission_started?: boolean}>};
      const status = String(result.status || "failed");
      const cloudEvidence = (result.chapters || []).some((item) => item.submission_started || ["submitted", "updated", "scheduled", "already_exists", "skipped", "uncertain"].includes(String(item.status || "")));
      const uncertainChapters = (result.chapters || []).filter((item) => String(item.status || "") === "uncertain").map((item) => Number(item.chapter_number)).filter(Number.isInteger);
      const complete = result.chapters?.length === preview.chapters.length && preview.chapters.every(ch => result.chapters?.some(item => item.chapter_number === ch.chapter_number));
      const ambiguous = !complete || ["submitted", "partial", "uncertain"].includes(status) || cloudEvidence;
      return {state: ambiguous ? "reconcile_required" : "safe_retry", result_status: status, result_exists: true, uncertain_chapters: uncertainChapters};
    } catch {
      return {state: "reconcile_required", result_status: "invalid_result", result_exists: true, uncertain_chapters: []};
    }
  }

  private async batchContentIsCurrent(preview: PublishBatchPreview): Promise<boolean> {
    try {
      const checked = await this.python.run<{chapters?: Array<{chapter_number?: number; content_fingerprint?: string}>}>(["fanqie", "check", "--batch", preview.batch_id, "--json"]);
      const job = checked.value;
      const current = new Map((job.chapters || []).map((item) => [Number(item.chapter_number), String(item.content_fingerprint || "")]));
      return current.size === preview.chapters.length && preview.chapters.every((item) => current.get(item.chapter_number) === item.content_fingerprint);
    } catch { return false; }
  }

  async prepareOrResumeBatch(bookId: string, chapters: number[], platformWorkId: string, options: PublishPlanOptions = {mode: "immediate"}, now = new Date()): Promise<OneClickBatchResolution> {
    const requested = [...new Set(chapters.map(Number).filter((value) => Number.isInteger(value) && value > 0))].sort((left, right) => left - right);
    if (!requested.length) throw new Error("一键提交至少需要一个已严格通过的章节");
    const pending = await this.pendingBatch(bookId);
    if (!pending) {
      return {batch: await this.prepareBatch(bookId, requested, platformWorkId, options, now), disposition: "created", message: "已按当前平台目录与正文创建锁定批次"};
    }
    const recovery = pending.recovery || await this.recoveryState(pending);
    if (recovery.state === "reconcile_required") {
      let recovered: {result: Record<string, unknown> | null; matched: number[]; remaining: number[]; uncertain: number[]; notAttempted: number[]} | null = null;
      if (recovery.result_status !== "invalid_result") {
        const recoveryWorkId = pending.platform_work_id || this.store.getMeta(`fanqie_batch_work:${pending.batch_id}`) || platformWorkId;
        try { recovered = await this.recoverUncertainResultFromPlatform(pending, recoveryWorkId); }
        catch (error) { throw Object.assign(new Error(`提交证据尚未核实，禁止重发：${error instanceof Error ? error.message : String(error)}`), {code: "platform_verification_required"}); }
      }
      const reconciled = await this.reconcile(pending.batch_id);
      const submitted = new Set([...(Array.isArray(reconciled.submitted) ? reconciled.submitted : []), ...(Array.isArray(reconciled.skipped) ? reconciled.skipped : [])].map(Number));
      if (String(reconciled.status || "") === "submitted" || requested.every((number) => submitted.has(number))) {
        return {batch: null, disposition: "already_submitted", message: `批次 ${pending.batch_id} 已从平台执行结果完成回写；没有重复提交`};
      }
      if (recovered?.uncertain.length) {
        throw Object.assign(new Error(`批次 ${pending.batch_id} 的第 ${recovered.uncertain.join("、")} 章在点击提交后仍无法确认是否落库；已停止重复写入，可稍后再次点击一键提交触发回查`), {
          code: "platform_verification_required", batchId: pending.batch_id, resultStatus: recovery.result_status,
        });
      }
      if (submitted.size) {
        const remaining = requested.filter((number) => !submitted.has(number));
        this.store.deleteMeta(`fanqie_book_pending_batch:${this.activeAccount().id}:${bookId}`);
        await this.preflightPublish(platformWorkId);
        const rebuilt = await this.prepareBatch(bookId, remaining, platformWorkId, options, now, true);
        return {batch: rebuilt, disposition: "rebuilt", message: `旧批次已回写 ${submitted.size} 章；仅为其余 ${remaining.length} 章重建，避免重复提交`};
      }
      if (!['failed'].includes(String(reconciled.status || ""))) {
        throw Object.assign(new Error(`批次 ${pending.batch_id} 的平台结果仍不确定，已停止重复提交`), {code: "batch_reconcile_required", batchId: pending.batch_id, resultStatus: recovery.result_status});
      }
    }
    // Verify browser/login/target state before superseding any usable local preview.
    await this.preflightPublish(platformWorkId);
    const pendingNumbers = pending.chapters.map((item) => item.chapter_number).sort((left, right) => left - right);
    const sameTarget = pending.platform_work_id === platformWorkId;
    const sameChapters = pendingNumbers.length === requested.length && pendingNumbers.every((number, index) => number === requested[index]);
    const hasLegacySchedule = pending.chapters.some((chapter) => Boolean(chapter.scheduled_at));
    const currentContent = sameTarget && sameChapters && !hasLegacySchedule ? await this.batchContentIsCurrent(pending) : false;
    if (sameTarget && sameChapters && currentContent) {
      return {batch: pending, disposition: "resumed", message: recovery.result_exists ? `已确认上次 ${recovery.result_status} 未写入章节，沿用正文哈希继续` : "待确认批次与当前正文一致，已直接恢复"};
    }
    await this.abandonBatch(pending.batch_id);
    const rebuilt = await this.prepareBatch(bookId, requested, platformWorkId, options, now, true);
    return {batch: rebuilt, disposition: "rebuilt", message: hasLegacySchedule ? "旧批次含有已停用的定时排期，已安全作废并改为立即提交" : sameTarget && sameChapters ? "旧批次正文已变化，已安全作废并按当前正文重建" : "旧批次目标与本次选择不同，已安全作废并按当前选择重建"};
  }

  async pendingBatch(bookId: string): Promise<PublishBatchPreview | null> {
    if (!/^[A-Za-z0-9_-]+$/.test(bookId)) throw new Error("作品编号无效");
    const account = this.activeAccount();
    const batchId = this.store.getMeta(`fanqie_book_pending_batch:${account.id}:${bookId}`);
    if (!batchId) return null;
    const pendingKey = `fanqie_book_pending_batch:${account.id}:${bookId}`;
    if (this.store.getMeta(`fanqie_batch_account:${batchId}`) !== account.id) {
      this.store.deleteMeta(pendingKey);
      return null;
    }
    const path = join(this.root, "books", bookId, "publish", `${batchId}.preview.json`);
    if (!existsSync(path)) {
      this.store.deleteMeta(pendingKey);
      return null;
    }
    const preview = JSON.parse(await readFile(path, "utf8")) as PublishBatchPreview;
    if (preview.status !== "preview") {
      this.store.deleteMeta(pendingKey);
      return null;
    }
    return {...preview, recovery: await this.recoveryState(preview)};
  }

  async abandonBatch(batchId: string): Promise<Record<string, unknown>> {
    const account = this.activeAccount();
    if (this.store.getMeta(`fanqie_batch_account:${batchId}`) !== account.id) throw new Error("当前番茄账号与待确认批次不一致");
    const {preview} = await this.findBatch(batchId);
    if ((await this.recoveryState(preview)).state === "reconcile_required") throw new Error("批次可能已发送，必须先核验平台结果，不能废弃提交证据");
    const pendingKey = `fanqie_book_pending_batch:${account.id}:${preview.book_id}`;
    if (this.store.getMeta(pendingKey) !== batchId || preview.status !== "preview") throw new Error("该批次已不是当前可废弃的待确认预览");
    const result = await this.python.run<Record<string, unknown>>(["fanqie", "abandon", "--batch", batchId, "--json"]);
    this.store.deleteMeta(pendingKey);
    return result.value;
  }

  async preflightPublish(platformWorkId: string): Promise<Record<string, unknown>> {
    if (!/^\d{10,}$/.test(platformWorkId)) throw new Error("请选择当前账号同步到的番茄作品");
    const account = this.activeAccount();
    const work = this.store.listWorks(account.id).find((item) => item.platformId === platformWorkId);
    if (!work) throw new Error("目标作品不属于当前账号的已同步作品，请先重新同步");
    const targetUrl = canonicalWorkUrl(platformWorkId);
    const page = await this.selectedPage();
    await page.goto(targetUrl, {waitUntil: "domcontentloaded", timeout: 30_000});
    await page.waitForLoadState("networkidle", {timeout: 8_000}).catch(() => undefined);
    await page.waitForTimeout(600);
    const text = await page.locator("body").innerText({timeout: 10_000});
    if (/\/login(?:[/?#]|$)/.test(page.url()) || (LOGIN_WORDS.test(text) && !WRITER_WORDS.test(text))) {
      throw Object.assign(new Error("番茄登录已失效，请在可见浏览器完成登录后重试"), {code: "auth_required"});
    }
    assertSafeText(text);
    if (!page.url().includes(platformWorkId) || !WRITER_WORDS.test(text)) {
      throw Object.assign(new Error("未能进入当前批次绑定的作品章节页，请先重新同步"), {code: "ui_mismatch"});
    }
    const createEntry = await this.firstLocator([
      page.getByRole("button", {name: /新建章节|新增章节|创建章节|写新章节/}),
      page.getByRole("link", {name: /新建章节|新增章节|创建章节|写新章节/}),
      page.getByText(/新建章节|新增章节|创建章节|写新章节/),
    ]);
    if (!createEntry) throw Object.assign(new Error("番茄章节页未识别到“新建章节”入口；页面可能已改版，未创建发布批次"), {code: "ui_mismatch"});
    const platformChapters = await this.completeDirectory(page, platformWorkId);
    const priorPlatformChapters = this.store.listChapters(platformWorkId, account.id);
    const explicitEmptyChapters = /暂无章节|还没有章节|尚未创建章节|创建第一章/.test(text);
    if (!platformChapters.length && priorPlatformChapters.length && !explicitEmptyChapters) {
      throw Object.assign(new Error("番茄章节页已打开，但未能可靠读取现有章节目录；为避免把替换误判为新建，已停止提交"), {code: "ui_mismatch"});
    }
    if (platformChapters.length) {
      const priorById = new Map(priorPlatformChapters.map((chapter) => [chapter.platformId, chapter]));
      for (const chapter of platformChapters) chapter.contentHash = priorById.get(chapter.platformId)?.contentHash || chapter.contentHash;
      this.store.replaceWorkChapters(account.id, platformWorkId, platformChapters);
    } else if (explicitEmptyChapters) this.store.replaceWorkChapters(account.id, platformWorkId, []);
    return {status: "ready", platformWorkId, targetUrl: page.url(), platformChapterCount: platformChapters.length, message: "登录、目标作品、章节目录与新建章节入口均已核验"};
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
    const creating = platformChapterId === "new";
    if (!/^\d{10,}$/.test(platformWorkId) || (!creating && !/^\d{10,}$/.test(platformChapterId))) throw new Error("平台作品或章节编号无效");
    const chapter = creating ? null : this.store.listChapters(platformWorkId, this.activeAccount().id).find((item) => item.platformId === platformChapterId);
    if (!creating && !chapter) throw new Error("该章节不属于当前账号同步到的目标作品");
    const page = await this.selectedPage();
    const url = creating
      ? `https://fanqienovel.com/main/writer/${platformWorkId}/publish/?enter_from=newchapter`
      : `https://fanqienovel.com/main/writer/${platformWorkId}/publish/${platformChapterId}/?enter_from=modifychapter`;
    await page.goto(url, {waitUntil: "domcontentloaded", timeout: 30_000});
    await page.waitForLoadState("networkidle", {timeout: 8_000}).catch(() => undefined);
    await page.waitForTimeout(2_500);
    let text = await page.locator("body").innerText({timeout: 10_000});
    assertSafeText(text);
    if (/\/login(?:[/?#]|$)/.test(page.url()) || (creating ? !page.url().includes(`/${platformWorkId}/publish/`) : !page.url().includes(platformChapterId))) throw Object.assign(new Error(creating ? "未能进入新建章节编辑页" : "未能进入已绑定章节的修改页"), {code: "auth_required"});
    if (advance) {
      const next = await this.firstLocator([
        page.locator('button[data-apm-action="core_chain_long_story_next_confirm"]'),
        page.locator("button.auto-editor-next"),
        page.locator(".publish-header-right button.publish-button"),
        page.getByRole("button", {name: /^下一步$/}),
      ]);
      if (!next) throw Object.assign(new Error("修改页未识别到右上角“下一步”按钮"), {code: "ui_mismatch"});
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
    return {status: "ready", step: advance ? "submit" : "editor", operation: creating ? "create" : "update", platformWorkId, platformChapterId, url: page.url(), bodyPreview: text.replace(/\s+/g, " ").trim().slice(0, 1400), fields, buttons, frames};
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

  private executingAccount: string | null = null;

  async executeBatch(batchId: string, confirmation: string, actionConfirmation: string, chapterConfirmations: Record<string, string>): Promise<Record<string, unknown>> {
    if (this.executingAccount) throw new Error("已有发布操作正在执行，请等待结束");
    this.executingAccount = this.activeAccount().id;
    try { return await this.executeBoundBatch(batchId, confirmation, actionConfirmation, chapterConfirmations); }
    finally { this.executingAccount = null; }
  }

  private async executeBoundBatch(batchId: string, confirmation: string, actionConfirmation: string, chapterConfirmations: Record<string, string>): Promise<Record<string, unknown>> {
    const writeWindow = fanqieWriteWindow();
    if (!writeWindow.allowed) throw Object.assign(new Error(writeWindow.message), {code: "time_window_blocked", writeWindow});
    const accountId = this.store.getMeta(`fanqie_batch_account:${batchId}`);
    if (accountId && accountId !== this.activeAccount().id) throw new Error("当前番茄账号与发布批次不一致，请切回生成批次时的账号");
    const batchSearch = await this.findBatch(batchId);
    const preview = batchSearch.preview;
    if ((await this.recoveryState(preview)).state === "reconcile_required") throw new Error("批次存在提交证据或缺失回执，请先核验，禁止重新发送");
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
    await this.preflightPublish(platformWorkId);
    const currentPlatformChapters = this.store.listChapters(platformWorkId, this.activeAccount().id);
    for (const planned of preview.chapters) {
      const current = currentPlatformChapters.find((item) => item.chapterNumber === planned.chapter_number);
      if (planned.operation === "update" && (!current || current.platformId !== planned.platform_chapter_id)) {
        throw Object.assign(new Error(`第 ${planned.chapter_number} 章的平台章节身份已经变化；已停止写入，请按最新目录重建批次`), {code: "stale_platform_state"});
      }
      if (planned.operation !== "update" && current) {
        throw Object.assign(new Error(`第 ${planned.chapter_number} 章已经出现在番茄目录中；为避免重复创建，已停止并要求重建为替换批次`), {code: "stale_platform_state"});
      }
    }
    const exported = await this.python.run<{job: string}>(["fanqie", "export", "--batch", batchId, "--confirm", confirmation, "--json"]);
    const jobPath = resolve(String(exported.value.job));
    const publishRoot = resolve(this.root, "books");
    if (!jobPath.startsWith(publishRoot + "\\") && !jobPath.startsWith(publishRoot + "/")) throw new Error("发布任务路径越界，已停止");
    const job = JSON.parse(await readFile(jobPath, "utf8")) as Record<string, unknown>;
    job.schema_version = 3;
    job.platform_work_id = platformWorkId;
    job.writer_url = canonicalWorkUrl(platformWorkId);
    if (!Array.isArray(job.chapters)) throw new Error("发布任务缺少章节内容，已停止");
    for (const chapter of job.chapters as Array<Record<string, unknown>>) {
      const planned = preview.chapters.find((item) => item.chapter_number === Number(chapter.chapter_number));
      if (!planned || String(chapter.content_fingerprint || "") !== planned.content_fingerprint) {
        throw Object.assign(new Error(`第 ${String(chapter.chapter_number)} 章正文已在批次锁定后变化；请废弃旧批次并按当前正文重新生成`), {code: "stale_batch"});
      }
    }
    job.chapters = (job.chapters as Array<Record<string, unknown>>).map((chapter) => {
      const planned = preview.chapters.find((item) => item.chapter_number === Number(chapter.chapter_number));
      if (!planned) throw new Error(`第 ${String(chapter.chapter_number)} 章不在当前替换预览中`);
      if (planned.operation !== "update" || !planned.platform_chapter_id) return {...chapter, operation: "create", scheduled_at: null};
      return {
        ...chapter,
        operation: "update",
        scheduled_at: null,
        local_platform_id: planned.platform_chapter_id,
        platform_chapter_id: planned.platform_chapter_id,
        modify_url: `https://fanqienovel.com/main/writer/${platformWorkId}/publish/${planned.platform_chapter_id}/?enter_from=modifychapter`,
      };
    });
    await (await this.publicationDriver()).persistPublicationResult(jobPath, job);
    if (!this.store.consumeConfirmations(confirmationItems)) throw new Error("本次一键上传确认已失效，请重新点击上传");
    this.store.setMeta(`fanqie_batch_attempted:${batchId}`, new Date().toISOString());
    await (await this.publicationDriver()).persistPublicationResult(jobPath.replace(/\.json$/, ".started.json"), {batch_id: batchId, started_at: new Date().toISOString()});
    const page = await this.selectedPage();
    const bridge = this.browserAdapter(page);
    const driverUrl = new URL("../../scripts/fanqie_browser_driver.mjs", import.meta.url);
    const driver = await import(driverUrl.href) as {runFanqiePublishJob: (options: Record<string, unknown>) => Promise<Record<string, unknown>>};
    let result = await driver.runFanqiePublishJob({ browser: bridge, jobPath, confirmation, actionConfirmation, chapterConfirmations, submit: true });
    let resultStatus = String(result.status || "failed");
    if (["uncertain", "partial"].includes(resultStatus)) {
      const recovered = await this.recoverUncertainResultFromPlatform(preview, platformWorkId);
      if (recovered.result) {
        result = recovered.result;
        resultStatus = String(result.status || resultStatus);
      }
    }
    let reconciliation: Record<string, unknown> | null = null;
    if (["submitted", "partial"].includes(resultStatus)) {
      reconciliation = (await this.python.run<Record<string, unknown>>(["fanqie", "reconcile", "--batch", batchId, "--json"], { allowExitCodes: [2] })).value;
    }
    const reconciled = new Set([
      ...(Array.isArray(reconciliation?.submitted) ? reconciliation.submitted : []),
      ...(Array.isArray(reconciliation?.skipped) ? reconciliation.skipped : []),
    ].map(Number));
    const fullyReconciled = reconciliation?.status === "submitted" && preview.chapters.every((chapter) => reconciled.has(chapter.chapter_number));
    if (resultStatus === "submitted" && !fullyReconciled) {
      result.status = "partial";
      resultStatus = "partial";
      result.message = "浏览器声称完成，但权威回写未覆盖全部锁定章节；批次已保留并等待断点续传";
      const resultPath = this.resultPath(preview);
      const temporary = `${resultPath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, JSON.stringify(result, null, 2), "utf8");
      await rename(temporary, resultPath);
    }
    if (fullyReconciled && this.store.getMeta(`fanqie_book_pending_batch:${this.activeAccount().id}:${preview.book_id}`) === batchId) {
      this.store.deleteMeta(`fanqie_book_pending_batch:${this.activeAccount().id}:${preview.book_id}`);
    }
    return {...result, reconciliation};
  }

  async reconcile(batchId: string): Promise<Record<string, unknown>> {
    const {preview: locked} = await this.findBatch(batchId);
    await this.recoverUncertainResultFromPlatform(locked, locked.platform_work_id || this.store.getMeta(`fanqie_batch_work:${batchId}`) || "");
    const value = (await this.python.run<Record<string, unknown>>(["fanqie", "reconcile", "--batch", batchId, "--json"], { allowExitCodes: [2] })).value;
    if (String(value.status || "") === "submitted") {
      const {preview} = await this.findBatch(batchId);
      const key = `fanqie_book_pending_batch:${this.activeAccount().id}:${preview.book_id}`;
      if (this.store.getMeta(key) === batchId) this.store.deleteMeta(key);
    }
    return value;
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
}
