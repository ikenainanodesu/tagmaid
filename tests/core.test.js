import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanUrl, apiEndpoint, candidates, payloadFor, parseAnswer, sameState, validatePlan, reconcilePreview, domainPlan } from '../extension/core.js';
import { requestPlan } from '../extension/api.js';

export const snapshot = {
  windowId: 7,
  tabs: [
    { id: 1, index: 0, pinned: true, groupId: -1, title: '固定', url: 'https://mail.test/' },
    { id: 2, index: 1, pinned: false, groupId: 10, title: '已有', url: 'https://docs.test/intro?token=secret#private' },
    { id: 3, index: 2, pinned: false, groupId: -1, title: '文档', url: 'https://docs.test/guide?key=secret#abc' },
    { id: 4, index: 3, pinned: false, groupId: -1, title: '音乐', url: 'https://music.test/' },
    { id: 5, index: 4, pinned: false, groupId: -1, title: '设置', url: 'edge://settings/' }
  ],
  groups: [{ id: 10, title: '资料', color: 'blue', collapsed: true }]
};
const response = { groups: [{ title: '阅读', color: 'green', existingGroupId: null, tabIds: [3] }], ungroupedTabIds: [4] };

test('网址清理去除查询、片段及嵌入凭据，拒绝内部网址', () => {
  assert.equal(cleanUrl('https://user:pass@example.com/path?secret=yes#token'), 'https://example.com/path');
  for (const url of ['edge://settings/', 'file:///secret', 'javascript:alert(1)', 'invalid']) assert.equal(cleanUrl(url), null);
});
test('接口地址支持基础路径与完整路径，阻止明文公网及查询凭据', () => {
  assert.deepEqual(apiEndpoint('https://api.test/v1/'), { url: 'https://api.test/v1/chat/completions', origin: 'https://api.test/*' });
  assert.equal(apiEndpoint('http://127.0.0.1:8080/v1/chat/completions').url, 'http://127.0.0.1:8080/v1/chat/completions');
  for (const url of ['http://api.test/v1', 'https://api.test/?key=secret', 'https://a:b@api.test/v1', 'ftp://api.test/']) assert.throws(() => apiEndpoint(url));
});
test('三种模式范围及发送数据边界', () => {
  assert.deepEqual(candidates(snapshot, 'rebuild').map(t => t.id), [2, 3, 4]);
  for (const mode of ['new', 'merge', 'sort-ai', 'sort-domain']) assert.deepEqual(candidates(snapshot, mode).map(t => t.id), [3, 4]);
  assert.equal(payloadFor(snapshot, 'new').existingGroups.length, 0);
  const payload = payloadFor(snapshot, 'merge');
  assert.equal(payload.existingGroups[0].tabs[0].url, 'https://docs.test/intro');
  assert.ok(!JSON.stringify(payload).includes('secret'));
});
test('接收严格 JSON 和代码围栏，要求全量唯一标签', () => {
  const plan = parseAnswer('```json\n' + JSON.stringify(response) + '\n```', snapshot, 'new');
  assert.equal(plan.assignments[3], 'new:0'); assert.equal(plan.assignments[4], 'none');
  for (const change of [
    r => r.groups[0].tabIds.push(1),
    r => r.groups[0].tabIds.push(999),
    r => r.ungroupedTabIds.push(3),
    r => r.ungroupedTabIds = [],
    r => r.groups[0].color = 'malicious',
    r => r.groups[0].title = ''
  ]) { const r = structuredClone(response); change(r); assert.throws(() => parseAnswer(JSON.stringify(r), snapshot, 'new')); }
});
test('仅模式三允许加入已有组，原有名称颜色不受 AI 改写', () => {
  const r = structuredClone(response); r.groups[0].existingGroupId = 10;
  assert.throws(() => parseAnswer(JSON.stringify(r), snapshot, 'new'));
  const plan = parseAnswer(JSON.stringify(r), snapshot, 'merge');
  assert.equal(plan.groups[0].title, '资料'); assert.equal(plan.groups[0].color, 'blue');
  plan.assignments[4] = 'keep'; assert.doesNotThrow(() => validatePlan(plan, snapshot, 'merge'));
});
test('过期预览检测覆盖顺序、分组、URL、固定和组属性', () => {
  assert.ok(sameState(snapshot, structuredClone(snapshot)));
  for (const change of [s => s.tabs.pop(), s => s.tabs[2].index++, s => s.tabs[2].url += '#changed', s => s.tabs[2].pinned = true, s => s.groups[0].title = '改名']) {
    const next = structuredClone(snapshot); change(next); assert.ok(!sameState(snapshot, next));
  }
});
test('请求只发送清理后的元数据，使用自填模型且不跟随重定向', async () => {
  await requestPlan({ endpoint: 'https://api.test/v1', model: 'my-model', apiKey: 'private-key' }, snapshot, 'new', '按项目分', undefined, async (url, opts) => {
    assert.equal(url, 'https://api.test/v1/chat/completions');
    assert.equal(opts.redirect, 'error');
    assert.equal(opts.headers.Authorization, 'Bearer private-key');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'my-model');
    assert.ok(!opts.body.includes('secret')); assert.ok(!opts.body.includes('private-key'));
    assert.ok(body.messages[1].content.includes('按项目分'));
    return Response.json({ choices: [{ message: { content: JSON.stringify(response) } }] });
  });
});
test('HTTP、取消、非法响应和截断均转为可读错误', async () => {
  const settings = { endpoint: 'https://api.test/v1', model: 'model' };
  for (const status of [401, 403, 404, 429, 500]) await assert.rejects(requestPlan(settings, snapshot, 'new', '', undefined, async () => new Response('', { status })), new RegExp(String(status)));
  await assert.rejects(requestPlan(settings, snapshot, 'new', '', undefined, async () => new Response('bad')), /无法解析/);
  await assert.rejects(requestPlan(settings, snapshot, 'new', '', undefined, async () => Response.json({ choices: [{ finish_reason: 'length' }] })), /截断/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestPlan(settings, snapshot, 'new', '', controller.signal, async () => { throw new Error(); }), /已取消/);
});
test('响应头已到达后取消，读取响应体失败仍报告取消', async () => {
  const controller = new AbortController();
  await assert.rejects(requestPlan({ endpoint: 'https://api.test/v1', model: 'model' }, snapshot, 'new', '', controller.signal, async () => ({
    ok: true,
    json: async () => { controller.abort(); throw new Error('body aborted'); }
  })), /已取消/);
});

