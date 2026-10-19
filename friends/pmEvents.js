// 私聊事件：好友间一对一消息/历史/文件/图片/打字状态（自 friend.js 事件半-私聊部分）
const { checkSocketRateLimit } = require('../socket/socketRateLimit');
const { isValidUsername, sanitizeString } = require('../security/auth');
const { PM_IMAGE_MAX, PM_IMAGE_HISTORY_MAX } = require('../config/constants');
const { isValidFileUrl, isValidDataUrl } = require('../storage/uploadsStore');
const usersStore = require('../storage/usersStore');
const pmHistoryStore = require('../storage/pmHistoryStore');
const friendService = require('./friendService');

function registerPmHandlers(io, socket) {
  // 通用前置检查 - 认证 + 限流
  function preCheck(callback) {
    if (!socket.data.authUsername) { if (callback) callback({ success: false, message: '未登录' }); return false; }
    if (checkSocketRateLimit(socket, true)) { if (callback) callback({ success: false, message: '操作过于频繁' }); return false; }
    return true;
  }

  // 校验目标用户名格式 + 是否存在
  function validateTarget(target, callback) {
    if (typeof target !== 'string' || !isValidUsername(target)) {
      if (callback) callback({ success: false, message: '用户名无效' });
      return false;
    }
    if (!usersStore.loadUsers()[target]) {
      if (callback) callback({ success: false, message: '用户不存在' });
      return false;
    }
    return true;
  }

  // 私聊消息
  socket.on('friend-chat-message', (data, callback) => {
    if (!preCheck(callback)) return;
    const me = socket.data.authUsername;
    const target = data && data.targetUsername;
    if (!validateTarget(target, callback)) return;

    // 必须是好友才能私聊
    const myData = friendService.getUserData(me);
    if (!myData.friends.has(target)) {
      if (callback) callback({ success: false, message: '不是好友，无法私聊' }); return;
    }

    let msg = data && data.message;
    if (typeof msg !== 'string') { if (callback) callback({ success: false, message: '消息无效' }); return; }
    // 清理控制字符 + 截断
    msg = msg.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').substring(0, 500).trim();
    if (!msg) { if (callback) callback({ success: false, message: '消息为空' }); return; }

    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const messageData = { from: me, to: target, message: msg, time };

    // 持久化到私聊历史
    const pmKey = pmHistoryStore.getPmKey(me, target);
    pmHistoryStore.addPmHistory(pmKey, 'chat', messageData);

    // 转发给目标用户的所有在线 socket
    for (const s of friendService.getUserSockets(target)) {
      s.emit('friend-chat-message', messageData);
    }
    // 回执给发送者
    if (callback) callback({ success: true, data: messageData });
  });

  // 加载私聊历史
  socket.on('friend-chat-history', (data, callback) => {
    if (!preCheck(callback)) return;
    const me = socket.data.authUsername;
    const target = data && data.targetUsername;
    if (!validateTarget(target, callback)) return;

    const myData = friendService.getUserData(me);
    if (!myData.friends.has(target)) {
      if (callback) callback({ success: false, message: '不是好友' }); return;
    }
    const pmKey = pmHistoryStore.getPmKey(me, target);
    const history = pmHistoryStore.getPmHistory(pmKey);
    if (callback) callback({ success: true, history });
  });

  // 私聊文件消息
  socket.on('friend-chat-file', (data, callback) => {
    if (!preCheck(callback)) return;
    const me = socket.data.authUsername;
    const target = data && data.targetUsername;
    if (!validateTarget(target, callback)) return;

    const myData = friendService.getUserData(me);
    if (!myData.friends.has(target)) {
      if (callback) callback({ success: false, message: '不是好友' }); return;
    }

    const fileData = data && data.file;
    if (!fileData || typeof fileData !== 'object') { if (callback) callback({ success: false, message: '文件无效' }); return; }
    if (!fileData.url || !isValidFileUrl(fileData.url)) { if (callback) callback({ success: false, message: '文件URL无效' }); return; }
    if (typeof fileData.name !== 'string' || fileData.name.length > 255) { if (callback) callback({ success: false, message: '文件名无效' }); return; }
    if (typeof fileData.size !== 'number' || fileData.size > 1024 * 1024 * 1024) { if (callback) callback({ success: false, message: '文件大小无效' }); return; }

    const safeFile = {
      name: sanitizeString(fileData.name).substring(0, 255),
      size: fileData.size,
      type: typeof fileData.type === 'string' ? fileData.type.substring(0, 200) : 'application/octet-stream',
      url: fileData.url
    };
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const messageData = { from: me, to: target, file: safeFile, time };

    const pmKey = pmHistoryStore.getPmKey(me, target);
    pmHistoryStore.addPmHistory(pmKey, 'file', messageData);

    for (const s of friendService.getUserSockets(target)) {
      s.emit('friend-chat-file', messageData);
    }
    if (callback) callback({ success: true, data: messageData });
  });

  // 私聊图片消息
  socket.on('friend-chat-image', (data, callback) => {
    if (!preCheck(callback)) return;
    const me = socket.data.authUsername;
    const target = data && data.targetUsername;
    if (!validateTarget(target, callback)) return;

    const myData = friendService.getUserData(me);
    if (!myData.friends.has(target)) {
      if (callback) callback({ success: false, message: '不是好友' }); return;
    }

    const img = data && data.image;
    if (!img || typeof img !== 'object') { if (callback) callback({ success: false, message: '图片无效' }); return; }
    if (!img.data || !isValidDataUrl(img.data)) { if (callback) callback({ success: false, message: '图片数据无效' }); return; }
    if (img.data.length > PM_IMAGE_MAX) { if (callback) callback({ success: false, message: '图片过大' }); return; }
    if (typeof img.name !== 'string' || img.name.length > 255) { if (callback) callback({ success: false, message: '图片名无效' }); return; }

    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const messageData = { from: me, to: target, name: img.name, data: img.data, time };

    // >512KB 图片只广播不入历史
    const pmKey = pmHistoryStore.getPmKey(me, target);
    if (img.data.length <= PM_IMAGE_HISTORY_MAX) {
      pmHistoryStore.addPmHistory(pmKey, 'image', messageData);
    }

    for (const s of friendService.getUserSockets(target)) {
      s.emit('friend-chat-image', messageData);
    }
    if (callback) callback({ success: true, data: messageData });
  });

  // 私聊打字状态
  socket.on('friend-chat-typing', (data) => {
    if (!socket.data.authUsername) return;
    if (checkSocketRateLimit(socket, true)) return;
    const me = socket.data.authUsername;
    const target = data && data.targetUsername;
    if (typeof target !== 'string' || !isValidUsername(target)) return;
    const myData = friendService.getUserData(me);
    if (!myData.friends.has(target)) return;
    for (const s of friendService.getUserSockets(target)) {
      s.emit('friend-chat-typing', { from: me });
    }
  });
}

module.exports = { registerPmHandlers };
