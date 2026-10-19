// 图形验证码模块：纯服务端生成 BMP 位图，5x7 点阵字体 + 噪点 + 干扰线
// 依赖：crypto（内置）。safeCompare 由调用方注入，避免与 auth 模块循环依赖。

const crypto = require('crypto');

const CAPTCHA_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CAPTCHA_TTL = 5 * 60 * 1000;
const captchaStore = new Map();

// 5x7 点阵字体（验证码用字符集）
const FONT_5x7 = {
  'A': ['01110','10001','10001','11111','10001','10001','10001'],
  'B': ['11110','10001','10001','11110','10001','10001','11110'],
  'C': ['01111','10000','10000','10000','10000','10000','01111'],
  'D': ['11110','10001','10001','10001','10001','10001','11110'],
  'E': ['11111','10000','10000','11110','10000','10000','11111'],
  'F': ['11111','10000','10000','11110','10000','10000','10000'],
  'G': ['01111','10000','10000','10011','10001','10001','01111'],
  'H': ['10001','10001','10001','11111','10001','10001','10001'],
  'J': ['00111','00010','00010','00010','00010','10010','01100'],
  'K': ['10001','10010','10100','11000','10100','10010','10001'],
  'M': ['10001','11011','10101','10101','10001','10001','10001'],
  'N': ['10001','11001','10101','10101','10101','10011','10001'],
  'P': ['11110','10001','10001','11110','10000','10000','10000'],
  'Q': ['01110','10001','10001','10001','10101','10010','01101'],
  'R': ['11110','10001','10001','11110','10100','10010','10001'],
  'S': ['01111','10000','10000','01110','00001','00001','11110'],
  'T': ['11111','00100','00100','00100','00100','00100','00100'],
  'U': ['10001','10001','10001','10001','10001','10001','01110'],
  'V': ['10001','10001','10001','10001','10001','01010','00100'],
  'W': ['10001','10001','10001','10101','10101','11011','10001'],
  'X': ['10001','10001','01010','00100','01010','10001','10001'],
  'Y': ['10001','10001','01010','00100','00100','00100','00100'],
  'Z': ['11111','00001','00010','00100','01000','10000','11111'],
  '2': ['01110','10001','00001','00010','00100','10000','11111'],
  '3': ['01110','10001','00001','00110','00001','10001','01110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','11110','00001','00001','10001','01110'],
  '6': ['00110','01000','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00010','01100']
};

function generateCaptchaText() {
  let text = '';
  for (let i = 0; i < 4; i++) {
    text += CAPTCHA_CHARS[crypto.randomInt(0, CAPTCHA_CHARS.length)];
  }
  return text;
}

