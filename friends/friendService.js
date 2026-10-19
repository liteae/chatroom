// 好友服务：好友关系缓存/黑名单判定/注销清理
// 数据存储：friends/ 目录，每用户一文件 username.json
// chat 模块依赖本模块的 isBlocked 做拉黑过滤；本模块不反向依赖 chat
const fs = require('fs');
const path = require('path');
const { withFileLock, atomicWriteJSON } = require('../utils/atomicWrite');
const pmHistoryStore = require('../storage/pmHistoryStore');

let ioInstance = null;
let friendsDir = null;
let lockFile = null;

// 内存缓存：username -> { friends:Set, pendingSent:Set, pendingReceived:Set, blacklist:Set }
const friendsCache = new Map();
let cacheLoaded = false;

// saveAll debounce 相关
let saveTimer = null;
let savePending = false;

function init({ dataDir }) {
  friendsDir = path.join(dataDir, 'friends');
  lockFile = path.join(dataDir, 'friends.lock');
  if (!fs.existsSync(friendsDir)) fs.mkdirSync(friendsDir, { recursive: true });
  pmHistoryStore.init({ dataDir });
  migrateLegacySingleFile(dataDir);
}

function register(io) {
  ioInstance = io;
}

// 旧版单文件 friends.json → friends/ 目录（迁移后删除旧文件）
function migrateLegacySingleFile(dataDir) {
  const oldFile = path.join(dataDir, 'friends.json');
  if (!fs.existsSync(oldFile)) return;
  try {
    const data = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
    for (const [username, info] of Object.entries(data)) {
      const filePath = path.join(friendsDir, `${username}.json`);
      if (!fs.existsSync(filePath)) {
        atomicWriteJSON(filePath, {
          friends: info.friends || [],
          pendingSent: info.pendingSent || [],
          pendingReceived: info.pendingReceived || [],
          blacklist: info.blacklist || []
        });
      }
    }
    fs.unlinkSync(oldFile);
    console.log(`已迁移 ${Object.keys(data).length} 个好友记录到 friends/ 目录`);
  } catch (e) {
    console.error('friends.json 迁移失败:', e.message);
  }
}

function ensureCacheLoaded() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  let files = [];
  try { files = fs.readdirSync(friendsDir); } catch { return; }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const username = file.slice(0, -5);
    if (!username) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(friendsDir, file), 'utf8'));
      friendsCache.set(username, {
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

// 写入 friends/ 目录：每个用户一个文件，空条目文件删除
function doSave() {
  const toWrite = {};
  const toDelete = [];
  for (const [username, info] of friendsCache) {
    // 清理空条目，避免内存和文件膨胀
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
  return withFileLock(lockFile, () => {
    // 写入/更新有数据的用户
    for (const [username, data] of Object.entries(toWrite)) {
      atomicWriteJSON(path.join(friendsDir, `${username}.json`), data);
    }
    // 删除空条目文件
    for (const username of toDelete) {
      try { fs.unlinkSync(path.join(friendsDir, `${username}.json`)); } catch {}
    }
  }).catch(err => {
    console.error('friends/ 目录写入失败:', err.message);
  });
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
