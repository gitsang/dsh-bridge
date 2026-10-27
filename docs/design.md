# dsh-bridge v2: 多 Host Path-Prefix 网关

## 目标

- 每个 bridge 是一个完整的 dsh Host，而不是 bridge 面板里的自定义会话。
- 浏览器只加载 dsh 原生 Web：原生 Conversation、原生 composer、原生 Lexical keymap。
- 切换 bridge 不 reload；多个 backend 可同时存活。
- bridge 不读取、不感知 dsh-qol 配置。dsh-qol 在原生 composer 上天然生效。
- 后端选择只由 URL path 决定，不使用自定义 header 或 query。

## 非目标

- 不在一个 dsh 页面内合并多个 Host 的 session 列表或事件流。
- 不继续维护 bridge 自己的 transcript / composer / engine event 渲染。
- 不实现按单个 session 跨 Host 路由。
- 不为 Pi / Codex 模拟 dsh `/api/bridge/*`；它们必须接入原生 Session API。

## 拓扑

```text
Browser
  /                          gateway shell
  /b/<bridge-id>/            完整 dsh Web Host
  /b/<bridge-id>/api/...     HTTP Remote RPC
  /b/<bridge-id>/api/remote.mux
                              WebSocket mux
  /b/<bridge-id>/plugins/... client plugin bundles
  /b/<bridge-id>/assets/...  hashed assets
```

Gateway 是唯一 origin。每个 backend 是独立进程或独立 Host，只监听 loopback。

## 路径契约

- 规范 mount 为 `/b/<id>/`，必须以 `/` 结尾。
- `/b/<id>` 301 到 `/b/<id>/`。
- Gateway 转发前剥掉 `/b/<id>`，upstream 看到的仍是根路径 `/`。
- upstream 返回的绝对 `Location` 重写回 `/b/<id>/...`。
- 页面相对 URL 由 dsh 自带的 `<base href="./">` 固定到 mount 目录。
- `api/...`、`api/remote.mux`、`plugins/...`、`assets/...` 全部自然落在 prefix 下，无需改 dsh 前端。
- `<id>` 为稳定 slug：`[a-z0-9][a-z0-9-]*`，创建后不可改名。

示例：

```text
/b/pi/api/session/list   -> upstream /api/session/list
/b/pi/api/remote.mux     -> upstream /api/remote.mux (WebSocket)
```

同一个前端 build 服务所有 backend。

## Gateway Shell

- `/` 是 gateway 自己的轻量 shell：backend 列表、状态、创建/编辑、打开。
- 每个 backend 用 iframe 加载 `/b/<id>/`。
- iframe 首次选中时创建，之后保持挂载；切换只切 active/visibility。
- 每个 iframe 内有独立的 `ctx.connection`、`ctx.remote`、`ctx.sessions`、Session/Workspace 状态和 WebSocket。
- 直接访问 `/b/<id>/` 与 iframe 内行为一致。
- backend 重启或版本升级时只 reload 对应 iframe。
- 多标签页可直接开不同 `/b/<id>/`，互不影响。

同源 iframe 共享 `localStorage`。主题、宽度、dsh-qol 的 Enter 偏好等用户偏好跨 backend 共享；Host 私有状态不写 `localStorage`，由各 Host 自己持久化。

## Backend 契约

每个 backend 必须是完整、协议兼容的 dsh Host：

- `session/list`、`session/follow`、`session/control`、`session/page`
- `session/prompt`、`session/cancel`、`session/updateQueue`
- `session/selectModel`、`session/projections`
- `session/create`、`session/rename`、`session/fork`
- `workspace/*`、`skills/*`、`fileReferences/*`
- `/api/remote.mux`

要求：

- 与 gateway shell 使用同一 dsh 版本、同一 client plugin 集合、同一 Typert 生成物。
- backend 产生原生 dsh `SessionWireEvent`、projection baseline/frame、turn/step 语义。
- backend 自己拥有 Agent 生命周期、writer lock、队列和持久化。
- gateway 只做路由、认证和进程监督，不翻译业务事件。

启动时 GET 后端 `/`，读取 `x-dsh-version` 做可选版本握手。配置了 `health.version` 且不匹配时，backend 标记为 `incompatible` 并拒绝挂载 iframe。dsh 当前不发送该响应头；未配置版本时记为 `unknown`，不阻止挂载。

## Engine 接入

| engine | backend |
| --- | --- |
| native | 现成 dsh Host |
| remote-dsh | 远端 dsh Host，gateway 作为反向代理 |
| pi | 专用 dsh Host + Pi Session/Agent adapter |
| codex | 专用 dsh Host + Codex Session/Agent adapter |
| opencode | 专用 dsh Host + OpenCode Session/Agent adapter |

Pi / Codex / OpenCode adapter 的职责是：

1. 发现、创建、恢复外部 session。
2. 将外部 turn/step、message、tool、usage 映射为 dsh Session 事件。
3. 维护 dsh projection（title、todos、inbox、model、sessionListMetadata 等）。
4. 接收 `session/prompt`、`session/cancel`、`session/updateQueue` 并驱动外部 agent。
5. 提供 dsh 原生模型选择与历史分页。

adapter 不存在时，对应 engine 只有 `unavailable` 状态，不提供假 API。

## 认证与转发

