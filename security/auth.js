// 认证模块：用户/会话/密码管理、用户名/密码校验、字符串清洗
// 依赖：bcryptjs、crypto、fs（均为外部或内置）
// io 实例通过 setIo() 注入，用于 deleteSessionsByUsername 断开 socket

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');

const BCRYPT_ROUNDS = 12;
const SESSION_TTL = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 5000;

const sessions = new Map();
let DUMMY_HASH = null;
let ioInstance = null;

// bcrypt 并发限制：bcryptjs 是纯 JS 实现，大量并发会阻塞事件循环导致全服饥饿
const BCRYPT_MAX_CONCURRENT = 2;
let bcryptActive = 0;
const bcryptWaiters = [];

function acquireBcryptSlot() {
  return new Promise((resolve) => {
    if (bcryptActive < BCRYPT_MAX_CONCURRENT) {
      bcryptActive++;
      resolve();
    } else {
      bcryptWaiters.push(resolve);
    }
  });
}

function releaseBcryptSlot() {
  bcryptActive--;
  if (bcryptWaiters.length > 0 && bcryptActive < BCRYPT_MAX_CONCURRENT) {
    bcryptActive++;
    bcryptWaiters.shift()();
  }
}

// dummy hash 预热（时序攻击防护），必须在信号量定义之后调用
hashPassword('dummy_timing_fix_' + crypto.randomBytes(16).toString('hex')).then(h => { DUMMY_HASH = h; });

// 注入 io 实例（用于 deleteSessionsByUsername 断开 socket）
function setIo(io) {
  ioInstance = io;
}

async function hashPassword(password) {
  await acquireBcryptSlot();
  try {
    return await bcrypt.hash(password, BCRYPT_ROUNDS);
  } finally {
    releaseBcryptSlot();
  }
}

async function verifyPassword(password, hash) {
  await acquireBcryptSlot();
  try {
    return await bcrypt.compare(password, hash);
  } finally {
    releaseBcryptSlot();
  }
}

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(username, ip) {
  const token = generateToken();
  sessions.set(token, { username, createdAt: Date.now(), lastActivity: Date.now(), ip: ip || '' });
  return token;
}

function getSession(token, ip) {
  if (!token || typeof token !== 'string') return null;
  if (token.length > 128) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(token);
    return null;
  }
  if (Date.now() - session.lastActivity > 12 * 60 * 60 * 1000) {
    sessions.delete(token);
    return null;
  }
  // M7 修复：不再做会话 IP 严格绑定（IPv4/IPv6 表示差异如 ::ffff:127.0.0.1 会导致 token 频繁失效），仅保留记录供排查
  session.lastActivity = Date.now();
  return session;
}

function cleanExpiredSessions() {
  const now = Date.now();
  const toDelete = [];
  for (const [token, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL || now - session.lastActivity > 12 * 60 * 60 * 1000) {
      toDelete.push(token);
    }
  }
  for (const token of toDelete) {
    const session = sessions.get(token);
    if (session && (now - session.createdAt > SESSION_TTL || now - session.lastActivity > 12 * 60 * 60 * 1000)) {
      sessions.delete(token);
    }
  }
  if (sessions.size > MAX_SESSIONS) {
    const entries = [...sessions.entries()].sort((a, b) => a[1].lastActivity - b[1].lastActivity);
    let deleted = 0;
    const target = sessions.size - MAX_SESSIONS;
    for (let i = 0; i < entries.length && deleted < target; i++) {
      const token = entries[i][0];
      const session = sessions.get(token);
      if (session && Date.now() - session.lastActivity > 5 * 60 * 1000) {
        sessions.delete(token);
        deleted++;
      }
    }
    if (deleted < target) {
      for (let i = 0; i < entries.length && deleted < target; i++) {
        const token = entries[i][0];
        if (sessions.has(token)) {
          sessions.delete(token);
          deleted++;
        }
      }
    }
  }
}
setInterval(cleanExpiredSessions, 10 * 60 * 1000);

// 删除指定用户名对应的所有会话（用于改密码、注销等场景使旧 token 失效）
// 可选保留某个 token（例如当前调用方的 token）
function deleteSessionsByUsername(username, exceptToken) {
  const killed = [];
  for (const [token, session] of sessions) {
    if (session.username === username && token !== exceptToken) {
      sessions.delete(token);
      killed.push(token);
    }
  }
  // 断开对应 socket 连接，强制客户端重新认证
  if (ioInstance) {
    for (const [, s] of ioInstance.sockets.sockets) {
      if (s.data && s.data.authUsername === username) {
        s.emit('force-logout', '会话已失效，请重新登录');
        s.disconnect(true);
      }
    }
  }
  return killed;
}

function sanitizeString(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b\u200c\u200d\ufeff]/g, '').trim();
}

function isValidUsername(username) {
  if (typeof username !== 'string') return false;
  if (username.length === 0 || username.length > 12) return false;
  if (!/^[\w\u4e00-\u9fff]+$/.test(username)) return false;
  if (/^\d+$/.test(username)) return false;
  if (username !== username.normalize('NFC')) return false;
  const normalized = username.normalize('NFC');
  // 禁连续双下划线：私聊会话 key 以 "__" 作分隔符，用户名内含 "__" 会导致会话归属歧义
  if (normalized.includes('__')) return false;
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.codePointAt(i);
    if (code < 0x20 || (code >= 0x7F && code <= 0x9F)) return false;
    if (code >= 0x200B && code <= 0x200F) return false;
    if (code >= 0x2028 && code <= 0x202F) return false;
    if (code >= 0xFEFF && code <= 0xFEFF) return false;
    if (code >= 0xFFF0 && code <= 0xFFFF) return false;
  }
  return true;
}

function isValidPassword(password) {
  if (typeof password !== 'string') return false;
  if (password.length < 6 || password.length > 128) return false;
  return true;
}

function loadUsers(usersFile) {
  if (!fs.existsSync(usersFile)) return {};
  try { return JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch { return {}; }
}

module.exports = {
  setIo,
  hashPassword,
  verifyPassword,
  safeCompare,
  createSession,
  getSession,
  deleteSessionsByUsername,
  sanitizeString,
  isValidUsername,
  isValidPassword,
  loadUsers,
  sessions,
  BCRYPT_ROUNDS,
  SESSION_TTL,
  MAX_SESSIONS,
  DUMMY_HASH: () => DUMMY_HASH
};
