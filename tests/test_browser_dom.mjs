// Isolated headless browser, synthetic pages only. Every request is intercepted.
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {isNegativeChoiceSelected, readCompleteChapterDirectory, verifyChapterPublication} from '../scripts/fanqie_browser_driver.mjs';

const require = createRequire(new URL('../studio/package.json', import.meta.url));
const {chromium} = require('playwright-core');
const executablePath = [process.env.TOMOTA_TEST_BROWSER, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => p && existsSync(p));
const work = '7675620772693429273';
const remote = '7675641066854302233';
const row = n => `<tr><td>第${n}章 标题${n}</td><td>1000</td><td>0</td><td>已发布</td><td><a href="https://fanqienovel.com/main/writer/${work}/publish/${remote.slice(0,-1) + n}/">编辑</a></td></tr>`;
const wrap = page => ({url: async () => page.url(), goto: url => page.goto(url), playwright: {
  locator: selector => page.locator(selector), getByPlaceholder: value => page.getByPlaceholder(value),
  getByRole: (role, options) => page.getByRole(role, options), domSnapshot: () => page.locator('body').innerText(),
  waitForTimeout: async () => {},
}});

test('real DOM publication regressions (all network intercepted)', {skip: !executablePath}, async t => {
  const browser = await chromium.launch({executablePath, headless: true});
  const context = await browser.newContext({serviceWorkers: 'block'});
  try {
    await context.route('**/*', route => route.fulfill({contentType: 'text/html', body: '<html><body>作家中心</body></html>'}));
    const page = await context.newPage();
    await page.goto(`https://fanqienovel.com/main/writer/chapter-manage/${work}`);
    const tab = wrap(page);
    await t.test('value=no and unrelated checked controls never imply selection', async () => {
      await page.setContent('<label><input id="no" type="radio" name="ai" value="no">否</label><label><input type="radio" name="ai" value="yes" checked>是</label><label><input type="radio" name="other" checked>否</label>否 已选');
      assert.equal(await isNegativeChoiceSelected(tab, page.locator('#no'), '否 已选'), false);
      await page.locator('#no').check();
      assert.equal(await isNegativeChoiceSelected(tab, page.locator('#no'), ''), true);
      await page.setContent('<label class="arco-radio"><span id="choice">否</span><input type="radio" value="false"></label>');
      assert.equal(await isNegativeChoiceSelected(tab, page.locator('#choice'), ''), false);
      await page.locator('input').check();
      assert.equal(await isNegativeChoiceSelected(tab, page.locator('#choice'), ''), true);
    });
    await t.test('extracts real rows and traverses next/disabled DOM controls', async () => {
      await page.setContent(`<div>作家中心</div><table><tbody>${row(1)}</tbody></table><div class="arco-pagination"><span class="arco-pagination-total">共 2 条</span><button class="arco-pagination-item-next">下一页</button></div>`);
      await page.evaluate(html => document.querySelector('button').onclick = () => {
        document.querySelector('tbody').innerHTML = html;
        document.querySelector('button').disabled = true;
      }, row(2));
      assert.deepEqual((await readCompleteChapterDirectory(tab, work)).map(c => c.chapterNumber), [1,2]);
    });
    await t.test('iterates real native volume selector, rejecting a stale page', async () => {
      await page.setContent(`<div>作家中心 共 1 条</div><select><option value="1">第一卷</option><option value="2">第二卷</option></select><table><tbody>${row(1)}</tbody></table>`);
      await page.evaluate(rows => document.querySelector('select').onchange = event => {
        document.querySelector('tbody').innerHTML = rows[event.target.value];
      }, {1: row(1), 2: row(2)});
      assert.deepEqual((await readCompleteChapterDirectory(tab, work)).map(c => c.chapterNumber), [1,2]);
      await page.setContent(`<div>作家中心 共 2 条</div><table>${row(1)}</table>`);
      await assert.rejects(() => readCompleteChapterDirectory(tab, work), /目录不完整/);
    });
    await t.test('replacement draft cannot pass without a bound final-submit acknowledgement', async () => {
      const chapter = {operation: 'update', chapter_number: 1, platform_chapter_id: remote, title: '标题1', content: '新草稿', content_fingerprint: 'f'.repeat(64)};
      assert.equal((await verifyChapterPublication(tab, {platform_work_id: work}, chapter)).status, 'uncertain');
      chapter.submission_ack = {kind:'platform_submit_feedback', platform_work_id:work, platform_chapter_id:remote,
        chapter_number:1,content_fingerprint:'wrong',evidence:'修改成功'};
      assert.equal((await verifyChapterPublication(tab, {platform_work_id: work}, chapter)).status, 'uncertain');
    });
  } finally { await context.close(); await browser.close(); }
});
