import test from 'node:test';
import assert from 'node:assert/strict';
import { duplicateSnapshot, duplicateGroups, scanDuplicates, closeDuplicates, duplicateKey } from '../extension/duplicates.js';

function browser() {
  const tab = (id, windowId, url, extra = {}) => ({ id, windowId, index: id, url, title: `页面 ${id}`, pinned: false, active: false, groupId: -1, ...extra });
  const windows = [
    { id: 1, type: 'normal', incognito: false, focused: true, tabs: [tab(1, 1, 'https://a.test/', { active: true }), tab(2, 1, 'https://a.test/'), tab(3, 1, 'https://b.test/')] },
    { id: 2, type: 'normal', incognito: false, focused: false, tabs: [tab(4, 2, 'https://a.test/', { active: true }), tab(5, 2, 'https://a.test/', { pinned: true }), tab(6, 2, 'https://b.test/')] },
    { id: 3, type: 'normal', incognito: true, focused: false, tabs: [tab(7, 3, 'https://a.test/')] },
    { id: 4, type: 'popup', incognito: false, focused: false, tabs: [tab(8, 4, 'https://a.test/')] }
  ];
  const store = {}, removals = [];
  let failAfter = Infinity;
  const api = {
    windows: { getAll: async () => structuredClone(windows) },
    tabGroups: { query: async () => [] },
    tabs: {
      query: async () => structuredClone(windows.flatMap(win => win.tabs)),
      remove: async ids => {
        removals.push([...ids]);
        for (const id of ids) {
          if (failAfter-- <= 0) throw new Error('模拟关闭失败');
          for (const win of windows) win.tabs = win.tabs.filter(tab => tab.id !== id);
        }
      }
    },
    storage: { session: {
      get: async key => ({ [key]: structuredClone(store[key]) }),
      set: async values => Object.assign(store, structuredClone(values)),
      remove: async key => { delete store[key]; }
    } }
  };
  return { api, windows, store, removals, tab, fail: count => { failAfter = count; } };
}

test('跨普通窗口检测，排除隐私、弹窗和内部页，保留完整网址差异', async () => {
  const b = browser();
  b.windows[0].tabs.push(...['https://a.test/?x=1', 'https://a.test/#x', 'http://a.test/', 'file:///a', 'edge://settings', 'invalid'].map((url, i) => b.tab(20 + i, 1, url)));
  const snapshot = await duplicateSnapshot(b.api);
  assert.equal(snapshot.tabs.length, 9);
  const groups = duplicateGroups(snapshot, 2);
  assert.deepEqual(groups.map(g => g.tabs.map(t => t.id)), [[1, 2, 4, 5], [3, 6]]);
  assert.deepEqual(groups.map(g => g.closeIds), [[2, 4], [3]], '只默认保护前台激活页；侧栏所在窗口优先保留');
  assert.deepEqual(duplicateGroups(snapshot, 99)[1].closeIds, [6], '没有侧栏窗口候选时按稳定顺序保留');
});

test('可手动关闭固定页、前台激活页和整组，不改变整理撤销记录', async () => {
  const b = browser(); b.store['undo:1'] = { status: 'ready' };
  const preview = await scanDuplicates(b.api, 1);
  const result = await closeDuplicates(b.api, 1, preview.id, [1, 2, 4, 5]);
  assert.deepEqual(result, { closed: 4, skippedGroups: 0, failed: 0 });
  assert.deepEqual(b.removals, [[1, 2, 4, 5]]);
  assert.deepEqual(b.store['undo:1'], { status: 'ready' });
  assert.equal(b.store[duplicateKey(1)], undefined);
  await assert.rejects(closeDuplicates(b.api, 1, preview.id, [3]), /预览已失效/);
});

for (const [label, mutate] of [
  ['保留页导航', b => { b.windows[0].tabs[0].url += '?changed'; }],
  ['保留页关闭', b => { b.windows[0].tabs.shift(); }],
  ['移窗', b => { const tab = b.windows[0].tabs.shift(); tab.windowId = 2; b.windows[1].tabs.push(tab); }],
  ['固定状态变化', b => { b.windows[0].tabs[0].pinned = true; }],
  ['后台窗口激活页变化', b => { b.windows[1].tabs[0].active = false; }],
  ['组归属变化', b => { b.windows[0].tabs[0].groupId = 99; }],
  ['导航待提交', b => { b.windows[0].tabs[0].pendingUrl = 'https://new.test/'; }],
  ['新增相同网址', b => { b.windows[1].tabs.push(b.tab(90, 2, 'https://a.test/')); }]
]) test(`${label}跳过整组，其他有效组继续`, async () => {
  const b = browser(), preview = await scanDuplicates(b.api, 1);
  mutate(b);
  const result = await closeDuplicates(b.api, 1, preview.id, [2, 6]);
  assert.deepEqual(result, { closed: 1, skippedGroups: 1, failed: 0 });
  assert.deepEqual(b.removals, [[6]]);
});

test('前台窗口变化跳过全部选中组', async () => {
  const b = browser(), preview = await scanDuplicates(b.api, 1);
  b.windows[0].focused = false; b.windows[1].focused = true;
  assert.deepEqual(await closeDuplicates(b.api, 1, preview.id, [2, 6]), { closed: 0, skippedGroups: 2, failed: 0 });
  assert.deepEqual(b.removals, []);
});

test('扫描时正在导航的组不关闭；新增无关网址与标签重排不影响其他组', async () => {
  const b = browser(); b.windows[0].tabs[0].pendingUrl = 'https://a.test/new';
  const preview = await scanDuplicates(b.api, 1);
  delete b.windows[0].tabs[0].pendingUrl;
  b.windows[0].tabs[2].index = 30;
  b.windows[0].tabs.push(b.tab(90, 1, 'https://unrelated.test/'));
  assert.deepEqual(await closeDuplicates(b.api, 1, preview.id, [2, 6]), { closed: 1, skippedGroups: 1, failed: 0 });
});

test('拒绝跨窗口预览编号、任意标签和重复编号，不执行任何关闭', async () => {
  const b = browser(), preview = await scanDuplicates(b.api, 1);
  await assert.rejects(closeDuplicates(b.api, 2, preview.id, [2]), /预览已失效/);
  for (const ids of [[7], [99], [2, 2], ['2'], [], null]) await assert.rejects(closeDuplicates(b.api, 1, preview.id, ids), /选择无效/);
  assert.deepEqual(b.removals, []);
});

test('后台从会话存储恢复预览；部分关闭失败按实际结果报告且不重试', async () => {
  const b = browser(), preview = await scanDuplicates(b.api, 1);
  b.fail(1);
  assert.deepEqual(await closeDuplicates({ ...b.api }, 1, preview.id, [2, 4, 6]), { closed: 1, skippedGroups: 0, failed: 2 });
  assert.equal(b.removals.length, 1);
  await assert.rejects(closeDuplicates(b.api, 1, preview.id, [4, 6]), /预览已失效/);
});

test('重新检测使旧预览失效，零重复时结果为空', async () => {
  const b = browser(), before = await scanDuplicates(b.api, 1);
  await scanDuplicates(b.api, 1);
  await assert.rejects(closeDuplicates(b.api, 1, before.id, [2]), /预览已失效/);
  b.windows.forEach(win => { win.tabs = []; });
  assert.deepEqual((await scanDuplicates(b.api, 1)).groups, []);
});
