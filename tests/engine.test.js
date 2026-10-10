import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPlan, undoLast, takeSnapshot, undoKey } from '../extension/engine.js';

function fakeBrowser() {
  let tabs = [
    { id: 1, index: 0, pinned: true, groupId: -1, url: 'https://pin.test/', title: '固定' },
    { id: 2, index: 1, pinned: false, groupId: 10, url: 'https://a.test/', title: 'A' },
    { id: 3, index: 2, pinned: false, groupId: 10, url: 'https://b.test/', title: 'B' },
    { id: 4, index: 3, pinned: false, groupId: -1, url: 'https://c.test/', title: 'C' },
    { id: 5, index: 4, pinned: false, groupId: -1, url: 'https://d.test/', title: 'D' }
  ];
  let groups = [{ id: 10, title: '原分组', color: 'purple', collapsed: true }];
  let nextId = 20; const store = {}; const calls = [];
  let failUpdate = false, failMoveAfter = -1;
  const reindex = () => tabs.forEach((t, index) => t.index = index);
  const prune = () => groups = groups.filter(g => tabs.some(t => t.groupId === g.id));
  const api = {
    tabs: {
      query: async () => structuredClone(tabs),
      ungroup: async ids => { calls.push('ungroup'); for (const t of tabs) if (ids.includes(t.id)) t.groupId = -1; prune(); },
      group: async ({ tabIds, groupId }) => {
        calls.push('group');
        if (groupId === undefined) { groupId = nextId++; groups.push({ id: groupId, title: '', color: 'grey', collapsed: false }); }
        if (!groups.some(g => g.id === groupId)) throw new Error('missing group');
        const members = tabs.filter(t => tabIds.includes(t.id));
        const originalMembers = tabs.filter(t => t.groupId === groupId && !tabIds.includes(t.id));
        for (const t of members) t.groupId = groupId;
        // 模拟浏览器保证组成员连续。
        const initialIndex = tabs.indexOf(members[0]);
        tabs = tabs.filter(t => !members.includes(t));
        const anchor = originalMembers.length ? tabs.indexOf(originalMembers.at(-1)) + 1 : Math.min(initialIndex, tabs.length);
        tabs.splice(anchor, 0, ...members);
        reindex(); prune(); return groupId;
      },
      move: async (id, { index }) => {
        if (failMoveAfter === 0) { failMoveAfter = -1; throw new Error('模拟移动失败'); }
        if (failMoveAfter > 0) failMoveAfter--;
        const i = tabs.findIndex(t => t.id === id); const [tab] = tabs.splice(i, 1);
        tabs.splice(index === -1 ? tabs.length : index, 0, tab); reindex();
      }
    },
    tabGroups: {
      query: async () => structuredClone(groups),
      update: async (id, update) => { if (failUpdate) { failUpdate = false; throw new Error('模拟失败'); } Object.assign(groups.find(g => g.id === id), update); },
      move: async (id, { index }) => { const members = tabs.filter(t => t.groupId === id); tabs = tabs.filter(t => t.groupId !== id); tabs.splice(index, 0, ...members); reindex(); }
    },
    storage: { session: {
      get: async key => ({ [key]: structuredClone(store[key]) }),
      set: async obj => Object.assign(store, structuredClone(obj)),
      remove: async key => { delete store[key]; }
    } }
  };
  return { api, calls, store, fail: () => { failUpdate = true; }, close: id => { tabs = tabs.filter(t => t.id !== id); reindex(); prune(); }, pin: id => { tabs.find(t => t.id === id).pinned = true; }, mutate: () => { tabs[3].url += '?new'; },
    failMove: count => { failMoveAfter = count; },
    add: (url = 'https://new.test/') => { tabs.splice(1, 0, { id: 6, pinned: false, groupId: -1, url, title: '新标签' }); reindex(); } };
}
const plan = (assignments, existingGroupId = null) => ({ groups: [{ key: existingGroupId === null ? 'new:0' : `existing:${existingGroupId}`, existingGroupId, title: '新组', color: 'green' }], assignments });

