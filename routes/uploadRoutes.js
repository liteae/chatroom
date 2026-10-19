// 上传/下载 HTTP 路由（自 fileUpload.js 路由半）
// 依赖注入：{ getSession, rateLimit, sanitizeString }
// 校验/配额/落盘逻辑全部委托 storage/uploadsStore
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const uploadsStore = require('../storage/uploadsStore');

function registerUploadRoutes(app, deps) {
  const { getSession, rateLimit, sanitizeString } = deps;

  app.post('/api/upload', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-token'];
    const session = getSession(token, ip);
    if (!session) {
      return res.status(401).json({ success: false, message: '请先登录后再上传文件' });
    }
    const uploader = session.username;

    if (rateLimit(`upload:${ip}`, 120, 60 * 60 * 1000)) {
      return res.status(429).json({ success: false, message: '上传请求过于频繁' });
    }

    let fileName = '';
    try { fileName = sanitizeString(decodeURIComponent(req.headers['x-filename'] || '')); }
    catch { fileName = sanitizeString(req.headers['x-filename'] || ''); }
    // L2 修复：截断超长文件名，防止 meta 与 Content-Disposition 携带超长字符串
    fileName = fileName.substring(0, 255);
    const fileType = req.headers['x-filetype'] || 'application/octet-stream';

    if (typeof fileType !== 'string' || fileType.length > 200) {
      return res.status(400).json({ success: false, message: '文件类型无效' });
    }

    if (!fileName) return res.status(400).json({ success: false, message: '缺少文件名' });
    if (uploadsStore.isBlockedFile(fileName)) return res.status(400).json({ success: false, message: '不允许上传此类型的文件' });
    if (!req.body || req.body.length === 0) return res.status(400).json({ success: false, message: '文件内容为空' });

    const actualSize = req.body.length;
    if (actualSize > 50 * 1024 * 1024) return res.status(400).json({ success: false, message: '文件大小超过限制（最大50MB）' });

    const ext = path.extname(fileName).toLowerCase();
    const forcedMime = uploadsStore.ALLOWED_MIME_MAP[ext] || 'application/octet-stream';

    // 文件头魔数校验：防止伪装扩展名上传恶意文件
    if (!uploadsStore.validateMagicBytes(req.body, ext)) {
      return res.status(400).json({ success: false, message: '文件内容与扩展名不匹配' });
    }

    const currentStorage = uploadsStore.getUploadsSize();
    if (currentStorage + actualSize > uploadsStore.MAX_STORAGE_BYTES) {
      return res.status(507).json({ success: false, message: '服务器存储空间已满，暂时无法上传文件' });
    }

    const fileId = crypto.randomBytes(16).toString('hex');

    try {
      const written = uploadsStore.writeUploadedFile({ fileId, fileBuffer: req.body, fileName, fileType: forcedMime, uploader });
      uploadsStore.addUploadedBytes(written);
    } catch (err) {
      const filePath = path.join(uploadsStore.getUploadsDir(), fileId);
      const metaPath = filePath + '.meta';
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
      try { if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath); } catch {}
      return res.status(500).json({ success: false, message: '文件保存失败' });
    }

    res.json({ success: true, fileId, fileName, fileSize: actualSize, fileType: forcedMime });
  });

  app.get('/api/files/:id', (req, res) => {
    const fileId = req.params.id;

    if (!uploadsStore.isSafeFileId(fileId)) {
      return res.status(400).send('非法文件ID');
    }

    const ip = req.ip || req.connection.remoteAddress;
    if (rateLimit(`download:${ip}`, 120, 60 * 60 * 1000)) {
      return res.status(429).send('下载请求过于频繁');
    }

    const token = req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-token'];
    const session = token ? getSession(token, ip) : null;
    if (!session) {
      return res.status(401).send('请先登录后再下载文件');
    }

    if (!uploadsStore.isPathInsideUploads(fileId)) {
      return res.status(400).send('非法路径');
    }

    const filePath = path.join(uploadsStore.getUploadsDir(), fileId);
    const metaPath = filePath + '.meta';

    if (!fs.existsSync(filePath) || !fs.existsSync(metaPath)) {
      return res.status(404).send('文件不存在或已过期');
    }

    try {
      const meta = uploadsStore.readMeta(fileId);
      const safeName = sanitizeString(meta.name) || 'download';
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`);
      const ext = path.extname(safeName).toLowerCase();
      const safeType = uploadsStore.ALLOWED_MIME_MAP[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', safeType);
      res.setHeader('X-Content-Type-Options', 'nosniff');

      const content = uploadsStore.readUploadedFile(fileId);
      res.setHeader('Content-Length', content.length);
      res.send(content);
    } catch {
      res.status(500).send('读取文件信息失败');
    }
  });

  // 过期（24h）与孤儿文件周期清理
  setInterval(() => uploadsStore.cleanupOldFiles(), 30 * 60 * 1000);
}

module.exports = { registerUploadRoutes };
