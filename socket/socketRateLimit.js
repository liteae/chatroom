// Socket 事件限流：每连接每分钟事件数上限（自 server.js checkSocketRateLimit）
const { MAX_SOCKET_EVENTS_PER_MINUTE } = require('../config/constants');

const socketEventCounts = new Map(); // socketId -> {count, windowStart}

function checkSocketRateLimit(socket, disconnect) {
  const id = socket.id;
  const now = Date.now();
  const record = socketEventCounts.get(id);
  if (!record || now - record.windowStart > 60000) {
    socketEventCounts.set(id, { count: 1, windowStart: now });
    return false;
  }
  record.count++;
  if (record.count > MAX_SOCKET_EVENTS_PER_MINUTE) {
    if (disconnect) socket.disconnect(true);
    return true;
  }
  return false;
}

function clearSocketEvents(socketId) {
  socketEventCounts.delete(socketId);
}

module.exports = { checkSocketRateLimit, clearSocketEvents };