for (const mode of ['new', 'merge', 'rebuild']) test(`${mode} 应用与撤销恢复顺序、成员、名称、颜色和折叠`, async () => {
  const { api } = fakeBrowser(); const before = await takeSnapshot(api, 7);
  const p = mode === 'merge' ? plan({ 4: 'existing:10', 5: 'none' }, 10) : mode === 'new' ? plan({ 4: 'new:0', 5: 'none' }) : plan({ 2: 'new:0', 3: 'none', 4: 'new:0', 5: 'keep' });
  await applyPlan(api, before, mode, p);
  let after = await takeSnapshot(api, 7);
  assert.equal(after.tabs.find(t => t.id === 1).groupId, -1);
  if (mode !== 'rebuild') {
    assert.equal(after.tabs.find(t => t.id === 2).groupId, 10);
    assert.deepEqual(after.groups.find(g => g.id === 10), before.groups[0]);
  }
  await undoLast(api, 7); after = await takeSnapshot(api, 7);
  assert.deepEqual(after.tabs.map(t => t.id), before.tabs.map(t => t.id));
  const restoredGroup = after.groups.find(g => g.title === '原分组');
  assert.equal(restoredGroup.color, 'purple'); assert.equal(restoredGroup.collapsed, true);
  assert.deepEqual(after.tabs.filter(t => t.groupId === restoredGroup.id).map(t => t.id), [2, 3]);
  assert.deepEqual(after.tabs.filter(t => t.groupId === -1).map(t => t.id), [1, 4, 5]);
});
test('过期预览在任何修改前被拒绝', async () => {
  const f = fakeBrowser(); const before = await takeSnapshot(f.api, 7); f.mutate();
  await assert.rejects(applyPlan(f.api, before, 'new', plan({ 4: 'new:0', 5: 'none' })), /已经变化/);
  assert.deepEqual(f.calls, []); assert.equal(Object.keys(f.store).length, 0);
});
test('排除部分原组成员且用户随后移动标签，撤销恢复组内原顺序', async () => {
  const f = fakeBrowser(); const before = await takeSnapshot(f.api, 7);
  await applyPlan(f.api, before, 'rebuild', plan({ 2: 'new:0', 3: 'keep', 4: 'new:0', 5: 'none' }));
  await f.api.tabs.ungroup([2]); await f.api.tabs.move(2, { index: 4 });
  await undoLast(f.api, 7);
  const restored = await takeSnapshot(f.api, 7);
  assert.deepEqual(restored.tabs.map(t => t.id), before.tabs.map(t => t.id));
  const groupId = restored.groups.find(g => g.title === '原分组').id;
  assert.deepEqual(restored.tabs.filter(t => t.groupId === groupId).map(t => t.id), [2, 3]);
});
test('应用失败自动回滚，第一次操作不留下虚假的撤销记录', async () => {
  const f = fakeBrowser(); const before = await takeSnapshot(f.api, 7); f.fail();
  await assert.rejects(applyPlan(f.api, before, 'rebuild', plan({ 2: 'new:0', 3: 'new:0', 4: 'none', 5: 'none' })), /已恢复/);
  const after = await takeSnapshot(f.api, 7);
  assert.deepEqual(after.tabs.map(t => t.id), before.tabs.map(t => t.id));
  assert.equal(after.groups[0].title, '原分组'); assert.equal(Object.keys(f.store).length, 0);
});
test('撤销跳过关闭和新固定的标签', async () => {
  const f = fakeBrowser(); const before = await takeSnapshot(f.api, 7);
  await applyPlan(f.api, before, 'new', plan({ 4: 'new:0', 5: 'new:0' })); f.close(4); f.pin(5);
  const result = await undoLast(f.api, 7); assert.equal(result.skipped, 2);
  assert.equal((await takeSnapshot(f.api, 7)).tabs.find(t => t.id === 5).pinned, true);
});
test('中断记录阻止覆盖，重建 engine 后仍可恢复', async () => {
  const f = fakeBrowser(); const before = await takeSnapshot(f.api, 7);
  await f.api.storage.session.set({ [undoKey(7)]: { snapshot: before, managedIds: [4], createdGroupIds: [], status: 'applying' } });
  await assert.rejects(applyPlan(f.api, before, 'new', plan({ 4: 'new:0', 5: 'none' })), /先点击撤销/);
  await undoLast(f.api, 7); assert.equal(f.store[undoKey(7)], undefined);
});

for (const mode of ['new', 'merge', 'rebuild']) test(`${mode} 预览后增删标签仍可应用，撤销保留应用前状态`, async () => {
  const f = fakeBrowser(); const before = await takeSnapshot(f.api, 7);
  const p = mode === 'merge' ? plan({ 4: 'existing:10', 5: 'none' }, 10) : mode === 'new' ? plan({ 4: 'new:0', 5: 'none' }) : plan({ 2: 'new:0', 3: 'none', 4: 'new:0', 5: 'keep' });
  f.close(5); f.add();
  await f.api.tabs.move(4, { index: 1 });
  const atApply = await takeSnapshot(f.api, 7);
  const result = await applyPlan(f.api, before, mode, p);
  assert.equal(result.skipped, 1);
  assert.equal(result.changed, mode === 'rebuild' ? 3 : 1);
  assert.deepEqual(f.store[undoKey(7)].snapshot, atApply);
  assert.equal((await takeSnapshot(f.api, 7)).tabs.find(t => t.id === 6).groupId, -1);
  await undoLast(f.api, 7);
  const after = await takeSnapshot(f.api, 7);
  assert.deepEqual(after.tabs.map(t => t.id), atApply.tabs.map(t => t.id));
  assert.equal(after.tabs.find(t => t.id === 6).groupId, -1);
  assert.ok(!after.tabs.some(t => t.id === 5));
});

