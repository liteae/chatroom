// 好友服务：好友关系缓存/黑名单判定/注销清理
// 数据存储：SQLite friends 表（username 主键 + data JSON 列）
// chat 模块依赖本模块的 isBlocked 做拉黑过滤；本模块不反向依赖 chat
const db = require('../storage/db');
const pmHistoryStore = require('../storage/pmHistoryStore');

let ioInstance = null;

// 内存缓存：username -> { friends:Set, pendingSent:Set, pendingReceived:Set, blacklist:Set }
const friendsCache = new Map();
let cacheLoaded = false;

function init({ dataDir }) {
  pmHistoryStore.init({ dataDir });
}

function register(io) {
  ioInstance = io;
}

function ensureCacheLoaded() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  let rows = [];
  try { rows = db.all('SELECT username, data FROM friends'); } catch { return; }
  for (const row of rows) {
    try {
      const info = JSON.parse(row.data);
      friendsCache.set(row.username, {
        friends: new Set(info.friends || []),
        pendingSent: new Set(info.pendingSent || []),
        pendingReceived: new Set(info.pendingReceived || []),
        blacklist: new Set(info.blacklist || [])
      });
    } catch {}
  }
}

function getUserData(username) {
  ensureCacheLoaded();
  if (!friendsCache.has(username)) {
    friendsCache.set(username, {
      friends: new Set(),
      pendingSent: new Set(),
      pendingReceived: new Set(),
      blacklist: new Set()
    });
  }
  return friendsCache.get(username);
}

// saveAll debounce 相关
let saveTimer = null;
let savePending = false;

// debounce 写入，500ms 内多次调用合并为一次
function saveAll() {
  if (saveTimer) {
    savePending = true;
    return;
  }
  doSave();
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (savePending) {
      savePending = false;
      saveAll();
    }
  }, 500);
}

// 写入 friends 表：UPSERT 有数据的用户，删除空条目（防抖落盘在 db 层）
function doSave() {
  const toWrite = {};
  const toDelete = [];
  for (const [username, info] of friendsCache) {
    // 清理空条目，避免内存和数据膨胀
    if (info.friends.size === 0 && info.pendingSent.size === 0 &&
        info.pendingReceived.size === 0 && info.blacklist.size === 0) {
      friendsCache.delete(username);
      toDelete.push(username);
      continue;
    }
    toWrite[username] = {
      friends: Array.from(info.friends),
      pendingSent: Array.from(info.pendingSent),
      pendingReceived: Array.from(info.pendingReceived),
      blacklist: Array.from(info.blacklist)
    };
  }
  try {
    for (const [username, data] of Object.entries(toWrite)) {
      db.run('INSERT OR REPLACE INTO friends (username, data) VALUES (?, ?)', [username, JSON.stringify(data)]);
    }
    for (const username of toDelete) {
      db.run('DELETE FROM friends WHERE username = ?', [username]);
    }
  } catch (err) {
    console.error('friends 表写入失败:', err.message);
  }
}

// 检查 A 是否把 B 拉黑了
function isBlocked(blocker, target) {
  if (!blocker || !target) return false;
  const data = getUserData(blocker);
  return data.blacklist.has(target);
}

// 检查两人是否是好友
function areFriends(user1, user2) {
  const data = getUserData(user1);
  return data.friends.has(user2);
}

// 一次性收集所有在线用户名，避免 O(好友×连接) 遍历
function getOnlineUsernames() {
  const online = new Set();
  if (!ioInstance) return online;
  for (const [, s] of ioInstance.sockets.sockets) {
    if (s.data && s.data.authUsername) online.add(s.data.authUsername);
  }
  return online;
}

// 获取用户在线 socket 列表
function getUserSockets(username) {
  const sockets = [];
  if (!ioInstance) return sockets;
  for (const [, s] of ioInstance.sockets.sockets) {
    if (s.data && s.data.authUsername === username) sockets.push(s);
  }
  return sockets;
}

// 注销用户时清理好友数据（供 authRoutes 调用）
// H3 修复：同时删除该用户参与的所有私聊历史（缓存 + 磁盘文件），防止同名重注册后旧记录复活
function cleanupUser(username) {
  const data = friendsCache.get(username);
  if (data) {
    // 从所有好友、申请、黑名单中移除该用户
    for (const [, info] of friendsCache) {
      info.friends.delete(username);
      info.pendingSent.delete(username);
      info.pendingReceived.delete(username);
      info.blacklist.delete(username);
    }
    friendsCache.delete(username);
  }
  saveAll();
  pmHistoryStore.cleanupUserPmHistory(username);
}

// 进程退出前一次性落盘私聊历史与好友数据
function flushAll() {
  pmHistoryStore.flushNow();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    savePending = false;
  }
  doSave();
}

module.exports = {
  init,
  register,
  getUserData,
  isBlocked,
  areFriends,
  getOnlineUsernames,
  getUserSockets,
  saveAll,
  cleanupUser,
  flushAll
};
