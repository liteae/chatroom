// 聊天事件：消息/文件/图片/输入状态（自 server.js chat-* 段）
// 房间与群聊共用：chatType 区分，广播统一走 chatService.emitChatFiltered（拉黑过滤）
const { checkSocketRateLimit } = require('../socket/socketRateLimit');
const { sanitizeMessage } = require('../utils/sanitize');
const { sanitizeString } = require('../security/auth');
const { isValidFileUrl, isValidDataUrl } = require('../storage/uploadsStore');
const { getGroupsData, saveGroupsDataDebounced } = require('../storage/groupsStore');
const historyStore = require('../storage/historyStore');
const roomManager = require('../rooms/roomManager');
const chatService = require('./chatService');
const botService = require('../groups/botService');
const { getUserColor, getTimeStr } = require('../utils/display');

let io = null;

function registerChatHandlers(newIo, socket) {
  io = newIo;

  socket.on('chat-message', (msg) => {
    if (checkSocketRateLimit(socket, true)) return;
    if (!socket.data || !socket.data.roomId || socket.data.pending) return;
    if (typeof msg !== 'string') return;
    msg = sanitizeMessage(msg);
    if (!msg) return;
    const { roomId } = socket.data;

    if (socket.data.chatType === 'group') {
      const group = getGroupsData()[roomId];
      if (!group) return;
      const username = socket.data.authUsername;
      if (!username || !group.members.includes(username)) return;
      const data = { username, color: getUserColor(username), message: msg, time: getTimeStr() };
      historyStore.addGroupHistory(roomId, 'chat', data);
      saveGroupsDataDebounced();
      chatService.emitChatFiltered(roomId, 'chat-message', data);
      // 消息中 @机器人名 时触发对应 AI 机器人
      botService.onGroupMessage(roomId, msg);
    } else {
      const room = roomManager.getRooms().get(roomId);
      if (!room) return;
      const member = room.members.get(socket.id);
      if (!member) return;
      const data = { username: member.username, color: member.color, message: msg, time: getTimeStr() };
      roomManager.addHistory(roomId, 'chat', data);
      chatService.emitChatFiltered(roomId, 'chat-message', data);
    }
  });

  socket.on('chat-file', (fileData) => {
    if (checkSocketRateLimit(socket)) return;
    if (!socket.data || !socket.data.roomId || socket.data.pending) return;
    if (!fileData || typeof fileData !== 'object') return;
    if (!fileData.url || !isValidFileUrl(fileData.url)) return;
    if (typeof fileData.name !== 'string' || fileData.name.length > 255) return;
    if (typeof fileData.size !== 'number' || fileData.size > 1024 * 1024 * 1024) return;
    if (fileData.type && typeof fileData.type !== 'string') return;
    const { roomId } = socket.data;

    const safeFileData = {
      name: sanitizeString(fileData.name).substring(0, 255),
      size: fileData.size,
      type: typeof fileData.type === 'string' ? fileData.type.substring(0, 200) : 'application/octet-stream',
      url: fileData.url
    };

    if (socket.data.chatType === 'group') {
      const group = getGroupsData()[roomId];
      if (!group) return;
      const username = socket.data.authUsername;
      if (!username || !group.members.includes(username)) return;
      const data = { username, color: getUserColor(username), file: safeFileData, time: getTimeStr() };
      historyStore.addGroupHistory(roomId, 'file', data);
      saveGroupsDataDebounced();
      chatService.emitChatFiltered(roomId, 'chat-file', data);
    } else {
      const room = roomManager.getRooms().get(roomId);
      if (!room) return;
      const member = room.members.get(socket.id);
      if (!member) return;
      const data = { username: member.username, color: member.color, file: safeFileData, time: getTimeStr() };
      roomManager.addHistory(roomId, 'file', data);
      chatService.emitChatFiltered(roomId, 'chat-file', data);
    }
  });

  socket.on('chat-image', (imageData) => {
    if (checkSocketRateLimit(socket)) return;
    if (!socket.data || !socket.data.roomId || socket.data.pending) return;
    if (!imageData || typeof imageData !== 'object') return;
    if (imageData.size && (typeof imageData.size !== 'number' || imageData.size > 5 * 1024 * 1024)) return;
    if (!imageData.data || !isValidDataUrl(imageData.data)) return;
    if (typeof imageData.name !== 'string' || imageData.name.length > 255) return;
    // 限制 data URL 大小，防止超大图片撑爆内存和带宽
    if (imageData.data.length > 2 * 1024 * 1024) return;
    const { roomId } = socket.data;

    const safeImageData = {
      name: sanitizeString(imageData.name).substring(0, 255),
      size: imageData.size || 0,
      type: typeof imageData.type === 'string' && imageData.type.startsWith('image/') ? imageData.type.substring(0, 100) : 'image/png',
      data: imageData.data
    };
    // 超过 512KB 的图片只广播不入历史，防止历史缓存和磁盘被撑爆
    const shouldStoreHistory = imageData.data.length <= 512 * 1024;

    if (socket.data.chatType === 'group') {
      const group = getGroupsData()[roomId];
      if (!group) return;
      const username = socket.data.authUsername;
      if (!username || !group.members.includes(username)) return;
      const data = { username, color: getUserColor(username), file: safeImageData, time: getTimeStr() };
      if (shouldStoreHistory) {
        historyStore.addGroupHistory(roomId, 'file', data);
        saveGroupsDataDebounced();
      }
      chatService.emitChatFiltered(roomId, 'chat-file', data);
    } else {
      const room = roomManager.getRooms().get(roomId);
      if (!room) return;
      const member = room.members.get(socket.id);
      if (!member) return;
      const data = { username: member.username, color: member.color, file: safeImageData, time: getTimeStr() };
      if (shouldStoreHistory) roomManager.addHistory(roomId, 'file', data);
      chatService.emitChatFiltered(roomId, 'chat-file', data);
    }
  });

  socket.on('typing', () => {
    if (checkSocketRateLimit(socket)) return;
    if (!socket.data || !socket.data.roomId || socket.data.pending) return;
    const { roomId } = socket.data;
    if (socket.data.chatType === 'group') {
      const username = socket.data.authUsername;
      if (username) socket.to(roomId).emit('typing', username);
    } else {
      const room = roomManager.getRooms().get(roomId);
      if (!room) return;
      const member = room.members.get(socket.id);
      if (!member) return;
      socket.to(roomId).emit('typing', member.username);
    }
  });

  socket.on('stop-typing', () => {
    if (checkSocketRateLimit(socket)) return;
    if (!socket.data || !socket.data.roomId || socket.data.pending) return;
    socket.to(socket.data.roomId).emit('stop-typing');
  });
}

module.exports = { registerChatHandlers };
