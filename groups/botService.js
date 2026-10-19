// 群 AI 机器人服务：情绪预设提示词 + @提及触发 + OpenAI 兼容 API 调用
// apiKey 仅存服务端群文件，永不下发（下发只给脱敏 maskedKey）
const crypto = require('crypto');
const {
  BOT_TIMEOUT_MS, BOT_CONTEXT_MESSAGES, BOT_COOLDOWN_MS,
  MAX_BOT_REPLY_LEN, MAX_BOT_NAME_LEN, MAX_API_URL_LEN,
  MAX_MODEL_LEN, MAX_APIKEY_LEN, MAX_PROMPT_LEN, BOT_AVATAR_MAX,
  BOT_ALLOW_PRIVATE_API
} = require('../config/constants');
const { sanitizeString, isValidUsername } = require('../security/auth');
const uploadsStore = require('../storage/uploadsStore');
const { getGroupsData } = require('../storage/groupsStore');
const historyStore = require('../storage/historyStore');
const { getTimeStr } = require('../utils/display');

let io = null;

const BOT_COLOR = '#7c4dff'; // 机器人消息固定色

// ==================== 情绪预设（常用几类，提示词内置服务端） ====================
const MOOD_PRESETS = {
  friendly: {
    label: '😊 默认助手',
    prompt: '你是一个友好、乐于助人的群聊AI助手。请用简洁自然的中文口语回答问题，条理清晰，长度适中，不要输出 markdown 格式符号，不要过度客套。'
  },
  cheerful: {
    label: '🎉 活泼元气',
    prompt: '你是一个活泼开朗、元气满满的群聊AI助手。语气轻松俏皮，可以适度使用颜文字（如 (｡･ω･｡)）和 emoji，说话简短有活力，像群里的开心果。用中文回答，不要输出 markdown 格式符号。'
  },
  cold: {
    label: '🧊 高冷毒舌',
    prompt: '你是一个高冷毒舌但心地不坏的群聊AI助手。回答简短犀利，偶尔吐槽和反问，带一点冷幽默，但绝不辱骂、不进行人身攻击，遇到真正需要帮助的问题仍会给出有用的答案。用中文，不要输出 markdown 格式符号。'
  },
  gentle: {
    label: '🌸 温柔治愈',
    prompt: '你是一个温柔治愈系的群聊AI助手。语气轻柔体贴、有耐心，善于倾听和安慰，回答温暖而给人鼓励，像知心朋友一样。用中文，不要输出 markdown 格式符号。'
  },
  pro: {
    label: '🎓 专业顾问',
    prompt: '你是一个严谨专业的群聊AI顾问。回答结构清晰、依据充分，涉及专业领域（技术、法律、健康等）时给出可靠信息并提醒必要时咨询专业人士，不确定时明确说明。用中文，不要输出 markdown 格式符号。'
  }
};

// ==================== 校验 ====================

// M1 修复：判断主机名是否为内网/本机地址（SSRF 防护）
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '::' || h === '0.0.0.0') return true;
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true; // IPv6 唯一本地/链路本地
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true;            // 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16/12
  if (a === 192 && b === 168) return true;            // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT 100.64/10
  return false;
}

