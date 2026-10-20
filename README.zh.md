# dsh-bridge

把 **Pi Coding Agent** 的会话桥接进 **DeepSeek Harness (dsh)** Web UI。

当前仓库只实现 **Pi 桥接**：dsh 的 Host 插件列出 Pi 会话、按需启动
`pi --mode rpc` 子进程、把 Pi 事件通过 SSE 推给浏览器，并把提问、steer、
abort、扩展对话框回传给 Pi。

## 状态

- [x] 读取 Pi 会话文件（`~/.pi/agent/sessions/**/*.jsonl`）
- [x] 当前分支还原、tool call 提取、列表摘要
- [x] 附加到 Pi RPC 进程
- [x] 事件广播与 prompt / steer / abort 路由
- [x] dsh 浏览器面板（Pi Sessions 主面板 + 侧栏入口）
- [x] 安装进 dsh web profile

## 工作方式

```text
Browser
  └─ dsh web
       └─ @gitsang/dsh-bridge（Host 插件）
            ├─ session-store.js   只读扫描 Pi JSONL
            └─ pi-attachment.js   spawn `pi --mode rpc --session <file>`
                 │ stdin/stdout JSONL
                 ▼
            Pi Coding Agent
```

Pi 的 RPC 模式是稳定集成点：stdin 收 JSON 命令，stdout 发响应和事件。
桥接层从不直接写 session 文件，因此不会破坏 Pi 的 branch 结构。

## Host 路由

所有路由都在 dsh 已鉴权的 `/api` 下，自动继承 Host/Origin 校验和浏览器
会话 Cookie。

| 路由 | 用途 |
| --- | --- |
| `GET /api/pi-bridge/sessions` | 列出 Pi 会话（只读 JSONL 摘要） |
| `GET/PUT /api/pi-bridge/settings` | 读取或修改桥接后端与 Pi 设置 |
| `GET /api/pi-bridge/session?key=…` | 单个会话及当前分支历史 |
| `GET /api/pi-bridge/capabilities` | 协议版本与当前 attachment 表 |
| `POST /api/pi-bridge/attach` | 启动 `pi --mode rpc --session <file>` |
| `POST /api/pi-bridge/detach` | 关闭该 Pi 子进程 |
| `GET /api/pi-bridge/state?key=…` | `get_state` 快照 |
| `GET /api/pi-bridge/events?key=…` | Pi 事件与扩展 UI 的 SSE 流 |
| `POST /api/pi-bridge/prompt` | 提问、steer、follow up |
| `POST /api/pi-bridge/abort` | 中断当前回复 |
| `POST /api/pi-bridge/ui-response` | 回复阻塞式扩展对话框 |
| `GET /api/pi-bridge/models?key=…` | 模型目录 |
| `GET /api/pi-bridge/history-message?key=…` | 纯文本历史 |

会话 key 是绝对 JSONL 路径的 base64url 编码；Host 会拒绝解析到 Pi 会话根目录
之外的 key。

## 界面

侧栏按钮是 **Bridge**，右侧齿轮打开桥接设置：切换后端（目前仅 Pi）、指定
会话根目录、指定 Pi 可执行文件、开关离线启动。面板复用 dsh 自己的
`dsh-client-ui-primitives`、`--dsw-*` token、Markdown 渲染和输入卡片样式。

设置保存在 `$DSH_HOME/pi-bridge.json`（0600）；有 Pi 子进程附加时 Host 会
拒绝修改后端或会话根目录。

## 安装

```bash
dsh plugin --profile web add github:gitsang/dsh-bridge
dsh web
```

重启后侧栏会出现 **Pi Sessions**。

## 配置

环境变量：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PI_BIN` | 自动探测 | 探测顺序：`$PI_CODING_AGENT_DIR/bin/pi`、`~/.pi/agent/bin/pi`、dsh 可见的 `@earendil-works/pi-coding-agent`、`PATH` 上的 `pi` |
| `PI_BRIDGE_OFFLINE` | `1` | 附加的 Pi 以 `PI_OFFLINE=1` 启动，避免启动时安装包或写 agent 目录；设为 `0` 可允许联网启动 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi 配置目录 |
| `PI_CODING_AGENT_SESSION_DIR` | `$PI_CODING_AGENT_DIR/sessions` | 会话根目录 |

## 已知限制

- 同一 Pi 会话同时只允许一个写入者。dsh 会 attach 一个受管子进程；已有 Pi
  TUI 正在写同一个文件时不要再次 attach。
- 浏览器面板是独立渲染器，不复用 dsh 原生 Conversation；工具调用先以卡片
  形式展示。
- 扩展 UI 的 blocking dialog 已支持；TUI 专属组件（`ctx.ui.custom`）在 RPC
  模式下不可用，这是 Pi 自身的限制。

## 开发

```bash
npm test
```

## License

MIT
