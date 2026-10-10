import { translate } from './i18n.js';

export const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
export const MODES = ['rebuild', 'new', 'merge', 'sort-ai', 'sort-domain'];
export const isSortMode = mode => mode === 'sort-ai' || mode === 'sort-domain';

export function domainPlan(snapshot) {
  const tabs = candidates(snapshot, 'sort-domain').sort((a, b) => {
    const left = new URL(a.url).hostname, right = new URL(b.url).hostname;
    return left < right ? -1 : left > right ? 1 : a.index - b.index;
  });
  return { groups: [], assignments: Object.fromEntries(tabs.map(t => [t.id, 'none'])), orderedTabIds: tabs.map(t => t.id) };
}

export function cleanUrl(raw) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.search = ''; url.hash = ''; url.username = ''; url.password = '';
    return url.href;
  } catch { return null; }
}

export function apiEndpoint(input) {
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error('请输入完整的 API 地址。'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('API 地址须使用 HTTPS；本机 localhost / 127.0.0.1 可使用 HTTP。');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含账号、密码、查询参数或片段。');
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return { url: url.href, origin: `${url.origin}/*` };
}

export function candidates(snapshot, mode) {
  if (!MODES.includes(mode)) throw new Error('未知的整理模式。');
  return snapshot.tabs.filter(t => !t.pinned && cleanUrl(t.url) && (mode === 'rebuild' || t.groupId === -1));
}

export function payloadFor(snapshot, mode, language = 'zh-CN') {
  const meta = t => ({ id: t.id, title: t.title || translate(language, '未命名网页'), url: cleanUrl(t.url) });
  return {
    mode,
    tabs: candidates(snapshot, mode).map(meta),
    existingGroups: mode === 'merge' ? snapshot.groups.map(g => ({
      id: g.id, title: g.title || translate(language, '未命名分组'), color: g.color,
      tabs: snapshot.tabs.filter(t => t.groupId === g.id && !t.pinned && cleanUrl(t.url)).map(meta)
    })) : []
  };
}

export function parseAnswer(content, snapshot, mode) {
  if (typeof content !== 'string') throw new Error('AI 没有返回可用的文本。');
  let raw;
  try { raw = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { throw new Error('AI 返回的内容不是有效 JSON，请重新生成。'); }
  if (isSortMode(mode)) {
    if (!raw || !Array.isArray(raw.orderedTabIds)) throw new Error('AI 返回的排序格式不正确。');
    return validatePlan({ groups: [], assignments: Object.fromEntries(raw.orderedTabIds.map(id => [id, 'none'])), orderedTabIds: raw.orderedTabIds }, snapshot, mode);
  }
  if (!raw || !Array.isArray(raw.groups) || !Array.isArray(raw.ungroupedTabIds)) throw new Error('AI 返回的分组格式不正确。');
  const allowed = new Set(candidates(snapshot, mode).map(t => t.id));
  const assignments = {};
  const put = (id, key) => {
    if (!Number.isInteger(id) || !allowed.has(id) || Object.hasOwn(assignments, id)) throw new Error('AI 返回了重复或不在整理范围内的标签。');
    assignments[id] = key;
  };
  const groups = raw.groups.map((g, i) => {
    if (!g || !Array.isArray(g.tabIds)) throw new Error('AI 返回的分组成员格式不正确。');
    const existing = g.existingGroupId ?? null;
    const key = existing === null ? `new:${i}` : `existing:${existing}`;
    g.tabIds.forEach(id => put(id, key));
    const original = snapshot.groups.find(x => x.id === existing);
    return { key, existingGroupId: existing, title: original?.title ?? g.title, color: original?.color ?? g.color };
  });
  raw.ungroupedTabIds.forEach(id => put(id, 'none'));
  if (Object.keys(assignments).length !== allowed.size) throw new Error('AI 遗漏了部分标签，请重新生成。');
  return validatePlan({ groups, assignments }, snapshot, mode);
}

export function validatePlan(plan, snapshot, mode) {
  if (!plan || !Array.isArray(plan.groups) || !plan.assignments || Array.isArray(plan.assignments)) throw new Error('分组方案格式不正确。');
  if (isSortMode(mode)) {
    const allowed = new Set(candidates(snapshot, mode).map(t => t.id));
    const order = plan.orderedTabIds;
    if (plan.groups.length || !Array.isArray(order) || order.length !== allowed.size || new Set(order).size !== allowed.size ||
      order.some(id => !Number.isInteger(id) || !allowed.has(id))) throw new Error('排序方案必须完整且不重复地包含待排序标签。');
    if (Object.keys(plan.assignments).length !== allowed.size || order.some(id => !['none', 'keep'].includes(plan.assignments[id]))) throw new Error('排序方案只能参与排序或排除标签，不能修改分组。');
    return { groups: [], assignments: { ...plan.assignments }, orderedTabIds: [...order] };
  }
  const keys = new Set();
  const groups = plan.groups.map(g => {
    if (!g || typeof g.key !== 'string' || keys.has(g.key) || ['none', 'keep'].includes(g.key)) throw new Error('分组标识重复或无效。');
    keys.add(g.key);
    if (g.existingGroupId !== null) {
      const original = snapshot.groups.find(x => x.id === g.existingGroupId);
      if (mode !== 'merge' || !original) throw new Error('当前模式不允许加入这个已有分组。');
      if (g.key !== `existing:${original.id}`) throw new Error('已有分组标识不正确。');
      return { key: g.key, existingGroupId: original.id, title: original.title, color: original.color };
    }
    if (typeof g.title !== 'string' || !g.title.trim() || g.title.trim().length > 60) throw new Error('新组名称须为 1–60 个字符。');
    if (!COLORS.includes(g.color)) throw new Error('分组颜色不受支持。');
    return { key: g.key, existingGroupId: null, title: g.title.trim(), color: g.color };
  });
  const ids = candidates(snapshot, mode).map(t => String(t.id));
  if (Object.keys(plan.assignments).length !== ids.length || Object.keys(plan.assignments).some(id => !ids.includes(id))) throw new Error('方案中的标签范围已发生变化。');
  for (const id of ids) {
    if (!Object.hasOwn(plan.assignments, id) || !['none', 'keep'].includes(plan.assignments[id]) && !keys.has(plan.assignments[id])) throw new Error('标签的目标分组无效。');
  }
  return { groups, assignments: { ...plan.assignments } };
}

export function sameState(a, b) {
  const compact = s => ({
    windowId: s.windowId,
    tabs: s.tabs.map(t => [t.id, t.index, t.pinned, t.groupId, t.url]),
    groups: [...s.groups].sort((x, y) => x.id - y.id).map(g => [g.id, g.title, g.color, g.collapsed])
  });
  return JSON.stringify(compact(a)) === JSON.stringify(compact(b));
}

// 保留生成时的内容与分配，只移除已经不能操作的标签；不把新标签混入旧方案。
// 界面编辑中的空组名可暂时存在，严格格式校验留在应用入口。
export function reconcilePreview(original, current, mode, plan) {
  if (original.windowId !== current.windowId) throw new Error('窗口不匹配。');
  const live = new Map(current.tabs.map(tab => [tab.id, tab]));
  const available = candidates(original, mode).filter(tab => live.has(tab.id) && !live.get(tab.id).pinned);
  const ids = new Set(available.map(tab => String(tab.id)));
  const assignments = Object.fromEntries(Object.entries(plan.assignments).filter(([id]) => ids.has(id)));
  const used = new Set(Object.values(assignments));
  const previouslyUsed = new Set(Object.values(plan.assignments));
  const groups = plan.groups.filter(group => used.has(group.key) || !previouslyUsed.has(group.key));
  let conflict = '';
  for (const tab of available) {
    if (assignments[tab.id] === 'keep') continue;
    const now = live.get(tab.id);
    if (tab.url !== now.url || tab.groupId !== now.groupId) {
      conflict = '待整理标签的网页或分组已经变化，请重新生成预览，或将该标签设为“排除”。';
      break;
    }
  }
  for (const group of groups) {
    if (group.existingGroupId === null || !used.has(group.key)) continue;
    const now = current.groups.find(item => item.id === group.existingGroupId);
    if (!now || now.title !== group.title || now.color !== group.color) {
      conflict = '目标已有分组已经变化，请重新生成预览，或为相关标签选择其他去向。';
      break;
    }
  }
  const nextSnapshot = { ...original, tabs: original.tabs.filter(tab => ids.has(String(tab.id))) };
  const nextPlan = { groups, assignments };
  if (isSortMode(mode)) nextPlan.orderedTabIds = plan.orderedTabIds.filter(id => ids.has(String(id)));
  return { snapshot: nextSnapshot, plan: nextPlan, conflict,
    skipped: candidates(original, mode).length - available.length,
    added: current.tabs.filter(tab => !original.tabs.some(item => item.id === tab.id)).length,
    included: Object.values(assignments).filter(target => target !== 'keep').length };
}
