import { apiEndpoint, candidates, COLORS, MODES, isSortMode, payloadFor, cleanUrl, reconcilePreview } from './core.js';
import { requestPlan } from './api.js';
import { resolveLanguage, translate, msg, errorMessage } from './i18n.js';

let language = resolveLanguage(null, chrome.i18n.getUILanguage());
const t = (key, params) => translate(language, key, params);
const messages = new Map();
const displayMessage = value => Array.isArray(value) ? value.map(displayMessage).filter(Boolean).join(' ')
  : value && typeof value === 'object' ? t(value.key, value.params) : t(value || '');

const $ = id => document.getElementById(id);
const colorNames = { grey: '灰色', blue: '蓝色', red: '红色', yellow: '黄色', green: '绿色', pink: '粉色', purple: '紫色', cyan: '青色', orange: '橙色' };
const colorHex = { grey: '#909a94', blue: '#6398d5', red: '#d06c64', yellow: '#cfb75d', green: '#6ba785', pink: '#d798b1', purple: '#a28acb', cyan: '#69b6bc', orange: '#d69c6a' };
let windowId, snapshot, plan, previewSnapshot, previewMode, controller, generationSnapshot;
let busy = false;
let syncVersion = 0, syncTimer, syncPending = false, previewConflict = '';
let settings = { endpoint: '', model: '', apiKey: '', rememberKey: false };
const mode = () => document.querySelector('input[name="mode"]:checked').value;

function localizePage() {
  document.documentElement.lang = language;
  $('language').value = language;
  for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  for (const attribute of ['title', 'aria-label', 'placeholder']) {
    for (const element of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
      element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
    }
  }
  for (const [id, message] of messages) $(id).textContent = displayMessage(message);
  $('undo').textContent = t($('undo').dataset.recovery === 'true' ? '恢复上次中断的整理' : '撤销最近一次整理');
  if (snapshot) showSnapshot();
  if (plan) renderPreview();
}

