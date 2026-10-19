// 原子写入与文件锁：防止并发写入导致数据损坏
const fs = require('fs');

const fileLocks = new Map();

// 同一路径的写操作串行化
function withFileLock(filePath, fn) {
  const promise = fileLocks.get(filePath) || Promise.resolve();
  const next = promise.then(() => fn());
  fileLocks.set(filePath, next);
  next.finally(() => {
    if (fileLocks.get(filePath) === next) fileLocks.delete(filePath);
  });
  return next;
}

// 原子写入：先写临时文件再 rename，防止写入中断导致文件损坏
function atomicWriteJSON(filePath, data) {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

module.exports = { withFileLock, atomicWriteJSON };