// L3 修复：转义正则特殊字符（防御性，机器人名理论上只含中文/字母/数字/下划线）
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 校验机器人配置（apiKey 可选：本地 Ollama/LM Studio 等无需 Key；更新时留空保留旧值）
function validateBotConfig(config) {
  if (!config || typeof config !== 'object') return { ok: false, message: '参数无效' };

  const name = sanitizeString(config.name);
  if (!name) return { ok: false, message: '请填写机器人在群中显示的名称' };
  if (name.length > MAX_BOT_NAME_LEN) return { ok: false, message: `机器人名称不能超过 ${MAX_BOT_NAME_LEN} 个字符` };
  if (!isValidUsername(name)) return { ok: false, message: '名称只能包含中文、字母、数字、下划线，且不能为纯数字' };

  let apiUrl = sanitizeString(config.apiUrl);
  if (!apiUrl) return { ok: false, message: '请填写 API 地址' };
  if (apiUrl.length > MAX_API_URL_LEN) return { ok: false, message: 'API 地址过长' };
  let parsed;
  try { parsed = new URL(apiUrl); } catch { return { ok: false, message: 'API 地址格式无效' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, message: 'API 地址必须是 http(s) 协议' };
  // M1 修复：SSRF 防护——禁止机器人 API 指向内网/本机地址（BOT_ALLOW_PRIVATE_API=false 时生效）
  if (!BOT_ALLOW_PRIVATE_API && isPrivateHost(parsed.hostname)) {
    return { ok: false, message: 'API 地址不允许指向内网/本机地址' };
  }
  // 仅填主机未填路径时自动补全 OpenAI 兼容端点（如 http://127.0.0.1:11434 -> .../v1/chat/completions）
  if (!parsed.pathname || parsed.pathname === '/') {
    apiUrl = parsed.origin + '/v1/chat/completions';
  }

  const model = sanitizeString(config.model);
  if (!model) return { ok: false, message: '请填写模型名称' };
  if (model.length > MAX_MODEL_LEN) return { ok: false, message: '模型名称过长' };

  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  if (apiKey) {
    if (apiKey.length > MAX_APIKEY_LEN) return { ok: false, message: 'API Key 过长' };
    if (/\s/.test(apiKey)) return { ok: false, message: 'API Key 不能包含空白字符' };
  }

  const mood = typeof config.mood === 'string' ? config.mood : 'friendly';
  if (!MOOD_PRESETS[mood]) return { ok: false, message: '无效的情绪预设' };

  const customPrompt = typeof config.customPrompt === 'string' ? config.customPrompt.trim() : '';
  if (customPrompt.length > MAX_PROMPT_LEN) return { ok: false, message: `自定义提示词不能超过 ${MAX_PROMPT_LEN} 个字符` };
  if (customPrompt) {
    // 提示词纯文本消费，但需清理控制字符
    if (/[\x00-\x08\x0E-\x1F]/.test(customPrompt)) return { ok: false, message: '自定义提示词包含非法字符' };
  }

  return { ok: true, values: { name, apiUrl, model, apiKey, mood, customPrompt } };
}

// 校验头像 data URL：仅图片 + 大小上限 + base64 解码后魔数校验
function validateBotAvatar(dataUrl) {
  if (typeof dataUrl !== 'string') return { ok: false, message: '头像无效' };
  if (dataUrl.length > BOT_AVATAR_MAX) return { ok: false, message: '头像图片过大，请压缩后上传' };
  const m = dataUrl.match(/^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return { ok: false, message: '仅支持 png / jpg / gif / webp 图片' };
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch { return { ok: false, message: '头像数据无效' }; }
  if (buf.length < 16 || buf.length > BOT_AVATAR_MAX) return { ok: false, message: '头像数据无效' };
  const ext = m[1] === 'png' ? '.png' : (m[1] === 'gif' ? '.gif' : (m[1] === 'webp' ? '.webp' : '.jpg'));
  if (!uploadsStore.validateMagicBytes(buf, ext)) return { ok: false, message: '头像内容不是有效的图片文件' };
  return { ok: true };
}

// ==================== 下发（脱敏） ====================

function maskKey(key) {
  if (!key) return null;
  if (key.length <= 8) return '****';
  return key.slice(0, 3) + '****' + key.slice(-4);
}

// 机器人信息下发（不含 apiKey）
// L2 修复：按角色脱敏——base 字段人人可见；full=true（群主/管理员）附加 apiUrl/model/customPrompt/maskedKey
function sanitizeBot(bot, full) {
  const base = {
    id: bot.id,
    name: bot.name,
    avatar: typeof bot.avatar === 'string' ? bot.avatar : null,
    mood: bot.mood,
    moodLabel: MOOD_PRESETS[bot.mood] ? MOOD_PRESETS[bot.mood].label : '😊 默认助手',
    hasCustomPrompt: !!(bot.customPrompt && bot.customPrompt.trim()),
    createdBy: bot.createdBy,
    createdAt: bot.createdAt
  };
  if (!full) return base;
  return {
    ...base,
    apiUrl: bot.apiUrl,
    model: bot.model,
    customPrompt: typeof bot.customPrompt === 'string' ? bot.customPrompt : '',
    maskedKey: maskKey(bot.apiKey)
  };
}

function getMoodList() {
  return Object.entries(MOOD_PRESETS).map(([key, v]) => ({ key, label: v.label }));
}

// 广播群内机器人列表（增删改后调用；传 socket 则只发给该连接，用于进群时）
// L2 修复：逐连接按角色下发——普通成员收受限字段，群主/管理员收完整配置
function emitGroupBots(groupId, targetSocket) {
  const group = getGroupsData()[groupId];
  const admins = group && Array.isArray(group.admins) ? group.admins : [];
  const canManage = (username) => !!username && !!group && (username === group.owner || admins.includes(username));
  const sendTo = (socket) => {
    const full = canManage(socket.data && socket.data.authUsername);
    const bots = (group && Array.isArray(group.bots)) ? group.bots.map(b => sanitizeBot(b, full)) : [];
    socket.emit('group-bots', { bots, moods: getMoodList() });
  };
  if (targetSocket) { sendTo(targetSocket); return; }
  const socketsInRoom = io.sockets.adapter.rooms.get(groupId);
  if (socketsInRoom) {
    for (const sid of socketsInRoom) {
      const s = io.sockets.sockets.get(sid);
      if (s) sendTo(s);
    }
  }
}

// ==================== 创建 ====================

function createBot(values, creator) {
  return {
    id: 'bot_' + crypto.randomBytes(12).toString('hex'),
    name: values.name,
    avatar: values.avatar || null,
    apiUrl: values.apiUrl,
    model: values.model,
    apiKey: values.apiKey,
    mood: values.mood,
    customPrompt: values.customPrompt,
    createdBy: creator,
    createdAt: getTimeStr()
  };
}

// ==================== @提及触发与回复 ====================

const cooldowns = new Map(); // botId -> 上次回复时间戳
const busyBots = new Set();  // 处理中的 botId（单飞，防并发堆积）

// 群消息入口：检测 @提及 并触发对应机器人（由 chatEvents 调用）
function onGroupMessage(groupId, message) {
  const group = getGroupsData()[groupId];
  if (!group || !Array.isArray(group.bots) || group.bots.length === 0) return;
  if (typeof message !== 'string') return;
  const now = Date.now();
  for (const bot of group.bots) {
    if (!bot || typeof bot.name !== 'string') continue;
    // L3 修复：@提及改为词边界匹配，防止 @BotNameXyz 误触发 BotName
    const mention = escapeRegExp('@' + bot.name);
    if (!new RegExp(mention + '(?![\\w\\u4e00-\\u9fff])').test(message)) continue;
    if (busyBots.has(bot.id)) continue;                                  // 正在回复，跳过
    if (now - (cooldowns.get(bot.id) || 0) < BOT_COOLDOWN_MS) continue; // 冷却中
    cooldowns.set(bot.id, now);
    triggerBot(groupId, bot.id).catch(() => {});
  }
}

async function triggerBot(groupId, botId) {
  busyBots.add(botId);
  let bot = null;
  try {
    const group = getGroupsData()[groupId];
    if (!group || !Array.isArray(group.bots)) return;
    bot = group.bots.find(b => b.id === botId);
    if (!bot) return;

    io.to(groupId).emit('typing', `${bot.name} 🤖`);
    const messages = buildMessages(bot, historyStore.getGroupHistory(groupId));
    const reply = await callLLM(bot, messages);

    // 异步间隙可能被删除/解散，回复前重新校验
    const g2 = getGroupsData()[groupId];
    const current = g2 && Array.isArray(g2.bots) ? g2.bots.find(b => b.id === botId) : null;
    if (!current) return;

    emitBotMessage(groupId, current, reply);
  } catch (e) {
    if (bot) emitBotMessage(groupId, bot, `⚠️ ${friendlyError(e)}`);
  } finally {
    io.to(groupId).emit('stop-typing');
    busyBots.delete(botId);
  }
}

function emitBotMessage(groupId, bot, text) {
  const data = {
    username: bot.name,
    color: BOT_COLOR,
    message: text,
    time: getTimeStr(),
    bot: true,
    avatar: typeof bot.avatar === 'string' ? bot.avatar : null
  };
  historyStore.addGroupHistory(groupId, 'chat', data);
  io.to(groupId).emit('chat-message', data);
}

// 构造 LLM 上下文：system 提示词（自动注入机器人名，自定义优先，否则情绪预设）+ 最近 N 条群消息
function buildMessages(bot, history) {
  const custom = bot.customPrompt && bot.customPrompt.trim();
  const persona = custom ? custom : (MOOD_PRESETS[bot.mood] || MOOD_PRESETS.friendly).prompt;
  const name = typeof bot.name === 'string' ? bot.name.trim() : '';
  // 自动拼接身份前缀：让机器人知道自己的名字与被 @ 召唤的方式；自定义提示词也拼接，不会被覆盖
  const systemPrompt = name
    ? `你是群聊机器人「${name}」，群成员发送含 @${name} 的消息即是在向你提问。\n${persona}`
    : persona;
  const messages = [{ role: 'system', content: systemPrompt }];
  const recent = Array.isArray(history) ? history.slice(-BOT_CONTEXT_MESSAGES) : [];
  for (const entry of recent) {
    if (!entry || !entry.data) continue;
    if (entry.type === 'chat' && typeof entry.data.message === 'string' && entry.data.username) {
      if (entry.data.bot === true && entry.data.username === bot.name) {
        messages.push({ role: 'assistant', content: entry.data.message });
      } else {
        messages.push({ role: 'user', content: `${entry.data.username}: ${entry.data.message}` });
      }
    } else if (entry.type === 'file' && entry.data.file && entry.data.file.name && entry.data.username) {
      messages.push({ role: 'user', content: `${entry.data.username} 发送了文件: ${entry.data.file.name}` });
    }
  }
  return messages;
}

// 运行时补全 OpenAI 兼容端点：只填主机补 /v1/chat/completions；填了基础路径（如火山方舟 .../v3、DeepSeek .../v1）则补 /chat/completions；
// 已是完整端点则原样返回，兼容历史存量配置
function resolveApiUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!u.pathname || u.pathname === '/') return u.origin + '/v1/chat/completions';
    if (u.pathname.endsWith('/chat/completions')) return rawUrl;
    return u.origin + u.pathname.replace(/\/+$/, '') + '/chat/completions' + u.search;
  } catch {
    return rawUrl;
  }
}

