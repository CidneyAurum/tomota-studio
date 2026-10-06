// Real built React UI, headless clean Chrome, local static server, in-memory API.
// No production server, browser profile, database or external network is used.
// Regressions for F20/F21; run from studio with npm run test:e2e (build first).
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createServer} = require('node:http');
const {readFile} = require('node:fs/promises');
const {existsSync} = require('node:fs');
const {resolve, join, extname, relative} = require('node:path');
const {createHash} = require('node:crypto');
const {chromium} = require('playwright-core');
const chrome = [process.env.TOMOTA_CHROME_PATH,
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
].filter(Boolean).find(existsSync);
const uiTest = (name, run) => test(name, {timeout: 30000, skip: chrome ? false : 'Chrome is not installed'}, run);
async function settled(page, response) {
  await (await response).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

const hash = text => createHash('sha256').update(text).digest('hex');
function deferred() {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};}
async function fixture() {
  const dist = resolve(__dirname, '../../dist');
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      let path = resolve(dist, '.' + url.pathname);
      if (relative(dist, path).startsWith('..') || !extname(path)) path = join(dist, 'index.html');
      const body = await readFile(path);
      response.writeHead(200, {'Content-Type': {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml'}[extname(path)] || 'application/octet-stream'});
      response.end(body);
    } catch {response.writeHead(404); response.end();}
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({headless: true, executablePath: chrome});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const projects = ['book-a', 'book-b'].map(id => ({id, title: id, metadata: {}, updated_at: '2026-09-28T00:00:00Z',
    chapterCount: 2, plannedChapterCount: 2, approvedCount: 0, blockedCount: 0, publishReadyCount: 0,
    completionMode: 'open_ended', targetChapterCount: null, latestWorkflow: null, activeJob: null, legacy: false}));
  const files = new Map();
  for (const project of projects) for (const n of [1, 2]) files.set(`C:/mock/books/${project.id}/drafts/chapter-000${n}.md`, `${project.id} chapter ${n} original`);
  const detail = id => ({book: projects.find(p => p.id === id), chapters: [], workflows: [], findings: [], outline: {},
    files: [...files.keys()].filter(path => path.includes(`/${id}/`)).map(path => ({path, name: path.split('/').pop(), size: 20,
      category: 'drafts', categoryLabel: '正文', editable: true, modifiedAt: '2026-09-28T00:00:00Z'}))});
  const state = {getGate: null, putGate: null, lastPut: null, recovery: {entries: [], truncated: false}, recoveryMethods: []};
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let value;
    if (url.pathname === '/api/projects') value = projects;
    else if (/^\/api\/projects\/book-[ab]$/.test(url.pathname)) value = detail(url.pathname.split('/').pop());
    else if (url.pathname === '/api/authors') value = {authors: []};
    else if (url.pathname === '/api/settings') value = {};
    else if (url.pathname === '/api/runtime/recovery') {state.recoveryMethods.push(request.method()); value = state.recovery;}
    else if (url.pathname === '/api/metrics/stages') value = {stages: [], runtime: {}};
    else if (url.pathname === '/api/backups') value = {snapshots: []};
    else if (url.pathname === '/api/fanqie/session') value = {status: 'auth_required'};
    else if (url.pathname.endsWith('/quality-lab')) value = {baselines: [], runs: []};
    else if (url.pathname.endsWith('/reader-feedback')) value = {feedback: []};
    else if (url.pathname === '/api/files' && request.method() === 'GET') {
      const path = url.searchParams.get('path');
      const content = files.get(path);
      assert.equal(typeof content, 'string');
      const gate = state.getGate;
      if (gate && gate.path === path) {gate.started.resolve(); await gate.release.promise;}
      if (gate?.path === path && gate.status >= 400) return route.fulfill({status: gate.status, json: {error: 'Fixture read failed'}});
      value = {content, hash: hash(content), editable: true};
    } else if (url.pathname === '/api/files' && request.method() === 'PUT') {
      const body = request.postDataJSON(); state.lastPut = body;
      assert.equal(body.expectedHash, hash(files.get(body.path)));
      const gate = state.putGate;
      if (!gate || !gate.status || gate.status < 400) files.set(body.path, body.content);
      if (gate) {gate.started.resolve(); await gate.release.promise;}
      if (gate?.status >= 400) return route.fulfill({status: gate.status, json: {error: 'Fixture save failed'}});
      value = {hash: hash(body.content)};
    } else {value = {};}
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(value)});
  });
  await page.goto(origin + '/books/book-a/workspace');
  const editor = page.locator('.editor-panel textarea');
  await editor.waitFor();
  await page.waitForFunction(() => document.querySelector('.editor-panel textarea')?.value === 'book-a chapter 1 original');
  return {page, editor, state, files, errors, close: async () => {
    state.getGate?.release.resolve(); state.putGate?.release.resolve();
    await browser.close(); await new Promise(r => server.close(r));
  }};
}

