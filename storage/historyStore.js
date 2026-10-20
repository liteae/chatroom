// 群历史存储：SQLite group_history 表（id 主键 + data JSON 列存整个历史数组）
// 内存 LRU 缓存 + 字节上限逻辑完整保留（H1 防内存放大），落盘走 SQL
const db = require('./db');
const { GROUP_HISTORY_MAX_BYTES, GROUP_HISTORY_CACHE_MAX, MAX_HISTORY } = require('../config/constants');

// 群ID格式校验：group_ + 32位hex（防注入/防误用）
function isSafeGroupId(id) {
  if (typeof id !== 'string') return false;
  return /^group_[0-9a-f]{32}$/.test(id);
}

// 估算单条历史记录的序列化字节数
function estimateHistoryEntryBytes(entry) {
  try { return JSON.stringify(entry).length; } catch { return 1024; }
}

const historyCache = new Map(); // groupId -> history数组（LRU：Map 尾部为最新）
const historyBytes = new Map(); // groupId -> 近似序列化字节数
let historyDirty = new Set();   // 需要写入 SQL 的 groupId

function init() {}

// 从 SQL 加载某群历史（缓存未命中时调用）
function loadFromDb(groupId) {
  const row = db.get('SELECT data FROM group_history WHERE id = ?', [groupId]);
  if (!row) return [];
  try {
    const h = JSON.parse(row.data);
    return Array.isArray(h) ? h : [];
  } catch { return []; }
}

// 写入 SQL（UPSERT 整个数组）
function saveToDb(groupId) {
  const history = historyCache.get(groupId);
  if (!history) return;
  db.run('INSERT OR REPLACE INTO group_history (id, data) VALUES (?, ?)', [groupId, JSON.stringify(history)]);
}

function getGroupHistory(groupId) {
  if (!isSafeGroupId(groupId)) return [];
  if (historyCache.has(groupId)) {
    // LRU 刷新：移到 Map 尾部（最新）
    const cached = historyCache.get(groupId);
    historyCache.delete(groupId);
    historyCache.set(groupId, cached);
    return cached;
  }
  const history = loadFromDb(groupId);
  historyCache.set(groupId, history);
  let total = 0;
  for (const e of history) total += estimateHistoryEntryBytes(e);
  historyBytes.set(groupId, total);
  // LRU 逐出：最久未用的群先落库再移出内存
  while (historyCache.size > GROUP_HISTORY_CACHE_MAX) {
    const oldestId = historyCache.keys().next().value;
    if (historyDirty.has(oldestId)) {
      try { saveToDb(oldestId); }
      catch (e) { console.error(`LRU 逐出落库失败(${oldestId}):`, e.message); }
      historyDirty.delete(oldestId);
    }
    historyCache.delete(oldestId);
    historyBytes.delete(oldestId);
  }
  return history;
}

function addGroupHistory(groupId, type, data) {
  const history = getGroupHistory(groupId);
  const entry = { type, data };
  history.push(entry);
  let total = (historyBytes.get(groupId) || 0) + estimateHistoryEntryBytes(entry);
  // 条数上限
  while (history.length > MAX_HISTORY) {
    total -= estimateHistoryEntryBytes(history.shift());
  }
  // 字节上限：从最旧的消息开始丢弃
  while (total > GROUP_HISTORY_MAX_BYTES && history.length > 1) {
    total -= estimateHistoryEntryBytes(history.shift());
  }
  historyBytes.set(groupId, Math.max(0, total));
  historyDirty.add(groupId);
  // 防抖落盘在 db 层（整库统一 2 秒窗口）
  db.markDirty();
}

// 立即落库（进程退出前调用；db.flushNow 负责写磁盘文件）
function flushHistory() {
  const dirty = [...historyDirty];
  historyDirty.clear();
  for (const groupId of dirty) {
    if (!isSafeGroupId(groupId)) continue;
    try {
      saveToDb(groupId);
    } catch (e) {
      console.error(`保存群聊${groupId}历史失败:`, e.message);
    }
  }
  db.flushNow();
}

function deleteGroupHistory(groupId) {
  if (!isSafeGroupId(groupId)) return;
  historyCache.delete(groupId);
  historyBytes.delete(groupId);
  historyDirty.delete(groupId);
  db.run('DELETE FROM group_history WHERE id = ?', [groupId]);
}

module.exports = {
  init,
  isSafeGroupId,
  estimateHistoryEntryBytes,
  getGroupHistory,
  addGroupHistory,
  flushHistory,
  deleteGroupHistory
};
