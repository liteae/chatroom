// 群组数据存储：groups/ 目录，每群一文件 groupId.json
// 启动时自动从旧 groups.json 迁移（迁移后删除旧文件）
// 内存缓存 groupsData 保持全量，saveGroupsData 写单个群文件
const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('../utils/atomicWrite');

let groupsDir = null;
let groupsData = {}; // groupId -> 群组数据（内存缓存，启动时全量加载）

function init({ dataDir }) {
  groupsDir = path.join(dataDir, 'groups');

  // 旧数据迁移：早期版本群历史混存于 groups.json，拆分到 history/ 目录
  const historyDir = path.join(dataDir, 'history');
  if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true });

  if (!fs.existsSync(groupsDir)) fs.mkdirSync(groupsDir, { recursive: true });

  migrateLegacySingleFile(dataDir, historyDir);
  loadGroupsData();
}

// 旧版单文件 groups.json → groups/ 目录（迁移后删除旧文件）
function migrateLegacySingleFile(dataDir, historyDir) {
  const oldFile = path.join(dataDir, 'groups.json');
  if (!fs.existsSync(oldFile)) return;
  try {
    const data = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
    for (const gid of Object.keys(data)) {
      // 群历史迁移到 history/
      if (Array.isArray(data[gid].history)) {
        const histPath = path.join(historyDir, `${gid}.json`);
        if (!fs.existsSync(histPath)) {
          fs.writeFileSync(histPath, JSON.stringify(data[gid].history));
        }
        delete data[gid].history;
      }
      // 写入 groups/ 目录
      atomicWriteJSON(path.join(groupsDir, `${gid}.json`), data[gid]);
    }
    fs.unlinkSync(oldFile);
    console.log(`已迁移 ${Object.keys(data).length} 个群到 groups/ 目录`);
  } catch (e) {
    console.error('groups.json 迁移失败:', e.message);
  }
}

function loadGroupsData() {
  groupsData = {};
  let files = [];
  try { files = fs.readdirSync(groupsDir); } catch { return; }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const gid = file.slice(0, -5);
    if (!/^group_[0-9a-f]{32}$/.test(gid)) continue;
    try {
      const g = JSON.parse(fs.readFileSync(path.join(groupsDir, file), 'utf8'));
      if (!g || typeof g.name !== 'string') continue;
      // 全量保留字段（members/blacklist/pendingJoins/owner 等被群路由与注销清理依赖）
      groupsData[gid] = g;
      groupsData[gid].id = gid;
    } catch {}
  }
}

// 只写入有变更的群文件（不再全量重写目录）
function saveGroupsData() {
  for (const [id, g] of Object.entries(groupsData)) {
    const toSave = {
      id: g.id,
      name: g.name,
      owner: g.owner,
      members: g.members,
      admins: g.admins || [],
      bots: g.bots || [],
      blacklist: g.blacklist,
      pendingJoins: g.pendingJoins
    };
    atomicWriteJSON(path.join(groupsDir, `${id}.json`), toSave);
  }
}

const SAVE_DEBOUNCE_MS = 2000;
let saveDebounceTimer = null;

// 信息级1修复：防抖保存——高频场景（如聊天消息）合并窗口内的多次调用为一次全量写，
// 避免每条消息都重写所有群文件；进程退出前用 flushGroupsNow 兜底
function saveGroupsDataDebounced() {
  if (saveDebounceTimer) return;
  saveDebounceTimer = setTimeout(() => {
    saveDebounceTimer = null;
    saveGroupsData();
  }, SAVE_DEBOUNCE_MS);
}

// 立即落盘并取消待执行的防抖（进程退出前调用，防丢数据）
function flushGroupsNow() {
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
  }
  saveGroupsData();
}

// 保存单个群（供创建/销毁等场景精确写入）
function saveGroup(groupId) {
  const g = groupsData[groupId];
  if (!g) return;
  const toSave = {
    id: g.id,
    name: g.name,
    owner: g.owner,
    members: g.members,
    admins: g.admins || [],
    bots: g.bots || [],
    blacklist: g.blacklist,
    pendingJoins: g.pendingJoins
  };
  atomicWriteJSON(path.join(groupsDir, `${groupId}.json`), toSave);
}

// 删除单个群文件（群解散时调用）
function deleteGroup(groupId) {
  try { fs.unlinkSync(path.join(groupsDir, `${groupId}.json`)); } catch {}
}

function getGroupsData() {
  return groupsData;
}

module.exports = { init, loadGroupsData, saveGroupsData, saveGroupsDataDebounced, flushGroupsNow, saveGroup, deleteGroup, getGroupsData };