test('应用跳过后来固定的标签，全部失效时不创建恢复记录', async () => {
  const f = fakeBrowser(); const before = await takeSnapshot(f.api, 7); f.pin(4);
  const result = await applyPlan(f.api, before, 'new', plan({ 4: 'new:0', 5: 'new:0' }));
  assert.equal(result.changed, 1); assert.equal(result.skipped, 1);
  assert.equal((await takeSnapshot(f.api, 7)).tabs.find(t => t.id === 4).groupId, -1);
  const empty = fakeBrowser(); const original = await takeSnapshot(empty.api, 7); empty.close(4); empty.pin(5);
  await assert.rejects(applyPlan(empty.api, original, 'new', plan({ 4: 'new:0', 5: 'none' })), /没有可应用/);
  assert.deepEqual(empty.calls, []); assert.deepEqual(empty.store, {});
});

test('标签被手动改组或目标组消失仍在修改前拒绝', async () => {
  const f = fakeBrowser(); const before = await takeSnapshot(f.api, 7);
  await f.api.tabs.group({ tabIds: [4], groupId: 10 }); f.calls.length = 0;
  await assert.rejects(applyPlan(f.api, before, 'new', plan({ 4: 'new:0', 5: 'none' })), /已经变化/);
  assert.deepEqual(f.calls, []);
  const g = fakeBrowser(); const initial = await takeSnapshot(g.api, 7); g.close(2); g.close(3);
  await assert.rejects(applyPlan(g.api, initial, 'merge', plan({ 4: 'existing:10', 5: 'none' }, 10)), /目标已有分组已经变化/);
  assert.deepEqual(g.calls, []);
});

const sortPlan = () => ({ groups: [], assignments: { 4: 'none', 5: 'none' }, orderedTabIds: [5, 4] });
for (const mode of ['sort-ai', 'sort-domain']) test(`${mode} 将未分组标签按预览排到组后，保留组属性且可撤销`, async () => {
  const f = fakeBrowser();
  await f.api.tabs.move(4, { index: 1 });
  const before = await takeSnapshot(f.api, 7);
  await applyPlan(f.api, before, mode, sortPlan());
  const after = await takeSnapshot(f.api, 7);
  assert.deepEqual(after.tabs.map(t => t.id), [1, 2, 3, 5, 4]);
  assert.deepEqual(after.groups, before.groups);
  assert.deepEqual(after.tabs.map(t => t.groupId), [ -1, 10, 10, -1, -1 ]);
  assert.deepEqual(f.calls, []);
  await undoLast(f.api, 7);
  assert.deepEqual(await takeSnapshot(f.api, 7), before);
});

test('排序跳过关闭和固定标签，不把新增标签或排除项加入排序', async () => {
  const f = fakeBrowser(); const before = await takeSnapshot(f.api, 7);
  f.close(5); f.add();
  const atApply = await takeSnapshot(f.api, 7);
  const result = await applyPlan(f.api, before, 'sort-ai', sortPlan());
  assert.equal(result.skipped, 1);
  assert.deepEqual((await takeSnapshot(f.api, 7)).tabs.map(t => t.id), [1, 6, 2, 3, 4]);
  await undoLast(f.api, 7);
  assert.deepEqual(await takeSnapshot(f.api, 7), atApply);
  const g = fakeBrowser(); const initial = await takeSnapshot(g.api, 7);
  const p = sortPlan(); p.assignments[5] = 'keep';
  await applyPlan(g.api, initial, 'sort-domain', p);
  assert.deepEqual((await takeSnapshot(g.api, 7)).tabs.map(t => t.id), [1, 2, 3, 5, 4]);
  await undoLast(g.api, 7);
  g.pin(4);
  await applyPlan(g.api, initial, 'sort-ai', sortPlan());
  assert.equal((await takeSnapshot(g.api, 7)).tabs.find(t => t.id === 4).pinned, true);
});

test('排序发生部分移动后失败会恢复全部原顺序与已有组', async () => {
  const f = fakeBrowser(); const before = await takeSnapshot(f.api, 7); f.failMove(1);
  await assert.rejects(applyPlan(f.api, before, 'sort-ai', sortPlan()), /已恢复操作前/);
  assert.deepEqual(await takeSnapshot(f.api, 7), before);
  assert.deepEqual(f.store, {});
});

