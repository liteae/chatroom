// 安全响应头中间件：CSP、HSTS、XSS 防护等
function applySecurityHeaders(app) {
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; " +
      "connect-src 'self' wss: https:; " +
      "font-src 'self'; " +
      "media-src 'self' blob:; " +
      "object-src 'none'; " +
      "frame-src 'none'; " +
      "base-uri 'self'; " +
      "form-action 'self'"
    );
    res.removeHeader('X-Powered-By');
    next();
  });
}

module.exports = { applySecurityHeaders };
