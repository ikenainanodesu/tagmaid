// 去重使用浏览器提供的原始网址，不复用供 AI 使用的网址裁剪逻辑。
const isWeb = url => {
  try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
};
export const duplicateKey = windowId => `duplicates:${windowId}`;

export async function duplicateSnapshot(api) {
  const [windows, groups] = await Promise.all([
    api.windows.getAll({ populate: true, windowTypes: ['normal'] }), api.tabGroups.query({})
  ]);
  const eligible = windows.filter(win => win.type === 'normal' && !win.incognito);
  return {
    focusedWindowId: eligible.find(win => win.focused)?.id ?? null,
    tabs: eligible.sort((a, b) => a.id - b.id).flatMap(win => (win.tabs || [])
      .filter(tab => !tab.incognito && isWeb(tab.url))
      .sort((a, b) => a.index - b.index)
      .map(tab => ({
        id: tab.id, windowId: win.id, index: tab.index, url: tab.url,
        pendingUrl: tab.pendingUrl || '', title: tab.title || '',
        pinned: Boolean(tab.pinned), active: Boolean(tab.active), groupId: tab.groupId,
        groupTitle: groups.find(group => group.id === tab.groupId && group.windowId === win.id)?.title || ''
      })))
  };
}

export function duplicateGroups(snapshot, preferredWindowId) {
  const byUrl = new Map();
  for (const tab of snapshot.tabs) {
    if (!byUrl.has(tab.url)) byUrl.set(tab.url, []);
    byUrl.get(tab.url).push(tab);
  }
  return [...byUrl].filter(([, tabs]) => tabs.length > 1).map(([url, tabs]) => {
    const keep = tabs.filter(tab => tab.pinned || (tab.active && tab.windowId === snapshot.focusedWindowId));
    if (!keep.length) keep.push(tabs.find(tab => tab.windowId === preferredWindowId) || tabs[0]);
    return { url, tabs, closeIds: tabs.filter(tab => !keep.includes(tab)).map(tab => tab.id) };
  });
}

export async function scanDuplicates(api, windowId) {
  const snapshot = await duplicateSnapshot(api);
  const preview = { id: crypto.randomUUID(), focusedWindowId: snapshot.focusedWindowId, groups: duplicateGroups(snapshot, windowId) };
  await api.storage.session.set({ [duplicateKey(windowId)]: preview });
  return preview;
}

// 后台保留原始预览，前端只提交编号和勾选项；预览一次性消费，跨 Worker 重启仍可复核。
export async function closeDuplicates(api, windowId, previewId, closeIds) {
  const key = duplicateKey(windowId);
  const preview = (await api.storage.session.get(key))[key];
  if (!preview || preview.id !== previewId) throw new Error('重复检测预览已失效，请重新检测。');
  const allowed = new Set(preview.groups.flatMap(group => group.tabs.map(tab => tab.id)));
  if (!Array.isArray(closeIds) || !closeIds.length || closeIds.some(id => !Number.isInteger(id) || !allowed.has(id)) || new Set(closeIds).size !== closeIds.length) {
    throw new Error('关闭选择无效，请重新检测。');
  }
  const current = await duplicateSnapshot(api);
  const live = new Map(current.tabs.map(tab => [tab.id, tab]));
  const selected = new Set(closeIds), validIds = [];
  let skippedGroups = 0;
  for (const group of preview.groups) {
    const chosen = group.tabs.filter(tab => selected.has(tab.id));
    if (!chosen.length) continue;
    const sameMembers = current.tabs.filter(tab => tab.url === group.url).length === group.tabs.length;
    const unchanged = current.focusedWindowId === preview.focusedWindowId && sameMembers && group.tabs.every(tab => {
      const now = live.get(tab.id);
      return now && !tab.pendingUrl && !now.pendingUrl &&
        ['url', 'windowId', 'pinned', 'active', 'groupId'].every(field => now[field] === tab[field]);
    });
    if (!unchanged) skippedGroups++;
    else validIds.push(...chosen.map(tab => tab.id));
  }
  // 同一批提交，避免关闭激活页造成的自动激活干扰后续组的核对。
  await api.storage.session.remove(key);
  if (validIds.length) {
    try { await api.tabs.remove(validIds); }
    catch { /* 可能部分成功，以实际存续状态报告；绝不自动重试关闭。 */ }
  }
  const remaining = new Set((await api.tabs.query({})).map(tab => tab.id));
  const closed = validIds.filter(id => !remaining.has(id)).length;
  return { closed, skippedGroups, failed: validIds.length - closed };
}
