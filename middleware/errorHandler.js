// 错误处理：asyncHandler 包裹 async 路由 + 全局错误中间件

// 包裹 async 路由，使 rejected promise 被错误处理中间件捕获，避免请求挂起
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function applyErrorHandler(app) {
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ success: false, message: '请求格式错误' });
    }
    if (err) {
      console.error('Server error:', err.message || err);
      return res.status(500).json({ success: false, message: '服务器内部错误' });
    }
    next();
  });
}

module.exports = { asyncHandler, applyErrorHandler };
