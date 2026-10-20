// 群组数据存储：SQLite groups 表（id 主键 + data JSON 列）
// 内存缓存 groupsData 保持全量（getGroupsData 被群路由高频读取），落盘走 SQL
// 对外 API 与旧 JSON 文件版完全一致
const db = require('./db');

let groupsData = {}; // groupId -> 群组数据（内存缓存，启动时全量加载）

function init() {
  loadGroupsData();
}

function loadGroupsData() {
  groupsData = {};
  for (const row of db.all('SELECT id, data FROM groups')) {
    try {
      const g = JSON.parse(row.data);
      if (!g || typeof g.name !== 'string') continue;
      // 全量保留字段（members/blacklist/pendingJoins/owner 等被群路由与注销清理依赖）
      groupsData[row.id] = g;
      groupsData[row.id].id = row.id;
    } catch {}
  }
}

// groups 表行数据白名单（与旧版保存字段一致）
function toRow(g) {
  return JSON.stringify({
    id: g.id,
    name: g.name,
    owner: g.owner,
    members: g.members,
    admins: g.admins || [],
    bots: g.bots || [],
    blacklist: g.blacklist,
    pendingJoins: g.pendingJoins
  });
}

// 全量写（事务内 UPSERT 全部群）
function saveGroupsData() {
  db.transaction(() => {
    for (const [id, g] of Object.entries(groupsData)) {
      db.run('INSERT OR REPLACE INTO groups (id, data) VALUES (?, ?)', [id, toRow(g)]);
    }
  });
}

// 防抖保存：具体防抖在 db 层（整库统一 2 秒窗口），这里仅标记脏
function saveGroupsDataDebounced() {
  db.markDirty();
}

// 立即落盘并取消待执行的防抖（进程退出前调用，防丢数据）
function flushGroupsNow() {
  db.flushNow();
}

// 保存单个群（供创建/销毁等场景精确写入）
function saveGroup(groupId) {
  const g = groupsData[groupId];
  if (!g) return;
  db.run('INSERT OR REPLACE INTO groups (id, data) VALUES (?, ?)', [groupId, toRow(g)]);
}

// 删除单个群（群解散时调用）
function deleteGroup(groupId) {
  db.run('DELETE FROM groups WHERE id = ?', [groupId]);
}

function getGroupsData() {
  return groupsData;
}

module.exports = { init, loadGroupsData, saveGroupsData, saveGroupsDataDebounced, flushGroupsNow, saveGroup, deleteGroup, getGroupsData };
