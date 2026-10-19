// 群组事件：建群/申请/审批/进出/踢人/转让/解散/管理员/AI机器人
const crypto = require('crypto');
const { checkSocketRateLimit } = require('../socket/socketRateLimit');
const { sanitizeString, isValidUsername } = require('../security/auth');
const { isValidRoomName } = require('../utils/sanitize');
const { MAX_HISTORY, MAX_GROUPS, MAX_BOTS_PER_GROUP } = require('../config/constants');
const { getGroupsData, saveGroupsData, saveGroup, deleteGroup } = require('../storage/groupsStore');
const historyStore = require('../storage/historyStore');
const groupManager = require('./groupManager');
const botService = require('./botService');
const roomManager = require('../rooms/roomManager');
const chatService = require('../chat/chatService');
const { getUserColor, getTimeStr } = require('../utils/display');

let io = null;

// 当前 socket 在群内的角色（群主/管理员/普通成员）
function getGroupRole(group, username) {
  if (group.owner === username) return 'owner';
  if (Array.isArray(group.admins) && group.admins.includes(username)) return 'admin';
  return 'member';
}

function registerGroupHandlers(newIo, socket) {
  io = newIo;

  socket.on('group-list', (callback) => {
    if (checkSocketRateLimit(socket)) return;
    const username = socket.data.authUsername;
    if (!username) { if (callback) callback({ success: false, message: '请先登录' }); return; }
    if (callback) callback({ success: true, groups: groupManager.getUserGroups(username) });
  });

  socket.on('group-create', (groupName, callback) => {
    if (checkSocketRateLimit(socket)) return;
    const username = socket.data.authUsername;
    if (!username) { if (callback) callback({ success: false, message: '请先登录' }); return; }
    const name = sanitizeString(groupName);
    if (!isValidRoomName(name)) { if (callback) callback({ success: false, message: '群聊名称无效' }); return; }
    const existing = groupManager.findGroupByName(name);
    if (existing) { if (callback) callback({ success: false, message: '该群聊名称已存在' }); return; }
    if (Object.keys(getGroupsData()).length >= MAX_GROUPS) { if (callback) callback({ success: false, message: '群聊数量已达上限' }); return; }
    const groupId = 'group_' + crypto.randomBytes(16).toString('hex');
    getGroupsData()[groupId] = {
      id: groupId,
      name,
      owner: username,
      members: [username],
      admins: [],
      bots: [],
      blacklist: [],
      pendingJoins: {}
    };
    // 初始化空历史（同时写入缓存）
    historyStore.getGroupHistory(groupId);
    saveGroupsData();
    if (callback) callback({ success: true, groupId });
  });

  socket.on('group-join-request', (data, callback) => {
    if (checkSocketRateLimit(socket)) return;
    if (!data || typeof data !== 'object') return;
    const username = socket.data.authUsername;
    if (!username) { if (callback) callback({ success: false, message: '请先登录' }); return; }
    const gName = sanitizeString(data.groupName);
    const gReason = sanitizeString(data.reason);
    if (!gName) { if (callback) callback({ success: false, message: '请输入群聊名称' }); return; }
    const group = groupManager.findGroupByName(gName);
    if (!group) { if (callback) callback({ success: false, message: '未找到该群聊' }); return; }
    if (group.members.includes(username)) { if (callback) callback({ success: false, message: '你已是该群聊成员' }); return; }
    if (group.blacklist.includes(username)) { if (callback) callback({ success: false, message: '你已被移出该群聊，无法再次加入' }); return; }
    if (group.pendingJoins[username]) { if (callback) callback({ success: false, message: '你已提交加入申请，请等待审批' }); return; }

    if (group.members.length === 0) {
      if (!group.members.includes(username)) group.members.push(username);
      group.owner = username;
      const joinMsg = `${username} 加入了群聊`;
      historyStore.addGroupHistory(group.id, 'system', joinMsg);
      saveGroupsData();
      if (callback) callback({ success: true, message: '已自动加入群聊（群聊无成员，你已成为群主）', autoJoined: true, groupId: group.id });
      return;
    }

    group.pendingJoins[username] = { reason: gReason.substring(0, 100), time: getTimeStr() };
    saveGroupsData();

    groupManager.findUserSocketsByUsername(group.owner).forEach(s => {
      s.emit('group-join-request', {
        groupId: group.id,
        groupName: group.name,
        username,
        reason: gReason.substring(0, 100),
        time: getTimeStr(),
        color: getUserColor(username)
      });
    });

    if (callback) callback({ success: true, message: '申请已提交，请等待群主审批' });
  });

  socket.on('group-enter', (groupId, callback) => {
    if (checkSocketRateLimit(socket)) return;
    const username = socket.data.authUsername;
    if (!username) { if (callback) callback({ success: false, message: '请先登录' }); return; }
    if (!groupId || typeof groupId !== 'string' || groupId.length > 50) { if (callback) callback({ success: false, message: '无效的群聊ID' }); return; }
    const group = getGroupsData()[groupId];
    if (!group) { if (callback) callback({ success: false, message: '群聊不存在' }); return; }
    if (!group.members.includes(username)) { if (callback) callback({ success: false, message: '你不是该群聊成员' }); return; }

    // 清理旧房间状态（统一处理所有房间类型，防止跨房间信息泄露和内存泄漏）
    roomManager.cleanupSocketRoom(socket);

    socket.data.roomId = groupId;
    socket.data.chatType = 'group';
    socket.join(groupId);

    const isOwner = group.owner === username;
    const isAdmin = Array.isArray(group.admins) && group.admins.includes(username);

    socket.emit('chat-history', chatService.filterHistoryForViewer(historyStore.getGroupHistory(groupId).slice(-MAX_HISTORY), username));
    socket.emit('room-info', {
      id: group.id,
      name: group.name,
      type: 'group',
      isOwner,
      isAdmin,
      inviteCode: null,
      canViewInvite: false
    });
    io.to(groupId).emit('user-list', groupManager.getGroupMembersList(groupId));
    botService.emitGroupBots(groupId, socket);

    if (isOwner) {
      groupManager.emitGroupJoinRequests(socket, groupId);
    }

    socket.emit('joined', true);
    if (callback) callback({ success: true });
  });

  socket.on('group-leave', (callback) => {
    if (checkSocketRateLimit(socket)) return;
    const username = socket.data.authUsername;
    const groupId = socket.data.roomId;
    if (!username || !groupId || socket.data.chatType !== 'group') return;

    const group = getGroupsData()[groupId];
    if (!group) return;

    group.members = group.members.filter(m => m !== username);
    if (Array.isArray(group.admins)) group.admins = group.admins.filter(a => a !== username);
    const leaveMsg = `${username} 离开了群聊`;
    io.to(groupId).emit('system-message', leaveMsg);
    historyStore.addGroupHistory(groupId, 'system', leaveMsg);

    socket.leave(groupId);

    // 群主退群：优先继承给剩余真人成员；无真人成员（群里只剩 AI 机器人）则自动解散（M8）
    let dissolved = false;
    if (group.owner === username) {
      const result = groupManager.handleOwnerDeparture(group, username);
      dissolved = !!result.dissolved;
    }

    saveGroupsData();
    if (!dissolved) io.to(groupId).emit('user-list', groupManager.getGroupMembersList(groupId));
    socket.data.roomId = null;
    socket.data.chatType = null;
    if (callback) callback({ success: true });
  });

  socket.on('group-kick', (targetUsername) => {
    if (checkSocketRateLimit(socket)) return;
    const username = socket.data.authUsername;
    const groupId = socket.data.roomId;
    if (!username || !groupId || socket.data.chatType !== 'group') return;
    const group = getGroupsData()[groupId];
    if (!group || group.owner !== username) return;
    if (targetUsername === username) return;
    if (typeof targetUsername !== 'string' || !isValidUsername(targetUsername)) return;
    // 仅能踢出当前群聊成员，禁止拉黑非成员
    if (!group.members.includes(targetUsername)) return;

    group.members = group.members.filter(m => m !== targetUsername);
    if (Array.isArray(group.admins)) group.admins = group.admins.filter(a => a !== targetUsername);
    if (!group.blacklist.includes(targetUsername)) {
      group.blacklist.push(targetUsername);
    }

    const kickMsg = `${targetUsername} 已被群主移出群聊（永久禁止加入）`;
    io.to(groupId).emit('system-message', kickMsg);
    historyStore.addGroupHistory(groupId, 'system', kickMsg);
    saveGroupsData();

    for (const [, s] of io.sockets.sockets) {
      if (s.data && s.data.authUsername === targetUsername && s.data.roomId === groupId) {
        s.emit('kicked');
        s.leave(groupId);
        s.data.roomId = null;
        s.data.chatType = null;
      }
    }

    io.to(groupId).emit('user-list', groupManager.getGroupMembersList(groupId));
  });

  socket.on('group-transfer-owner', (targetUsername) => {
    if (checkSocketRateLimit(socket)) return;
    const username = socket.data.authUsername;
    const groupId = socket.data.roomId;
    if (!username || !groupId || socket.data.chatType !== 'group') return;
    const group = getGroupsData()[groupId];
    if (!group || group.owner !== username) return;
    if (typeof targetUsername !== 'string' || !isValidUsername(targetUsername)) return;
    if (!group.members.includes(targetUsername)) return;

    group.owner = targetUsername;
    // 新群主身份提升为 owner，同时从管理员列表移除（避免双重身份）
    if (Array.isArray(group.admins)) group.admins = group.admins.filter(a => a !== targetUsername);
    const transferMsg = `群主已转让给 ${targetUsername}`;
    io.to(groupId).emit('system-message', transferMsg);
    historyStore.addGroupHistory(groupId, 'system', transferMsg);
    saveGroupsData();

    for (const [, s] of io.sockets.sockets) {
      if (s.data && s.data.roomId === groupId) {
        const isOwner = s.data.authUsername === targetUsername;
        const isAdmin = Array.isArray(group.admins) && group.admins.includes(s.data.authUsername);
        s.emit('room-info', {
          id: group.id, name: group.name, type: 'group',
          isOwner, isAdmin, inviteCode: null, canViewInvite: false
        });
      }
    }
    io.to(groupId).emit('user-list', groupManager.getGroupMembersList(groupId));
  });

  socket.on('group-destroy', (callback) => {
    if (checkSocketRateLimit(socket)) return;
    const username = socket.data.authUsername;
    const groupId = socket.data.roomId;
    if (!username || !groupId || socket.data.chatType !== 'group') return;
    const group = getGroupsData()[groupId];
    if (!group || group.owner !== username) return;

    io.to(groupId).emit('group-destroyed', { groupName: group.name });

    for (const [, s] of io.sockets.sockets) {
      if (s.data && s.data.roomId === groupId) {
        s.leave(groupId);
        s.data.roomId = null;
        s.data.chatType = null;
      }
    }

    delete getGroupsData()[groupId];
    historyStore.deleteGroupHistory(groupId);
    deleteGroup(groupId);
    if (callback) callback({ success: true });
  });

  socket.on('group-approve-join', (data) => {
    if (checkSocketRateLimit(socket)) return;
    if (!data || typeof data !== 'object') return;
    const { groupId, username: targetUsername } = data;
    const username = socket.data.authUsername;
    if (!username) return;
    if (typeof targetUsername !== 'string' || !isValidUsername(targetUsername)) return;
    if (typeof groupId !== 'string' || groupId.length > 50) return;
    const group = getGroupsData()[groupId];
    if (!group || group.owner !== username) return;
    if (!group.pendingJoins[targetUsername]) return;

    delete group.pendingJoins[targetUsername];
    if (!group.members.includes(targetUsername)) group.members.push(targetUsername);
    const joinMsg = `${targetUsername} 加入了群聊`;
    historyStore.addGroupHistory(groupId, 'system', joinMsg);
    saveGroupsData();

    io.to(groupId).emit('system-message', joinMsg);
    io.to(groupId).emit('user-list', groupManager.getGroupMembersList(groupId));

    groupManager.findUserSocketsByUsername(targetUsername).forEach(s => {
      s.emit('group-join-approved', { groupId, groupName: group.name });
    });

    groupManager.emitGroupJoinRequests(socket, groupId);
  });

  socket.on('group-reject-join', (data) => {
    if (checkSocketRateLimit(socket)) return;
    if (!data || typeof data !== 'object') return;
    const { groupId, username: targetUsername } = data;
    const username = socket.data.authUsername;
    if (!username) return;
    if (typeof targetUsername !== 'string') return;
    if (typeof groupId !== 'string' || groupId.length > 50) return;
    const group = getGroupsData()[groupId];
    if (!group || group.owner !== username) return;
    if (!group.pendingJoins[targetUsername]) return;

    delete group.pendingJoins[targetUsername];
    saveGroupsData();

    groupManager.findUserSocketsByUsername(targetUsername).forEach(s => {
      s.emit('group-join-rejected', { groupId, groupName: group.name });
    });

    groupManager.emitGroupJoinRequests(socket, groupId);
  });

  // ==================== 群管理员（仅群主可授予/撤销） ====================
  socket.on('group-set-admin', (data, callback) => {
    if (checkSocketRateLimit(socket)) return;
    const fail = (msg) => { if (callback) callback({ success: false, message: msg }); };
    if (!data || typeof data !== 'object') return fail('参数无效');
    const username = socket.data.authUsername;
    const groupId = socket.data.roomId;
    if (!username || !groupId || socket.data.chatType !== 'group') return fail('请在群聊内操作');
    const group = getGroupsData()[groupId];
    if (!group) return fail('群聊不存在');
    if (group.owner !== username) return fail('只有群主可以设置管理员');
    const target = data.username;
    if (typeof target !== 'string' || !isValidUsername(target)) return fail('目标用户无效');
    if (target === group.owner) return fail('群主无需设置管理员权限');
    if (!group.members.includes(target)) return fail('该用户不是群成员');

    if (!Array.isArray(group.admins)) group.admins = [];
    let msg;
    if (data.isAdmin) {
      if (group.admins.includes(target)) return fail('该用户已经是管理员');
      group.admins.push(target);
      msg = `${target} 已被群主设置为管理员`;
    } else {
      if (!group.admins.includes(target)) return fail('该用户不是管理员');
      group.admins = group.admins.filter(a => a !== target);
      msg = `已撤销 ${target} 的管理员权限`;
    }

    io.to(groupId).emit('system-message', msg);
    historyStore.addGroupHistory(groupId, 'system', msg);
    saveGroupsData();

    // 刷新房间内所有成员的 room-info（isAdmin 变化）与成员列表徽章
    for (const [, s] of io.sockets.sockets) {
      if (s.data && s.data.roomId === groupId) {
        s.emit('room-info', {
          id: group.id, name: group.name, type: 'group',
          isOwner: s.data.authUsername === group.owner,
          isAdmin: group.admins.includes(s.data.authUsername),
          inviteCode: null, canViewInvite: false
        });
      }
    }
    io.to(groupId).emit('user-list', groupManager.getGroupMembersList(groupId));
    if (callback) callback({ success: true });
  });

  // ==================== AI 机器人：查询 ====================
  socket.on('group-list-bots', (callback) => {
    if (checkSocketRateLimit(socket)) return;
    const username = socket.data.authUsername;
    const groupId = socket.data.roomId;
    if (!username || !groupId || socket.data.chatType !== 'group') return;
    botService.emitGroupBots(groupId, socket);
  });

  // ==================== AI 机器人：添加（群主/管理员） ====================
  socket.on('group-add-bot', (data, callback) => {
    if (checkSocketRateLimit(socket)) return;
    const fail = (msg) => { if (callback) callback({ success: false, message: msg }); };
    if (!data || typeof data !== 'object') return fail('参数无效');
    const username = socket.data.authUsername;
    const groupId = socket.data.roomId;
    if (!username || !groupId || socket.data.chatType !== 'group') return fail('请在群聊内操作');
    const group = getGroupsData()[groupId];
    if (!group) return fail('群聊不存在');
    const role = getGroupRole(group, username);
    if (role !== 'owner' && role !== 'admin') return fail('只有群主或管理员可以添加机器人');

    if (!Array.isArray(group.bots)) group.bots = [];
    if (group.bots.length >= MAX_BOTS_PER_GROUP) return fail(`每个群聊最多 ${MAX_BOTS_PER_GROUP} 个机器人`);

    const v = botService.validateBotConfig(data);
    if (!v.ok) return fail(v.message);
    const val = v.values;
    if (group.bots.some(b => b.name === val.name)) return fail('该机器人名称已存在');
    if (group.members.includes(val.name)) return fail('机器人名称不能与群成员重名');

    // 头像（可选）
    if (typeof data.avatar === 'string' && data.avatar) {
      const av = botService.validateBotAvatar(data.avatar);
      if (!av.ok) return fail(av.message);
    }

    const bot = botService.createBot(val, username);
    if (typeof data.avatar === 'string' && data.avatar) bot.avatar = data.avatar;
    group.bots.push(bot);

    const msg = `机器人 ${val.name} 已加入群聊（由 ${username} 添加），@${val.name} 可召唤`;
    io.to(groupId).emit('system-message', msg);
    historyStore.addGroupHistory(groupId, 'system', msg);
    saveGroupsData();
    botService.emitGroupBots(groupId);
    if (callback) callback({ success: true, bot: botService.sanitizeBot(bot, true) });
  });

  // ==================== AI 机器人：修改设置（群主/管理员） ====================
  socket.on('group-update-bot', (data, callback) => {
    if (checkSocketRateLimit(socket)) return;
    const fail = (msg) => { if (callback) callback({ success: false, message: msg }); };
    if (!data || typeof data !== 'object') return fail('参数无效');
    const username = socket.data.authUsername;
    const groupId = socket.data.roomId;
    if (!username || !groupId || socket.data.chatType !== 'group') return fail('请在群聊内操作');
    const group = getGroupsData()[groupId];
    if (!group) return fail('群聊不存在');
    const role = getGroupRole(group, username);
    if (role !== 'owner' && role !== 'admin') return fail('只有群主或管理员可以修改机器人设置');

    if (!Array.isArray(group.bots)) return fail('机器人不存在');
    const bot = group.bots.find(b => b.id === data.botId);
    if (!bot) return fail('机器人不存在');

    const v = botService.validateBotConfig(data);
    if (!v.ok) return fail(v.message);
    const val = v.values;
    if (group.bots.some(b => b.name === val.name && b.id !== bot.id)) return fail('该机器人名称已存在');
    if (group.members.includes(val.name)) return fail('机器人名称不能与群成员重名');

    // apiKey 留空则保留旧值
    if (!val.apiKey) val.apiKey = bot.apiKey;
    // 头像：dataURL=替换（校验）、''=清除、undefined=不变
    if (typeof data.avatar === 'string' && data.avatar) {
      const av = botService.validateBotAvatar(data.avatar);
      if (!av.ok) return fail(av.message);
      bot.avatar = data.avatar;
    } else if (data.avatar === '') {
      bot.avatar = null;
    }

    const oldName = bot.name;
    bot.name = val.name;
    bot.apiUrl = val.apiUrl;
    bot.model = val.model;
    bot.apiKey = val.apiKey;
    bot.mood = val.mood;
    bot.customPrompt = val.customPrompt;

    const msg = `机器人 ${oldName} 的设置已更新（由 ${username} 修改）${val.name !== oldName ? `，现名 ${val.name}` : ''}`;
    io.to(groupId).emit('system-message', msg);
    historyStore.addGroupHistory(groupId, 'system', msg);
    saveGroupsData();
    botService.emitGroupBots(groupId);
    if (callback) callback({ success: true, bot: botService.sanitizeBot(bot, true) });
  });

  // ==================== AI 机器人：删除（仅群主） ====================
  socket.on('group-remove-bot', (data, callback) => {
    if (checkSocketRateLimit(socket)) return;
    const fail = (msg) => { if (callback) callback({ success: false, message: msg }); };
    if (!data || typeof data !== 'object') return fail('参数无效');
    const username = socket.data.authUsername;
    const groupId = socket.data.roomId;
    if (!username || !groupId || socket.data.chatType !== 'group') return fail('请在群聊内操作');
    const group = getGroupsData()[groupId];
    if (!group) return fail('群聊不存在');
    if (group.owner !== username) return fail('只有群主可以删除机器人');

    if (!Array.isArray(group.bots)) return fail('机器人不存在');
    const bot = group.bots.find(b => b.id === data.botId);
    if (!bot) return fail('机器人不存在');

    group.bots = group.bots.filter(b => b.id !== data.botId);
    const msg = `机器人 ${bot.name} 已被群主移除`;
    io.to(groupId).emit('system-message', msg);
    historyStore.addGroupHistory(groupId, 'system', msg);
    saveGroupsData();
    botService.emitGroupBots(groupId);
    if (callback) callback({ success: true });
  });
}

module.exports = { registerGroupHandlers };
