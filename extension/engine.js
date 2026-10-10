import { reconcilePreview, validatePlan, isSortMode } from './core.js';

export async function takeSnapshot(api, windowId) {
  const [tabs, groups] = await Promise.all([api.tabs.query({ windowId }), api.tabGroups.query({ windowId })]);
  return {
    windowId,
    tabs: tabs.sort((a, b) => a.index - b.index).map(({ id, index, pinned, groupId, url, title }) => ({ id, index, pinned, groupId, url, title })),
    groups: groups.map(({ id, title, color, collapsed }) => ({ id, title, color, collapsed }))
  };
}

export const undoKey = windowId => `undo:${windowId}`;

// 分组完成后按预览排列新成员，并把整组移到固定标签后；未分组标签统一收尾。
async function arrangeGroupedTabs(api, before, plannedGroups) {
  const current = await takeSnapshot(api, before.windowId);
  const liveGroups = new Set(current.groups.map(group => group.id));
  const groupIds = [...new Set([
    ...before.tabs.map(tab => tab.groupId),
    ...plannedGroups.map(group => group.id),
    ...current.tabs.map(tab => tab.groupId)
  ])].filter(id => liveGroups.has(id));
  for (const group of plannedGroups) {
    const members = current.tabs.filter(tab => tab.groupId === group.id);
    const incoming = new Set(group.tabIds);
    const ordered = [...members.filter(tab => !incoming.has(tab.id)).map(tab => tab.id), ...group.tabIds];
    // 仅在组内移动，保留已有成员的相对顺序；新成员依照预览追加。
    for (let offset = 0; offset < ordered.length; offset++) {
      await api.tabs.move(ordered[offset], { index: members[0].index + offset });
    }
  }
  let index = current.tabs.filter(tab => tab.pinned).length;
  for (const id of groupIds) {
    await api.tabGroups.move(id, { index });
    index += current.tabs.filter(tab => tab.groupId === id).length;
  }
  const originalOrder = new Map(before.tabs.map((tab, index) => [tab.id, index]));
  const ungrouped = current.tabs.filter(tab => !tab.pinned && tab.groupId === -1)
    .sort((a, b) => (originalOrder.get(a.id) ?? Infinity) - (originalOrder.get(b.id) ?? Infinity));
  for (const tab of ungrouped) await api.tabs.move(tab.id, { index: -1 });
}

export async function applyPlan(api, snapshot, mode, rawPlan) {
  const validated = validatePlan(rawPlan, snapshot, mode);
  const current = await takeSnapshot(api, snapshot.windowId);
  const reconciled = reconcilePreview(snapshot, current, mode, validated);
  if (reconciled.conflict) throw new Error(reconciled.conflict);
  const plan = reconciled.plan;
  const managedIds = Object.entries(plan.assignments).filter(([, target]) => target !== 'keep').map(([id]) => Number(id));
  if (!managedIds.length) throw new Error('没有可应用的标签：标签已关闭、移出窗口、固定或被排除。');
  // 撤销回到真正应用前的状态，保留等待期间新增的标签与顺序调整。
  snapshot = current;
  const key = undoKey(snapshot.windowId);
  const old = (await api.storage.session.get(key))[key];
  if (old?.status === 'applying' || old?.status === 'restoring' || old?.status === 'recovery') throw new Error('上次操作尚未恢复，请先点击撤销恢复。');
  const record = { snapshot, managedIds, createdGroupIds: [], restoredGroups: {}, status: 'applying', time: Date.now() };
  await api.storage.session.set({ [key]: record });
  try {
    // 先写恢复记录；即使后台中断，下一次打开仍能撤销。
    if (isSortMode(mode)) {
      // 依次追加到窗口末尾，保持预览顺序，不移动已有组及其成员。
      for (const id of plan.orderedTabIds) {
        if (plan.assignments[id] !== 'keep') await api.tabs.move(id, { index: -1 });
      }
    } else {
      const plannedGroups = [];
      const toUngroup = snapshot.tabs.filter(t => managedIds.includes(t.id) && t.groupId !== -1).map(t => t.id);
      if (toUngroup.length) await api.tabs.ungroup(toUngroup);
      for (const group of plan.groups) {
        const tabIds = reconciled.snapshot.tabs.filter(tab => plan.assignments[tab.id] === group.key).map(tab => tab.id);
        if (!tabIds.length) continue;
        if (group.existingGroupId !== null) {
          await api.tabs.group({ tabIds, groupId: group.existingGroupId });
          plannedGroups.push({ id: group.existingGroupId, tabIds });
        } else {
          const groupId = await api.tabs.group({ tabIds, createProperties: { windowId: snapshot.windowId } });
          record.createdGroupIds.push(groupId);
          await api.storage.session.set({ [key]: record });
          await api.tabGroups.update(groupId, { title: group.title, color: group.color, collapsed: false });
          plannedGroups.push({ id: groupId, tabIds });
        }
      }
      await arrangeGroupedTabs(api, snapshot, plannedGroups);
    }
    record.status = 'ready';
    await api.storage.session.set({ [key]: record });
    return { changed: managedIds.length, skipped: reconciled.skipped };
  } catch {
    record.status = 'recovery';
    await api.storage.session.set({ [key]: record });
    try {
      await restoreRecord(api, record);
      if (old) await api.storage.session.set({ [key]: old }); else await api.storage.session.remove(key);
    } catch { throw new Error('应用中断，部分标签可能已经改变。恢复记录已保留，请点击撤销恢复。'); }
    throw new Error('应用失败，已恢复操作前的标签状态。请重新生成预览。');
  }
}