async function send(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, windowId, ...extra });
  if (!response?.ok) throw new Error(response?.error || '后台没有响应，请重新打开侧栏。');
  return response.data;
}
function status(message, error = false) {
  messages.set('status', message);
  $('status').textContent = displayMessage(message); $('status').hidden = !message;
  $('status').classList.toggle('error', error);
}
function applyStatus(message, error = false) {
  messages.set('apply-status', message);
  $('apply-status').textContent = displayMessage(message); $('apply-status').hidden = !message;
  $('apply-status').classList.toggle('error', error);
}
function showSettings(open) {
  $('settings-panel').hidden = !open;
  $('settings-toggle').setAttribute('aria-expanded', String(open));
}
function showSortingWait(active) {
  $('sorting-wait').hidden = !active;
  $('generate').setAttribute('aria-busy', String(active));
  if (active) requestAnimationFrame(() => {
    if (!$('sorting-wait').hidden) $('sorting-wait').scrollIntoView({ block: 'nearest', behavior: 'instant' });
  });
}
function updateControls() {
  for (const id of ['generate', 'refresh', 'apply', 'add-group', 'discard', 'instruction', 'settings-toggle']) $(id).disabled = busy;
  $('mode-options').disabled = busy;
  $('instruction').disabled = busy || mode() === 'sort-domain';
  for (const input of $('settings-form').elements) input.disabled = busy;
  for (const input of $('preview-groups').querySelectorAll('input,select,button')) input.disabled = busy;
  $('generate').disabled = busy || !snapshot || !candidates(snapshot, mode()).length;
  $('apply').disabled = busy || !plan || Boolean(previewConflict) || !Object.values(plan.assignments).some(target => target !== 'keep');
  $('undo').disabled = busy || $('undo').dataset.available !== 'true';
}
async function updateUndo() {
  const info = await send('undoStatus');
  $('undo').dataset.available = String(info.available);
  $('undo').dataset.recovery = String(Boolean(info.status && info.status !== 'ready'));
  $('undo').textContent = info.status && info.status !== 'ready' ? t('恢复上次中断的整理') : t('撤销最近一次整理');
  updateControls();
}
function discard() {
  syncVersion++;
  plan = undefined; previewSnapshot = undefined; previewMode = undefined; generationSnapshot = undefined;
  previewConflict = ''; applyStatus('');
  $('preview-notice').hidden = true;
  $('preview').hidden = true; $('preview-groups').replaceChildren();
}
function showSnapshot() {
  const sorting = isSortMode(mode()), local = mode() === 'sort-domain';
  $('generate').textContent = sorting ? t('生成排序预览') : t('✦ 生成分组预览');
  $('instruction').hidden = local; $('instruction-label').hidden = local;
  $('payload-label').textContent = local ? t('查看本地排序范围') : t('发送前查看数据范围');
  $('privacy-note').textContent = local
    ? t('完全在本地按完整域名升序排列，同域名保持原先顺序。不发送任何数据，不需要 API 配置。')
    : t('只发送标题、去掉查询参数和片段的网址，以及必要编号。允许加入已有组时，还发送已有组名和组内网页信息。标题和网址路径本身仍可能含有私人信息。不读取正文。');
  updateConnection();
  const payload = payloadFor(snapshot, mode(), language);
  $('candidate-count').textContent = payload.tabs.length;
  $('group-count').textContent = t('{count} 个已有组', { count: snapshot.groups.length });
  $('scope-note').textContent = t('窗口共 {count} 个标签 · 固定标签与内部页面不参与整理。', { count: snapshot.tabs.length });
  $('payload-count').textContent = t('· {count} 个标签', { count: payload.tabs.length });
  $('payload-preview').textContent = JSON.stringify(payload, null, 2);
  updateControls();
}
async function refresh() {
  snapshot = await send('snapshot'); showSnapshot(); await updateUndo();
}
function previewNotices() {
  if (!plan) return [];
  const result = reconcilePreview(previewSnapshot, snapshot, previewMode, plan);
  previewConflict = result.conflict;
  const skipped = candidates(generationSnapshot, previewMode).length - Object.keys(plan.assignments).length;
  const originalIds = new Set(generationSnapshot.tabs.map(tab => tab.id));
  const added = snapshot.tabs.filter(tab => !originalIds.has(tab.id)).length;
  const messages = [];
  if (skipped) messages.push(msg('已跳过 {count} 个已关闭、移出窗口或固定的标签。', { count: skipped }));
  if (added) messages.push(msg('{count} 个新增标签未纳入本次整理，保持原样。', { count: added }));
  if (!result.included) messages.push(msg('没有可应用的标签，请重新生成预览或调整排除项。'));
  if (previewConflict) messages.push(msg(previewConflict));
  return messages;
}
function updatePreviewNotice() {
  if (!plan) return;
  const messages = previewNotices();
  $('preview-notice').textContent = displayMessage(messages);
  $('preview-notice').hidden = !messages.length;
  $('preview-notice').classList.toggle('error', Boolean(previewConflict));
}
async function syncPreview() {
  const version = ++syncVersion;
  const current = await send('snapshot');
  if (version !== syncVersion) return;
  snapshot = current; showSnapshot();
  if (!plan) return;
  const result = reconcilePreview(previewSnapshot, current, previewMode, plan);
  const changed = result.skipped > 0;
  previewSnapshot = result.snapshot; plan = result.plan;
  if (changed) {
    const active = document.activeElement;
    const focusTabId = active?.closest('.tab-row')?.dataset.tabId;
    renderPreview(focusTabId);
  } else { updatePreviewNotice(); updateControls(); }
}
function scheduleSync() {
  syncPending = true;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    if (busy) return;
    syncPending = false;
    try { await syncPreview(); }
    catch (error) { if (plan) applyStatus(errorMessage(error), true); else status(errorMessage(error), true); }
  }, 100);
}
function updateConnection() {
  if (mode() === 'sort-domain') { $('connection-note').textContent = t('本地排序 · 无需 API · 不发送数据'); return; }
  $('connection-note').textContent = settings.endpoint && settings.model ? `${new URL(settings.endpoint).host} · ${settings.model}` : t('先连接你的 AI，整理从这里开始。');
}
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function allTargets() {
  if (isSortMode(previewMode)) return [{ key: 'none', label: t('参与排序') }, { key: 'keep', label: t('排除 · 不移动此标签') }];
  const targets = plan.groups.map(g => ({ key: g.key, label: `${g.existingGroupId === null ? t('新组') : t('已有组')} · ${g.title || t('未命名')}` }));
  if (previewMode === 'merge') for (const group of previewSnapshot.groups.filter(group => snapshot.groups.some(current => current.id === group.id))) {
    const key = `existing:${group.id}`;
    if (!targets.some(t => t.key === key)) targets.push({ key, label: `${t('已有组')} · ${group.title || t('未命名分组')}` });
  }
  return [...targets, { key: 'none', label: t('保持未分组') }, { key: 'keep', label: t('排除 · 保持原样') }];
}
function updateTargetLabels() {
  const names = new Map(allTargets().map(t => [t.key, t.label]));
  for (const option of $('preview-groups').querySelectorAll('.tab-row select option')) option.textContent = names.get(option.value);
}
function renderPreview(focusTabId) {
  $('preview').hidden = false;
  const sorting = isSortMode(previewMode);
  $('preview-heading').textContent = sorting ? t('你的排序方案') : t('你的分组方案');
  $('add-group').hidden = sorting;
  $('preview-help').textContent = sorting
    ? t('按下方顺序将参与排序的标签移到所有组后面，不创建分组。可排除标签；已有组与排除项的相对顺序保留，绝对位置可能随其他标签移动而变化。')
    : t('可修改新组名称和颜色，调整标签去向。“排除”将保留该标签原样。');
  const container = $('preview-groups'); container.replaceChildren();
  const available = candidates(previewSnapshot, previewMode);
  const byId = new Map(available.map(tab => [tab.id, tab]));
  const tabs = sorting ? plan.orderedTabIds.map(id => byId.get(id)) : available;
  const destinations = [...plan.groups, { key: 'none', title: sorting ? t('排序结果 · 从左到右') : t('保持未分组'), color: 'grey' }, { key: 'keep', title: t('排除 · 保持原样'), color: 'grey' }];
  for (const group of destinations) {
    const members = tabs.filter(t => plan.assignments[t.id] === group.key);
    if (!members.length && ['none', 'keep'].includes(group.key)) continue;
    const card = node('article', 'group-card'); card.style.setProperty('--group-color', colorHex[group.color]);
    card.append(node('span', 'badge', group.existingGroupId === null ? t('创建新组') : Number.isInteger(group.existingGroupId) ? t('加入已有组 · 原有成员保持不变') : t('不加入分组')));
    const header = node('div', 'group-header');
    if (group.existingGroupId === null) {
      const input = node('input'); input.value = group.title; input.maxLength = 60; input.setAttribute('aria-label', t('新组名称'));
      input.addEventListener('input', () => { group.title = input.value; updateTargetLabels(); });
      const colors = node('select'); colors.setAttribute('aria-label', t('新组颜色'));
      for (const color of COLORS) { const option = node('option', '', t(colorNames[color])); option.value = color; colors.append(option); }
      colors.value = group.color;
      colors.addEventListener('change', () => { group.color = colors.value; card.style.setProperty('--group-color', colorHex[group.color]); });
      header.append(input, colors);
    } else header.append(node('strong', '', group.title || t('未命名分组')));
    header.append(node('span', 'badge', String(members.length))); card.append(header);
    if (!members.length) card.append(node('p', 'empty-group', t('尚无标签，应用时不会创建空组。')));
    for (const tab of members) {
      const row = node('div', 'tab-row'); row.dataset.tabId = tab.id;
      const rank = sorting && group.key === 'none' ? `${members.indexOf(tab) + 1}. ` : '';
      const title = node('span', 'tab-title', rank + (tab.title || t('未命名网页'))); title.title = tab.title || '';
      row.append(title, node('div', 'tab-domain', new URL(cleanUrl(tab.url)).hostname));
      const select = node('select'); select.setAttribute('aria-label', t('{title} 的去向', { title: tab.title || t('未命名网页') }));
      for (const target of allTargets()) { const option = node('option', '', target.label); option.value = target.key; select.append(option); }
      select.value = group.key;
      select.addEventListener('change', () => {
        if (select.value.startsWith('existing:') && !plan.groups.some(g => g.key === select.value)) {
          const original = previewSnapshot.groups.find(g => `existing:${g.id}` === select.value);
          plan.groups.push({ key: select.value, existingGroupId: original.id, title: original.title, color: original.color });
        }
        plan.assignments[tab.id] = select.value; renderPreview(tab.id);
      });
      row.append(select); card.append(row);
    }
    container.append(card);
  }
  const included = Object.values(plan.assignments).filter(target => target !== 'keep').length;
  $('plan-summary').textContent = t(sorting ? '{count} 个标签参与排序 · 可撤销' : '{count} 个标签参与整理 · 可撤销', { count: included });
  updatePreviewNotice();
  updateControls();
  if (focusTabId) container.querySelector(`[data-tab-id="${focusTabId}"] select`)?.focus();
}