test('排序前手动分组冲突会阻止移动，全部候选失效不创建撤销记录', async () => {
  const f = fakeBrowser(); const before = await takeSnapshot(f.api, 7);
  await f.api.tabs.group({ tabIds: [4], groupId: 10 });
  const current = await takeSnapshot(f.api, 7);
  await assert.rejects(applyPlan(f.api, before, 'sort-ai', sortPlan()), /已经变化/);
  assert.deepEqual(await takeSnapshot(f.api, 7), current);
  assert.deepEqual(f.store, {});
  f.close(4); f.close(5);
  await assert.rejects(applyPlan(f.api, before, 'sort-domain', sortPlan()), /没有可应用/);
  assert.deepEqual(f.store, {});
});

for (const mode of ['new', 'merge', 'rebuild']) test(`${mode} 分组后自动排列所有组并将未分类和排除项统一置后`, async () => {
  const f = fakeBrowser();
  f.add();
  // 模拟未分类标签散落在已有组之前。
  await f.api.tabs.move(5, { index: 1 });
  const before = await takeSnapshot(f.api, 7);
  const p = mode === 'merge' ? plan({ 4: 'existing:10', 5: 'none', 6: 'keep' }, 10)
    : mode === 'new' ? plan({ 4: 'new:0', 5: 'none', 6: 'keep' })
    : plan({ 2: 'new:0', 3: 'none', 4: 'new:0', 5: 'none', 6: 'keep' });
  await applyPlan(f.api, before, mode, p);
  const after = await takeSnapshot(f.api, 7);
  const ungroupedStart = after.tabs.findIndex(t => !t.pinned && t.groupId === -1);
  assert.ok(after.tabs.slice(1, ungroupedStart).every(t => t.groupId !== -1));
  assert.deepEqual(after.tabs.slice(ungroupedStart).map(t => t.id), mode === 'rebuild' ? [5, 6, 3] : [5, 6]);
  assert.equal(after.tabs[0].id, 1);
  assert.equal(after.tabs.find(t => t.id === 6).groupId, -1);
  await undoLast(f.api, 7);
  assert.deepEqual((await takeSnapshot(f.api, 7)).tabs.map(t => t.id), before.tabs.map(t => t.id));
});

test('多个新组依预览顺序排列，组内顺序不受数字 ID 或预览后手动移动影响', async () => {
  const f = fakeBrowser(); f.add();
  await f.api.tabs.move(5, { index: 1 });
  const before = await takeSnapshot(f.api, 7);
  const p = { groups: [
    { key: 'new:first', existingGroupId: null, title: '第一组', color: 'blue' },
    { key: 'new:last', existingGroupId: null, title: '第二组', color: 'green' }
  ], assignments: { 4: 'new:first', 5: 'new:last', 6: 'new:first' } };
  await f.api.tabs.move(4, { index: 1 });
  const atApply = await takeSnapshot(f.api, 7);
  await applyPlan(f.api, before, 'new', p);
  const after = await takeSnapshot(f.api, 7);
  assert.deepEqual(after.tabs.map(t => t.id), [1, 2, 3, 6, 4, 5]);
  assert.deepEqual(after.tabs.filter(t => t.groupId === after.groups.find(g => g.title === '第一组').id).map(t => t.id), [6, 4]);
  await undoLast(f.api, 7);
  assert.deepEqual(await takeSnapshot(f.api, 7), atApply);
});

test('分组后自动排序的移动失败仍回滚分组及整窗顺序', async () => {
  const f = fakeBrowser(); f.add();
  const before = await takeSnapshot(f.api, 7);
  // 新组成员已排好后，在未分类标签收尾时失败。
  f.failMove(1);
  await assert.rejects(applyPlan(f.api, before, 'new', plan({ 4: 'new:0', 5: 'none', 6: 'keep' })), /已恢复操作前/);
  assert.deepEqual(await takeSnapshot(f.api, 7), before);
  assert.deepEqual(f.store, {});
});

test('不参与分类的内部页面同样移到分组后，撤销恢复其原位置', async () => {
  const f = fakeBrowser(); f.add('edge://settings/');
  const before = await takeSnapshot(f.api, 7);
  await applyPlan(f.api, before, 'new', plan({ 4: 'new:0', 5: 'none' }));
  const after = await takeSnapshot(f.api, 7);
  assert.deepEqual(after.tabs.map(t => t.id), [1, 2, 3, 4, 6, 5]);
  assert.equal(after.tabs.find(t => t.id === 6).groupId, -1);
  await undoLast(f.api, 7);
  assert.deepEqual(await takeSnapshot(f.api, 7), before);
});
