// 用户账号存储：users/ 目录，每用户一文件 username.json
// 启动时自动从旧 users.json 迁移（迁移后删除旧文件）
// loadUsers() 返回全量对象（目录扫描），saveUsers() 全量写目录
const fs = require('fs');
const path = require('path');
const { withFileLock, atomicWriteJSON } = require('../utils/atomicWrite');

let usersDir = null;
let lockFile = null; // 目录级文件锁

function init({ dataDir }) {
  usersDir = path.join(dataDir, 'users');
  lockFile = path.join(dataDir, 'users.lock');
  if (!fs.existsSync(usersDir)) fs.mkdirSync(usersDir, { recursive: true });
  migrateLegacySingleFile(dataDir);
}

// 旧版单文件 users.json → users/ 目录（迁移后删除旧文件）
// 注意：Windows 文件系统不区分大小写，attacker1 和 Attacker1 会冲突
// 迁移时检测冲突，保留先写入的，跳过后来的（记录警告）
function migrateLegacySingleFile(dataDir) {
  const oldFile = path.join(dataDir, 'users.json');
  if (!fs.existsSync(oldFile)) return;
  try {
    const users = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
    const seenLower = new Set(); // 小写文件名去重
    let count = 0;
    for (const [username, data] of Object.entries(users)) {
      const lower = username.toLowerCase();
      if (seenLower.has(lower)) {
        console.warn(`迁移跳过: 用户名 "${username}" 与已存在用户名大小写冲突`);
        continue;
      }
      seenLower.add(lower);
      const filePath = path.join(usersDir, `${username}.json`);
      if (!fs.existsSync(filePath)) {
        atomicWriteJSON(filePath, data);
        count++;
      }
    }
    fs.unlinkSync(oldFile);
    console.log(`已迁移 ${count} 个用户到 users/ 目录`);
  } catch (e) {
    console.error('users.json 迁移失败:', e.message);
  }
}

function loadUsers() {
  const users = {};
  let files = [];
  try { files = fs.readdirSync(usersDir); } catch { return users; }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const username = file.slice(0, -5);
    if (!username) continue;
    try {
      users[username] = JSON.parse(fs.readFileSync(path.join(usersDir, file), 'utf8'));
    } catch {}
  }
  return users;
}

// 全量写目录：先写所有新文件，再删除不再存在的用户文件
function saveUsers(users) {
  const existing = new Set();
  let files = [];
  try { files = fs.readdirSync(usersDir); } catch { files = []; }
  for (const file of files) {
    if (file.endsWith('.json')) existing.add(file.slice(0, -5));
  }
  const newUsernames = new Set(Object.keys(users));
  // 写入/更新
  for (const [username, data] of Object.entries(users)) {
    atomicWriteJSON(path.join(usersDir, `${username}.json`), data);
  }
  // 删除不再存在的
  for (const username of existing) {
    if (!newUsernames.has(username)) {
      try { fs.unlinkSync(path.join(usersDir, `${username}.json`)); } catch {}
    }
  }
}

// 带锁保存：注册/改密/注销等"读-改-写"场景必须持锁
function saveUsersLocked(users) {
  return withFileLock(lockFile, () => {
    saveUsers(users);
  });
}

// 兼容旧接口：返回锁文件路径供 withFileLock 使用
function getUsersFile() {
  return lockFile;
}

module.exports = { init, loadUsers, saveUsers, saveUsersLocked, getUsersFile, withFileLock };
