import { applyPlan, takeSnapshot, undoLast, undoKey } from './engine.js';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

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
  if (!Number.isInteger(windowId) || !['snapshot', 'apply', 'undo', 'undoStatus'].includes(type)) return;
  serial(windowId, async () => {
    if (type === 'snapshot') return takeSnapshot(chrome, windowId);
    if (type === 'apply') {
      if (message.snapshot?.windowId !== windowId) throw new Error('窗口不匹配。');
      return applyPlan(chrome, message.snapshot, message.mode, message.plan);
    }
    if (type === 'undo') return undoLast(chrome, windowId);
    const key = undoKey(windowId);
    const record = (await chrome.storage.session.get(key))[key];
    return { available: Boolean(record), status: record?.status };
  }).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message || '操作失败。' }));
  return true;
});

chrome.windows.onRemoved.addListener(windowId => {
  chrome.storage.session.remove(undoKey(windowId)).catch(() => {});
});
