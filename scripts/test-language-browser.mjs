// 在独立 Edge 配置的真实 sidePanel 页面验证；模拟服务仅用于测试副本。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(`test-results/language-${Date.now()}`);
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
    const content = payload.mode === 'sort-ai' ? { orderedTabIds: payload.tabs.map(t => t.id).reverse() }
      : { groups: [{ title, color: 'blue', existingGroupId: null, tabIds: payload.tabs.map(t => t.id) }], ungroupedTabIds: [] };
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
const edge = spawn(process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--lang=en-US',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, 'about:blank'
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let browserLog = '';
edge.stderr.on('data', chunk => { browserLog += chunk; });
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
  const portFile = await waitFor(async () => { try { return await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'); } catch { return null; } }, 'Edge 调试入口');
  const [port, wsPath] = portFile.trim().split(/\r?\n/);
  let connectionError;
  try {
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch (error) { connectionError = error.cause || error; return false; } }, 'Edge 调试服务就绪');
  } catch (error) { console.error({ connectionError, exitCode: edge.exitCode, browserLog }); throw error; }
  socket = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const call = calls.get(message.id); calls.delete(message.id);
      if (message.error) call?.reject(new Error(JSON.stringify(message.error))); else call?.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  });
  const target = await waitFor(async () => (await cdp('Target.getTargets')).targetInfos.find(t => t.type === 'service_worker' && t.url.endsWith('/background.js')), '扩展后台');
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
  // 在扩展页中提供一次浏览器用户手势，再连接实际侧栏的独立 target。
  const bootstrap = await cdp('Target.createTarget', { url: target.url.replace('background.js', 'sidepanel.html') });
  const bootstrapSession = (await cdp('Target.attachToTarget', { targetId: bootstrap.targetId, flatten: true })).sessionId;
  await waitFor(() => evaluate(bootstrapSession, 'typeof chrome !== "undefined" && Boolean(chrome.sidePanel)'), '侧栏打开入口');
  await evaluate(bootstrapSession, `chrome.sidePanel.open({windowId: ${windowId}})`);
  const panel = await waitFor(async () => (await cdp('Target.getTargets')).targetInfos.find(t => t.url.endsWith('/sidepanel.html') && t.targetId !== bootstrap.targetId), '实际侧栏页面');
  await cdp('Target.closeTarget', { targetId: bootstrap.targetId });
  const contexts = await evaluate(worker, 'chrome.runtime.getContexts({contextTypes:["SIDE_PANEL"]})');
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
  assert.deepEqual(errors, []);
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ passed: true, browser: await cdp('Browser.getVersion'), contextType: contexts[0].contextType, layouts, requests: requests.length, errors }, null, 2));
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
  edge.kill();
  server.closeAllConnections();
  server.close();
}
