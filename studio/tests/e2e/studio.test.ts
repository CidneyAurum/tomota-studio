import assert from "node:assert/strict";
import {execFileSync, spawn, type ChildProcess} from "node:child_process";
import {existsSync} from "node:fs";
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {test} from "node:test";
import {chromium} from "playwright-core";
import {StudioStore} from "../../server/store.js";

const chrome = [
  process.env.TOMOTA_CHROME_PATH,
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
].filter((item): item is string => Boolean(item)).find(existsSync);

function usablePython(candidate: string | undefined): candidate is string {
  if (!candidate) return false;
  try {
    execFileSync(candidate, ["-c", "from zoneinfo import ZoneInfo; ZoneInfo('Asia/Shanghai'); import tomota"], {
      env: {...process.env, PYTHONPATH: resolve(process.cwd(), "..", "src")},
      stdio: "ignore",
    });
    return true;
  } catch { return false; }
}

const python = [
  process.env.TOMOTA_PYTHON,
  process.platform === "win32" ? "D:\\Develop\\Python\\python.exe" : undefined,
  process.platform === "win32" ? "python.exe" : "python",
].find(usablePython);

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("无法分配临时端口"));
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function requestFile(root: string, name: string, value: Record<string, unknown>): Promise<string> {
  const path = join(root, `${name}.json`);
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

function tomota(root: string, args: string[]): Record<string, any> {
  const repository = resolve(process.cwd(), "..");
  if (!python) throw new Error("E2E could not find a Python runtime with Tomota and Asia/Shanghai timezone data");
  const output = execFileSync(python, ["-m", "tomota", "--root", root, ...args], {
    cwd: repository,
    env: {...process.env, PYTHONUTF8: "1", PYTHONPATH: join(repository, "src")},
    encoding: "utf8",
  });
  return JSON.parse(output) as Record<string, any>;
}

async function waitForHealth(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`隔离 Studio 提前退出：${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error("隔离 Studio 启动超时");
}

test("Studio E2E uses an isolated database, project fixture and temporary port", {skip: chrome ? false : "Chrome is not installed"}, async () => {
  const root = await mkdtemp(join(tmpdir(), "tomota-studio-e2e-"));
  let server: ChildProcess | null = null;
  try {
    const authorPayload = await requestFile(root, "author", {
      name: "E2E 自定义作者", description: "隔离夹具作者",
      persona: {
        public_identity: "开朗但不装熟的创作者", speaking_tone: "坦率轻松，偶尔自嘲", reader_relationship: "平等交流",
        humor_style: "只拿自己开玩笑", emotional_openness: "愿意谈创作卡点，不消费隐私",
        values: ["尊重读者判断"], preferred_topics: ["创作感受"], avoided_topics: ["未公开私生活"],
        interaction_habits: ["不端着说教"], authenticity_rules: ["不虚构亲身经历"], boundaries: ["不剧透未来剧情"],
      },
    });
    const author = tomota(root, ["author", "create", "--file", authorPayload, "--json"]).author;
    const versionPayload = await requestFile(root, "version", {profile: {
      narrative: {pov: "第三人称限知", distance: "近景", camera: "动作优先"},
      rhythm: {sentence: "长短交替", paragraph: "移动端短段"}, dialogue: {density: "中等", subtext: "少解释"},
      character_voice: {rule: "称呼与句长区分"}, emotion: {rule: "用动作落地"}, scene_pacing: {rule: "每场发生价值变化"},
      openings: ["从异常动作起笔"], transitions: ["以前场后果承接"], endings: ["收在新选择"],
      lexical_preferences: ["中文自然"], forbidden_patterns: ["总结式升华"], platform_constraints: ["纯文字可成立"],
      genre_tendencies: ["轻小说感但不照搬日文句法"], rules: [{category: "节奏", rule: "先因果与人物，再润色去AI味"}],
    }});
    const version = tomota(root, ["author", "version-create", "--author-id", author.id, "--file", versionPayload, "--json"]).version;
    tomota(root, ["author", "version-publish", "--author-id", author.id, "--version-id", version.id, "--json"]);
    const bookPayload = await requestFile(root, "book", {
      book_id: "e2e-book", title: "隔离测试轻小说", authorProfileVersionId: version.id,
      metadata: {author: "测试署名", genre: "轻小说感", synopsis: "只存在于临时目录的夹具"},
      outline: {version: 1, completion_mode: "open_ended", target_chapters: null, premise: "临时夹具", core_conflict: "验证隔离", ending_direction: "未锁定", major_beats: ["建立测试"], volumes: [], rolling_plan: {window_size: 5, planned_through: 0}},
      chapters: [
        {chapter_number: 1, volume_id: "volume-1", title: "异常来客", objective: "建立相遇", obstacle: "互不信任", change: "形成临时合作", next_first_beat: "核验来客身份", target_word_count: 2600},
        {chapter_number: 2, volume_id: "volume-1", title: "身份核验", objective: "确认来客目的", obstacle: "线索互相矛盾", change: "发现共同敌人", next_first_beat: "追查共同敌人", target_word_count: 2700},
      ],
    });
    tomota(root, ["book", "create", "--file", bookPayload, "--json"]);
    const e2eDraftPath = join(root, "books", "e2e-book", "drafts", "chapter-0001.md");
    await writeFile(e2eDraftPath, "“你好”,他说...\n", "utf8");
    await writeFile(join(root, "books", "e2e-book", "assets", "cover.png"), "isolated-cover", "utf8");
    const planningSeed = new StudioStore(root);
    const inspectorRun = "run-e2e-inspector";
    try {
      planningSeed.savePlanningMessage({bookId: "e2e-book", scopeType: "book", scopeId: "book", role: "user", text: "E2E 需要保留的共创上下文", jobId: "planning-e2e-seed"});
      const inspectorDir = join(root, "books", "e2e-book", "workflow", inspectorRun, "chapter-0001");
      await mkdir(inspectorDir, {recursive: true});
      const designArtifact = {
      stage: "chapter_design", title: "异常来客",
      reader_experience_contract: {must_deliver: ["互不信任转为临时合作"], emotional_curve: "警惕→试探→有限信任"},
      continuity_handoff: {entry_state: "双方陌生", exit_state: "形成临时合作", next_first_beat: "核验来客身份"},
      constraint_application: [{rule_id: "style-e2e", scene: "门口试探", acceptance_test: "对白不直接解释动机"}],
      };
      const promptPath = join(planningSeed.dataDir, "e2e-inspector.prompt.md");
      const outputPath = join(planningSeed.dataDir, "e2e-inspector.json");
      await mkdir(planningSeed.dataDir, {recursive: true});
      await writeFile(promptPath, [
      "## StageActionV2 交接封装", JSON.stringify({action_id: "action-e2e", inputs_hash: "inputs-e2e", allowed_context: ["canon", "design"], output_schema: {required: ["stage", "reader_experience_contract"], properties: {stage: {}, reader_experience_contract: {}}}}, null, 2),
      "## 当前输入（最小上下文）", JSON.stringify({canon: {facts: ["只用于服务端，不在收据返回原始值"]}}, null, 2),
      "## 冻结写作策略", JSON.stringify({policy_hash: "policy-e2e", executable_style_rules: [{rule_id: "style-e2e", category: "对白", instruction: "对白以潜台词推进", trigger: "人物试探", avoid: "解释动机"}], withheld_for_other_stages: 7, conflicts: [], source_samples: ["范文原句不应出现"]}, null, 2),
      ].join("\n"), "utf8");
      await writeFile(outputPath, JSON.stringify(designArtifact), "utf8");
      await writeFile(join(inspectorDir, "chapter_design.json"), JSON.stringify(designArtifact), "utf8");
      await writeFile(join(inspectorDir, "review_logic.json"), JSON.stringify({stage: "review_logic", passed: true, public_summary: "因果链闭合", evidence: [{evidence_id: "E1", location: "正文", quote: "她没有回答，只把湿透的信封推过去。"}]}), "utf8");
      const inspectorJob = planningSeed.createJob({runId: inspectorRun, bookId: "e2e-book", chapter: 1, stage: "chapter_design", status: "succeeded", promptPath, promptHash: "prompt-e2e", outputPath, retryOf: null});
      planningSeed.updateJob(inspectorJob.id, {outputHash: "output-e2e", finishedAt: new Date().toISOString()});
      planningSeed.saveJobResult(inspectorJob.id, {lineage: {inputsHash: "inputs-e2e"}, validationTrace: {status: "accepted"}});
    } finally {
      planningSeed.db.close();
    }

    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    server = spawn(process.execPath, [tsxCli, "server/index.ts"], {
      cwd: process.cwd(), windowsHide: true, stdio: "ignore",
      env: {...process.env, TOMOTA_PYTHON: python, TOMOTA_ROOT: root, TOMOTA_STUDIO_PORT: String(port), TOMOTA_STUDIO_API_PORT: String(port)},
    });
    await waitForHealth(url, server);
    const filteredAuthors = await (await fetch(`${url}/api/authors?q=E2E&status=active`)).json() as {authors: Array<{id: string}>};
    assert.deepEqual(filteredAuthors.authors.map((item) => item.id), [author.id]);
    const uploadSource = async (name: string, text: string) => {
      const response = await fetch(`${url}/api/authors/${author.id}/sources?filename=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: {"content-type": "application/octet-stream", "x-tomota-rights-confirmed": "true"},
        body: new Blob([text]),
      });
      assert.equal(response.status, 201, `source upload failed: ${await response.clone().text()}`);
      return await response.json() as {source: {id: string; restored?: boolean}};
    };
    const firstSource = await uploadSource("第一部.txt", "第一章\n\n“别急着下结论。”她推开门。\n\n雨还在下。");
    const deleteSource = await fetch(`${url}/api/authors/${author.id}/sources/${firstSource.source.id}`, {method: "DELETE"});
    assert.equal(deleteSource.status, 200, `source delete failed: ${await deleteSource.text()}`);
    const restoredSource = await uploadSource("第一部重新上传.txt", "第一章\n\n“别急着下结论。”她推开门。\n\n雨还在下。");
    assert.equal(restoredSource.source.id, firstSource.source.id);
    assert.equal(restoredSource.source.restored, true);
    const secondSource = await uploadSource("第二部.txt", "第一章\n\n“把证据留下。”他按住信封。\n\n风穿过长廊。");
    const reorder = await fetch(`${url}/api/authors/${author.id}/sources/order`, {
      method: "PUT", headers: {"content-type": "application/json"},
      body: JSON.stringify({sourceIds: [secondSource.source.id, restoredSource.source.id]}),
    });
    assert.equal(reorder.status, 200, `source reorder failed: ${await reorder.text()}`);
    const authorDetail = await (await fetch(`${url}/api/authors/${author.id}`)).json() as {author: {sources: Array<{id: string; deleted_at: string | null}>}};
    assert.deepEqual(authorDetail.author.sources.filter((item) => !item.deleted_at).map((item) => item.id), [secondSource.source.id, restoredSource.source.id]);
    const bindingAudit = await (await fetch(`${url}/api/projects/e2e-book/author-binding`)).json() as Record<string, any>;
    assert.equal(bindingAudit.binding.version_id, version.id);
    assert.equal(bindingAudit.compiledPolicy.author_binding.version_id, version.id);
    assert.equal(bindingAudit.effectState, "next_workflow");
    const publicPolicy = await (await fetch(`${url}/api/projects/e2e-book/writing-policy`)).json() as Record<string, any>;
    assert.equal(publicPolicy.writingPolicy.policy_hash, bindingAudit.compiledPolicy.policy_hash);
    assert.equal(JSON.stringify(publicPolicy).includes("source_samples"), false);
    const outlineFixture = await (await fetch(`${url}/api/projects/e2e-book/outline`)).json() as Record<string, any>;
    const outlineSave = await fetch(`${url}/api/projects/e2e-book/outline`, {method: "PUT", headers: {"content-type": "application/json"}, body: JSON.stringify(outlineFixture)});
    assert.equal(outlineSave.status, 200, `outline PUT route failed: ${await outlineSave.text()}`);

    const browser = await chromium.launch({executablePath: chrome, headless: true});
    try {
      const page = await browser.newPage({viewport: {width: 1280, height: 820}});
      const errors: string[] = [];
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      const assertNoHorizontalOverflow = async (context: string) => {
        const overflow = await page.evaluate(() => ({
          client: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
        }));
        assert.equal(
          overflow.scroll <= overflow.client + 1 && overflow.body <= overflow.client + 1,
          true,
          `${context} must not create page-level horizontal overflow: ${JSON.stringify(overflow)}`,
        );
      };
      const assertVisibleFontFloor = async (selector: string, minimum = 12) => {
        const sizes = await page.locator(selector).evaluateAll((nodes) => nodes.flatMap((node) => {
          const element = node as HTMLElement;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
            ? [Number.parseFloat(style.fontSize)]
            : [];
        }));
        assert.ok(sizes.length > 0, `${selector} should have at least one visible readability target`);
        assert.equal(sizes.every((size) => size >= minimum), true, `${selector} font sizes must be >= ${minimum}px: ${sizes.join(", ")}`);
      };
      await page.goto(url, {waitUntil: "networkidle"});
      assert.equal(await page.title(), "Tomota Studio");
      assert.ok(await page.getByText("隔离测试轻小说", {exact: true}).count() >= 1);
      assert.equal(await page.getByText("纯白残响", {exact: true}).count(), 0, "不得读取用户真实作品");

      await page.getByRole("button", {name: /作者与文风/}).click();
      assert.equal(new URL(page.url()).pathname, "/authors");
      assert.equal(await page.getByRole("heading", {name: "作者空间"}).count(), 1);
      assert.equal(await page.getByLabel("当前作品").count(), 0, "作者空间不得继续伪装成当前书籍上下文");
      await page.getByText("E2E 自定义作者", {exact: true}).first().waitFor({state: "visible", timeout: 5_000});
      await page.locator(".author-card").filter({hasText: "E2E 自定义作者"}).click();
      await page.getByRole("heading", {name: "E2E 自定义作者"}).waitFor({state: "visible", timeout: 5_000});
      assert.equal(new URL(page.url()).pathname, `/authors/${author.id}`);
      assert.match(await page.locator("body").innerText(), /作者版本.*作品绑定.*编译策略.*工作流快照.*阶段 Prompt/s);
      assert.ok(await page.getByText("隔离测试轻小说", {exact: true}).count() >= 1);

      await page.getByRole("link", {name: /文风工作室/}).click();
      await page.getByRole("heading", {name: "文风工作室"}).waitFor({state: "visible"});
      await page.goBack();
      await page.getByRole("heading", {name: "E2E 自定义作者"}).waitFor({state: "visible"});
      assert.equal(new URL(page.url()).pathname, `/authors/${author.id}`);
      await page.goForward();
      await page.getByRole("heading", {name: "文风工作室"}).waitFor({state: "visible"});
      await page.locator(".advanced-json").getByText(/高级 JSON/).click();
      await page.locator(".advanced-json textarea").fill("{}");
      await page.getByRole("button", {name: "校验并应用到表单"}).click();
      assert.match(await page.locator(".field-error").innerText(), /至少需要一条非空的可执行规则/);
      await page.getByRole("button", {name: /保存为新草稿/}).click();
      await page.getByRole("heading", {name: "不可变版本中心"}).waitFor({state: "visible", timeout: 5_000});
      assert.match(await page.locator(".version-timeline").innerText(), /版本 v2[\s\S]*草稿/);

      await page.getByRole("link", {name: /个人人设/}).click();
      await page.getByRole("heading", {name: "作者个人人设"}).waitFor({state: "visible"});
      assert.match(await page.locator(".persona-boundary").innerText(), /默认独立，可显式协同[\s\S]*开朗作者完全可以写阴暗作品[\s\S]*显式选择/);
      assert.equal(await page.getByLabel("公开自我定位").inputValue(), "开朗但不装熟的创作者");
      assert.equal((await page.locator("body").innerText()).includes("阴暗悬疑场景保持冷峻克制"), false, "人设页不得把小说文风冒充作者人格");

      await page.getByRole("link", {name: /个人谈/}).click();
      await page.getByRole("heading", {name: "个人谈", exact: true}).waitFor({state: "visible"});
      assert.match(await page.locator(".personal-talk-page").innerText(), /不进入小说章节、目录、字数、Canon 或质量审查/);
      assert.equal(await page.getByLabel("小说文风参与").inputValue(), "none");
      await page.getByLabel("标题").fill("写在连载之外");
      await page.getByLabel("正文").fill("这是一条作者面对读者的独立感想，不是小说章节，也不会改变书中的人物与剧情事实。");
      await page.getByRole("button", {name: /保存草稿/}).click();
      await page.getByText("写在连载之外", {exact: true}).waitFor({state: "visible"});
      assert.match(await page.locator(".personal-talk-list").innerText(), /未关联作品[\s\S]*小说文风未参与/);
      const talks = await (await fetch(`${url}/api/authors/${author.id}/personal-talks`)).json() as {talks: Array<Record<string, any>>};
      assert.equal(talks.talks.length, 1);
      assert.equal(talks.talks[0].linkedBookId, null);
      assert.equal(talks.talks[0].styleInfluence, "none");
      assert.ok(existsSync(join(root, "authors", author.id, "personal-talks", `${talks.talks[0].id}.json`)));
      assert.equal(((await (await fetch(`${url}/api/projects/e2e-book`)).json()) as Record<string, any>).chapters.length, 2, "个人谈不得写入小说章节");

      await page.goto(`${url}/authors/${author.id}/books`, {waitUntil: "networkidle"});
      await page.getByRole("heading", {name: "关联作品与生效证据"}).waitFor({state: "visible"});
      assert.match(await page.locator("body").innerText(), /作者版本.*作品绑定.*编译策略.*工作流快照/s);
      assert.match(await page.locator("body").innerText(), /后续新工作流生效|当前运行与后续工作流均生效/);

      await page.getByRole("button", {name: /新建作者/}).click();
      await page.getByLabel("内部作者名称").fill("无书独立作者");
      await page.getByLabel("创作方向与目标读者").fill("先建作者，暂不关联作品");
      await page.getByRole("button", {name: /保存身份并继续/}).click();
      await page.getByRole("button", {name: /暂时保持空白/}).click();
      await page.getByRole("heading", {name: "无书独立作者"}).waitFor({state: "visible", timeout: 5_000});
      assert.match(await page.locator("body").innerText(), /零关联作者完全有效/);
      await page.getByRole("link", {name: /作者设置/}).click();
      page.once("dialog", (dialog) => void dialog.accept());
      await page.getByRole("button", {name: /删除作者/}).click();
      await page.getByRole("heading", {name: "作者空间"}).waitFor({state: "visible", timeout: 5_000});
      assert.equal(await page.getByText("无书独立作者", {exact: true}).count(), 0);

      await page.getByRole("button", {name: /作品总览/}).click();
      await page.getByRole("button", {name: /新建作品/}).click();
      const dialog = page.getByRole("dialog", {name: "新建作品"});
      assert.equal(await dialog.getByText("发布署名", {exact: true}).count(), 1);
      assert.equal(await dialog.getByText("作者版本（必选）", {exact: true}).count(), 1);
      await dialog.getByRole("option", {name: /E2E 自定义作者 · v1/}).waitFor({state: "attached", timeout: 5_000});
      assert.equal(await dialog.getByRole("option", {name: /E2E 自定义作者 · v1/}).count(), 1);
      await dialog.getByRole("button", {name: "关闭", exact: true}).click();

      await page.getByRole("button", {name: /全书与分卷/}).click();
      await page.getByRole("heading", {name: "全书 · 分卷 · 章节"}).waitFor({state: "visible"});
      assert.equal(await page.getByRole("heading", {name: "书籍大纲对话室"}).count(), 1);
      assert.match(await page.locator("#book-planning-dialogue").innerText(), /按作品和范围保存.*刷新后可继续/s);
      assert.match(await page.locator("#book-planning-dialogue").innerText(), /E2E 需要保留的共创上下文/);
      const bookPlanningMode = page.locator("#book-planning-dialogue select");
      await bookPlanningMode.selectOption("rewrite");
      assert.match(await page.locator("#book-planning-dialogue").innerText(), /重做模式：保留你的要求，但旧 AI 候选不会进入生成/);
      await page.getByRole("button", {name: "批量重规划", exact: true}).click();
      assert.equal(await page.locator(".chapter-batch-check input").count(), 2);
      await page.locator(".chapter-batch-check").nth(0).click();
      await page.locator(".chapter-batch-check").nth(1).click();
      const clearOutline = page.getByRole("button", {name: /允许清空并替换所选章纲/});
      await clearOutline.click();
      assert.equal(await page.locator(".batch-clear-authorization").getAttribute("aria-pressed"), "true");
      const batchReplan = page.getByRole("button", {name: "对话重规划 2 章", exact: true});
      assert.equal(await batchReplan.isEnabled(), true);
      await batchReplan.click();
      const batchDialog = page.getByRole("dialog", {name: "已选 2 章 AI 共创"});
      await batchDialog.waitFor({state: "visible"});
      assert.equal(await batchDialog.locator("select").inputValue(), "rewrite");
      assert.match(await batchDialog.innerText(), /整体重排已选章节的因果、状态传递与章末承接/);
      await batchDialog.getByRole("button", {name: "稍后再说"}).click();
      await page.getByRole("button", {name: "退出批量重规划", exact: true}).click();
      await page.locator(".outline-tree button").filter({hasText: "第 1 章"}).first().click();
      await page.getByRole("button", {name: /删除本章及关联产物/}).click();
      const chapterRebuild = page.getByRole("dialog", {name: /清空.*第 1 章.*关联产物/});
      await chapterRebuild.waitFor({state: "visible"});
      await chapterRebuild.getByText("将永久清除", {exact: true}).waitFor({state: "visible", timeout: 10_000});
      assert.match(await chapterRebuild.innerText(), /将永久清除[\s\S]*明确保留[\s\S]*DELETE CHAPTER 1/);
      assert.equal(await chapterRebuild.getByRole("button", {name: /确认永久清除/}).isEnabled(), false);
      await chapterRebuild.getByRole("button", {name: "取消", exact: true}).click();
      await page.locator(".outline-tree > button").filter({hasText: "全书"}).first().click();
      await page.getByRole("button", {name: /只保留书名与封面，推倒重建/}).click();
      const bookRebuild = page.getByRole("dialog", {name: /清空.*全书.*关联产物/});
      await bookRebuild.waitFor({state: "visible"});
      await bookRebuild.getByText("明确保留", {exact: true}).waitFor({state: "visible", timeout: 10_000});
      assert.match(await bookRebuild.innerText(), /作品标题[\s\S]*assets\/ 中的封面[\s\S]*REBUILD BOOK e2e-book/);
      await bookRebuild.getByRole("button", {name: "取消", exact: true}).click();

      await page.getByRole("button", {name: /作品工作区/}).click();
      await page.getByRole("heading", {name: "作品工作区"}).waitFor({state: "visible"});
      await page.getByRole("button", {name: "只读扫描", exact: true}).click();
      await page.getByText("只读结果，正文未修改", {exact: true}).waitFor({state: "visible"});
      assert.match(await page.locator(".deslop-panel").innerText(), /去 AI 味检查[\s\S]*真正的文字返工仍由严格流水线[\s\S]*明确应用规范化/);
      assert.equal((await readFile(e2eDraftPath, "utf8")).replaceAll("\r\n", "\n"), "“你好”,他说...\n", "只读扫描不得改写正文");

      await page.getByRole("button", {name: /系统设置/}).click();
      await page.getByRole("heading", {name: "系统设置"}).waitFor({state: "visible"});
      assert.equal(new URL(page.url()).pathname, "/settings");
      assert.equal(await page.getByLabel("当前作品").count(), 0, "全局系统设置不得携带作品上下文");
      assert.equal(await page.getByText("隔离测试轻小说", {exact: true}).count(), 0, "系统页不得写死或显示当前书名");
      assert.equal(await page.getByText("本书作者与文风", {exact: true}).count(), 0);
      for (const role of ["生成模型", "审查模型", "工作台助手模型", "审查仲裁模型"]) assert.equal(await page.getByText(role, {exact: true}).count(), 1);
      assert.equal(await page.getByText("整库安全快照", {exact: true}).count(), 1);
      assert.match(await page.locator(".model-settings-panel").innerText(), /默认全部使用本地 Antigravity[\s\S]*Windows 当前用户加密/);

      await page.getByRole("button", {name: /作品设置/}).click();
      await page.getByRole("heading", {name: "作品设置"}).waitFor({state: "visible"});
      assert.equal(new URL(page.url()).pathname, "/books/e2e-book/book-settings");
      assert.ok(await page.getByText("隔离测试轻小说", {exact: true}).count() >= 1);
      assert.equal(await page.getByText("本书作者与文风", {exact: true}).count(), 1);

      await page.getByRole("button", {name: /严格流水线/}).click();
      assert.equal(await page.getByRole("heading", {name: "严格写作流水线"}).count(), 1);
      await page.getByRole("tab", {name: "阶段产物", exact: true}).click();
      await page.locator(".artifact-body").getByRole("heading", {name: "异常来客", exact: true}).waitFor({state: "visible"});
      for (const tabName of ["阶段产物", "上下文收据", "计划—正文对账", "判断依据", "交接校验", "原始 JSON"]) {
        await page.getByRole("tab", {name: tabName, exact: true}).click();
        const overflow = await page.locator(".artifact-body").evaluate((node) => {
          const right = node.getBoundingClientRect().right;
          return {client: node.clientWidth, scroll: node.scrollWidth, offenders: [...node.querySelectorAll("*")].filter((item) => item.getBoundingClientRect().right > right + 1).slice(0, 8).map((item) => ({className: String((item as HTMLElement).className), tag: item.tagName, right: item.getBoundingClientRect().right, width: item.getBoundingClientRect().width}))};
        });
        assert.equal(overflow.scroll <= overflow.client + 1, true, `${tabName} must not create horizontal overflow: ${JSON.stringify(overflow)}`);
        if (tabName === "交接校验") assert.ok(await page.locator(".artifact-body .inspector-field.complex").count() >= 1, "nested objects should use a full-width vertical layout");
      }
      await page.getByRole("tab", {name: "阶段产物", exact: true}).click();
      await page.getByRole("button", {name: "放大查看阶段产物"}).click();
      const artifactDialog = page.getByRole("dialog", {name: "阶段产物放大查看"});
      await artifactDialog.waitFor({state: "visible"});
      await artifactDialog.getByRole("button", {name: "放大产物"}).click();
      assert.equal(await artifactDialog.getByRole("button", {name: "恢复百分之百缩放"}).innerText(), "110%");
      await artifactDialog.getByRole("tab", {name: "上下文收据", exact: true}).click();
      await artifactDialog.getByText("上下文应用收据", {exact: true}).waitFor({state: "visible"});
      await page.keyboard.press("Escape");
      await artifactDialog.waitFor({state: "hidden"});
      await page.getByRole("tab", {name: "上下文收据", exact: true}).click();
      await page.getByText("上下文应用收据", {exact: true}).waitFor({state: "visible"});
      assert.match(await page.locator(".artifact-body").innerText(), /2 条写作规则已编译|1 条写作规则已编译/);
      assert.match(await page.locator(".artifact-body").innerText(), /canon[\s\S]*正式事实[\s\S]*对白以潜台词推进/);
      assert.equal((await page.locator(".artifact-body").innerText()).includes("范文原句不应出现"), false);
      await page.getByRole("tab", {name: "计划—正文对账", exact: true}).click();
      await page.getByText("计划已冻结，等待实际正文", {exact: true}).waitFor({state: "visible"});
      assert.match(await page.locator(".artifact-body").innerText(), /互不信任转为临时合作[\s\S]*正文通过全部闸门前保持 pending/);
      assert.deepEqual(errors, []);

      const desktopRoutes = [
        ["作品总览", `${url}/books/e2e-book/overview`],
        ["全书与分卷", `${url}/books/e2e-book/planning`],
        ["严格流水线", `${url}/books/e2e-book/workflow`],
        ["作品工作区", `${url}/books/e2e-book/workspace`],
        ["番茄运营", `${url}/books/e2e-book/fanqie`],
        ["作品设置", `${url}/books/e2e-book/book-settings`],
        ["系统设置", `${url}/settings`],
      ] as const;
      for (const viewport of [{width: 1280, height: 820}, {width: 1440, height: 900}, {width: 1920, height: 1080}]) {
        await page.setViewportSize(viewport);
        for (const [name, route] of desktopRoutes) {
          await page.goto(route, {waitUntil: "networkidle"});
          await page.locator("main").waitFor({state: "visible"});
          await assertNoHorizontalOverflow(`${name} at ${viewport.width}x${viewport.height}`);
          const topbarControls = await page.locator(".topbar button:visible, .topbar select:visible").evaluateAll((nodes) => nodes.map((node) => {
            const rect = node.getBoundingClientRect();
            return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom};
          }));
          assert.equal(topbarControls.every((rect) => rect.left >= -1 && rect.right <= viewport.width + 1 && rect.top >= -1), true, `${name} topbar controls must remain inside the viewport`);
        }
      }

      await page.setViewportSize({width: 1280, height: 820});
      await page.goto(`${url}/books/e2e-book/workspace`, {waitUntil: "networkidle"});
      const workspaceGeometry = await page.locator(".workspace-layout").evaluate((node) => {
        const layout = node.getBoundingClientRect();
        const findings = node.querySelector(".findings-panel") as HTMLElement | null;
        const findingRect = findings?.getBoundingClientRect();
        return {
          client: node.clientWidth,
          scroll: node.scrollWidth,
          columns: getComputedStyle(node).gridTemplateColumns,
          findingsDisplay: findings ? getComputedStyle(findings).display : "missing",
          findingsWidth: findingRect?.width || 0,
          layoutWidth: layout.width,
        };
      });
      assert.equal(workspaceGeometry.scroll <= workspaceGeometry.client + 1, true, `workspace grid must not overflow: ${JSON.stringify(workspaceGeometry)}`);
      assert.notEqual(workspaceGeometry.findingsDisplay, "none", "review findings must remain accessible at 1280px");
      assert.ok(workspaceGeometry.findingsWidth > 0 && workspaceGeometry.findingsWidth <= workspaceGeometry.layoutWidth + 1, "review findings should use a full-width row below the editor");
      await assertVisibleFontFloor(".editor-head span, .editor-foot span");

      await page.goto(`${url}/books/e2e-book/planning`, {waitUntil: "networkidle"});
      await assertVisibleFontFloor(".planning-head-actions button");
      await page.goto(`${url}/books/e2e-book/workflow`, {waitUntil: "networkidle"});
      await assertVisibleFontFloor(".scope-head small, .stage-row span, .terminal-head b, .artifact-tabs button");
      await page.goto(`${url}/settings`, {waitUntil: "networkidle"});
      await assertVisibleFontFloor(".setting-card p, .setting-card code");

      await page.setViewportSize({width: 390, height: 844});
      for (const [name, route] of desktopRoutes.slice(0, 4)) {
        await page.goto(route, {waitUntil: "networkidle"});
        await assertNoHorizontalOverflow(`${name} at 390x844`);
      }
      await page.goto(`${url}/books/e2e-book/overview`, {waitUntil: "networkidle"});
      const agentButton = page.locator(".workbench-agent-open");
      const agentButtonBox = await agentButton.boundingBox();
      assert.ok(agentButtonBox && agentButtonBox.width >= 40 && agentButtonBox.height >= 40 && agentButtonBox.x + agentButtonBox.width <= 390, "mobile Workbench AI button must remain a tappable icon inside the viewport");
      assert.equal(await page.locator(".workbench-agent-open .topbar-button-label").isVisible(), false, "mobile Workbench AI text should be hidden instead of stacking vertically");
      await page.goto(`${url}/books/e2e-book/planning`, {waitUntil: "networkidle"});
      const mobilePlanningActions = await page.locator(".planning-head-actions button:visible").evaluateAll((nodes) => nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return {left: rect.left, right: rect.right, height: rect.height};
      }));
      assert.equal(mobilePlanningActions.every((rect) => rect.left >= -1 && rect.right <= 391 && rect.height >= 40), true, "mobile planning actions must remain tappable and inside the viewport");
      await assertNoHorizontalOverflow("planning actions at 390x844");
      assert.deepEqual(errors, []);

      const finalPreview = await (await fetch(`${url}/api/projects/e2e-book/rebuild-preview?scopeType=book&scopeId=book`)).json() as Record<string, any>;
      const rebuiltResponse = await fetch(`${url}/api/projects/e2e-book/rebuild`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({scopeType: "book", scopeId: "book", confirmation: finalPreview.confirmation_phrase})});
      const rebuilt = await rebuiltResponse.json() as Record<string, any>;
      assert.equal(rebuiltResponse.status, 200, JSON.stringify(rebuilt));
      assert.equal(rebuilt.recoverable, false);
      assert.ok(existsSync(join(root, "books", "e2e-book", "assets", "cover.png")));
      const rebuiltProject = await (await fetch(`${url}/api/projects/e2e-book`)).json() as Record<string, any>;
      assert.equal(rebuiltProject.book.title, "隔离测试轻小说");
      assert.equal(rebuiltProject.chapters.length, 0);
      assert.equal((await readdir(join(root, "books", "e2e-book", ".trash"))).length, 0);
    } finally {
      await browser.close();
    }
  } finally {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    await rm(root, {recursive: true, force: true});
  }
});