uiTest('recovery diagnostics show empty and pending states without executing a recovery', async () => {
  const f = await fixture();
  try {
    await f.page.getByRole('navigation', {name: '主导航'}).getByRole('button', {name: '系统设置', exact: true}).click();
    const panel = f.page.getByRole('region', {name: '事务恢复诊断'});
    await panel.getByText('未发现未完成的作品事务。', {exact: true}).waitFor();
    f.state.recovery = {entries: [{marker: 'C:/mock/.tomota-locks/fixture.owner.json', bookId: 'book-a', scope: 'file', state: 'unconfirmed', message: '存在未完成事务，可能仍在执行；请先退出所有写入者再恢复。', command: "& 'C:/mock/python.exe' -m tomota.book_transaction --recover"}], truncated: false};
    await f.page.reload();
    await f.page.getByRole('alert').filter({hasText: '检测到 1 条未完成事务记录'}).waitFor();
    await panel.getByText('book-a · 单文件事务', {exact: true}).waitFor();
    assert.match(await panel.textContent(), /退出所有写入者后/);
    assert.match(await panel.locator('pre').textContent(), /--recover/);
    assert.equal(await panel.getByRole('button').count(), 1, 'only explicit diagnostic refresh is offered');
    f.state.recovery = {entries: [], truncated: false};
    await panel.getByRole('button', {name: '刷新事务诊断', exact: true}).click();
    await panel.getByText('未发现未完成的作品事务。', {exact: true}).waitFor();
    assert.ok(f.state.recoveryMethods.every(method => method === 'GET'));
    f.state.recovery = {};
    await f.page.reload();
    await f.page.getByRole('alert').filter({hasText: '无法检查事务恢复记录'}).waitFor();
    await panel.getByRole('alert').filter({hasText: '诊断响应格式无效'}).waitFor();
    assert.deepEqual(f.errors, []);
  } finally {await f.close();}
});

uiTest('F20: an old file response must not re-enter the editor after switching books', async () => {
  const f = await fixture();
  try {
    const gate = {path: 'C:/mock/books/book-a/drafts/chapter-0002.md', started: deferred(), release: deferred()};
    f.state.getGate = gate;
    const lateResponse = f.page.waitForResponse(response => new URL(response.url()).searchParams.get('path') === gate.path);
    await f.page.locator('.file-list').getByText('chapter-0002.md', {exact: true}).click();
    await gate.started.promise;
    await f.page.getByLabel('当前作品').selectOption('book-b');
    await f.page.waitForFunction(() => document.querySelector('.editor-panel textarea')?.value === 'book-b chapter 1 original');
    gate.release.resolve();
    await (await lateResponse).finished();
    await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const observed = {probe: 'F20', selectedBook: await f.page.getByLabel('当前作品').inputValue(),
      editor: await f.editor.inputValue(), selectedFile: await f.page.locator('.editor-head strong').textContent(), errors: f.errors};
    // Saving from the B workspace must still address B after the stale response.
    await f.editor.fill('User edit made while book B is selected');
    await f.page.getByRole('button', {name: '保存版本', exact: true}).click();
    await f.page.waitForFunction(() => !document.querySelector('.editor-head button.primary').disabled);
    observed.savedPath = f.state.lastPut?.path;
    console.log(JSON.stringify(observed));
    assert.deepEqual(f.errors, []);
    assert.equal(observed.editor, 'book-b chapter 1 original');
    assert.ok(observed.savedPath.includes('/book-b/'), 'book B UI submitted a write to book A');
  } finally {await f.close();}
});

uiTest('F21: save acknowledgement must preserve edits typed while save is in flight', async () => {
  const f = await fixture();
  try {
    const gate = {started: deferred(), release: deferred()}; f.state.putGate = gate;
    await f.editor.fill('First edit sent for saving');
    await f.page.getByRole('button', {name: '保存版本', exact: true}).click();
    await gate.started.promise;
    await f.editor.fill('Second edit typed before save acknowledgement');
    gate.release.resolve();
    await f.page.waitForFunction(() => !document.querySelector('.editor-head button.primary').disabled);
    const observed = {probe: 'F21', editor: await f.editor.inputValue(), saved: f.files.get('C:/mock/books/book-a/drafts/chapter-0001.md'), errors: f.errors};
    console.log(JSON.stringify(observed));
    assert.deepEqual(f.errors, []);
    assert.equal(observed.editor, 'Second edit typed before save acknowledgement', 'newer unsaved typing was discarded');
    assert.equal(observed.saved, 'First edit sent for saving');
    assert.match(await f.page.locator('.editor-foot').textContent(), /尚未保存/);
    f.state.putGate = null;
    await f.page.getByRole('button', {name: '保存版本', exact: true}).click();
    await f.page.waitForFunction(() => !document.querySelector('.editor-head button.primary').disabled);
    assert.equal(f.files.get('C:/mock/books/book-a/drafts/chapter-0001.md'), observed.editor, 'second save must use the acknowledged hash');
    assert.doesNotMatch(await f.page.locator('.editor-foot').textContent(), /尚未保存/);
  } finally {await f.close();}
});