// 纯JS生成BMP位图：5x7点阵字体渲染 + 随机噪点 + 干扰线
function generateCaptchaBMP(text) {
  const W = 120, H = 40, bpp = 24;
  const rowSize = Math.floor((W * bpp + 31) / 32) * 4;
  const imageSize = rowSize * H;
  const fileSize = 54 + imageSize;

  // 像素缓冲（白色背景，BMP从下到上存储）
  const pixels = Buffer.alloc(imageSize, 0xFF);

  // 绘制4个字符
  const scale = 3;
  const charW = 5 * scale;
  const charSpacing = 6;
  const totalW = text.length * charW + (text.length - 1) * charSpacing;
  const startX = Math.floor((W - totalW) / 2);
  const startY = Math.floor((H - 7 * scale) / 2);

  // 波形扭曲相位（每次验证码随机，几何形变抵抗模板匹配 OCR）
  const warpPhase = crypto.randomInt(0, 7);

  for (let i = 0; i < text.length; i++) {
    const font = FONT_5x7[text[i]];
    if (!font) continue;
    const cx = startX + i * (charW + charSpacing);
    // 每个字符轻微随机偏移，增加识别难度
    const offsetY = crypto.randomInt(-2, 3);
    const offsetX = crypto.randomInt(-2, 3);
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (font[row][col] === '1') {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const px = cx + offsetX + col * scale + dx;
              const py = startY + row * scale + dy + offsetY;
              // 水平方向正弦波形扭曲（振幅2px，波长~20px）
              const wx = px + Math.round(2 * Math.sin((py + warpPhase) / 3.2));
              if (wx >= 0 && wx < W && py >= 0 && py < H) {
                const off = (H - 1 - py) * rowSize + wx * 3;
                // 深色字符（随机深色）
                const c = crypto.randomInt(0, 60);
                pixels[off] = c;     // B
                pixels[off + 1] = c; // G
                pixels[off + 2] = c; // R
              }
            }
          }
        }
      }
    }
  }

  // 随机噪点
  for (let i = 0; i < 300; i++) {
    const px = crypto.randomInt(0, W);
    const py = crypto.randomInt(0, H);
    const off = (H - 1 - py) * rowSize + px * 3;
    const n = crypto.randomInt(80, 180);
    pixels[off] = n;
    pixels[off + 1] = n;
    pixels[off + 2] = n;
  }

  // 干扰线（3条水平线 + 2条斜线）
  for (let i = 0; i < 3; i++) {
    const y = crypto.randomInt(5, H - 5);
    for (let x = 0; x < W; x++) {
      const off = (H - 1 - y) * rowSize + x * 3;
      const n = crypto.randomInt(80, 150);
      pixels[off] = n;
      pixels[off + 1] = n;
      pixels[off + 2] = n;
    }
  }
  for (let i = 0; i < 2; i++) {
    let x0 = crypto.randomInt(0, W / 2);
    let y0 = crypto.randomInt(0, H);
    const x1 = crypto.randomInt(W / 2, W);
    const y1 = crypto.randomInt(0, H);
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let s = 0; s <= steps; s++) {
      const px = Math.floor(x0 + (x1 - x0) * s / steps);
      const py = Math.floor(y0 + (y1 - y0) * s / steps);
      if (px >= 0 && px < W && py >= 0 && py < H) {
        const off = (H - 1 - py) * rowSize + px * 3;
        const n = crypto.randomInt(80, 150);
        pixels[off] = n;
        pixels[off + 1] = n;
        pixels[off + 2] = n;
      }
    }
  }

  // BMP文件头（14字节）+ DIB头（40字节）
  const header = Buffer.alloc(54);
  header.write('BM', 0);
  header.writeUInt32LE(fileSize, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(W, 18);
  header.writeInt32LE(H, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(bpp, 28);
  header.writeUInt32LE(imageSize, 34);
  header.writeUInt32LE(2835, 38);
  header.writeUInt32LE(2835, 42);

  return 'data:image/bmp;base64,' + Buffer.concat([header, pixels]).toString('base64');
}

// 定期清理过期验证码
setInterval(() => {
  const now = Date.now();
  for (const [id, cap] of captchaStore) {
    if (now > cap.expireAt) captchaStore.delete(id);
  }
}, 60 * 1000);

// 创建一个验证码（返回 { captchaId, image }）
function createCaptcha() {
  const captchaId = crypto.randomBytes(16).toString('hex');
  const text = generateCaptchaText();
  const image = generateCaptchaBMP(text);
  captchaStore.set(captchaId, { text, expireAt: Date.now() + CAPTCHA_TTL });
  return { captchaId, image };
}

// 校验验证码：传入 safeCompare 函数（避免循环依赖）
function makeVerifyCaptcha(safeCompareFn) {
  return function verifyCaptcha(captchaId, code) {
    if (!captchaId || typeof captchaId !== 'string' || captchaId.length > 64) return false;
    if (!code || typeof code !== 'string' || code.length > 10) return false;
    const cap = captchaStore.get(captchaId);
    captchaStore.delete(captchaId); // 一次性使用
    if (!cap || Date.now() > cap.expireAt) return false;
    return safeCompareFn(cap.text.toUpperCase(), code.toUpperCase().trim());
  };
}

module.exports = { createCaptcha, makeVerifyCaptcha, CAPTCHA_TTL };
