// 私聊历史存储：每会话对独立文件 + 内存 LRU 缓存 + 字节上限（H1）
const fs = require('fs');
const path = require('path');
const {
  MAX_PM_HISTORY, PM_HISTORY_MAX_BYTES, PM_CACHE_MAX_PAIRS
} = require('../config/constants');
const { atomicWriteJSON } = require('../utils/atomicWrite');

let pmHistoryDir = null;

const pmHistoryCache = new Map();   // pmKey -> history数组（LRU：Map 尾部为最新）
const pmHistoryBytes = new Map();   // pmKey -> 近似序列化字节数
let pmHistoryDirty = new Set();
let pmHistorySaveTimer = null;

function init({ dataDir }) {
  pmHistoryDir = path.join(dataDir, 'pm_history');
  if (!fs.existsSync(pmHistoryDir)) fs.mkdirSync(pmHistoryDir, { recursive: true });
}

// 会话对标识：两个用户名排序后拼接
function getPmKey(user1, user2) {
  return [user1, user2].sort().join('__');
}

// 估算单条历史记录的序列化字节数
function estimateEntryBytes(entry) {
  try { return JSON.stringify(entry).length; } catch { return 1024; }
}

function getPmHistory(pmKey) {
  if (pmHistoryCache.has(pmKey)) {
    // LRU 刷新
    const cached = pmHistoryCache.get(pmKey);
    pmHistoryCache.delete(pmKey);
    pmHistoryCache.set(pmKey, cached);
    return cached;
  }
  const filePath = path.join(pmHistoryDir, `${pmKey}.json`);
  let history = [];
  try {
    if (fs.existsSync(filePath)) {
      history = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(history)) history = [];
    }
  } catch { history = []; }
  pmHistoryCache.set(pmKey, history);
  let total = 0;
  for (const e of history) total += estimateEntryBytes(e);
  pmHistoryBytes.set(pmKey, total);
  evictPmCacheIfNeeded();
  return history;
}

// LRU 逐出：超出缓存会话数上限时，最久未用的会话先落盘再移出内存
function evictPmCacheIfNeeded() {
  while (pmHistoryCache.size > PM_CACHE_MAX_PAIRS) {
    const oldestKey = pmHistoryCache.keys().next().value;
    if (pmHistoryDirty.has(oldestKey)) {
      const history = pmHistoryCache.get(oldestKey);
      const filePath = path.join(pmHistoryDir, `${oldestKey}.json`);
      try { atomicWriteJSON(filePath, history); }
      catch (e) { console.error('LRU 逐出落盘失败:', e.message); }
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
  schedulePmHistorySave();
}

function schedulePmHistorySave() {
  if (pmHistorySaveTimer) return;
  pmHistorySaveTimer = setTimeout(() => {
    flushPmHistory();
    pmHistorySaveTimer = null;
  }, 2000); // 2秒防抖
}

function flushPmHistory() {
  const dirty = [...pmHistoryDirty];
  pmHistoryDirty.clear();
  for (const pmKey of dirty) {
    const history = pmHistoryCache.get(pmKey);
    if (!history) continue;
    const filePath = path.join(pmHistoryDir, `${pmKey}.json`);
    try {
      atomicWriteJSON(filePath, history);
    } catch (e) {
      console.error('保存私聊历史失败:', e.message);
    }
  }
}

// 进程退出前调用：取消防抖定时器并立即落盘
function flushNow() {
  if (pmHistorySaveTimer) {
    clearTimeout(pmHistorySaveTimer);
    pmHistorySaveTimer = null;
  }
  flushPmHistory();
}

// pmKey 形如 "userA__userB"（排序后拼接），判断某用户是否为其中一方
// 新注册用户名不含 "__"（isValidUsername 已禁止），key 恰好拆为两段时可精确判定归属；
// 仅当 username 自身含 "__"（历史存量）时才回退前缀/后缀匹配。
// 对拆出超过两段的歧义 key（历史含 "__" 用户名产生），非含 "__" 用户一律不匹配：
// 宁可残留孤儿文件也不误删他人会话（如 "a" 不得命中属于 "a__b" 与 "c" 的 "a__b__c"）
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

// H3 修复：注销用户时删除其参与的所有私聊历史（缓存 + 磁盘），防同名重注册后旧记录复活
function cleanupUserPmHistory(username) {
  // 清理内存缓存
  for (const pmKey of [...pmHistoryCache.keys()]) {
    if (isPmKeyOf(pmKey, username)) {
      pmHistoryCache.delete(pmKey);
      pmHistoryBytes.delete(pmKey);
      pmHistoryDirty.delete(pmKey);
    }
  }
  // 清理磁盘文件（含未加载进缓存的）
  if (pmHistoryDir && fs.existsSync(pmHistoryDir)) {
    for (const fname of fs.readdirSync(pmHistoryDir)) {
      if (!fname.endsWith('.json')) continue;
      const base = fname.slice(0, -5);
      if (isPmKeyOf(base, username)) {
        try { fs.unlinkSync(path.join(pmHistoryDir, fname)); }
        catch (e) { console.error('注销清理私聊历史失败:', e.message); }
      }
    }
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
