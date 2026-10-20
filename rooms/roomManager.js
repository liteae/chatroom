// 房间管理：房间表/通用房间/邀请码/成员列表/历史记录/房间信息（自 server.js 顶部房间段）
// H1 修复：房间历史受条数+字节双上限约束
const crypto = require('crypto');
const { MAX_HISTORY, ROOM_HISTORY_MAX_BYTES } = require('../config/constants');
const db = require('../storage/db');
const { estimateHistoryEntryBytes } = require('../storage/historyStore');
const { getGroupsData } = require('../storage/groupsStore');
const groupManager = require('../groups/groupManager');

let io = null;

const rooms = new Map();

rooms.set('general', {
  id: 'general',
  name: '通用聊天室',
  type: 'public',
  owner: null,
  inviteCode: null,
  inviteViewers: new Set(),
  pendingJoins: new Map(),
  members: new Map(),
  history: []
});

function register(newIo) {
  io = newIo;
}

// 信息级2修复：私人聊天室持久化（SQLite rooms 表）——只保存元数据
// （members 按 socket.id 记录且断线即失，无需持久化；general 固定存在不落盘）
function init() {
  let rows = [];
  try { rows = db.all('SELECT id, data FROM rooms'); } catch { return; }
  for (const row of rows) {
    const roomId = row.id;
    if (roomId === 'general' || !/^room_[0-9a-f]{32}$/.test(roomId) || rooms.has(roomId)) continue;
    try {
      const meta = JSON.parse(row.data);
      if (!meta || typeof meta.name !== 'string') continue;
      rooms.set(roomId, {
        id: roomId,
        name: meta.name,
        type: meta.type === 'private' ? 'private' : 'public',
        owner: typeof meta.owner === 'string' ? meta.owner : null,
        inviteCode: typeof meta.inviteCode === 'string' ? meta.inviteCode : null,
        inviteViewers: new Set(Array.isArray(meta.inviteViewers) ? meta.inviteViewers : []),
        pendingJoins: new Map(),
        members: new Map(),
        history: []
      });
    } catch {}
  }
}

// 保存房间元数据（创建/转让/邀请码权限变更时调用）
function persistRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room || roomId === 'general') return;
  db.run('INSERT OR REPLACE INTO rooms (id, data) VALUES (?, ?)', [roomId, JSON.stringify({
    id: room.id,
    name: room.name,
    type: room.type,
    owner: room.owner,
    inviteCode: room.inviteCode,
    inviteViewers: Array.from(room.inviteViewers || [])
  })]);
}

// 删除房间持久化记录（房间销毁时调用）
function removePersistedRoom(roomId) {
  if (roomId === 'general') return;
  db.run('DELETE FROM rooms WHERE id = ?', [roomId]);
}

function getRooms() {
  return rooms;
}

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    // L1 修复：用加密安全随机数替代 Math.random，防止邀请码被预测
    code += chars[crypto.randomInt(0, chars.length)];
  }
  return code;
}

function getRoomMembers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.members.values()).map(m => ({
    username: m.username,
    color: m.color,
    isOwner: m.username === room.owner,
    canViewInvite: room.type === 'private' && (m.username === room.owner || room.inviteViewers.has(m.username))
  }));
}

function addHistory(roomId, type, data) {
  const room = rooms.get(roomId);
  if (!room) return;
  const entry = { type, data };
  room.history.push(entry);
  room.historyBytes = (room.historyBytes || 0) + estimateHistoryEntryBytes(entry);
  while (room.history.length > MAX_HISTORY) {
    room.historyBytes -= estimateHistoryEntryBytes(room.history.shift());
  }
  while (room.historyBytes > ROOM_HISTORY_MAX_BYTES && room.history.length > 1) {
    room.historyBytes -= estimateHistoryEntryBytes(room.history.shift());
  }
}

function sendRoomInfo(socket, room) {
  const member = room.members.get(socket.id);
  if (!member) return;
  const isOwner = member.username === room.owner;
  const canViewInvite = isOwner || room.inviteViewers.has(member.username);
  socket.emit('room-info', {
    id: room.id,
    name: room.name,
    type: room.type,
    isOwner,
    inviteCode: canViewInvite ? room.inviteCode : null,
    canViewInvite
  });
}

// 清理 socket 当前所在房间的状态（切换房间或断开连接时调用）
function cleanupSocketRoom(socket) {
  if (!socket.data || !socket.data.roomId) return;
  const oldRoomId = socket.data.roomId;
  const oldChatType = socket.data.chatType;

  socket.leave(oldRoomId);

  if (oldChatType === 'group') {
    if (getGroupsData()[oldRoomId]) {
      io.to(oldRoomId).emit('user-list', groupManager.getGroupMembersList(oldRoomId));
    }
  } else {
    const room = rooms.get(oldRoomId);
    if (room) {
      room.members.delete(socket.id);
      if (socket.data.pending) {
        const pendingUsername = socket.data.username;
        if (pendingUsername) room.pendingJoins.delete(pendingUsername);
      }
      io.to(oldRoomId).emit('user-list', getRoomMembers(oldRoomId));
    }
  }
  socket.data.pending = false;
}

module.exports = {
  register,
  init,
  getRooms,
  generateInviteCode,
  getRoomMembers,
  addHistory,
  sendRoomInfo,
  cleanupSocketRoom,
  persistRoom,
  removePersistedRoom
};
