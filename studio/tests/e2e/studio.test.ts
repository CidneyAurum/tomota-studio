import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";

const executable = [
  process.env.TOMOTA_CHROME_PATH,
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
].filter((item): item is string => Boolean(item)).find(existsSync);

test("Studio renders real projects and its primary work surfaces at desktop and mobile widths", { skip: executable ? false : "Chrome is not installed" }, async () => {
  const browser = await chromium.launch({ executablePath: executable, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(process.env.TOMOTA_STUDIO_URL || "http://127.0.0.1:43127/", { waitUntil: "networkidle" });
    assert.equal(await page.title(), "Tomota Studio");
    assert.match(await page.locator("body").innerText(), /每一章，都留下通过的证据/);
    assert.ok(await page.getByText("纯白残响", { exact: true }).count() >= 1);
    assert.ok(await page.getByText("第十三响后，死去的少女寄来了信", { exact: true }).count() >= 1);
    assert.equal(await page.getByRole("button", { name: /新建作品/ }).count(), 1);
    await page.getByRole("button", {name: /新建作品/}).click();
    assert.equal(await page.getByRole("dialog", {name: "新建作品"}).count(), 1);
    assert.equal(await page.getByText("本地作品编号", {exact: true}).count(), 0);
    assert.equal(await page.getByRole("button", {name: /AI 共创新书/}).count(), 1);
    await page.getByRole("button", {name: /AI 共创新书/}).click();
    assert.equal(await page.getByRole("dialog", {name: "新书创意 AI 共创"}).count(), 1);
    await page.screenshot({path: join(process.cwd(), "..", ".tomota-studio", "studio-new-book-ai.png"), fullPage: true});
    await page.getByRole("button", {name: "关闭 AI 共创"}).click();
    await page.getByRole("button", {name: "关闭", exact: true}).click();
    await page.screenshot({ path: join(process.cwd(), "..", ".tomota-studio", "studio-preview.png"), fullPage: true });
    await page.getByRole("button", { name: /全书与分卷/ }).click();
    assert.equal(await page.getByRole("heading", { name: "全书 · 分卷 · 章节" }).count(), 1);
    assert.ok(await page.getByText("全书", { exact: true }).count() >= 1);
    assert.ok(await page.getByText("第一卷", { exact: true }).count() >= 1);
    assert.match(await page.locator("body").innerText(), /已规划范围只是下一段可执行路线，不等于全书完结章数/);
    await page.getByRole("button", {name: /AI 共创全书/}).click();
    assert.equal(await page.getByRole("dialog", {name: "全书总纲 AI 共创"}).count(), 1);
    assert.equal(await page.getByText(/不会自动覆盖/).count(), 1);
    await page.screenshot({path: join(process.cwd(), "..", ".tomota-studio", "studio-planning-ai.png"), fullPage: true});
    await page.getByRole("button", {name: "关闭 AI 共创"}).click();
    await page.locator(".volume-node > button").first().click();
    assert.equal(await page.getByRole("button", {name: /AI 共创本卷/}).count(), 1);
    await page.locator(".volume-node > div button").first().click();
    assert.equal(await page.getByRole("button", {name: /AI 共创本章/}).count(), 1);
    await page.screenshot({ path: join(process.cwd(), "..", ".tomota-studio", "studio-planning.png"), fullPage: true });
    await page.getByRole("button", { name: /严格流水线/ }).click();
    assert.equal(await page.getByRole("heading", { name: "严格写作流水线" }).count(), 1);
    assert.equal(await page.getByLabel("当前阶段修改反馈").count(), 1);
    assert.equal(await page.getByText("修改反馈", { exact: true }).count(), 1);
    assert.equal(await page.getByLabel("章节号").count(), 0);
    const picker = page.locator(".chapter-picker");
    if (await picker.count()) {
      await picker.locator("summary").click();
      assert.equal(await page.getByText("本次处理哪些章节？", { exact: true }).count(), 1);
      assert.match(await page.locator("body").innerText(), /这里只决定本次任务队列，不代表小说将在这些章节完结/);
      assert.ok(await page.getByText("已有正文 · 待严格审查", {exact: true}).count() >= 2);
    }
    await page.screenshot({ path: join(process.cwd(), "..", ".tomota-studio", "studio-workflow.png"), fullPage: true });
    await page.getByRole("button", { name: /作品工作区/ }).click();
    assert.equal(await page.getByRole("heading", { name: "作品工作区" }).count(), 1);
    assert.equal(await page.getByText(/autopilot-/, {exact: false}).count(), 0);
    assert.equal(await page.getByText("audit", {exact: true}).count(), 0);
    assert.ok(await page.getByRole("option", {name: "正文"}).count() >= 1);
    await page.locator(".file-list").getByText("chapter-0003.md", {exact: true}).click();
    assert.equal(await page.getByText("尚未严格审查", {exact: true}).count(), 1);
    assert.equal(await page.getByText("正文已经存在，但还没有严格审查报告", {exact: true}).count(), 1);
    await page.screenshot({ path: join(process.cwd(), "..", ".tomota-studio", "studio-workspace.png"), fullPage: true });
    await page.getByRole("button", { name: /番茄运营/ }).click();
    assert.equal(await page.getByRole("heading", { name: "番茄作品运营" }).count(), 1);
    await page.locator(".works-panel").getByText("第十三响后，死去的少女寄来了信", {exact: true}).waitFor({state: "visible", timeout: 5_000});
    assert.equal(await page.locator(".works-panel").getByText("点此了解", {exact: true}).count(), 0);
    assert.equal(await page.getByText("作品资料与封面", { exact: true }).count(), 1);
    assert.equal(await page.getByRole("combobox", {name: "番茄账号"}).count(), 1);
    assert.equal(await page.getByRole("button", {name: /添加账号/}).count(), 1);
    await page.screenshot({ path: join(process.cwd(), "..", ".tomota-studio", "studio-fanqie.png"), fullPage: true });
    await page.getByRole("button", { name: /系统设置/ }).click();
    assert.match(await page.locator("body").innerText(), /CLI 已安装|已连接，可以运行|Google 拒绝当前网络地区|当前不可运行/);
    await page.screenshot({ path: join(process.cwd(), "..", ".tomota-studio", "studio-settings.png"), fullPage: true });
    await page.setViewportSize({ width: 1000, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
