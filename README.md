# 多人聊天室（chat-room）

基于 Node.js + Socket.IO 的实时聊天室，支持群组、AI 机器人、私信好友与聊天房间，全站 HTTPS，开箱即用。

> 个人学习项目：JSON 文件存储（未使用数据库），注重安全设计，欢迎交流指正。

## 功能特性

- **实时聊天**：Socket.IO 驱动，文字 / 图片 / 文件消息，消息历史持久化
- **群组**：创建群、管理员、黑白名单、防抖落盘（高频消息不刷爆磁盘 IO）
- **AI 机器人**：接入任意 OpenAI 兼容 API（火山方舟 / DeepSeek / 本地 Ollama 均可），支持自定义人设提示词、@提及触发、自动读取上下文
- **私信与好友**：好友关系、私信历史，注销账号时安全清理
- **聊天房间**：公开 / 私人房间，邀请码加入，私人房间元数据重启不丢
- **注册体系**：图形验证码、登录失败锁定、密码强度校验
- **文件上传**：头像与聊天附件，路径穿越校验

## 快速开始

环境要求：Node.js ≥ 18（下载：https://nodejs.org/）

```bash
# 1. 克隆
git clone https://github.com/你的用户名/chat-room.git
cd chat-room

# 2. 安装依赖（或直接双击 启动聊天室.bat，会自动执行本步）
npm install

# 3. 启动
node server.js
```

Windows 用户最简单的方式：**双击 `启动聊天室.bat`**——自动装依赖、自动启动。

启动后访问 `https://localhost:3001`（HTTP 3000 会自动跳转 HTTPS）。
首次运行会自动生成自签名证书，浏览器提示证书警告时选择"继续访问"即可。

## 安全设计

- **密码**：bcrypt 12 轮哈希 + 常量时间比较（防时序攻击）
- **限流**：HTTP 层与 Socket 层双层限流；邀请码错误 10 次锁定 10 分钟
- **XSS**：消息内容全量 HTML 转义
- **SSRF**：机器人 API 地址双重校验，默认禁止指向内网（可配置 `BOT_ALLOW_PRIVATE_API`）
- **权限脱敏**：机器人 apiUrl / model / 密钥打码仅群主与管理员可见，apiKey 永不下发
- **数据完整**：原子写盘 + 文件锁，写盘中途断电不留半截文件
- **HTTPS**：自签名叶子证书（cA=false），首次启动自动生成，私钥永不出现在仓库中

## 项目结构

```
chat-room/
├── server.js           # 入口：HTTPS 服务 + HTTP 跳转
├── config/             # 常量配置
├── routes/             # HTTP 路由（注册登录 / 验证码 / 上传）
├── middleware/         # CORS、限流、安全头、错误处理
├── security/           # 认证、验证码、证书生成
├── socket/             # Socket.IO 认证与限流
├── chat/  groups/  rooms/  friends/   # 聊天 / 群组与机器人 / 房间 / 好友与私信
├── storage/            # JSON 数据存储层（用户 / 群 / 历史 / 私信）
└── utils/              # 原子写盘、消息净化、失败锁定
```

## 技术栈

Node.js · Express · Socket.IO · bcryptjs · node-forge · 原生 HTML/JS 前端（零构建）

## 已知边界

- JSON 文件存储，适合小规模自用与学习，不适合大规模生产部署
- 自签名证书需手动信任，公网部署建议换正式证书并关闭 `BOT_ALLOW_PRIVATE_API`
- 未包含自动化测试

## License

MIT