export async function restoreRecord(api, record) {
  const { snapshot, managedIds } = record;
  const key = undoKey(snapshot.windowId);
  record.status = 'restoring';
  record.restoredGroups ??= {};
  await api.storage.session.set({ [key]: record });
  const now = await takeSnapshot(api, snapshot.windowId);
  const live = new Map(now.tabs.map(t => [t.id, t]));
  // 不重开已关闭的标签，不跨窗口找回标签，也不解除用户后来固定的标签。
  const available = snapshot.tabs.filter(t => managedIds.includes(t.id) && live.has(t.id) && !live.get(t.id).pinned);
  const grouped = available.filter(t => live.get(t.id).groupId !== -1).map(t => t.id);
  if (grouped.length) await api.tabs.ungroup(grouped);
  for (const original of snapshot.groups) {
    const members = available.filter(t => t.groupId === original.id).map(t => t.id);
    if (!members.length) continue;
    const groups = await api.tabGroups.query({ windowId: snapshot.windowId });
    const previousId = record.restoredGroups[original.id] ?? original.id;
    const exists = groups.some(g => g.id === previousId);
    const groupId = await api.tabs.group(exists ? { tabIds: members, groupId: previousId } : { tabIds: members, createProperties: { windowId: snapshot.windowId } });
    record.restoredGroups[original.id] = groupId;
    await api.storage.session.set({ [key]: record });
    await api.tabGroups.update(groupId, { title: original.title, color: original.color, collapsed: original.collapsed });
  }
  // 先在各组内部恢复成员顺序，再移动整个组；组内移动不越过组边界。
  const restored = await takeSnapshot(api, snapshot.windowId);
  const originalOrder = new Map(snapshot.tabs.map((t, index) => [t.id, index]));
  for (const group of restored.groups) {
    const members = restored.tabs.filter(t => t.groupId === group.id);
    const ordered = [...members].sort((a, b) => (originalOrder.get(a.id) ?? Infinity) - (originalOrder.get(b.id) ?? Infinity));
    const start = members[0]?.index;
    for (let offset = 0; offset < ordered.length; offset++) {
      await api.tabs.move(ordered[offset].id, { index: start + offset });
    }
  }
  const currentById = new Map(restored.tabs.map(t => [t.id, t]));
  const movedGroups = new Set();
  let index = restored.tabs.filter(t => t.pinned).length;
  for (const original of snapshot.tabs) {
    const tab = currentById.get(original.id);
    if (!tab || tab.pinned || original.pinned) continue;
    if (tab.groupId !== -1) {
      if (movedGroups.has(tab.groupId)) continue;
      movedGroups.add(tab.groupId);
      await api.tabGroups.move(tab.groupId, { index });
      index += restored.tabs.filter(t => t.groupId === tab.groupId).length;
    } else {
      await api.tabs.move(tab.id, { index });
      index++;
    }
  }
  return { restored: available.length, skipped: managedIds.length - available.length };
}

export async function undoLast(api, windowId) {
  const key = undoKey(windowId);
  const record = (await api.storage.session.get(key))[key];
  if (!record) throw new Error('当前窗口没有可撤销的整理记录。');
  try {
    const result = await restoreRecord(api, record);
    await api.storage.session.remove(key);
    return result;
  } catch {
    record.status = 'recovery';
    await api.storage.session.set({ [key]: record });
    throw new Error('恢复尚未完成，记录仍然保留。请停止移动标签后再次撤销。');
  }
}
