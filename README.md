# 多人聊天室（chat-room · SQLite 版）

基于 Node.js + Socket.IO 的实时聊天室，支持群组、AI 机器人、私信好友与聊天房间，全站 HTTPS，开箱即用。

> 个人学习项目：本分支使用 **SQLite 数据库存储**（sql.js，纯 JS 零编译，无需安装数据库软件），注重安全设计，欢迎交流指正。

## 功能特性

- **实时聊天**：Socket.IO 驱动，文字 / 图片 / 文件消息，消息历史持久化

- **SQLite 存储**：6 张表统一管理用户 / 群组 / 群聊历史 / 私信 / 房间 / 好友关系，写入事务化，落盘 2 秒防抖 + 临时文件原子替换（高频消息不刷爆磁盘 IO）

- **防 SQL 注入**：全部查询走参数化绑定（`?` 占位符），用户输入永不拼接进 SQL 文本

- **AI 机器人**：接入任意 OpenAI 兼容 API（火山方舟 / DeepSeek / 本地 Ollama 均可），支持自定义人设提示词、@提及触发、自动读取上下文

- **私信与好友**：好友关系、私信历史，注销账号时安全清理

- **聊天房间**：公开 / 私人房间，邀请码加入，私人房间元数据重启不丢

- **注册体系**：图形验证码、登录失败锁定、密码强度校验

- **文件上传**：头像与聊天附件，路径穿越校验

## 快速开始

环境要求：Node.js ≥ 18（下载：<https://nodejs.org/）>

```bash
# 1. 克隆并切到本分支
git clone -b sqlite https://github.com/liteae/chatroom.git
cd chatroom

# 2. 安装依赖（或直接双击 启动聊天室.bat，会自动执行本步）
npm install

# 3. 启动
node server.js
```

Windows 用户最简单的方式：**双击** **`启动聊天室.bat`**——自动装依赖、自动启动。

启动后访问 `https://localhost:3001`（HTTP 3000 会自动跳转 HTTPS）。
首次运行会自动生成自签名证书，浏览器提示证书警告时选择"继续访问"即可。
数据落盘为单文件 `data/chatroom.db`，删除它即重置全部数据。

## 安全设计

- **密码**：bcrypt 12 轮哈希 + 常量时间比较（防时序攻击）

- **限流**：HTTP 层与 Socket 层双层限流；邀请码错误 10 次锁定 10 分钟

- **XSS**：消息内容全量 HTML 转义

- **SSRF**：机器人 API 地址双重校验，默认禁止指向内网（可配置 `BOT_ALLOW_PRIVATE_API`）

- **权限脱敏**：机器人 apiUrl / model / 密钥打码仅群主与管理员可见，apiKey 永不下发

- **防注入**：SQL 全部参数化查询；写操作走事务，失败自动回滚

- **数据完整**：防抖落盘 + 临时文件原子替换，写盘中途断电不留半截文件

- **HTTPS**：自签名叶子证书（cA=false），首次启动自动生成，私钥永不出现在仓库中

## 项目结构

```
chat-room/
├── server.js           # 入口：SQLite 初始化 → HTTPS 服务 + HTTP 跳转
├── config/             # 常量配置
├── routes/             # HTTP 路由（注册登录 / 验证码 / 上传）
├── middleware/         # CORS、限流、安全头、错误处理
├── security/           # 认证、验证码、证书生成
├── socket/             # Socket.IO 认证与限流
├── chat/  groups/  rooms/  friends/   # 聊天 / 群组与机器人 / 房间 / 好友与私信
├── storage/            # SQLite 存储层（db.js 引擎 + 各数据表读写）
└── utils/              # 原子写盘、消息净化、失败锁定
```

## 技术栈

Node.js · Express · Socket.IO · sql.js（WebAssembly 版 SQLite）· bcryptjs · node-forge · 原生 HTML/JS 前端（零构建）

## 与 main 分支的区别

| <br />    | main              | 本分支（sqlite）                       |
| --------- | ----------------- | --------------------------------- |
| 存储方式      | JSON 文件（每类数据一个文件） | SQLite 单文件数据库（`data/chatroom.db`） |
| 额外依赖      | 无                 | sql.js（纯 JS，npm 自动安装，无需编译）        |
| 存储层对外 API | 完全一致              | 完全一致（事件层零改动）                      |
| 崩溃恢复      | 防抖窗口内可能丢最近几秒写入    | 同左（内存库 + 防抖整库落盘）                  |

两个分支功能等价，按喜好选用：想看"零依赖纯文件"的写法用 main，想看"SQL 表设计与参数化查询"的写法用本分支。

## 已知边界

- sql.js 为内存数据库 + 整库落盘，数据量非常大时内存占用会上升

- 自签名证书需手动信任，公网部署建议换正式证书并关闭 `BOT_ALLOW_PRIVATE_API`

- 未包含自动化测试

## 开源

- 仓库地址：<https://github.com/liteae/chatroom>

- 觉得有用的话欢迎点个 Star ⭐

- 发现 Bug 或有建议，欢迎提交 [Issue](https://github.com/liteae/chatroom/issues)

- 欢迎 Fork 与 PR，一起改进这个项目

## License

本项目基于 [MIT License](LICENSE) 开源——可自由使用、修改、分发（含商用），仅需保留版权声明。