// 调用 OpenAI 兼容接口（POST 端点自动补全，Bearer key，{model, messages}）
async function callLLM(bot, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOT_TIMEOUT_MS);
  try {
    const finalUrl = resolveApiUrl(bot.apiUrl);
    // M1 修复：调用时二次校验（覆盖存量配置），开关关闭时禁止请求内网地址
    if (!BOT_ALLOW_PRIVATE_API && isPrivateHost(new URL(finalUrl).hostname)) {
      throw Object.assign(new Error('blocked'), { botErr: 'private' });
    }
    const res = await fetch(finalUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(bot.apiKey ? { 'Authorization': `Bearer ${bot.apiKey}` } : {})
      },
      body: JSON.stringify({ model: bot.model, messages, max_tokens: 800, stream: false }),
      signal: controller.signal
    });
    if (!res.ok) throw Object.assign(new Error('api status'), { status: res.status, botErr: res.status === 404 ? 'notfound' : undefined });
    const data = await res.json();
    const reply = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : null;
    if (typeof reply !== 'string' || !reply.trim()) {
      throw Object.assign(new Error('empty reply'), { botErr: 'empty' });
    }
    return reply.trim().slice(0, MAX_BOT_REPLY_LEN);
  } finally {
    clearTimeout(timer);
  }
}

// 错误提示转中文，不泄露 apiKey / apiUrl 细节
function friendlyError(e) {
  if (e && e.name === 'AbortError') return '机器人请求超时了';
  if (e && e.botErr === 'empty') return '机器人返回了空回复';
  if (e && e.botErr === 'private') return '机器人 API 不允许指向内网地址';
  if (e && e.botErr === 'notfound') return '接口不存在（HTTP 404），请检查 API 地址是否正确';
  if (e && typeof e.status === 'number') return `机器人接口返回错误（HTTP ${e.status}），请检查 API 地址、Key 与模型名`;
  return '机器人调用失败，请检查 API 地址、Key 与模型名';
}

function register(newIo) {
  io = newIo;
}

module.exports = {
  register,
  BOT_COLOR,
  MOOD_PRESETS,
  validateBotConfig,
  validateBotAvatar,
  sanitizeBot,
  getMoodList,
  emitGroupBots,
  createBot,
  buildMessages,
  onGroupMessage
};