$('language').addEventListener('change', async () => {
  const next = resolveLanguage($('language').value);
  $('language').disabled = true;
  try {
    await chrome.storage.local.set({ language: next });
    language = next;
    localizePage();
  } catch (error) {
    $('language').value = language;
    status(errorMessage(error), true);
  } finally { $('language').disabled = false; }
});
$('settings-toggle').addEventListener('click', () => showSettings($('settings-panel').hidden));
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const endpoint = apiEndpoint($('endpoint').value);
    // 权限申请紧接用户手势；只请求本次配置的服务地址。
    const granted = await chrome.permissions.request({ origins: [endpoint.origin] });
    if (!granted) throw new Error('API 站点授权未通过，设置尚未保存。');
    const next = { endpoint: endpoint.url, model: $('model').value.trim(), apiKey: $('api-key').value.trim(), rememberKey: $('remember-key').checked };
    if (!next.model) throw new Error('请填写模型名称。');
    await chrome.storage.local.set({ settings: { ...next, apiKey: next.rememberKey ? next.apiKey : '' } });
    await chrome.storage.session.set({ apiKey: next.rememberKey ? '' : next.apiKey });
    const oldOrigin = settings.endpoint ? apiEndpoint(settings.endpoint).origin : null;
    settings = next;
    if (oldOrigin && oldOrigin !== endpoint.origin) await chrome.permissions.remove({ origins: [oldOrigin] });
    updateConnection(); showSettings(false); status(msg('设置已保存。生成预览时才会发送标签信息。'));
  } catch (error) { status(errorMessage(error), true); }
});
$('mode-options').addEventListener('change', async () => {
  discard(); status('');
  if (mode() === 'sort-domain') showSettings(false);
  try { await chrome.storage.local.set({ mode: mode() }); await refresh(); }
  catch (error) { status(errorMessage(error), true); }
});
$('refresh').addEventListener('click', async () => {
  discard();
  try { await refresh(); status(msg('已刷新当前窗口。')); } catch (error) { status(errorMessage(error), true); }
});
$('generate').addEventListener('click', async () => {
  const local = mode() === 'sort-domain';
  const requestLanguage = language;
  if (!local && (!settings.endpoint || !settings.model)) { showSettings(true); status(msg('先填写 API 地址和模型名称。'), true); return; }
  try {
    // 申请前没有异步操作，保留浏览器要求的用户手势。
    const permission = local ? Promise.resolve(true) : chrome.permissions.request({ origins: [apiEndpoint(settings.endpoint).origin] });
    busy = true; discard(); showSortingWait(true); updateControls();
    if (!await permission) throw new Error('需要授权所配置的 API 站点才能生成预览。');
    await refresh();
    if (!candidates(snapshot, mode()).length) throw new Error('当前范围没有可整理的网页标签。');
    previewSnapshot = snapshot; generationSnapshot = snapshot; previewMode = mode();
    controller = new AbortController(); $('cancel').hidden = local;
    status(msg(local ? '正在本地生成排序预览…' : 'AI 正在分析标签，浏览器标签尚未改变…'));
    plan = await requestPlan({ ...settings, language: requestLanguage }, previewSnapshot, previewMode, $('instruction').value, controller.signal);
    await syncPreview();
    renderPreview(); status(msg('预览已生成。调整方案后，点击“确认应用”。'));
    $('preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { status(errorMessage(error), true); }
  finally { busy = false; controller = undefined; $('cancel').hidden = true; showSortingWait(false); updateControls(); if (syncPending) scheduleSync(); }
});
$('cancel').addEventListener('click', () => controller?.abort());
$('add-group').addEventListener('click', () => {
  if (!plan || isSortMode(previewMode)) return;
  plan.groups.push({ key: `new:${crypto.randomUUID()}`, title: t('新分组'), color: COLORS[plan.groups.length % COLORS.length], existingGroupId: null });
  renderPreview();
});
$('discard').addEventListener('click', () => { discard(); status(msg('已放弃预览，浏览器标签没有改变。')); });
$('apply').addEventListener('click', async () => {
  busy = true; updateControls(); applyStatus(msg('正在应用整理方案，请暂时不要移动或关闭标签…'));
  try {
    await syncPreview();
    const result = await send('apply', { snapshot: previewSnapshot, mode: previewMode, plan });
    const notices = previewNotices();
    discard(); status([msg('已整理 {count} 个标签。可撤销最近一次整理。', { count: result.changed }), ...notices,
      result.skipped ? msg('应用前另有 {count} 个标签被跳过。', { count: result.skipped }) : '']);
  } catch (error) { applyStatus(errorMessage(error), true); }
  finally {
    busy = false;
    try { await syncPreview(); await updateUndo(); } catch (error) { applyStatus(errorMessage(error), true); }
    updateControls();
    if (syncPending) scheduleSync();
  }
});
$('undo').addEventListener('click', async () => {
  busy = true; updateControls(); status(msg('正在恢复标签顺序和分组…'));
  try {
    const result = await send('undo'); discard();
    status([msg('已恢复 {count} 个标签。', { count: result.restored }),
      result.skipped ? msg('另有 {count} 个已关闭、移到其他窗口或固定的标签被跳过。', { count: result.skipped }) : '']);
  } catch (error) { status(errorMessage(error), true); }
  finally {
    busy = false;
    try { await refresh(); } catch (error) { status(errorMessage(error), true); }
    updateControls();
    if (syncPending) scheduleSync();
  }
});

async function init() {
  windowId = (await chrome.windows.getCurrent()).id;
  const [local, session] = await Promise.all([chrome.storage.local.get(['settings', 'mode', 'language']), chrome.storage.session.get('apiKey')]);
  language = resolveLanguage(local.language, chrome.i18n.getUILanguage());
  localizePage();
  settings = { ...settings, ...local.settings };
  if (!settings.rememberKey) settings.apiKey = session.apiKey || '';
  $('endpoint').value = settings.endpoint; $('model').value = settings.model;
  $('api-key').value = settings.apiKey; $('remember-key').checked = settings.rememberKey;
  if (MODES.includes(local.mode)) document.querySelector(`input[value="${local.mode}"]`).checked = true;
  updateConnection(); showSettings(mode() !== 'sort-domain' && (!settings.endpoint || !settings.model));
  await refresh();
  $('language').disabled = false;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.language) return;
    const next = resolveLanguage(changes.language.newValue, chrome.i18n.getUILanguage());
    if (next !== language) { language = next; localizePage(); }
  });
  chrome.tabs.onCreated.addListener(tab => { if (tab.windowId === windowId) scheduleSync(); });
  chrome.tabs.onRemoved.addListener((_id, info) => { if (info.windowId === windowId) scheduleSync(); });
  chrome.tabs.onAttached.addListener((_id, info) => { if (info.newWindowId === windowId) scheduleSync(); });
  chrome.tabs.onDetached.addListener((_id, info) => { if (info.oldWindowId === windowId) scheduleSync(); });
  chrome.tabs.onMoved.addListener((_id, info) => { if (info.windowId === windowId) scheduleSync(); });
  chrome.tabs.onUpdated.addListener((_id, change, tab) => {
    if (tab.windowId === windowId && ['url', 'pinned', 'groupId'].some(key => Object.hasOwn(change, key))) scheduleSync();
  });
  for (const event of [chrome.tabGroups.onCreated, chrome.tabGroups.onUpdated, chrome.tabGroups.onRemoved]) {
    event.addListener(group => { if (group.windowId === windowId) scheduleSync(); });
  }
}
localizePage();
init().catch(error => status(msg('初始化失败：{detail}', { detail: errorMessage(error) }), true));
