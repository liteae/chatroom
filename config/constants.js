// 全局常量集中配置
module.exports = {
  PORT: 3000,

  // 容量上限
  MAX_HISTORY: 500,              // 房间/群历史最大条数
  MAX_USERS: 1000,               // 最大注册用户数
  MAX_GROUPS: 500,               // 最大群组数
  MAX_SESSIONS: 5000,            // 最大会话数

  // 连接与事件限流
  MAX_CONNECTIONS_PER_IP: 50,
  MAX_SOCKET_EVENTS_PER_MINUTE: 200,
  MAX_TOTAL_CONNECTIONS: 500,

  // 历史记录字节上限（H1：防内存放大 DoS）
  ROOM_HISTORY_MAX_BYTES: 5 * 1024 * 1024,
  GROUP_HISTORY_MAX_BYTES: 5 * 1024 * 1024,
  GROUP_HISTORY_CACHE_MAX: 20,

  // 私聊（好友模块）
  MAX_FRIENDS: 200,
  MAX_BLACKLIST: 500,
  MAX_PENDING: 50,
  MAX_PM_HISTORY: 500,
  PM_IMAGE_MAX: 2 * 1024 * 1024,
  PM_IMAGE_HISTORY_MAX: 512 * 1024,
  PM_HISTORY_MAX_BYTES: 5 * 1024 * 1024,
  PM_CACHE_MAX_PAIRS: 20,

  // 群 AI 机器人
  MAX_BOTS_PER_GROUP: 10,           // 每群最大机器人数
  MAX_BOT_NAME_LEN: 12,             // 机器人名称长度上限（同用户名，防冒充歧义）
  MAX_API_URL_LEN: 300,             // API 地址长度上限
  MAX_MODEL_LEN: 60,                // 模型名称长度上限
  MAX_APIKEY_LEN: 200,              // API Key 长度上限
  MAX_PROMPT_LEN: 2000,             // 高级自定义提示词长度上限
  BOT_AVATAR_MAX: 128 * 1024,         // 机器人头像 data URL 长度上限（前端压缩，约96KB图片）
  BOT_ALLOW_PRIVATE_API: true,        // 允许机器人 API 指向内网/本地地址（本地 Ollama 等需要）；设为 false 可封禁 SSRF 攻击面
  BOT_TIMEOUT_MS: 90000,            // 机器人 API 调用超时（本地大模型推理较慢，放宽到 90 秒）
  BOT_CONTEXT_MESSAGES: 20,         // 机器人可见的上下文消息条数
  BOT_COOLDOWN_MS: 5000,            // 单个机器人回复冷却（防刷 API）
  MAX_BOT_REPLY_LEN: 2000           // 机器人回复最大长度
};
