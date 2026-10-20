// 聊天室入口：装配中间件、路由、存储与 Socket 事件
// 各功能实现分散在 12 个功能域目录中，本文件只做初始化与装配
const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const { PORT } = require('./config/constants');
const { initCerts } = require('./security/cert');
const auth = require('./security/auth');
const { makeVerifyCaptcha } = require('./security/captcha');

const { applySecurityHeaders } = require('./middleware/securityHeaders');
const { applyHttpRateLimit, rateLimit, sweepRateLimits } = require('./middleware/httpRateLimit');
const { applyCorsGuard } = require('./middleware/corsGuard');
const { applyErrorHandler } = require('./middleware/errorHandler');

const usersStore = require('./storage/usersStore');
const groupsStore = require('./storage/groupsStore');
const historyStore = require('./storage/historyStore');
const uploadsStore = require('./storage/uploadsStore');
const dbStore = require('./storage/db');

const { registerAuthRoutes } = require('./routes/authRoutes');
const { registerCaptchaRoutes } = require('./routes/captchaRoutes');
const { registerUploadRoutes } = require('./routes/uploadRoutes');

const friendService = require('./friends/friendService');
const { registerFriendHandlers } = require('./friends/friendEvents');
const { registerPmHandlers } = require('./friends/pmEvents');
const roomManager = require('./rooms/roomManager');
const { registerRoomHandlers } = require('./rooms/roomEvents');
const groupManager = require('./groups/groupManager');
const { registerGroupHandlers } = require('./groups/groupEvents');
const botService = require('./groups/botService');
const chatService = require('./chat/chatService');
const { registerChatHandlers } = require('./chat/chatEvents');
const { registerSocketAuth, registerAuthEvents } = require('./socket/socketAuth');
const { registerDisconnectHandler } = require('./socket/connectionManager');

// ==================== 数据目录与存储初始化 ====================
// SQL 版：先异步初始化 SQLite（加载/创建 data/chatroom.db），各 store 在库就绪后 init
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
const dbReady = dbStore.init(dataDir);

// ==================== 证书（自签叶子） ====================
const { caCertPem, serverCertPem, serverKeyPem, caCertPath, localIP, allLocalIPs } = initCerts();

// ==================== Express 应用与中间件 ====================
const app = express();

applySecurityHeaders(app);
applyHttpRateLimit(app);

app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  res.setHeader('Content-Type', 'text/html; charset=UTF-8');
  res.sendFile(htmlPath);
});
app.use(express.static('public'));
app.use(express.json({ limit: '1mb' }));
applyCorsGuard(app);
applyErrorHandler(app);

// ==================== API 路由 ====================
const verifyCaptcha = makeVerifyCaptcha(auth.safeCompare);

registerCaptchaRoutes(app);
registerAuthRoutes(app, {
  verifyCaptcha,
  friendCleanup: friendService.cleanupUser
});
registerUploadRoutes(app, {
  getSession: auth.getSession,
  rateLimit,
  sanitizeString: auth.sanitizeString
});

app.get('/ca.crt', (req, res) => {
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="chatroom-ca.crt"');
  res.send(caCertPem);
});

app.use((req, res) => {
  res.status(404).send('Not Found');
});

// ==================== HTTPS / HTTP 服务器 ====================
const httpsServer = https.createServer({
  key: serverKeyPem,
  cert: serverCertPem,
  ca: caCertPem
}, app);

const httpServer = http.createServer((req, res) => {
  const host = req.headers.host;
  if (!host) { res.writeHead(400); res.end(); return; }
  const hostname = host.split(':')[0];
  if (allLocalIPs.includes(hostname)) {
    // L9 修复：显式跳转到 HTTPS 端口（HTTP:3000 → HTTPS:3001），host 里可能带的是 3000 端口
    const redirectUrl = `https://${hostname}:${PORT + 1}${req.url}`;
    res.writeHead(301, { Location: redirectUrl });
    res.end();
  } else {
    res.writeHead(400);
    res.end('Invalid host');
  }
});

const io = new Server(httpsServer, {
  maxHttpBufferSize: 15e6,
  cors: {
    // 朋友间小范围使用，认证靠 token，CORS 放开以便支持各种内网穿透域名
    origin: true,
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 50000,
  connectTimeout: 30000,
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

// 注入 io 实例（deleteSessionsByUsername 需要断开 socket）
auth.setIo(io);
friendService.register(io);
roomManager.register(io);
groupManager.register(io);
botService.register(io);
chatService.register(io);

// ==================== Socket 认证与事件装配 ====================
registerSocketAuth(io, { getSession: auth.getSession });

io.on('connection', (socket) => {
  console.log('新用户连接:', socket.id);
  registerDisconnectHandler(io, socket);
  registerAuthEvents(socket);
  registerGroupHandlers(io, socket);
  registerRoomHandlers(io, socket);
  registerChatHandlers(io, socket);
  registerFriendHandlers(io, socket);
  registerPmHandlers(io, socket);
});

// 定时清理限流记录
setInterval(() => sweepRateLimits(), 5 * 60 * 1000);

// 服务关闭前保存所有脏数据（群历史 + 群数据 + 好友数据 + SQLite 整库落盘）
function shutdown() {
  historyStore.flushHistory();
  groupsStore.flushGroupsNow();
  friendService.flushAll();
  dbStore.flushNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ==================== 启动 ====================
// SQLite 就绪后：初始化各存储模块（含数据加载/恢复），再启动监听
dbReady.then(() => {
  usersStore.init({ dataDir });
  groupsStore.init({ dataDir });
  historyStore.init({ dataDir });
  uploadsStore.init({ dataDir });
  friendService.init({ dataDir }); // 内部会初始化 pmHistoryStore
  roomManager.init();              // 从 SQLite 恢复持久化的私人聊天室

  httpServer.listen(PORT, () => {
    console.log(`HTTP → HTTPS 重定向服务已启动 (端口 ${PORT})`);
  });

  httpsServer.listen(PORT + 1, () => {
    console.log('==========================================');
    console.log('   多人聊天室已启动！(HTTPS + SQLite)');
    console.log(`   本机访问: https://localhost:${PORT + 1}`);
    console.log(`   局域网访问: https://${localIP}:${PORT + 1}`);
  console.log('------------------------------------------');
  // CA 证书自动安装已禁用（H2 修复后为自签叶子证书，无需安装 CA）
  console.log('   浏览器首次访问需手动信任自签证书警告');
  console.log('==========================================');
  });
}).catch(err => {
  console.error('SQLite 初始化失败，服务无法启动:', err);
  process.exit(1);
});