for (const status of [200, 500]) {
  uiTest(`late file response (${status}) cannot replace a newer selection within the same book`, async () => {
    const f = await fixture();
    try {
      const gate = {path: 'C:/mock/books/book-a/drafts/chapter-0002.md', status, started: deferred(), release: deferred()};
      f.state.getGate = gate;
      const response = f.page.waitForResponse(r => new URL(r.url()).searchParams.get('path') === gate.path);
      await f.page.locator('.file-list').getByText('chapter-0002.md', {exact: true}).click();
      await gate.started.promise;
      await f.page.locator('.file-list').getByText('chapter-0001.md', {exact: true}).click();
      await f.page.waitForFunction(() => document.querySelector('.editor-panel textarea')?.value === 'book-a chapter 1 original');
      gate.release.resolve(); await settled(f.page, response);
      assert.equal(await f.editor.inputValue(), 'book-a chapter 1 original');
      assert.equal(await f.page.locator('.editor-panel .assistant-error').count(), 0);
      assert.deepEqual(f.errors, []);
    } finally {await f.close();}
  });

  uiTest(`late save acknowledgement (${status}) cannot alter another book or its save state`, async () => {
    const f = await fixture();
    try {
      const gate = {status, started: deferred(), release: deferred()}; f.state.putGate = gate;
      const response = f.page.waitForResponse(r => r.request().method() === 'PUT');
      await f.editor.fill('Book A pending save');
      await f.page.getByRole('button', {name: '保存版本', exact: true}).click();
      await gate.started.promise;
      await f.page.getByLabel('当前作品').selectOption('book-b');
      await f.page.waitForFunction(() => document.querySelector('.editor-panel textarea')?.value === 'book-b chapter 1 original');
      await f.editor.fill('Book B independent edit');
      f.state.putGate = null;
      await f.page.getByRole('button', {name: '保存版本', exact: true}).click();
      await f.page.waitForFunction(() => !document.querySelector('.editor-head button.primary').disabled);
      gate.release.resolve(); await settled(f.page, response);
      assert.equal(await f.page.getByLabel('当前作品').inputValue(), 'book-b');
      assert.equal(await f.editor.inputValue(), 'Book B independent edit');
      assert.equal(f.files.get('C:/mock/books/book-b/drafts/chapter-0001.md'), 'Book B independent edit');
      assert.equal(await f.page.locator('.editor-panel .assistant-error').count(), 0);
      assert.deepEqual(f.errors, []);
    } finally {await f.close();}
  });
}

uiTest('failed save preserves newer typing and allows a safe retry', async () => {
  const f = await fixture();
  try {
    const gate = {status: 409, started: deferred(), release: deferred()}; f.state.putGate = gate;
    await f.editor.fill('First edit');
    await f.page.getByRole('button', {name: '保存版本', exact: true}).click();
    await gate.started.promise;
    await f.editor.fill('Newer edit during failed save');
    gate.release.resolve();
    await f.page.waitForFunction(() => !document.querySelector('.editor-head button.primary').disabled);
    assert.equal(await f.editor.inputValue(), 'Newer edit during failed save');
    assert.equal(await f.page.locator('.editor-panel .assistant-error').count(), 1);
    f.state.putGate = null;
    await f.page.getByRole('button', {name: '保存版本', exact: true}).click();
    await f.page.waitForFunction(() => !document.querySelector('.editor-head button.primary').disabled);
    assert.equal(f.files.get('C:/mock/books/book-a/drafts/chapter-0001.md'), 'Newer edit during failed save');
    assert.deepEqual(f.errors, []);
  } finally {await f.close();}
});

uiTest('returning to book A does not revive an earlier A file request', async () => {
  const f = await fixture();
  try {
    const gate = {path: 'C:/mock/books/book-a/drafts/chapter-0002.md', started: deferred(), release: deferred()}; f.state.getGate = gate;
    const response = f.page.waitForResponse(r => new URL(r.url()).searchParams.get('path') === gate.path);
    await f.page.locator('.file-list').getByText('chapter-0002.md', {exact: true}).click();
    await gate.started.promise;
    for (const book of ['book-b', 'book-a']) {
      await f.page.getByLabel('当前作品').selectOption(book);
      await f.page.waitForFunction(book => document.querySelector('.editor-panel textarea')?.value === `${book} chapter 1 original`, book);
    }
    gate.release.resolve(); await settled(f.page, response);
    assert.equal(await f.editor.inputValue(), 'book-a chapter 1 original');
    assert.deepEqual(f.errors, []);
  } finally {await f.close();}
});
