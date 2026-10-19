// HTTP 请求限流：每 IP 600 请求/分钟 + 通用 rateLimit 函数（供 API 路由使用）
const requestCounts = new Map();
const rateLimits = new Map();

// 中间件：每 IP 每分钟最多 600 个 HTTP 请求
function applyHttpRateLimit(app) {
  app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const key = `req:${ip}`;
    const record = requestCounts.get(key);
    if (!record || now - record.windowStart > 60000) {
      requestCounts.set(key, { count: 1, windowStart: now });
    } else {
      record.count++;
      if (record.count > 600) {
        return res.status(429).send('请求过于频繁');
      }
    }
    next();
  });

  // 过期计数清理
  setInterval(() => {
    const now = Date.now();
    for (const [key, record] of requestCounts) {
      if (now - record.windowStart > 120000) requestCounts.delete(key);
    }
  }, 30000);
}

// 通用限流：窗口内超过 maxAttempts 返回 true（拒绝）
// rateLimits 的定期清理由 sweepRateLimits 提供（server.js 入口调度）
function rateLimit(key, maxAttempts, windowMs) {
  const now = Date.now();
  const record = rateLimits.get(key);
  if (!record || now - record.windowStart > windowMs) {
    rateLimits.set(key, { count: 1, windowStart: now });
    return false;
  }
  record.count++;
  if (record.count > maxAttempts) return true;
  return false;
}

function sweepRateLimits() {
  const now = Date.now();
  for (const [key, record] of rateLimits) {
    if (now - record.windowStart > 10 * 60 * 1000) rateLimits.delete(key);
  }
}

module.exports = { applyHttpRateLimit, rateLimit, sweepRateLimits };
