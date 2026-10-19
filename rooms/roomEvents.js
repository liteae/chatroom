// 房间事件：进入通用/私人房间/审批/创建/踢人/转让/邀请码权限/销毁（自 server.js room 段）
const crypto = require('crypto');
const { checkSocketRateLimit } = require('../socket/socketRateLimit');
const { sanitizeString, isValidUsername } = require('../security/auth');
const { isValidRoomName } = require('../utils/sanitize');
const { makeFailLock } = require('../utils/failLock');
const { MAX_HISTORY } = require('../config/constants');
const usersStore = require('../storage/usersStore');
const roomManager = require('./roomManager');
const chatService = require('../chat/chatService');
const { getUserColor } = require('../utils/display');

let io = null;

// M5 修复：邀请码失败锁定——10 次/10 分钟 → 锁 10 分钟
const inviteLock = makeFailLock({ limit: 10, windowMs: 10 * 60 * 1000, lockMs: 10 * 60 * 1000 });
setInterval(() => inviteLock.sweep(), 5 * 60 * 1000);

function registerRoomHandlers(newIo, socket) {
  io = newIo;
  const rooms = roomManager.getRooms();

  socket.on('join-general', (username) => {
    if (checkSocketRateLimit(socket)) return;
    if (typeof username !== 'string' || !isValidUsername(username)) return;

    // 防止用户名冒充：
    // - 已登录用户必须使用认证用户名，禁止传任意名冒充他人
    // - 未登录游客禁止使用已注册用户名（防止冒充已注册账号）
    const authUsername = socket.data.authUsername;
    let displayName;
    if (authUsername) {
      if (username !== authUsername) return;
      displayName = authUsername;
    } else {
      const users = usersStore.loadUsers();
      if (users[username]) {
        socket.emit('join-error', '该用户名已注册，请登录后使用');
        return;
      }
      displayName = username;
    }

    const color = getUserColor(displayName);

    // 清理旧房间状态
    roomManager.cleanupSocketRoom(socket);

    const room = rooms.get('general');
    room.members.set(socket.id, { username: displayName, color });
    socket.data.username = displayName;
    socket.data.roomId = 'general';
    socket.join('general');

    socket.emit('chat-history', chatService.filterHistoryForViewer(room.history.slice(-MAX_HISTORY), displayName));
    socket.emit('room-info', { id: room.id, name: room.name, type: room.type, isOwner: false, inviteCode: null, canViewInvite: false });
    io.to('general').emit('user-list', roomManager.getRoomMembers('general'));

    const joinMsg = `${displayName} 加入了聊天室`;
    io.to('general').emit('system-message', joinMsg);
    roomManager.addHistory('general', 'system', joinMsg);

    socket.emit('joined', true);
  });

  socket.on('join-private', (data) => {
    if (checkSocketRateLimit(socket)) return;
    if (!data || typeof data !== 'object') return;
    const username = socket.data.authUsername;
    if (!username) { socket.emit('join-error', '请先登录后再加入私人聊天室'); return; }
    // M5 修复：邀请码失败次数超限后临时锁定
    if (inviteLock.locked(username)) {
      socket.emit('join-error', '尝试次数过多，请 10 分钟后再试');
      return;
    }
    const { inviteCode, roomName } = data;
    if (typeof inviteCode !== 'string' || typeof roomName !== 'string') return;
    const code = sanitizeString(inviteCode).toUpperCase();
    const name = sanitizeString(roomName);
    if (!name || !isValidRoomName(name)) {
      socket.emit('join-error', '聊天室名称无效');
      return;
    }
    if (code.length !== 6) {
      socket.emit('join-error', '邀请码格式无效');
      return;
    }
    let targetRoom = null;
    for (const [, room] of rooms) {
      if (room.type === 'private' && room.inviteCode === code && room.name === name) {
        targetRoom = room;
        break;
      }
    }
    if (!targetRoom) {
      inviteLock.fail(username); // M5：记录失败
      socket.emit('join-error', '聊天室名称或邀请码无效，未找到对应的聊天室');
      return;
    }
    inviteLock.clear(username); // M5：成功后清零失败计数

    for (const [, m] of targetRoom.members) {
      if (m.username === username) {
        socket.emit('join-error', '该昵称已在此聊天室中，请换一个昵称');
        return;
      }
    }

    if (targetRoom.pendingJoins.has(username)) {
      socket.emit('join-error', '你已提交加入申请，请等待房主审批');
      return;
    }

    targetRoom.pendingJoins.set(username, { username, color: getUserColor(username), socketId: socket.id });
    socket.data.username = username;
    socket.data.roomId = targetRoom.id;
    socket.data.pending = true;

    const ownerSocketId = [...targetRoom.members.entries()].find(([, m]) => m.username === targetRoom.owner);
    if (ownerSocketId) {
      const ownerSocket = io.sockets.sockets.get(ownerSocketId[0]);
      if (ownerSocket) {
        ownerSocket.emit('join-request', { username, color: getUserColor(username) });
      }
    }

    socket.emit('join-pending', targetRoom.name);
  });

  socket.on('approve-join', (username) => {
    if (checkSocketRateLimit(socket)) return;
    if (!socket.data || !socket.data.roomId) return;
    if (typeof username !== 'string' || !isValidUsername(username)) return;
    const { roomId } = socket.data;
    const room = rooms.get(roomId);
    if (!room || room.owner !== socket.data.authUsername) return;

    let targetData = null;
    for (const [uname, pending] of room.pendingJoins) {
      if (uname === username) {
        targetData = pending;
        break;
      }
    }
    if (!targetData) return;

    room.pendingJoins.delete(username);

    const targetSocket = io.sockets.sockets.get(targetData.socketId);
    if (!targetSocket) return;

    room.members.set(targetData.socketId, { username: targetData.username, color: targetData.color });
    targetSocket.data.username = targetData.username;
    targetSocket.data.roomId = room.id;
    targetSocket.data.pending = false;
    targetSocket.join(room.id);

    targetSocket.emit('chat-history', chatService.filterHistoryForViewer(room.history.slice(-MAX_HISTORY), targetData.username));
    roomManager.sendRoomInfo(targetSocket, room);

    const joinMsg = `${targetData.username} 加入了聊天室`;
    io.to(roomId).emit('system-message', joinMsg);
    roomManager.addHistory(roomId, 'system', joinMsg);
    io.to(roomId).emit('user-list', roomManager.getRoomMembers(roomId));

    targetSocket.emit('joined', true);
  });

  socket.on('reject-join', (username) => {
    if (checkSocketRateLimit(socket)) return;
    if (!socket.data || !socket.data.roomId) return;
    if (typeof username !== 'string') return;
    const { roomId } = socket.data;
    const room = rooms.get(roomId);
    if (!room || room.owner !== socket.data.authUsername) return;

    let targetSocketId = null;
    for (const [uname, pending] of room.pendingJoins) {
      if (uname === username) {
        targetSocketId = pending.socketId;
        break;
      }
    }
    if (!targetSocketId) return;

    room.pendingJoins.delete(username);

    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit('join-rejected');
    }
  });

  socket.on('create-private', (data) => {
    if (checkSocketRateLimit(socket)) return;
    if (!data || typeof data !== 'object') return;
    const username = socket.data.authUsername;
    if (!username) { socket.emit('join-error', '请先登录后再创建私人聊天室'); return; }
    const { roomName } = data;
    if (typeof roomName !== 'string') return;
    const rName = sanitizeString(roomName);
    if (!rName || !isValidRoomName(rName)) return;
    const roomId = 'room_' + crypto.randomBytes(16).toString('hex');
    const inviteCode = roomManager.generateInviteCode();
    const color = getUserColor(username);

    // 清理旧房间状态
    roomManager.cleanupSocketRoom(socket);

    const room = {
      id: roomId,
      name: rName,
      type: 'private',
      owner: username,
      inviteCode,
      inviteViewers: new Set(),
      pendingJoins: new Map(),
      members: new Map(),
      history: []
    };
    room.members.set(socket.id, { username, color });
    rooms.set(roomId, room);
    roomManager.persistRoom(roomId);

    socket.data.username = username;
    socket.data.roomId = roomId;
    socket.join(roomId);

    socket.emit('chat-history', room.history);
    roomManager.sendRoomInfo(socket, room);
    io.to(roomId).emit('user-list', roomManager.getRoomMembers(roomId));

    const createMsg = `${username} 创建了私人聊天室`;
    io.to(roomId).emit('system-message', createMsg);
    roomManager.addHistory(roomId, 'system', createMsg);

    socket.emit('joined', true);
    console.log(`私人聊天室已创建: ${roomId}, 邀请码: ${inviteCode}, 房主: ${username}`);
  });

  socket.on('kick-user', (targetUsername) => {
    if (checkSocketRateLimit(socket)) return;
    if (!socket.data || !socket.data.roomId) return;
    if (typeof targetUsername !== 'string' || !isValidUsername(targetUsername)) return;
    const { roomId } = socket.data;
    const room = rooms.get(roomId);
    if (!room || room.owner !== socket.data.authUsername) return;

    let targetSocketId = null;
    for (const [sid, m] of room.members) {
      if (m.username === targetUsername) {
        targetSocketId = sid;
        break;
      }
    }
    if (!targetSocketId) return;

    const kickMsg = `${targetUsername} 已被房主移出聊天室`;
    io.to(roomId).emit('system-message', kickMsg);
    roomManager.addHistory(roomId, 'system', kickMsg);

    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit('kicked');
      targetSocket.leave(roomId);
    }
    room.members.delete(targetSocketId);
    room.inviteViewers.delete(targetUsername);
    roomManager.persistRoom(roomId);
    io.to(roomId).emit('user-list', roomManager.getRoomMembers(roomId));
  });

  socket.on('transfer-owner', (targetUsername) => {
    if (checkSocketRateLimit(socket)) return;
    if (!socket.data || !socket.data.roomId) return;
    if (typeof targetUsername !== 'string' || !isValidUsername(targetUsername)) return;
    const { roomId } = socket.data;
    const room = rooms.get(roomId);
    if (!room || room.owner !== socket.data.authUsername) return;

    let targetInRoom = false;
    for (const [, m] of room.members) {
      if (m.username === targetUsername) { targetInRoom = true; break; }
    }
    if (!targetInRoom) return;

    room.owner = targetUsername;
    room.inviteViewers.add(targetUsername);
    roomManager.persistRoom(roomId);

    const transferMsg = `房主已转让给 ${targetUsername}`;
    io.to(roomId).emit('system-message', transferMsg);
    roomManager.addHistory(roomId, 'system', transferMsg);

    for (const [sid, m] of room.members) {
      const s = io.sockets.sockets.get(sid);
      if (s) roomManager.sendRoomInfo(s, room);
    }
    io.to(roomId).emit('user-list', roomManager.getRoomMembers(roomId));
  });

  socket.on('grant-invite-view', (targetUsername) => {
    if (checkSocketRateLimit(socket)) return;
    if (!socket.data || !socket.data.roomId) return;
    if (typeof targetUsername !== 'string' || !isValidUsername(targetUsername)) return;
    const { roomId } = socket.data;
    const room = rooms.get(roomId);
    if (!room || room.owner !== socket.data.authUsername) return;

    room.inviteViewers.add(targetUsername);
    roomManager.persistRoom(roomId);

    const grantMsg = `房主已授权 ${targetUsername} 查看邀请码`;
    io.to(roomId).emit('system-message', grantMsg);
    roomManager.addHistory(roomId, 'system', grantMsg);

    const targetEntry = [...room.members.entries()].find(([, m]) => m.username === targetUsername);
    if (targetEntry) {
      const s = io.sockets.sockets.get(targetEntry[0]);
      if (s) roomManager.sendRoomInfo(s, room);
    }
    io.to(roomId).emit('user-list', roomManager.getRoomMembers(roomId));
  });

  socket.on('revoke-invite-view', (targetUsername) => {
    if (checkSocketRateLimit(socket)) return;
    if (!socket.data || !socket.data.roomId) return;
    if (typeof targetUsername !== 'string' || !isValidUsername(targetUsername)) return;
    const { roomId } = socket.data;
    const room = rooms.get(roomId);
    if (!room || room.owner !== socket.data.authUsername) return;

    room.inviteViewers.delete(targetUsername);
    roomManager.persistRoom(roomId);

    const revokeMsg = `房主已撤销 ${targetUsername} 查看邀请码的权限`;
    io.to(roomId).emit('system-message', revokeMsg);
    roomManager.addHistory(roomId, 'system', revokeMsg);

    const targetEntry = [...room.members.entries()].find(([, m]) => m.username === targetUsername);
    if (targetEntry) {
      const s = io.sockets.sockets.get(targetEntry[0]);
      if (s) roomManager.sendRoomInfo(s, room);
    }
    io.to(roomId).emit('user-list', roomManager.getRoomMembers(roomId));
  });

  socket.on('destroy-room', () => {
    if (checkSocketRateLimit(socket)) return;
    if (!socket.data || !socket.data.roomId) return;
    const { roomId } = socket.data;
    const room = rooms.get(roomId);
    if (!room || room.owner !== socket.data.authUsername) return;

    io.to(roomId).emit('room-destroyed');
    const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
    if (socketsInRoom) {
      for (const sid of socketsInRoom) {
        const s = io.sockets.sockets.get(sid);
        if (s) s.leave(roomId);
      }
    }
    rooms.delete(roomId);
    roomManager.removePersistedRoom(roomId);
    console.log(`聊天室已销毁: ${roomId}`);
  });
}

module.exports = { registerRoomHandlers };
