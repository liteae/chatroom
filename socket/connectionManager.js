// 连接管理：断开连接时的计数释放与房间/群聊状态清理（自 server.js disconnect 段）
const { releaseConnection } = require('./socketAuth');
const { clearSocketEvents } = require('./socketRateLimit');
const roomManager = require('../rooms/roomManager');
const groupManager = require('../groups/groupManager');

let io = null;

function registerDisconnectHandler(newIo, socket) {
  io = newIo;

  socket.on('disconnect', () => {
    // 连接计数与事件计数释放
    releaseConnection(socket.data._ip);
    clearSocketEvents(socket.id);

    if (!socket.data || !socket.data.roomId) {
      console.log('用户断开连接:', socket.id);
      return;
    }

    // 群聊断开：只广播状态，不改群成员表（成员关系持久）
    if (socket.data.chatType === 'group') {
      const { roomId } = socket.data;
      const username = socket.data.authUsername;
      if (username) {
        const stillOnline = groupManager.findUserSocketsByUsername(username).some(s => s.id !== socket.id && s.data && s.data.roomId === roomId);
        if (!stillOnline) {
          socket.to(roomId).emit('system-message', `${username} 离线了`);
        }
      }
      io.to(roomId).emit('user-list', groupManager.getGroupMembersList(roomId));
      console.log('群聊用户断开连接:', socket.id);
      return;
    }

    // 房间断开
    const { roomId } = socket.data;
    const room = roomManager.getRooms().get(roomId);
    if (!room) return;

    if (socket.data.pending) {
      const pendingUsername = socket.data.username;
      if (pendingUsername) room.pendingJoins.delete(pendingUsername);
      console.log('待审批用户断开连接:', socket.id);
      return;
    }

    const member = room.members.get(socket.id);
    if (member) {
      const leaveMsg = `${member.username} 离开了聊天室`;
      io.to(roomId).emit('system-message', leaveMsg);
      roomManager.addHistory(roomId, 'system', leaveMsg);
      room.members.delete(socket.id);
      room.inviteViewers.delete(member.username);
      io.to(roomId).emit('user-list', roomManager.getRoomMembers(roomId));

      // 私人房间房主离开：自动转让给最早加入的成员
      if (room.type === 'private' && room.owner === member.username && room.members.size > 0) {
        const newOwner = room.members.values().next().value;
        if (newOwner) {
          room.owner = newOwner.username;
          room.inviteViewers.add(newOwner.username);
          const transferMsg = `房主已自动转移给 ${newOwner.username}`;
          io.to(roomId).emit('system-message', transferMsg);
          roomManager.addHistory(roomId, 'system', transferMsg);
          for (const [sid, m] of room.members) {
            const s = io.sockets.sockets.get(sid);
            if (s) roomManager.sendRoomInfo(s, room);
          }
          io.to(roomId).emit('user-list', roomManager.getRoomMembers(roomId));
        }
      }

      if (room.members.size === 0 && room.type === 'private') {
        roomManager.getRooms().delete(roomId);
        console.log(`私人聊天室已自动删除: ${roomId}`);
      }
    }
    console.log('用户断开连接:', socket.id);
  });
}

module.exports = { registerDisconnectHandler };
