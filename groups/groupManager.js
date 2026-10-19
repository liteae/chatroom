// 群组管理：查询/成员列表/在线状态/入群申请推送（自 server.js 群管理函数段）
// io 实例通过 register(io) 注入，避免循环依赖
const { getGroupsData, deleteGroup } = require('../storage/groupsStore');
const historyStore = require('../storage/historyStore');
const { getUserColor } = require('../utils/display');

let io = null;

function register(newIo) {
  io = newIo;
}

function findGroupByName(name) {
  for (const group of Object.values(getGroupsData())) {
    if (group.name === name) return group;
  }
  return null;
}

function getUserGroups(username) {
  return Object.values(getGroupsData())
    .filter(g => g.members.includes(username))
    .map(g => ({
      id: g.id,
      name: g.name,
      isOwner: g.owner === username,
      memberCount: g.members.length
    }));
}

function getGroupMembersList(groupId) {
  const group = getGroupsData()[groupId];
  if (!group) return [];
  const onlineUsernames = new Set();
  const socketsInRoom = io.sockets.adapter.rooms.get(groupId);
  if (socketsInRoom) {
    for (const sid of socketsInRoom) {
      const s = io.sockets.sockets.get(sid);
      if (s && s.data && s.data.authUsername) {
        onlineUsernames.add(s.data.authUsername);
      }
    }
  }
  return group.members.map(username => ({
    username,
    color: getUserColor(username),
    isOwner: username === group.owner,
    isAdmin: Array.isArray(group.admins) && group.admins.includes(username),
    isOnline: onlineUsernames.has(username)
  }));
}

function findUserSocketsByUsername(username) {
  const result = [];
  for (const [, s] of io.sockets.sockets) {
    if (s.data && s.data.authUsername === username) {
      result.push(s);
    }
  }
  return result;
}

function emitGroupJoinRequests(socket, groupId) {
  const group = getGroupsData()[groupId];
  if (!group) return;
  const requests = Object.entries(group.pendingJoins).map(([username, data]) => ({
    username,
    reason: data.reason,
    time: data.time,
    color: getUserColor(username)
  }));
  socket.emit('group-join-requests', { groupId, requests });
}

// 解散群：广播解散事件 + 踢出房间内 socket + 清内存/历史/群文件（与群主手动解散同流程）
function dissolveGroup(group) {
  io.to(group.id).emit('group-destroyed', { groupName: group.name });
  for (const [, s] of io.sockets.sockets) {
    if (s.data && s.data.roomId === group.id) {
      s.leave(group.id);
      s.data.roomId = null;
      s.data.chatType = null;
    }
  }
  delete getGroupsData()[group.id];
  historyStore.deleteGroupHistory(group.id);
  deleteGroup(group.id);
}

// 群主离开（注销/退群）后的处理：优先继承给第一个真人成员；无真人成员（群里只剩 AI 机器人）则自动解散群
// members 仅含真人（机器人独立存于 bots 字段）。只改内存与广播，落盘由调用方 saveGroupsData 负责
function handleOwnerDeparture(group, departedUsername) {
  if (group.members.length > 0) {
    group.owner = group.members[0];
    // 新群主从管理员列表移除，避免双重身份
    if (Array.isArray(group.admins)) group.admins = group.admins.filter(a => a !== group.owner);
    const transferMsg = `群主已转让给 ${group.owner}`;
    io.to(group.id).emit('system-message', transferMsg);
    historyStore.addGroupHistory(group.id, 'system', transferMsg);
    for (const [, s] of io.sockets.sockets) {
      if (s.data && s.data.roomId === group.id) {
        const isOwner = s.data.authUsername === group.owner;
        const isAdmin = Array.isArray(group.admins) && group.admins.includes(s.data.authUsername);
        s.emit('room-info', {
          id: group.id, name: group.name, type: 'group',
          isOwner, isAdmin, inviteCode: null, canViewInvite: false
        });
      }
    }
    return { transferred: true, newOwner: group.owner };
  }
  // 没有任何真人成员可继承：自动解散，避免留下无主死群
  dissolveGroup(group);
  return { dissolved: true };
}

module.exports = {
  register,
  findGroupByName,
  getUserGroups,
  getGroupMembersList,
  findUserSocketsByUsername,
  emitGroupJoinRequests,
  handleOwnerDeparture
};
