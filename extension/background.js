import { applyPlan, takeSnapshot, toggleAllGroups, undoLast, undoKey } from './engine.js';
import { appearanceForEndpoint } from './appearance.js';
import { scanDuplicates, closeDuplicates, duplicateKey } from './duplicates.js';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

// Worker 启动和配置变化均从持久存储恢复；串行更新避免快速切换后图标回退。
let toolbarUpdate = Promise.resolve();
function refreshToolbarAppearance() {
  toolbarUpdate = toolbarUpdate.catch(() => {}).then(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.action.setIcon({ path: appearanceForEndpoint(settings?.endpoint).icons });
  });
  toolbarUpdate.catch(error => console.warn('Toolbar icon update failed', error));
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) refreshToolbarAppearance();
});
refreshToolbarAppearance();

// 队列只负责当前 worker 的并发；恢复记录保存在 session 中，跨 worker 重启有效。
const queues = new Map();
function serial(windowId, operation) {
  const previous = queues.get(windowId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  queues.set(windowId, next);
  next.finally(() => { if (queues.get(windowId) === next) queues.delete(windowId); }).catch(() => {});
  return next;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL('sidepanel.html')) return;
  const { type, windowId } = message ?? {};
  if (!Number.isInteger(windowId) || !['snapshot', 'apply', 'undo', 'undoStatus', 'toggleGroups', 'scanDuplicates', 'closeDuplicates', 'discardDuplicates'].includes(type)) return;
  // 跨窗关闭与整理共用队列，避免不同侧栏同时修改同一批标签。
  serial('browser', async () => {
    if (type === 'scanDuplicates') return scanDuplicates(chrome, windowId);
    if (type === 'closeDuplicates') return closeDuplicates(chrome, windowId, message.previewId, message.closeIds);
    if (type === 'discardDuplicates') {
      const key = duplicateKey(windowId);
      const preview = (await chrome.storage.session.get(key))[key];
      if (preview?.id === message.previewId) await chrome.storage.session.remove(key);
      return;
    }
    if (type === 'snapshot') return takeSnapshot(chrome, windowId);
    if (type === 'toggleGroups') return toggleAllGroups(chrome, windowId);
    if (type === 'apply') {
      if (message.snapshot?.windowId !== windowId) throw new Error('窗口不匹配。');
      const { groupDisplay } = await chrome.storage.local.get('groupDisplay');
      return applyPlan(chrome, message.snapshot, message.mode, message.plan, groupDisplay === 'collapse');
    }
    if (type === 'undo') return undoLast(chrome, windowId);
    const key = undoKey(windowId);
    const record = (await chrome.storage.session.get(key))[key];
    return { available: Boolean(record), status: record?.status };
  }).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message || '操作失败。' }));
  return true;
});

chrome.windows.onRemoved.addListener(windowId => {
  chrome.storage.session.remove([undoKey(windowId), duplicateKey(windowId)]).catch(() => {});
});