- 浏览器只向 Gateway 认证；Gateway 签发自己的 session cookie。
- Gateway 为每个 backend 保存上游 dsh 浏览器凭证。
- 转发 HTTP 和 WebSocket upgrade 时：
  - 把 `Host`、`Origin`、`Referer` 重写为该 backend 的 loopback authority；
  - 丢弃浏览器带来的上游 `dsh-auth-*` cookie；
  - 注入该 backend 对应的上游 cookie。
- Gateway 在 backend 启动后用 launch token 交换上游 cookie，并随 backend 重启刷新。
- backend 只绑定 loopback，不直接暴露给浏览器。
- 客户端不能通过 header 或 query 选择 backend。

## 配置

`$DSH_HOME/bridge-v2.json`，版本化、原子写入、0600：

```json
{
  "version": 1,
  "bridges": [
    {
      "id": "pi",
      "name": "Work Pi",
      "engine": "pi",
      "autostart": true,
      "upstream": { "command": "dsh", "args": ["web", "--profile", "pi"], "cwd": "/work" },
      "health": { "timeoutMs": 15000, "version": "2.0.0" }
    },
    {
      "id": "native",
      "name": "Local",
      "engine": "native",
      "upstream": { "url": "http://127.0.0.1:3080" }
    }
  ]
}
```

`upstream` 二选一：`url` 连接外部 Host，或 `command` 由 Gateway 监督启动。密钥只存 credential reference 或环境变量。

## 生命周期

```text
stopped -> starting -> ready -> stopping -> stopped
                     \-> failed
```

- Gateway 启动后按 `autostart` 启动或连接 backend。
- `ready` 后才允许 iframe 挂载。
- 未 ready 的 mount 返回 gateway 自己的状态页或 503。
- backend 崩溃后自动重启，指数退避，保留同一 bridge id。
- 重启会废弃该 backend 的旧连接；对应 iframe reload，其他 iframe 不受影响。
- backend 停止时关闭其所有 HTTP/WS 连接。

## 请求流程

1. `GET /` -> gateway shell。
2. shell 创建 iframe `/b/pi/`。
3. Gateway 代理到 Pi Host `/`，返回 dsh index。
4. 浏览器按 `<base href="./">` 请求 `/b/pi/assets/...`、`/b/pi/plugins/...`。
5. dsh 前端请求 `/b/pi/api/session/list`；Gateway 剥前缀并注入上游凭证。
6. dsh 前端连接 `/b/pi/api/remote.mux`；Gateway 代理 WebSocket upgrade，保持整条 mux 属于同一个 Host。
7. 切换 bridge 只切 iframe active 状态。

## 迁移

- v1 的 `BridgePage`、自定义 transcript、自定义 composer、`/api/bridge/*` 不再保留。
- v1 `bridge.json` 的 bridge 实例迁移为 v2 backend 配置。
- Pi JSONL、workspace 映射、archive 状态继续由 Pi Host adapter 读取。
- v1 session key 不进入浏览器；浏览器只看到各 Host 自己的原生 session id。
- dsh-qol 无需迁移，安装在后端 dsh Host 的 web profile 中即可。

## 验收

- 在 `/b/pi/` 内安装 dsh-qol，开启 Enter 换行 / Ctrl+Enter 发送；bridge 代码无任何 dsh-qol 分支，行为正确。
- `/b/pi/api/remote.mux` 与 `/b/pi/api/session/*` 都命中 Pi Host。
- 两个 backend iframe 同时运行，切换不 reload，各自保持连接和选中会话。
- 同一 backend 多标签页互不干扰。
- backend 崩溃只影响自己的 iframe。
- 直接访问 `/b/<id>/`、刷新、深层 API 路径都保持 mount 前缀。

## 已实现范围

| 文件 | 职责 |
| --- | --- |
| `src/gateway.js` | HTTP 服务、认证、shell、管理 API、mount 调度 |
| `src/proxy.js` | path-prefix HTTP 代理、WebSocket 隧道、header/cookie/redirect 改写 |
| `src/auth.js` | scrypt 密码、滚动 session、cookie 过滤、登录页 |
| `src/upstream-auth.js` | 兑换后端 dsh launch token 并托管 `dsh-auth-*` |
| `src/backends.js` | URL/command/self 三类 upstream、健康检查、版本检查、进程监督、自动重启 |
| `src/config.js` | `bridge-v2.json` 校验、原子写入、增删改 |
| `src/shell.js` | bridge 列表、管理面板、常驻 iframe |
| `src/index.js` | Cordis bundle 入口 |

管理 API（均经过 gateway 登录）：

```text
GET    /__bridge/state
POST   /__bridge/bridges
PUT    /__bridge/bridges/<id>
DELETE /__bridge/bridges/<id>
POST   /__bridge/bridges/<id>/restart
```

`GET /__bridge/state` 不返回 upstream token；URL 中的 `token` 查询参数改写为
`***`。

认证重试：

- HTTP：上游 401 + `dsh web authentication required` 时刷新 cookie 并重放请求体一次。
- WebSocket：握手返回 401 时刷新 cookie 并重新握手一次。
- 大于 2 MiB 的请求体直接流式转发，不做重放。

测试：

```bash
npm test
```

覆盖配置、认证、代理、WebSocket、cookie 托管、版本检查、进程监督和管理 API。
