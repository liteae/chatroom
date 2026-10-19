// 群历史存储：每群独立文件 + 内存 LRU 缓存 + 字节上限（H1 防内存放大）
const fs = require('fs');
const path = require('path');
const { GROUP_HISTORY_MAX_BYTES, GROUP_HISTORY_CACHE_MAX, MAX_HISTORY } = require('../config/constants');
const { atomicWriteJSON } = require('../utils/atomicWrite');

let historyDir = null;

// 群ID格式校验：group_ + 32位hex（防路径穿越）
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
let historyDirty = new Set();   // 需要写入磁盘的 groupId
let historySaveTimer = null;    // 防抖定时器

function init({ dataDir }) {
  historyDir = path.join(dataDir, 'history');
  if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true });
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
  const filePath = path.join(historyDir, `${groupId}.json`);
  let history = [];
  try {
    if (fs.existsSync(filePath)) {
      history = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(history)) history = [];
    }
  } catch { history = []; }
  historyCache.set(groupId, history);
  let total = 0;
  for (const e of history) total += estimateHistoryEntryBytes(e);
  historyBytes.set(groupId, total);
  // LRU 逐出：最久未用的群先落盘再移出内存
  while (historyCache.size > GROUP_HISTORY_CACHE_MAX) {
    const oldestId = historyCache.keys().next().value;
    if (historyDirty.has(oldestId)) {
      const h = historyCache.get(oldestId);
      const fp = path.join(historyDir, `${oldestId}.json`);
      try { atomicWriteJSON(fp, h); } catch (e) { console.error(`LRU 逐出落盘失败(${oldestId}):`, e.message); }
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
  scheduleHistorySave();
}

function scheduleHistorySave() {
  if (historySaveTimer) return;
  historySaveTimer = setTimeout(() => {
    flushHistory();
    historySaveTimer = null;
  }, 2000); // 2秒防抖
}

function flushHistory() {
  const dirty = [...historyDirty];
  historyDirty.clear();
  for (const groupId of dirty) {
    if (!isSafeGroupId(groupId)) continue;
    const history = historyCache.get(groupId);
    if (!history) continue;
    const filePath = path.join(historyDir, `${groupId}.json`);
    try {
      atomicWriteJSON(filePath, history);
    } catch (e) {
      console.error(`保存群聊${groupId}历史失败:`, e.message);
    }
  }
}

function deleteGroupHistory(groupId) {
  if (!isSafeGroupId(groupId)) return;
  historyCache.delete(groupId);
  historyBytes.delete(groupId);
  historyDirty.delete(groupId);
  const filePath = path.join(historyDir, `${groupId}.json`);
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
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
