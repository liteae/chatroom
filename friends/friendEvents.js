// 好友关系事件：申请/接受/拒绝/删除/拉黑/列表（自 friend.js 事件半-关系部分）
const { checkSocketRateLimit } = require('../socket/socketRateLimit');
const { isValidUsername } = require('../security/auth');
const { MAX_FRIENDS, MAX_BLACKLIST, MAX_PENDING } = require('../config/constants');
const usersStore = require('../storage/usersStore');
const friendService = require('./friendService');

function registerFriendHandlers(io, socket) {
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

  // 发送好友申请
  socket.on('friend-request', (data, callback) => {
    if (!preCheck(callback)) return;
    const me = socket.data.authUsername;
    const target = data && data.targetUsername;
    if (!validateTarget(target, callback)) return;
    if (target === me) {
      if (callback) callback({ success: false, message: '不能加自己为好友' }); return;
    }

    const myData = friendService.getUserData(me);
    const targetData = friendService.getUserData(target);

    // 已是好友
    if (myData.friends.has(target)) {
      if (callback) callback({ success: false, message: '已经是好友了' }); return;
    }
    // 被对方拉黑
    if (targetData.blacklist.has(me)) {
      if (callback) callback({ success: false, message: '无法发送申请' }); return;
    }
    // 自己拉黑了对方
    if (myData.blacklist.has(target)) {
      if (callback) callback({ success: false, message: '请先解除拉黑' }); return;
    }
    // 已发送过申请
    if (myData.pendingSent.has(target)) {
      if (callback) callback({ success: false, message: '已发送过申请，等待对方确认' }); return;
    }
    // 对方已经向我发过申请 -> 直接互相加为好友
    if (myData.pendingReceived.has(target)) {
      // 互加路径也要检查 MAX_FRIENDS
      if (myData.friends.size >= MAX_FRIENDS || targetData.friends.size >= MAX_FRIENDS) {
        if (callback) callback({ success: false, message: '好友数已达上限' }); return;
      }
      myData.pendingReceived.delete(target);
      targetData.pendingSent.delete(me);
      myData.friends.add(target);
      targetData.friends.add(me);
      friendService.saveAll();
      if (callback) callback({ success: true, message: '已互相添加为好友' });
      // 通知对方
      for (const s of friendService.getUserSockets(target)) {
        s.emit('friend-added', { username: me });
        s.emit('friend-request-updated', {});
      }
      return;
    }
    // 限制数量
    if (myData.pendingSent.size >= MAX_PENDING) {
      if (callback) callback({ success: false, message: '待处理申请过多' }); return;
    }
    if (targetData.pendingReceived.size >= MAX_PENDING) {
      if (callback) callback({ success: false, message: '对方申请过多，请稍后再试' }); return;
    }

    myData.pendingSent.add(target);
    targetData.pendingReceived.add(me);
    friendService.saveAll();
    if (callback) callback({ success: true, message: '申请已发送' });
    // 通知对方有新申请
    for (const s of friendService.getUserSockets(target)) {
      s.emit('friend-request-received', { username: me });
    }
  });

  // 接受好友申请
  socket.on('friend-accept', (data, callback) => {
    if (!preCheck(callback)) return;
    const me = socket.data.authUsername;
    const target = data && data.targetUsername;
    if (!validateTarget(target, callback)) return;

    const myData = friendService.getUserData(me);
    const targetData = friendService.getUserData(target);

    if (!myData.pendingReceived.has(target)) {
      if (callback) callback({ success: false, message: '没有该申请' }); return;
    }
    // 检查双方好友上限
    if (myData.friends.size >= MAX_FRIENDS) {
      if (callback) callback({ success: false, message: '好友数已达上限' }); return;
    }
    if (targetData.friends.size >= MAX_FRIENDS) {
      if (callback) callback({ success: false, message: '对方好友数已达上限' }); return;
    }

    myData.pendingReceived.delete(target);
    targetData.pendingSent.delete(me);
    myData.friends.add(target);
    targetData.friends.add(me);
    friendService.saveAll();
    if (callback) callback({ success: true });
    // 通知对方
    for (const s of friendService.getUserSockets(target)) {
      s.emit('friend-added', { username: me });
      s.emit('friend-request-updated', {});
    }
  });

  // 拒绝好友申请
  socket.on('friend-reject', (data, callback) => {
    if (!preCheck(callback)) return;
    const me = socket.data.authUsername;
    const target = data && data.targetUsername;
    if (!validateTarget(target, callback)) return;

    const myData = friendService.getUserData(me);
    const targetData = friendService.getUserData(target);
    myData.pendingReceived.delete(target);
    targetData.pendingSent.delete(me);
    friendService.saveAll();
    if (callback) callback({ success: true });
    // 通知对方申请被拒
    for (const s of friendService.getUserSockets(target)) {
      s.emit('friend-request-updated', {});
    }
  });

  // 删除好友
  socket.on('friend-remove', (data, callback) => {
    if (!preCheck(callback)) return;
    const me = socket.data.authUsername;
    const target = data && data.targetUsername;
    if (!validateTarget(target, callback)) return;

    const myData = friendService.getUserData(me);
    // 只有真正是好友才通知对方
    if (!myData.friends.has(target)) {
      if (callback) callback({ success: false, message: '不是好友' }); return;
    }
    const targetData = friendService.getUserData(target);
    myData.friends.delete(target);
    targetData.friends.delete(me);
    friendService.saveAll();
    if (callback) callback({ success: true });
    // 通知对方
    for (const s of friendService.getUserSockets(target)) {
      s.emit('friend-removed', { username: me });
    }
  });

  // 拉黑某人
  socket.on('friend-block', (data, callback) => {
    if (!preCheck(callback)) return;
    const me = socket.data.authUsername;
    const target = data && data.targetUsername;
    if (!validateTarget(target, callback)) return;
    if (target === me) {
      if (callback) callback({ success: false, message: '不能拉黑自己' }); return;
    }

    const myData = friendService.getUserData(me);
    const targetData = friendService.getUserData(target);
    if (myData.blacklist.size >= MAX_BLACKLIST) {
      if (callback) callback({ success: false, message: '黑名单已满' }); return;
    }
    const wasFriend = myData.friends.has(target);
    myData.blacklist.add(target);
    // 拉黑时自动删除好友关系和待处理申请
    if (wasFriend) {
      myData.friends.delete(target);
      targetData.friends.delete(me);
    }
    myData.pendingSent.delete(target);
    myData.pendingReceived.delete(target);
    targetData.pendingSent.delete(me);
    targetData.pendingReceived.delete(me);
    friendService.saveAll();
    if (callback) callback({ success: true });
    // 只有曾经是好友时才通知对方被删
    if (wasFriend) {
      for (const s of friendService.getUserSockets(target)) {
        s.emit('friend-removed', { username: me });
      }
    }
    for (const s of friendService.getUserSockets(target)) {
      s.emit('friend-request-updated', {});
    }
  });

  // 解除拉黑
  socket.on('friend-unblock', (data, callback) => {
    if (!preCheck(callback)) return;
    const me = socket.data.authUsername;
    const target = data && data.targetUsername;
    if (!validateTarget(target, callback)) return;

    const myData = friendService.getUserData(me);
    if (!myData.blacklist.has(target)) {
      if (callback) callback({ success: false, message: '该用户不在黑名单中' }); return;
    }
    myData.blacklist.delete(target);
    friendService.saveAll();
    if (callback) callback({ success: true });
  });

  // 获取好友列表 + 申请列表 + 黑名单
  socket.on('friend-list', (callback) => {
    if (!preCheck(callback)) return;
    const me = socket.data.authUsername;
    const data = friendService.getUserData(me);
    // 先收集在线用户名集合，O(好友+连接) 而非 O(好友×连接)
    const onlineUsers = friendService.getOnlineUsernames();
    const friends = Array.from(data.friends).map(name => ({
      username: name,
      online: onlineUsers.has(name)
    }));
    if (callback) callback({
      success: true,
      friends,
      pendingSent: Array.from(data.pendingSent),
      pendingReceived: Array.from(data.pendingReceived),
      blacklist: Array.from(data.blacklist)
    });
  });
}

module.exports = { registerFriendHandlers };