test('预览对账剔除关闭、移窗和固定标签，保留手动调整及待编辑空组', () => {
  const original = structuredClone(snapshot);
  original.tabs.push({ id: 6, pinned: false, groupId: -1, url: 'https://other.test/' });
  const p = parseAnswer(JSON.stringify({ ...response, ungroupedTabIds: [4, 6] }), original, 'new');
  p.groups[0].title = '用户修改'; p.groups[0].color = 'pink';
  p.groups.push({ key: 'new:manual', title: '', color: 'blue', existingGroupId: null });
  const current = structuredClone(original); current.tabs = current.tabs.filter(t => t.id !== 4);
  current.tabs.find(t => t.id === 6).pinned = true;
  current.tabs.push({ id: 9, pinned: false, groupId: -1, url: 'https://added.test/' });
  const result = reconcilePreview(original, current, 'new', p);
  assert.equal(result.skipped, 2); assert.equal(result.added, 1); assert.equal(result.conflict, '');
  assert.deepEqual(result.plan.assignments, { 3: 'new:0' });
  assert.equal(result.plan.groups[0].title, '用户修改'); assert.equal(result.plan.groups[0].color, 'pink');
  assert.equal(result.plan.groups[1].key, 'new:manual');
  current.tabs = current.tabs.filter(t => t.id !== 3);
  const empty = reconcilePreview(original, current, 'new', p);
  assert.equal(empty.included, 0); assert.deepEqual(empty.plan.groups.map(g => g.key), ['new:manual']);
});

