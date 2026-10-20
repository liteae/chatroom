// SQLite 存储引擎（sql.js = WebAssembly 版 SQLite，纯 JS 零编译依赖）
// 架构：单例内存库 + 防抖整库落盘（临时文件 + rename 原子写）
// 表设计：均为主键 + JSON 文档列，保持与旧 JSON 文件版完全一致的数据结构，
//         存储层对外 API 不变，调用方（事件层）零改动
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

let db = null;
let dbFile = null;
let dirty = false;
let saveTimer = null;
const SAVE_DEBOUNCE_MS = 2000;

// 初始化（server.js 启动时 await 一次；各 store 的 init 在其完成后调用）
async function init(dataDir) {
  if (db) return;
  const SQL = await initSqlJs();
  dbFile = path.join(dataDir, 'chatroom.db');
  if (fs.existsSync(dbFile)) {
    try {
      db = new SQL.Database(fs.readFileSync(dbFile));
    } catch (e) {
      console.error('chatroom.db 读取失败，使用空库:', e.message);
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      username   TEXT PRIMARY KEY,
      lower_name TEXT NOT NULL UNIQUE,
      data       TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS groups (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_history (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pm_history (
      pm_key TEXT PRIMARY KEY,
      data   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS friends (
      username TEXT PRIMARY KEY,
      data     TEXT NOT NULL
    );
  `);
}

// 写操作（自动标记脏 + 防抖落盘）
function run(sql, params) {
  db.run(sql, params);
  markDirty();
}

// 查询多行：[{col: value}, ...]
function all(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// 查询单行（无则 null）
function get(sql, params) {
  return all(sql, params)[0] || null;
}

// 事务包裹：fn 内的 run 不触发防抖，事务结束统一标记
function transaction(fn) {
  db.run('BEGIN');
  try {
    fn();
    db.run('COMMIT');
  } catch (e) {
    try { db.run('ROLLBACK'); } catch {}
    throw e;
  }
  markDirty();
}

function markDirty() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushNow();
  }, SAVE_DEBOUNCE_MS);
}

// 整库落盘（原子写：临时文件 + rename），进程退出前必须调用
function flushNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!db || !dirty) return;
  try {
    const buf = Buffer.from(db.export());
    const tmp = dbFile + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dbFile);
    dirty = false;
  } catch (e) {
    console.error('SQLite 落盘失败:', e.message);
  }
}

module.exports = { init, run, all, get, transaction, markDirty, flushNow };
