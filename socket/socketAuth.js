// Socket 连接认证：连接数限制 + 可选 token 认证
// 设计：通用聊天室支持游客（不登录直接用），token 有则认证、无则放行；
// 需要登录的功能（私聊/群聊/私人房间）在各自 handler 内检查 authUsername
const { MAX_TOTAL_CONNECTIONS, MAX_CONNECTIONS_PER_IP } = require('../config/constants');

const connectionCounts = new Map(); // ip -> 连接数

let io = null;
let getSession = null;

function registerSocketAuth(newIo, deps) {
  io = newIo;
  getSession = deps.getSession;

  io.use((socket, next) => {
    const ip = socket.handshake.address || 'unknown';
    const currentCount = connectionCounts.get(ip) || 0;
    const totalConnections = io.sockets.sockets.size;

    if (totalConnections >= MAX_TOTAL_CONNECTIONS) {
      return next(new Error('服务器连接数已满'));
    }

    if (currentCount >= MAX_CONNECTIONS_PER_IP) {
      return next(new Error('该IP连接数已达上限'));
    }

    // 可选认证：携带有效 token 则记录登录身份；无 token 视为游客放行
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (typeof token === 'string' && token.length > 0 && token.length <= 128) {
      const session = getSession(token, ip);
      if (session) {
        socket.data.authUsername = session.username;
      }
    }

    connectionCounts.set(ip, currentCount + 1);
    socket.data._ip = ip;

    next();
  });
}

// 断开时释放 IP 连接计数
function releaseConnection(ip) {
  if (!ip) return;
  const count = connectionCounts.get(ip);
  if (count !== undefined) {
    if (count <= 1) connectionCounts.delete(ip);
    else connectionCounts.set(ip, count - 1);
  }
}

// 连接后的 token 换新事件（会话续期/重认证）
function registerAuthEvents(socket) {
  socket.on('auth', (token, callback) => {
    if (checkSocketRateLimit(socket)) { if (callback) callback({ success: false }); return; }
    if (typeof token !== 'string' || token.length > 128) { if (callback) callback({ success: false }); return; }
    const ip = socket.data._ip || socket.handshake.address;
    const session = getSession(token, ip);
    if (session) {
      socket.data.authUsername = session.username;
      if (callback) callback({ success: true, username: session.username });
    } else {
      if (callback) callback({ success: false });
    }
  });
}

// 延迟 require 避免模块加载顺序问题
const { checkSocketRateLimit } = require('./socketRateLimit');

module.exports = { registerSocketAuth, registerAuthEvents, releaseConnection };