test('已排除标签的导航不阻断其余标签，其他标签导航仍提示冲突', () => {
  const p = parseAnswer(JSON.stringify(response), snapshot, 'new'); p.assignments[4] = 'keep';
  const current = structuredClone(snapshot); current.tabs.find(t => t.id === 4).url = 'https://changed.test/';
  assert.equal(reconcilePreview(snapshot, current, 'new', p).conflict, '');
  current.tabs.find(t => t.id === 3).url = 'https://changed.test/';
  assert.match(reconcilePreview(snapshot, current, 'new', p).conflict, /网页或分组已经变化/);
});

test('域名排序使用完整主机名并保持同域原序，不调用 API 或要求配置', async () => {
  const s = structuredClone(snapshot);
  s.tabs.push({ id: 6, index: 5, groupId: -1, url: 'https://docs.test/other' },
    { id: 7, index: 6, groupId: -1, url: 'https://a.docs.test/' },
    { id: 8, index: 7, groupId: -1, url: 'https://www.docs.test/' });
  s.tabs.reverse();
  const p = await requestPlan({}, s, 'sort-domain', '', undefined, () => { throw new Error('不应联网'); });
  assert.deepEqual(p.orderedTabIds, [7, 3, 6, 4, 8]);
  assert.deepEqual(p.groups, []);
  assert.doesNotThrow(() => validatePlan(p, s, 'sort-domain'));
});

test('AI 排序保存模型顺序，拒绝遗漏、重复、未知及范围外标签', () => {
  const p = parseAnswer('{"orderedTabIds":[4,3]}', snapshot, 'sort-ai');
  assert.deepEqual(p.orderedTabIds, [4, 3]);
  for (const order of [[3], [3, 3], [4, 999], [2, 3, 4], ['3', 4], [4, 3, 4]]) {
    assert.throws(() => parseAnswer(JSON.stringify({ orderedTabIds: order }), snapshot, 'sort-ai'));
  }
  assert.throws(() => parseAnswer(JSON.stringify(response), snapshot, 'sort-ai'));
  assert.throws(() => validatePlan({ ...p, groups: [{ key: 'new:0' }] }, snapshot, 'sort-ai'));
  assert.throws(() => validatePlan({ ...p, assignments: { 3: 'new:0', 4: 'none' } }, snapshot, 'sort-ai'));
});

test('AI 排序请求只发送候选元数据，要求独立的顺序数组', async () => {
  const p = await requestPlan({ endpoint: 'https://api.test/v1', model: 'model' }, snapshot, 'sort-ai', '资料优先', undefined, async (_url, opts) => {
    const body = JSON.parse(opts.body);
    assert.match(body.messages[0].content, /orderedTabIds/);
    assert.match(body.messages[1].content, /资料优先/);
    assert.ok(!opts.body.includes('secret'));
    assert.deepEqual(payloadFor(snapshot, 'sort-ai').existingGroups, []);
    return Response.json({ choices: [{ message: { content: '{"orderedTabIds":[4,3]}' } }] });
  });
  assert.deepEqual(p.orderedTabIds, [4, 3]);
});

test('排序预览对账保留顺序与排除项，剔除失效标签且不加入新增标签', () => {
  const original = structuredClone(snapshot);
  original.tabs.push({ id: 6, index: 5, groupId: -1, url: 'https://other.test/' });
  const p = parseAnswer('{"orderedTabIds":[6,4,3]}', original, 'sort-ai');
  p.assignments[3] = 'keep';
  const current = structuredClone(original);
  current.tabs = current.tabs.filter(t => t.id !== 4);
  current.tabs.push({ id: 7, index: 6, groupId: -1, url: 'https://new.test/' });
  const r = reconcilePreview(original, current, 'sort-ai', p);
  assert.deepEqual(r.plan.orderedTabIds, [6, 3]);
  assert.equal(r.plan.assignments[3], 'keep');
  assert.equal(r.skipped, 1); assert.equal(r.added, 1); assert.equal(r.included, 1);
  assert.doesNotThrow(() => validatePlan(r.plan, r.snapshot, 'sort-ai'));
  current.tabs.find(t => t.id === 6).groupId = 10;
  assert.match(reconcilePreview(original, current, 'sort-ai', p).conflict, /分组已经变化/);
  assert.deepEqual(domainPlan(snapshot).orderedTabIds, [3, 4]);
});
