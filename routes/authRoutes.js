// 认证路由：注册/登录/登出/会话查询/改密/注销
const { asyncHandler } = require('../middleware/errorHandler');
const { rateLimit } = require('../middleware/httpRateLimit');
const { sanitizeBody } = require('../utils/sanitize');
const { makeFailLock } = require('../utils/failLock');
const { MAX_USERS } = require('../config/constants');
const auth = require('../security/auth');
const usersStore = require('../storage/usersStore');
const groupsStore = require('../storage/groupsStore');
const groupManager = require('../groups/groupManager');

// M6 修复：账户登录失败锁定：5 次/15 分钟 -> 锁 15 分钟
const loginLock = makeFailLock({ limit: 5, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 });

function registerAuthRoutes(app, { verifyCaptcha, friendCleanup }) {
  const {
    hashPassword, verifyPassword, createSession, getSession,
    deleteSessionsByUsername, sanitizeString, isValidUsername, isValidPassword,
    sessions, DUMMY_HASH
  } = auth;

  app.post('/api/register', asyncHandler(async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    if (rateLimit(`register:${ip}`, 40, 15 * 60 * 1000)) {
      return res.status(429).json({ success: false, message: '注册请求过于频繁，请稍后再试' });
    }
    const body = sanitizeBody(req.body);
    if (!verifyCaptcha(body.captchaId, body.captchaCode)) {
      return res.json({ success: false, message: '验证码错误或已过期' });
    }
    const rawUsername = body.username;
    if (typeof rawUsername !== 'string') return res.json({ success: false, message: '用户名或密码无效' });
    const username = sanitizeString(rawUsername);
    if (rawUsername !== username) return res.json({ success: false, message: '用户名或密码无效' });
    const password = body.password;
    if (!isValidUsername(username)) return res.json({ success: false, message: '用户名或密码无效' });
    if (!isValidPassword(password)) return res.json({ success: false, message: '用户名或密码无效' });
    const passwordHash = await hashPassword(password);
    let registered = false;
    let dupReason = '';
    await usersStore.withFileLock(usersStore.getUsersFile(), () => {
      const users = usersStore.loadUsers();
      // Windows 文件系统大小写不敏感：Attacker1 与 attacker1 会写进同一文件互相覆盖，必须查重
      const lower = username.toLowerCase();
      if (users[username] || Object.keys(users).some(u => u.toLowerCase() === lower)) { dupReason = 'exists'; return; }
      if (Object.keys(users).length >= MAX_USERS) { dupReason = 'full'; return; }
      users[username] = { passwordHash };
      // 必须用 saveUsers 写入 users/ 目录（getUsersFile 返回的是锁文件路径，历史版本误写导致注册用户丢失）
      usersStore.saveUsers(users);
      registered = true;
    });
    if (!registered) {
      console.log(`[注册失败] 用户=${username} ip=${ip} 原因=${dupReason === 'exists' ? '重名' : dupReason === 'full' ? '用户数已满' : '未知'}`);
      const msg = dupReason === 'exists' ? '该用户名已被注册，请直接登录或换一个用户名'
        : dupReason === 'full' ? '用户数量已达上限，无法注册' : '用户名或密码无效';
      return res.json({ success: false, message: msg });
    }
    console.log(`[注册成功] 用户=${username} ip=${ip}`);
    const token = createSession(username, ip);
    res.json({ success: true, token, username });
  }));

  app.post('/api/login', asyncHandler(async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    if (rateLimit(`login:${ip}`, 60, 15 * 60 * 1000)) {
      return res.status(429).json({ success: false, message: '登录请求过于频繁，请稍后再试' });
    }
    const body = sanitizeBody(req.body);
    if (!verifyCaptcha(body.captchaId, body.captchaCode)) {
      console.log(`[登录失败] ip=${ip} 用户=${body.username || '?'} 原因=验证码错误或过期`);
      return res.json({ success: false, message: '验证码错误或已过期' });
    }
    const rawUsername = body.username;
    if (typeof rawUsername !== 'string') return res.json({ success: false, message: '用户名或密码错误' });
    const username = sanitizeString(rawUsername);
    const password = body.password;
    if (!username || !password) return res.json({ success: false, message: '用户名或密码错误' });
    // M6 修复：账户级失败锁定，防分布式在线爆破（锁定期内直接拒绝）
    if (loginLock.locked(username)) {
      console.log(`[登录失败] ip=${ip} 用户=${username} 原因=锁定中`);
      return res.json({ success: false, message: '尝试次数过多，请 15 分钟后再试' });
    }
    const users = usersStore.loadUsers();
    const user = users[username];
    if (!user) {
      const dummyHash = DUMMY_HASH || await hashPassword('dummy_fallback');
      await verifyPassword(password, dummyHash).catch(() => {});
      console.log(`[登录失败] ip=${ip} 用户=${username} 原因=用户不存在`);
      return res.json({ success: false, message: '用户名或密码错误' });
    }
    const match = await verifyPassword(password, user.passwordHash);
    if (!match) {
      loginLock.fail(username); // M6：仅对真实账户的错误密码计数
      console.log(`[登录失败] ip=${ip} 用户=${username} 原因=密码错误`);
      return res.json({ success: false, message: '用户名或密码错误' });
    }
    loginLock.clear(username);
    console.log(`[登录成功] ip=${ip} 用户=${username}`);
    const token = createSession(username, ip);
    res.json({ success: true, token, username });
  }));

  app.post('/api/logout', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-token'];
    if (token && typeof token === 'string' && token.length <= 128) {
      const session = getSession(token, ip);
      if (session) sessions.delete(token);
    }
    res.json({ success: true });
  });

  app.post('/api/unregister', asyncHandler(async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    // bcrypt 单次约 250ms CPU，限制每 IP 每小时 20 次防 CPU DoS
    if (rateLimit(`unregister:${ip}`, 20, 60 * 60 * 1000)) {
      return res.status(429).json({ success: false, message: '操作过于频繁，请稍后再试' });
    }
    // 优先从 header 取 token，兼容旧前端的 body.token
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-token'] || req.body?.token;
    const password = req.body?.password;
    if (!token || !password) return res.json({ success: false, message: '请输入密码' });
    if (typeof token !== 'string' || token.length > 128) return res.json({ success: false, message: '无效token' });
    if (typeof password !== 'string') return res.json({ success: false, message: '密码错误' });
    const session = getSession(token, ip);
    if (!session) return res.json({ success: false, message: '未登录' });
    const username = session.username;

    // 整个 load+verify+delete+write 放进文件锁，避免 TOCTOU 竞态
    let deleted = false;
    await usersStore.withFileLock(usersStore.getUsersFile(), async () => {
      const users = usersStore.loadUsers();
      const user = users[username];
      if (!user) return;
      const match = await verifyPassword(password, user.passwordHash);
      if (!match) return;
      delete users[username];
      // 必须用 saveUsers 写入 users/ 目录（历史版本误写到锁文件导致注销不生效）
      usersStore.saveUsers(users);
      deleted = true;
    });
    if (!deleted) return res.json({ success: false, message: '密码错误' });

    // 清理该用户的所有会话（包括其他设备），防止注销后 token 仍可用
    sessions.delete(token);
    deleteSessionsByUsername(username, null);

    // 清理好友/私聊数据（H3：含私聊历史文件）
    friendCleanup(username);

    const groupsData = groupsStore.getGroupsData();
    for (const group of Object.values(groupsData)) {
      group.members = group.members.filter(m => m !== username);
      group.blacklist = group.blacklist.filter(b => b !== username);
      if (Array.isArray(group.admins)) group.admins = group.admins.filter(a => a !== username);
      delete group.pendingJoins[username];
      // M8 修复：群主注销时优先继承给剩余真人成员；无真人成员（群里只剩 AI 机器人）则自动解散群，
      // 避免留下无主死群（历史版本会留下无主群永不销毁）
      if (group.owner === username) {
        groupManager.handleOwnerDeparture(group, username);
      }
    }
    groupsStore.saveGroupsData();

    res.json({ success: true });
  }));

  app.get('/api/session', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-token'];
    const session = getSession(token, ip);
    if (!session) return res.json({ success: false });
    res.json({ success: true, username: session.username });
  });

  app.post('/api/change-password', asyncHandler(async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    // bcrypt 单次约 250ms CPU，限制每 IP 每小时 20 次防 CPU DoS
    if (rateLimit(`change-pwd:${ip}`, 20, 60 * 60 * 1000)) {
      return res.status(429).json({ success: false, message: '操作过于频繁，请稍后再试' });
    }
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-token'];
    const session = getSession(token, ip);
    if (!session) return res.status(401).json({ success: false, message: '未登录或会话已过期' });
    const body = sanitizeBody(req.body);
    const { oldPassword, newPassword } = body;
    if (typeof oldPassword !== 'string' || typeof newPassword !== 'string') {
      return res.json({ success: false, message: '参数无效' });
    }
    if (!isValidPassword(newPassword)) {
      return res.json({ success: false, message: '新密码至少6位' });
    }
    if (oldPassword === newPassword) {
      return res.json({ success: false, message: '新密码不能与旧密码相同' });
    }
    const username = session.username;
    let changed = false;
    await usersStore.withFileLock(usersStore.getUsersFile(), async () => {
      const users = usersStore.loadUsers();
      const user = users[username];
      if (!user) return;
      const match = await verifyPassword(oldPassword, user.passwordHash);
      if (!match) return;
      user.passwordHash = await hashPassword(newPassword);
      // 必须用 saveUsers 写入 users/ 目录（getUsersFile 返回的是锁文件路径，历史版本误写导致改密丢失）
      usersStore.saveUsers(users);
      changed = true;
    });
    if (!changed) return res.json({ success: false, message: '旧密码错误' });
    // 改密码后让该用户所有会话（含当前）失效，强制重新登录
    deleteSessionsByUsername(username, null);
    res.json({ success: true });
  }));
}

module.exports = { registerAuthRoutes };
