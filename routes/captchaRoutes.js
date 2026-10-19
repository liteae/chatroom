// 验证码路由：GET /api/captcha
const { createCaptcha } = require('../security/captcha');
const { rateLimit } = require('../middleware/httpRateLimit');

function registerCaptchaRoutes(app) {
  app.get('/api/captcha', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    if (rateLimit(`captcha:${ip}`, 30, 5 * 60 * 1000)) {
      return res.status(429).json({ success: false, message: '验证码请求过于频繁' });
    }
    const { captchaId, image } = createCaptcha();
    res.json({ success: true, captchaId, image });
  });
}

module.exports = { registerCaptchaRoutes };
