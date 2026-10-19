// 聊天服务：按拉黑关系过滤广播与历史（M4 修复，自 server.js）
// chat → friendService 单向依赖，friendService 不反向依赖本模块
const friendService = require('../friends/friendService');

let io = null;

function register(newIo) {
  io = newIo;
}

// 聊天广播按拉黑关系过滤——互相拉黑的双方在群聊/聊天室内看不到彼此的消息
function emitChatFiltered(roomId, event, data) {
  const sender = data.username;
  if (!sender) { io.to(roomId).emit(event, data); return; }
  const sids = io.sockets.adapter.rooms.get(roomId);
  if (!sids) return;
  for (const sid of sids) {
    const s = io.sockets.sockets.get(sid);
    if (!s || !s.data) continue;
    const viewer = s.data.authUsername;
    // 游客（无 authUsername）无拉黑列表，正常收消息
    if (viewer && viewer !== sender && (friendService.isBlocked(viewer, sender) || friendService.isBlocked(sender, viewer))) continue;
    s.emit(event, data);
  }
}

// 历史记录按查看者的拉黑关系过滤（拉黑后历史里也看不到对方旧消息）
function filterHistoryForViewer(history, viewer) {
  if (!viewer) return history;
  return history.filter(entry => {
    const u = entry && entry.data && entry.data.username;
    if (!u || u === viewer) return true;
    return !(friendService.isBlocked(viewer, u) || friendService.isBlocked(u, viewer));
  });
}

module.exports = { register, emitChatFiltered, filterHistoryForViewer };
