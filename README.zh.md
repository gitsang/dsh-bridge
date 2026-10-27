# dsh-bridge

把多个**完整的 DeepSeek Harness Host** 放在同一个认证过的 path-prefix 网关后面。
每个 bridge 打开的是原生 dsh Web，而不是重新实现一套会话界面。

```text
Browser
  /                          bridge shell
  /b/native/                 本机 dsh Host
  /b/pi/                     由 Pi 驱动的 dsh Host
  /b/codex/                  由 Codex 驱动的 dsh Host
```

每个 mount 里都是 dsh 自己的 Conversation、composer、Lexical keymap、
Session API、插件和设置。bridge 只由 URL path 选择，所以 HTTP RPC 和
`/api/remote.mux` WebSocket 永远落在同一个 Host 上，不需要自定义 header
或 query。`dsh-qol` 这类原生 composer 插件因此天然生效，bridge 没有任何
插件专用代码。

## 为什么是网关

dsh Web 不只是一组 REST endpoint。它的客户端为每个 Host 维护一套 Session
输入机、连接 generation 和 remote mux。要正确复用它，必须整 Host 路由，
而不是按 session 路由。

- `GET /b/<id>/` -> upstream `/`
- `GET /b/<id>/api/...` -> upstream `/api/...`
- `WS /b/<id>/api/remote.mux` -> upstream `/api/remote.mux`
- `GET /b/<id>/plugins/...` -> upstream `/plugins/...`
- `GET /b/<id>/assets/...` -> upstream `/assets/...`

dsh 自带的 `<base href="./">` 会让前端所有相对 URL 落在 mount 下。网关转发前
剥掉前缀，并把上游的绝对重定向改写回 mount。

## Backend 契约

backend 必须是真实的 dsh Host，实现原生 Remote API：

- `session/list`、`session/follow`、`session/control`、`session/page`
- `session/prompt`、`session/cancel`、`session/updateQueue`
- `session/selectModel`、`session/projections`
- `session/create`、`session/rename`、`session/fork`
- `workspace/*`、`skills/*`、`fileReferences/*`
- `/api/remote.mux`

网关不翻译 Pi、Codex、OpenCode 事件。这些 engine 需要一个 dsh Host
adapter，把外部会话和活动映射成原生 dsh Session 事件与 projection。
adapter 不存在时 engine 就是 unavailable，网关不会伪造兼容 API。

backend 应与网关使用相同的 dsh 版本和 client 插件构建。可选的
`health.version` 会让网关拒绝版本不匹配的 Host，而不是挂载不兼容前端。

## 安装

```bash
dsh plugin --profile web add github:gitsang/dsh-bridge
dsh web
```

网关默认监听下一个本地端口并打印 URL。默认 bridge 是 `native`，代理加载
该插件的同一个 dsh web server。

## 配置

`$DSH_HOME/bridge-v2.json`，权限 `0600`：

```json
{
  "version": 1,
  "bridges": [
    {
      "id": "native",
      "name": "Local",
      "engine": "native",
      "autostart": true,
      "upstream": { "self": true }
    },
    {
      "id": "pi",
      "name": "Work Pi",
      "engine": "pi",
      "autostart": true,
      "upstream": {
        "command": "dsh",
        "args": ["web", "--profile", "pi"],
        "cwd": "/work"
      },
      "health": { "version": "2.0.0" }
    },
    {
      "id": "remote",
      "name": "Build Box",
      "engine": "dsh",
      "upstream": {
        "url": "http://127.0.0.1:3090/?token=..."
      }
    }
  ]
}
```

`upstream` 三选一：

- `{ "self": true }` — 承载本插件的 dsh web server。
- `{ "url": "..." }` — 已运行、loopback 可达的 dsh Host。
- `{ "command": "...", "args": [] }` — 由网关监督启动的子 dsh Host，
  从 stdout/stderr 发现它打印的 URL。

bridge id 是不可变的小写 slug，匹配 `[a-z0-9][a-z0-9-]*`。`native`
不能删除。

环境变量：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `DSH_BRIDGE_HOST` | `127.0.0.1` | 网关监听地址 |
| `DSH_BRIDGE_PORT` | dsh web 端口 + 1 | 网关端口 |
| `DSH_BRIDGE_DATA_DIR` | `$DSH_HOME/profiles/bridge-v2` | 密码和会话存储 |
| `DSH_BRIDGE_CONFIG` | `$DSH_HOME/bridge-v2.json` | bridge 配置文件 |
| `DSH_BRIDGE_AUTH` | `1` | 仅测试时设为 `0` |

## 认证

- 网关自己使用 scrypt 哈希密码和 24 小时滚动 session。
- dsh 绑定 authority 的 `dsh-auth-*` cookie 不会到浏览器。网关在服务端
  兑换每个 backend 的 launch token，并在代理 HTTP 和 WebSocket upgrade 时
  注入对应 Host 的 cookie。
- backend 只监听 loopback，不直接暴露。
- bridge 只由 URL path 选择；没有请求 header 或 query 指定 backend。

## Shell

`/` 是轻量管理 shell。bridge 列表显示实时就绪状态。选中后用 `/b/<id>/`
的持久 iframe 显示；之前打开的 bridge 保持挂载，所以切换不会 reload 或
丢失 Session 状态。多个标签页可以分别打开不同 mount。

用 **Manage bridges** 添加、编辑、重启或删除 backend。也可以直接编辑 JSON
文件，重启网关后生效。

## 测试

```bash
npm test
```

覆盖配置校验、密码/会话存储、path-prefix 与 WebSocket 代理、上游 cookie
托管、backend 健康与版本检查、进程监督和管理 API。
