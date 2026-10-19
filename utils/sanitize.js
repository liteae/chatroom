// 输入清洗与格式校验（服务端通用）
// 注：sanitizeString / isValidUsername / isValidPassword 在 security/auth.js

// 递归清洗请求体：防原型污染、防深层嵌套、限数组长度
function sanitizeBody(body, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 10) return {};
  if (!body || typeof body !== 'object') return {};
  if (Array.isArray(body)) {
    return body.slice(0, 100).map(item => {
      if (item && typeof item === 'object') return sanitizeBody(item, depth + 1);
      return item;
    });
  }
  const safe = {};
  for (const key of Object.keys(body)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const val = body[key];
    if (val && typeof val === 'object') {
      safe[key] = sanitizeBody(val, depth + 1);
    } else {
      safe[key] = val;
    }
  }
  return safe;
}

// 聊天消息清洗：去控制字符/零宽字符 + 截断 500 字
// M3 修复：服务端不做 HTML 转义，前端渲染时统一 escapeHtml
function sanitizeMessage(msg) {
  if (typeof msg !== 'string') return '';
  msg = msg.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b\u200c\u200d\ufeff\u202a-\u202e\u2066-\u2069\u200e\u200f\u2028\u2029]/g, '');
  // 按码点截断，避免把 emoji 等代理对切成两半
  msg = Array.from(msg).slice(0, 500).join('');
  return msg;
}

// 聊天室名称校验
function isValidRoomName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 20) return false;
  if (/[<>"'&\\\/\n\r\t\0]/.test(name)) return false;
  return true;
}

module.exports = { sanitizeBody, sanitizeMessage, isValidRoomName };
