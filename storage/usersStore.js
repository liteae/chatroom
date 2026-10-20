// 用户账号存储：SQLite users 表（username 主键 + lower_name 唯一 + data JSON 列）
// lower_name 保持与旧版 Windows 文件系统一致的大小写不敏感唯一性（attacker1 与 Attacker1 冲突）
// 对外 API 与旧 JSON 文件版完全一致：loadUsers() 全量对象 / saveUsers() 全量写
const path = require('path');
const db = require('./db');
const { withFileLock } = require('../utils/atomicWrite');

let lockFile = null; // 兼容旧锁接口（authRoutes 的 withFileLock 包裹仍传入此路径）

function init({ dataDir }) {
  lockFile = path.join(dataDir, 'users.lock');
}

function loadUsers() {
  const users = {};
  for (const row of db.all('SELECT username, data FROM users')) {
    try {
      users[row.username] = JSON.parse(row.data);
    } catch {}
  }
  return users;
}

// 全量写：事务内清表重建（INSERT OR REPLACE 保持"后写胜"语义）
function saveUsers(users) {
  db.transaction(() => {
    db.run('DELETE FROM users');
    for (const [username, data] of Object.entries(users)) {
      db.run(
        'INSERT OR REPLACE INTO users (username, lower_name, data) VALUES (?, ?, ?)',
        [username, username.toLowerCase(), JSON.stringify(data)]
      );
    }
  });
}

// 带锁保存：SQL 单连接天然串行，锁不再必要，保留接口兼容旧调用方
function saveUsersLocked(users) {
  return saveUsers(users);
}

// 兼容旧接口：返回锁文件路径供 withFileLock 使用
function getUsersFile() {
  return lockFile;
}

module.exports = { init, loadUsers, saveUsers, saveUsersLocked, getUsersFile, withFileLock };
