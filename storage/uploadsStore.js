// 上传文件存储：校验函数 + 配额管理 + 过期/孤儿清理（自 fileUpload.js 存储半）
// 写入的文件带随机内容前缀（CHATROOM_V2_...），下载时剥离
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_STORAGE_BYTES = 4 * 1024 * 1024 * 1024;
const FILE_PREFIX = Buffer.from('CHATROOM_V2_' + crypto.randomBytes(16).toString('hex') + '\x00', 'utf8');

const ALLOWED_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.ico',
  '.mp4', '.avi', '.mov', '.mkv', '.webm',
  '.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a',
  '.txt', '.csv',
  '.pdf',
  '.zip'
];

const ALLOWED_MIME_MAP = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.aac': 'audio/aac', '.m4a': 'audio/mp4',
  '.txt': 'text/plain', '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip'
};

// 文件头魔数校验表：验证文件实际内容与扩展名是否匹配
const MAGIC_BYTES = {
  '.jpg': [[0xFF, 0xD8, 0xFF]],
  '.jpeg': [[0xFF, 0xD8, 0xFF]],
  '.png': [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
  '.gif': [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
  '.bmp': [[0x42, 0x4D]],
  '.webp': [[0x52, 0x49, 0x46, 0x46]],
  '.ico': [[0x00, 0x00, 0x01, 0x00], [0x00, 0x00, 0x02, 0x00]],
  '.mp4': [[0x66, 0x74, 0x79, 0x70]],
  '.webm': [[0x1A, 0x45, 0xDF, 0xA3]],
  '.mp3': [[0x49, 0x44, 0x33], [0xFF, 0xFB], [0xFF, 0xF3], [0xFF, 0xF2]],
  '.ogg': [[0x4F, 0x67, 0x67, 0x53]],
  '.flac': [[0x66, 0x4C, 0x61, 0x43]],
  '.zip': [[0x50, 0x4B, 0x03, 0x04], [0x50, 0x4B, 0x05, 0x06], [0x50, 0x4B, 0x07, 0x08]],
  '.pdf': [[0x25, 0x50, 0x44, 0x46]],
  '.wav': [[0x52, 0x49, 0x46, 0x46]],       // RIFF....WAVE
  '.avi': [[0x52, 0x49, 0x46, 0x46]],        // RIFF....AVI
  '.mov': [[0x66, 0x74, 0x79, 0x70]],        // ftyp（同mp4）
  '.mkv': [[0x1A, 0x45, 0xDF, 0xA3]],        // EBML（同webm）
  '.m4a': [[0x66, 0x74, 0x79, 0x70]],        // ftyp（同mp4）
  '.aac': [[0xFF, 0xF1], [0xFF, 0xF9]]        // ADTS frame
};

function validateMagicBytes(buffer, ext) {
  const signatures = MAGIC_BYTES[ext];
  // txt/csv 是纯文本，无固定魔数，跳过校验
  if (!signatures) return true;
  if (!buffer || buffer.length < 16) return false;
  // mp4/mov/m4a 的 ftyp 在第4-7字节
  const offset = (ext === '.mp4' || ext === '.mov' || ext === '.m4a') ? 4 : 0;
  for (const sig of signatures) {
    let match = true;
    for (let i = 0; i < sig.length; i++) {
      if (buffer[offset + i] !== sig[i]) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

function isBlockedFile(filename) {
  if (!filename || typeof filename !== 'string') return true;
  if (filename.includes('\0')) return true;
  if (filename.includes('..')) return true;
  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) return true;
  return false;
}

function isSafeFileId(id) {
  if (!id || typeof id !== 'string') return false;
  return /^[0-9a-f]{32}$/.test(id);
}

function isValidDataUrl(url) {
  if (typeof url !== 'string') return false;
  if (!url.startsWith('data:image/')) return false;
  if (url.includes('\0')) return false;
  if (url.length > 8 * 1024 * 1024) return false;
  const commaIdx = url.indexOf(',');
  if (commaIdx === -1) return false;
  const header = url.substring(5, commaIdx);
  if (!/^image\/[a-zA-Z0-9.+-]+;base64$/.test(header)) return false;
  const base64Part = url.substring(commaIdx + 1);
  if (base64Part.length === 0) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64Part)) return false;
  if (base64Part.length % 4 !== 0) return false;
  return true;
}

function isValidFileUrl(url) {
  if (typeof url !== 'string') return false;
  if (!url.startsWith('/api/files/')) return false;
  const fileId = url.replace('/api/files/', '');
  return isSafeFileId(fileId);
}

// ==================== 配额管理 ====================

let uploadsDir = null;
let uploadsSizeCache = 0;

function init({ dataDir }) {
  uploadsDir = path.join(dataDir, 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  recalcUploadsSize();
  cleanupOldFiles();
}

function getUploadsDir() { return uploadsDir; }
function getUploadsSize() { return uploadsSizeCache; }
function addUploadedBytes(n) { uploadsSizeCache += n; }
function freeBytes(n) { uploadsSizeCache = Math.max(0, uploadsSizeCache - n); }

function recalcUploadsSize() {
  try {
    let totalSize = 0;
    const files = fs.readdirSync(uploadsDir);
    for (const file of files) {
      if (file.endsWith('.meta')) continue;
      // L4 修复：所有非 meta 文件都计入配额（含异常遗留文件）
      const filePath = path.join(uploadsDir, file);
      try {
        const stat = fs.statSync(filePath);
        totalSize += stat.size;
      } catch {}
    }
    uploadsSizeCache = totalSize;
  } catch {}
}

// 落盘：数据文件（带前缀）+ meta 元数据
function writeUploadedFile({ fileId, fileBuffer, fileName, fileType, uploader }) {
  const filePath = path.join(uploadsDir, fileId);
  const metaPath = filePath + '.meta';
  const prefixedContent = Buffer.concat([FILE_PREFIX, fileBuffer]);
  fs.writeFileSync(filePath, prefixedContent);
  fs.writeFileSync(metaPath, JSON.stringify({
    name: fileName,
    size: fileBuffer.length,
    type: fileType,
    time: Date.now(),
    owner: uploader
  }));
  return prefixedContent.length;
}

// 读取：剥离内容前缀
function readUploadedFile(fileId) {
  const filePath = path.join(uploadsDir, fileId);
  const fileData = fs.readFileSync(filePath);
  if (fileData.slice(0, FILE_PREFIX.length).equals(FILE_PREFIX)) {
    return fileData.slice(FILE_PREFIX.length);
  }
  return fileData;
}

function readMeta(fileId) {
  const metaPath = path.join(uploadsDir, fileId + '.meta');
  return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
}

// 路径穿越防御：解析后的路径必须仍位于上传目录内
function isPathInsideUploads(fileId) {
  const filePath = path.join(uploadsDir, fileId);
  const resolvedPath = path.resolve(filePath);
  return resolvedPath.startsWith(path.resolve(uploadsDir) + path.sep) && resolvedPath !== path.resolve(uploadsDir);
}

// 过期文件清理（24h）+ 孤儿文件清理（L4）
function cleanupOldFiles() {
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  let freedBytes = 0;
  let files = [];
  try { files = fs.readdirSync(uploadsDir); } catch { return; }

  for (const file of files) {
    if (!file.endsWith('.meta')) continue;
    if (!isSafeFileId(file.replace('.meta', ''))) continue;
    const metaPath = path.join(uploadsDir, file);
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (now - meta.time > ONE_DAY) {
        const fileId = file.replace('.meta', '');
        const filePath = path.join(uploadsDir, fileId);
        const resolvedPath = path.resolve(filePath);
        if (resolvedPath.startsWith(path.resolve(uploadsDir) + path.sep) || resolvedPath === path.resolve(uploadsDir)) {
          try { const stat = fs.statSync(filePath); freedBytes += stat.size; } catch {}
          fs.unlinkSync(metaPath);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          console.log('已清理过期文件:', meta.name);
        }
      }
    } catch {}
  }

  // L4：孤儿文件--文件名非法、或对应 .meta 已丢失的文件
  // 仅清理存在超过一天的孤儿，避免误删"刚写入数据、meta 未落盘"的瞬间状态
  const metaIds = new Set(files.filter(f => f.endsWith('.meta')).map(f => f.replace(/\.meta$/, '')));
  for (const file of files) {
    if (file.endsWith('.meta')) continue;
    if (isSafeFileId(file) && metaIds.has(file)) continue;
    const filePath = path.join(uploadsDir, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > ONE_DAY) {
        fs.unlinkSync(filePath);
        freedBytes += stat.size;
        console.log('已清理孤儿文件:', file);
      }
    } catch {}
  }

  if (freedBytes > 0) freeBytes(freedBytes);
}

module.exports = {
  init,
  MAX_STORAGE_BYTES,
  FILE_PREFIX,
  ALLOWED_MIME_MAP,
  isBlockedFile,
  validateMagicBytes,
  isSafeFileId,
  isValidDataUrl,
  isValidFileUrl,
  getUploadsDir,
  getUploadsSize,
  addUploadedBytes,
  recalcUploadsSize,
  writeUploadedFile,
  readUploadedFile,
  readMeta,
  isPathInsideUploads,
  cleanupOldFiles
};
