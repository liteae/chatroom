// 通用失败锁定器：窗口内失败超限后临时锁定
// 用途：登录爆破防护（账户级）、邀请码爆破防护（用户级）
function makeFailLock({ limit, windowMs, lockMs }) {
  const fails = new Map();
  return {
    locked(key) {
      const rec = fails.get(key);
      return !!(rec && rec.lockedUntil && Date.now() < rec.lockedUntil);
    },
    fail(key) {
      const now = Date.now();
      let rec = fails.get(key);
      if (!rec || now - rec.windowStart > windowMs) {
        rec = { count: 0, windowStart: now, lockedUntil: 0 };
        fails.set(key, rec);
      }
      rec.count++;
      if (rec.count >= limit) {
        rec.lockedUntil = now + lockMs;
        rec.count = 0;
        rec.windowStart = now;
      }
    },
    clear(key) { fails.delete(key); },
    sweep() {
      const now = Date.now();
      for (const [k, rec] of fails) {
        if (rec.lockedUntil && now - rec.lockedUntil > lockMs) fails.delete(k);
        else if (!rec.lockedUntil && now - rec.windowStart > 2 * windowMs) fails.delete(k);
      }
    }
  };
}

module.exports = { makeFailLock };
