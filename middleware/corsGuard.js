// 跨域请求防护：JSON 写请求校验 Origin/Referer 与 Host 一致
function applyCorsGuard(app) {
  app.use((req, res, next) => {
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
      const contentType = req.headers['content-type'] || '';
      if (contentType.includes('application/json')) {
        const origin = req.headers['origin'];
        const referer = req.headers['referer'];
        const host = req.headers['host'];
        if (origin) {
          try {
            const originHost = new URL(origin).host;
            if (originHost !== host) {
              return res.status(403).json({ success: false, message: '跨域请求被拒绝' });
            }
          } catch {
            return res.status(403).json({ success: false, message: '跨域请求被拒绝' });
          }
        } else if (referer) {
          try {
            const refererHost = new URL(referer).host;
            if (refererHost !== host) {
              return res.status(403).json({ success: false, message: '跨域请求被拒绝' });
            }
          } catch {}
        }
      }
    }
    next();
  });
}

module.exports = { applyCorsGuard };
