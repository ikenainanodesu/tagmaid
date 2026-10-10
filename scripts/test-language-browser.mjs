// 在独立 Chrome / Edge 配置的真实 sidePanel 页面验证；模拟服务仅用于测试副本。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const browserName = process.argv[2] || 'edge';
assert.ok(['chrome', 'edge'].includes(browserName), '浏览器参数必须为 chrome 或 edge');
const executable = browserName === 'chrome'
  ? process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(`test-results/language-${browserName}-${Date.now()}`);
await mkdir(root, { recursive: true });
let apiStatus = 200, pendingResponse, holdResponse = false;
const requests = [], errors = [], layouts = [];
const server = createServer(async (req, res) => {
  if (!req.url.endsWith('/chat/completions')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<title>Tab ${req.url}</title><p>Local test page</p>`); return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body); requests.push(request);
  const send = () => {
    if (apiStatus !== 200) { res.writeHead(apiStatus); res.end('{}'); return; }
    const payload = JSON.parse(request.messages[1].content.split('\n待分类数据：')[1]);
    const title = request.messages[0].content.includes('日本語 (Japanese)') ? '資料' : request.messages[0].content.includes('English') ? 'Reading' : '阅读';
    const existing = payload.mode === 'merge' ? payload.existingGroups[0] : null;
    const content = payload.mode === 'sort-ai' ? { orderedTabIds: payload.tabs.map(t => t.id).reverse() }
      : { groups: [{ title: existing?.title ?? title, color: existing?.color ?? 'blue', existingGroupId: existing?.id ?? null, tabIds: payload.tabs.map(t => t.id) }], ungroupedTabIds: [] };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  };
  if (holdResponse) pendingResponse = send; else send();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const extension = path.join(root, 'extension');
await cp('extension', extension, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const profile = path.join(root, 'profile');
const browser = spawn(executable, [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--lang=en-US',
  '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', `--user-data-dir=${profile}`, 'about:blank'
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let browserLog = '';
browser.stderr.on('data', chunk => { browserLog += chunk; });
let launchError;
browser.on('error', error => { launchError = error; });
let socket, id = 0;
const calls = new Map();
async function waitFor(fn, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(80);
  }
  throw new Error(`等待超时：${label}`);
}
function cdp(method, params = {}, sessionId) {
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { calls.delete(requestId); reject(new Error(`CDP 超时：${method}`)); }, 15000);
    calls.set(requestId, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
    socket.send(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function evaluate(session, expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, session);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
let ui, worker;
const get = expression => evaluate(ui, expression);
const click = selector => get(`document.querySelector(${JSON.stringify(selector)}).click()`);
const select = (selector, value) => get(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const input = (selector, value) => get(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const language = async value => {
  await select('#language', value);
  await waitFor(() => get(`document.documentElement.lang === ${JSON.stringify(value)} && !document.querySelector('#language').disabled`), `语言 ${value}`);
};
try {
  const portFile = await waitFor(async () => {
    if (launchError) throw launchError;
    if (browser.exitCode !== null) throw new Error(`${browserName} 已退出：${browserLog}`);
    try { return await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'); } catch { return null; }
  }, `${browserName} 调试入口`);
  const [port, wsPath] = portFile.trim().split(/\r?\n/);
  let connectionError;
  try {
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch (error) { connectionError = error.cause || error; return false; } }, `${browserName} 调试服务就绪`);
  } catch (error) { console.error({ connectionError, exitCode: browser.exitCode, browserLog }); throw error; }
  socket = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const call = calls.get(message.id); calls.delete(message.id);
      if (message.error) call?.reject(new Error(JSON.stringify(message.error))); else call?.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  });
  // 品牌版 Chrome 不再接受 --load-extension；仅在临时测试配置开启调试加载。
  const { id: extensionId } = await cdp('Extensions.loadUnpacked', { path: extension });
  const target = await waitFor(async () => (await cdp('Target.getTargets')).targetInfos.find(t => t.type === 'service_worker' && t.url === `chrome-extension://${extensionId}/background.js`), '扩展后台');
  worker = (await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  await cdp('Runtime.enable', {}, worker);
  await waitFor(() => evaluate(worker, 'typeof chrome !== "undefined" && Boolean(chrome.runtime?.id)'), '扩展后台初始化');
  const windowId = await evaluate(worker, `(async () => {
    const tabs = [];
    for (const name of ['a', 'b', 'c']) tabs.push(await chrome.tabs.create({url: '${origin}/' + name, active: false}));
    const groupId = await chrome.tabs.group({tabIds: [tabs[2].id]});
    await chrome.tabGroups.update(groupId, {title: '原有 Group 元の組', color: 'green'});
    await chrome.storage.local.set({mode: 'sort-domain'});
    return tabs[0].windowId;
  })()`);
  // 触发真实工具栏 action，避免直接打开 HTML 掩盖入口失效。
  assert.equal((await evaluate(worker, 'chrome.sidePanel.getPanelBehavior()')).openPanelOnActionClick, true);
  const page = (await cdp('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] })).targetInfos.find(t => t.type === 'tab' && t.url === 'about:blank');
  await cdp('Extensions.triggerAction', { id: extensionId, targetId: page.targetId });
  const panel = await waitFor(async () => (await cdp('Target.getTargets')).targetInfos.find(t => t.url === `chrome-extension://${extensionId}/sidepanel.html`), '实际侧栏页面');
  const contexts = await waitFor(async () => {
    const found = await evaluate(worker, 'chrome.runtime.getContexts({contextTypes:["SIDE_PANEL"]})');
    return found.length ? found : null;
  }, 'SIDE_PANEL 执行上下文');
  assert.equal(contexts.length, 1, '必须存在实际 SIDE_PANEL 执行上下文');
  ui = (await cdp('Target.attachToTarget', { targetId: panel.targetId, flatten: true })).sessionId;
  await cdp('Runtime.enable', {}, ui);
  assert.equal(await get('chrome.tabs.getCurrent().then(tab => Boolean(tab))'), false, '实际侧栏不应是普通标签页');
  await waitFor(() => get(`!document.querySelector('#generate').disabled && !document.querySelector('#language').disabled`), '侧栏初始化');
  assert.equal(await get('document.documentElement.lang'), 'en');
  assert.equal(await get('chrome.runtime.getManifest().name'), 'TagMaid · AI Tab Organizer');
  console.log('实际侧栏已打开，首次匹配浏览器英文。');

  // 无 API 配置时切换、生成本地域名排序，保留排除项并真实应用、撤销。
  await language('ja');
  assert.equal(await get(`document.querySelector('#generate').textContent`), '並び順をプレビュー');
  await click('#generate');
  await waitFor(() => get(`!document.querySelector('#preview').hidden && !document.querySelector('#apply').disabled`), '本地预览');
  const excludedId = await get(`document.querySelector('.tab-row').dataset.tabId`);
  await select(`.tab-row[data-tab-id="${excludedId}"] select`, 'keep');
  await language('en');
  assert.equal(await get(`document.querySelector('.tab-row[data-tab-id="${excludedId}"] select').value`), 'keep');
  assert.match(await get(`document.querySelector('#status').textContent`), /Preview ready/);
  assert.equal(requests.length, 0);
  await click('#apply');
  await waitFor(() => get(`!document.querySelector('#undo').disabled && document.querySelector('#preview').hidden`), '排序应用');
  assert.match(await get(`document.querySelector('#status').textContent`), /Organized 1 tabs/);
  await language('ja');
  assert.match(await get(`document.querySelector('#status').textContent`), /1 個のタブを整理/);
  await click('#undo');
  await waitFor(() => get(`document.querySelector('#status').textContent.includes('復元しました')`), '排序撤销');
  await cdp('Page.reload', {}, ui);
  await waitFor(() => get(`document.documentElement.lang === 'ja' && !document.querySelector('#language').disabled`), '语言记忆');
  console.log('独立保存、重载记忆、排序预览保留、应用与撤销通过。');

  await evaluate(worker, `chrome.storage.local.set({settings:{endpoint:'${origin}/v1/chat/completions',model:'local-test',apiKey:'',rememberKey:false},mode:'new'})`);
  await cdp('Page.reload', {}, ui);
  await waitFor(() => get(`!document.querySelector('#generate').disabled && !document.querySelector('#language').disabled && document.querySelector('#connection-note').textContent.includes('local-test') && document.querySelector('input[value="new"]').checked`), 'AI 模式');
  holdResponse = true;
  await click('#generate');
  await waitFor(() => Boolean(pendingResponse), 'AI 请求');
  await language('en');
  assert.match(await get(`document.querySelector('#status').textContent`), /AI is analyzing/);
  pendingResponse(); pendingResponse = undefined; holdResponse = false;
  await waitFor(() => get(`!document.querySelector('#preview').hidden && !document.querySelector('#apply').disabled`), 'AI 预览');
  assert.equal(await get(`document.querySelector('.group-header input').value`), '資料');
  await input('.group-header input', '我的 Group 手動');
  await select('.group-header select', 'pink');
  await input('#instruction', '请用法语命名');
  await language('zh-CN');
  assert.equal(await get(`document.querySelector('.group-header input').value`), '我的 Group 手動');
  assert.equal(await get(`document.querySelector('.group-header select').value`), 'pink');
  assert.equal(await get(`document.querySelector('#instruction').value`), '请用法语命名');
  // 后台校验错误跟随当前语言并在切换后重新渲染。
  await input('.group-header input', '');
  await click('#apply');
  await waitFor(() => get(`document.querySelector('#apply-status').textContent.includes('1–60')`), '后台校验错误');
  await language('en');
  assert.equal(await get(`document.querySelector('#apply-status').textContent`), 'New group names must contain 1–60 characters.');
  await input('.group-header input', '我的 Group 手動');

  for (const lang of ['zh-CN', 'ja', 'en']) {
    await language(lang);
    for (const width of [300, 382]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, ui);
      const layout = await get(`({inner: innerWidth, client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight})`);
      layouts.push({ language: lang, width, ...layout });
      assert.ok(layout.scroll <= layout.client, `${lang} ${width}px 出现横向溢出`);
      const shot = await cdp('Page.captureScreenshot', { captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: layout.height, scale: 1 } }, ui);
      await writeFile(path.join(root, `${lang}-${width}.png`), Buffer.from(shot.data, 'base64'));
    }
  }
  await click('#apply');
  await waitFor(() => get(`document.querySelector('#preview').hidden && !document.querySelector('#undo').disabled`), '分组应用');
  const groups = await evaluate(worker, 'chrome.tabGroups.query({})');
  assert.ok(groups.some(g => g.title === '我的 Group 手動' && g.color === 'pink'));
  assert.ok(groups.some(g => g.title === '原有 Group 元の組' && g.color === 'green'));
  await click('#undo');
  await waitFor(() => get(`document.querySelector('#status').textContent.includes('Restored')`), '分组撤销');
  console.log('生成期间切换、编辑保留、后台错误三语显示、300/382px 布局、分组应用与撤销通过。');

  await language('en');
  await click('#generate');
  await waitFor(() => get(`!document.querySelector('#preview').hidden && !document.querySelector('#apply').disabled`), '英文 AI 请求');
  assert.match(requests.at(-1).messages[0].content, /新组名默认使用 English/);
  assert.match(requests.at(-1).messages[1].content, /请用法语命名/);
  await click('#discard');
  apiStatus = 429;
  await click('#generate');
  await waitFor(() => get(`document.querySelector('#status').textContent.includes('429')`), 'API 错误');
  assert.match(await get(`document.querySelector('#status').textContent`), /insufficient quota/);
  await language('ja');
  assert.match(await get(`document.querySelector('#status').textContent`), /利用枠/);
  apiStatus = 200;
  await language('en');
  // 补齐所有模式的真实浏览器状态验证；撤销可能重建 groupId，按属性和成员比较。
  const state = () => evaluate(worker, `(async () => {
    const tabs = await chrome.tabs.query({windowId: ${windowId}});
    const groups = await chrome.tabGroups.query({windowId: ${windowId}});
    return tabs.sort((a, b) => a.index - b.index).map(tab => {
      const group = groups.find(g => g.id === tab.groupId);
      return {id: tab.id, pinned: tab.pinned, group: group ? {title: group.title, color: group.color, collapsed: group.collapsed} : null};
    });
  })()`);
  const modes = ['rebuild', 'new', 'merge', 'sort-ai', 'sort-domain'];
  for (const mode of modes) {
    await click(`input[value="${mode}"]`);
    await waitFor(() => get(`!document.querySelector('#generate').disabled`), `${mode} 就绪`);
    const before = await state();
    const requestCount = requests.length;
    await click('#generate');
    await waitFor(() => get(`!document.querySelector('#preview').hidden && !document.querySelector('#apply').disabled`), `${mode} 预览`);
    const previewIds = await get(`[...document.querySelectorAll('.tab-row')].map(row => Number(row.dataset.tabId))`);
    await click('#apply');
    await waitFor(() => get(`document.querySelector('#preview').hidden && !document.querySelector('#undo').disabled`), `${mode} 应用`);
    const after = await state();
    if (mode.startsWith('sort-')) {
      assert.deepEqual(after.slice(-previewIds.length).map(t => t.id), previewIds, `${mode} 必须按预览顺序排列`);
      assert.deepEqual(after.filter(t => t.group), before.filter(t => t.group), `${mode} 必须保留已有组`);
    } else {
      assert.ok(after.filter(t => previewIds.includes(t.id)).every(t => t.group), `${mode} 必须分组`);
      if (mode === 'merge') assert.ok(after.filter(t => previewIds.includes(t.id)).every(t => t.group.title === '原有 Group 元の組' && t.group.color === 'green'));
    }
    assert.equal(requests.length - requestCount, mode === 'sort-domain' ? 0 : 1);
    await click('#undo');
    await waitFor(() => get(`document.querySelector('#status').textContent.includes('Restored')`), `${mode} 撤销`);
    assert.deepEqual(await state(), before, `${mode} 撤销必须恢复顺序、成员和组属性`);
  }
  console.log('五种模式的预览、实际标签状态与撤销恢复全部通过。');
  assert.deepEqual(errors, []);
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ passed: true, browserName, executable, browser: await cdp('Browser.getVersion'), entry: 'Extensions.triggerAction', contextType: contexts[0].contextType, modes, layouts, requests: requests.length, errors }, null, 2));
  console.log(`全部浏览器检查通过。证据：${root}`);
} catch (error) {
  if (ui) {
    try { console.error(await get(`(async () => ({status: document.querySelector('#status').textContent, apply: document.querySelector('#apply-status').textContent, candidates: document.querySelector('#candidate-count').textContent, preview: !document.querySelector('#preview').hidden, disabled: document.querySelector('#generate').disabled, permissions: await chrome.permissions.getAll(), settings: await chrome.storage.local.get('settings')}))()`)); } catch { /* 保留原始错误。 */ }
  }
  throw error;
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    try { await cdp('Browser.close'); } catch { /* 浏览器可能先断开连接。 */ }
    socket.close();
  }
  browser.kill();
  server.closeAllConnections();
  server.close();
}
