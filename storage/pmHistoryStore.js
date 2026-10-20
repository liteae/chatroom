// 私聊历史存储：SQLite pm_history 表（pm_key 主键 + data JSON 列存整个历史数组）
// 内存 LRU 缓存 + 字节上限逻辑完整保留（H1），落盘走 SQL
// pmKey 归属判定（M2 修复）与注销清理（H3 修复）逻辑原样保留
const db = require('./db');
const {
  MAX_PM_HISTORY, PM_HISTORY_MAX_BYTES, PM_CACHE_MAX_PAIRS
} = require('../config/constants');

const pmHistoryCache = new Map();   // pmKey -> history数组（LRU：Map 尾部为最新）
const pmHistoryBytes = new Map();   // pmKey -> 近似序列化字节数
let pmHistoryDirty = new Set();

function init() {}

// 会话对标识：两个用户名排序后拼接
function getPmKey(user1, user2) {
  return [user1, user2].sort().join('__');
}

// 估算单条历史记录的序列化字节数
function estimateEntryBytes(entry) {
  try { return JSON.stringify(entry).length; } catch { return 1024; }
}

// 从 SQL 加载（缓存未命中时调用）
function loadFromDb(pmKey) {
  const row = db.get('SELECT data FROM pm_history WHERE pm_key = ?', [pmKey]);
  if (!row) return [];
  try {
    const h = JSON.parse(row.data);
    return Array.isArray(h) ? h : [];
  } catch { return []; }
}

// 写入 SQL（UPSERT 整个数组）
function saveToDb(pmKey) {
  const history = pmHistoryCache.get(pmKey);
  if (!history) return;
  db.run('INSERT OR REPLACE INTO pm_history (pm_key, data) VALUES (?, ?)', [pmKey, JSON.stringify(history)]);
}

function getPmHistory(pmKey) {
  if (pmHistoryCache.has(pmKey)) {
    // LRU 刷新
    const cached = pmHistoryCache.get(pmKey);
    pmHistoryCache.delete(pmKey);
    pmHistoryCache.set(pmKey, cached);
    return cached;
  }
  const history = loadFromDb(pmKey);
  pmHistoryCache.set(pmKey, history);
  let total = 0;
  for (const e of history) total += estimateEntryBytes(e);
  pmHistoryBytes.set(pmKey, total);
  evictPmCacheIfNeeded();
  return history;
}

// LRU 逐出：超出缓存会话数上限时，最久未用的会话先落库再移出内存
function evictPmCacheIfNeeded() {
  while (pmHistoryCache.size > PM_CACHE_MAX_PAIRS) {
    const oldestKey = pmHistoryCache.keys().next().value;
    if (pmHistoryDirty.has(oldestKey)) {
      try { saveToDb(oldestKey); }
      catch (e) { console.error('LRU 逐出落库失败:', e.message); }
      pmHistoryDirty.delete(oldestKey);
    }
    pmHistoryCache.delete(oldestKey);
    pmHistoryBytes.delete(oldestKey);
  }
}

function addPmHistory(pmKey, type, data) {
  const history = getPmHistory(pmKey);
  const entry = { type, data };
  history.push(entry);
  let total = (pmHistoryBytes.get(pmKey) || 0) + estimateEntryBytes(entry);
  // 条数上限
  while (history.length > MAX_PM_HISTORY) {
    total -= estimateEntryBytes(history.shift());
  }
  // 字节上限：从最旧的消息开始丢弃
  while (total > PM_HISTORY_MAX_BYTES && history.length > 1) {
    total -= estimateEntryBytes(history.shift());
  }
  pmHistoryBytes.set(pmKey, Math.max(0, total));
  pmHistoryDirty.add(pmKey);
  // 防抖落盘在 db 层（整库统一 2 秒窗口）
  db.markDirty();
}

// 立即落库（进程退出前调用；db.flushNow 负责写磁盘文件）
function flushPmHistory() {
  const dirty = [...pmHistoryDirty];
  pmHistoryDirty.clear();
  for (const pmKey of dirty) {
    try {
      saveToDb(pmKey);
    } catch (e) {
      console.error('保存私聊历史失败:', e.message);
    }
  }
  db.flushNow();
}

// 兼容旧接口（server.js shutdown 调用）
function flushNow() {
  flushPmHistory();
}

// pmKey 形如 "userA__userB"（排序后拼接），判断某用户是否为其中一方
// 新注册用户名不含 "__"（isValidUsername 已禁止），key 恰好拆为两段时可精确判定归属；
// 仅当 username 自身含 "__"（历史存量）时才回退前缀/后缀匹配。
// 对拆出超过两段的歧义 key（历史含 "__" 用户名产生），非含 "__" 用户一律不匹配：
// 宁可残留孤儿记录也不误删他人会话（如 "a" 不得命中属于 "a__b" 与 "c" 的 "a__b__c"）
function isPmKeyOf(pmKey, username) {
  if (typeof pmKey !== 'string' || typeof username !== 'string' || !username) return false;
  const parts = pmKey.split('__');
  if (parts.length === 2) {
    return parts[0] === username || parts[1] === username;
  }
  if (username.includes('__')) {
    return pmKey.startsWith(username + '__') || pmKey.endsWith('__' + username);
  }
  return false;
}

// H3 修复：注销用户时删除其参与的所有私聊历史（缓存 + SQL），防同名重注册后旧记录复活
function cleanupUserPmHistory(username) {
  // 清理内存缓存
  for (const pmKey of [...pmHistoryCache.keys()]) {
    if (isPmKeyOf(pmKey, username)) {
      pmHistoryCache.delete(pmKey);
      pmHistoryBytes.delete(pmKey);
      pmHistoryDirty.delete(pmKey);
    }
  }
  // 清理 SQL 记录（含未加载进缓存的）
  try {
    const keys = db.all('SELECT pm_key FROM pm_history').map(r => r.pm_key);
    for (const pmKey of keys) {
      if (isPmKeyOf(pmKey, username)) {
        db.run('DELETE FROM pm_history WHERE pm_key = ?', [pmKey]);
      }
    }
  } catch (e) {
    console.error('注销清理私聊历史失败:', e.message);
  }
}

module.exports = {
  init,
  getPmKey,
  getPmHistory,
  addPmHistory,
  flushPmHistory,
  flushNow,
  cleanupUserPmHistory
};
