# dsh-bridge

把外部 coding agent 的会话桥接进 **DeepSeek Harness (dsh)** Web UI。

Bridge 采用**实例模型**：用户可以先创建多个已保存的桥接，每个桥接有自己的
名称、传输模式、引擎和配置。同一个引擎可以对应多个桥接，比如两个 Pi 桥接分别
指向不同的 Session 根目录。左上角 dsh 图标的下拉框固定保留 **本机**（原生 dsh
对话），并列出所有已配置桥接；选择某个桥接后，侧边栏和右侧对话区会一起切换到
该桥接。

Pi 是第一个完整支持的引擎。Codex、OpenCode、远程 DSH 会出现在新增桥接表单里，
在适配器接入前明确标记为暂不可用。

## 当前状态

- [x] 桥接实例模型（`bridges[]`，不再是全局“当前后端”）
- [x] 同一引擎可配置多个桥接，各自独立配置
- [x] 设置悬浮层内新增 / 编辑 / 删除桥接
- [x] CLI / Web 模式与按模式过滤的引擎列表
- [x] Pi 引擎完整可用：JSONL 会话、RPC attach、事件归一化、prompt
- [x] 左上角「本机 + 已配置桥接」下拉框，带实时连接状态点
- [x] 启动自动连接：每个桥接预热最新会话
- [x] 选中桥接后由侧边栏直接展示该桥接的工作区 / 会话
- [x] 与 dsh Web 一致的侧边栏浏览器：按工作区 / 工作区树 / 单列表分组、手动 / 最近更新排序、会话筛选
- [x] dsh 风格搜索按钮与结果列表
- [x] dsh 风格“选择工作区目录”弹窗，可新建文件夹并加入工作区
- [x] dsh 风格对话界面与 composer
- [x] composer 模型选择器与 dsh 风格 statusline（轮次/步数、Token、缓存命中）
- [ ] Codex 引擎适配器
- [ ] OpenCode 引擎适配器
- [ ] 远程 DSH Web 引擎适配器

## 交互

### 左上角切换器

点击左上角 dsh 品牌图标展开：

```text
本机                      回到 DeepSeek Harness
────────────────────────────────────────────────────
工作 Pi                   CLI · Pi
临时 Pi                   CLI · Pi
公司 Codex                CLI · Codex          （适配器待接入）
Bridge 设置
```

- **本机**：回到 dsh 原生对话，同时恢复原生侧边栏。
- 每个已配置桥接都是独立一行；同一个引擎出现多行是正常的。
- 每个桥接右侧有状态点：绿色=已连接、橙色=正在连接、红色=连接失败；悬停可看原因。
- 未接入的引擎仍然展示，但不可选择。
- **Bridge 设置**：在当前页面上悬浮打开设置弹窗，不跳转页面。

### 连接生命周期

dsh Host 启动时会自动连接所有已配置桥接。对 Pi 来说：

1. 探测可执行文件和 Session 根目录；
2. 列出该桥接的会话；
3. 用 Pi RPC 连接最新会话，并保持该进程存活。

`GET /api/bridge/status` 返回每个桥接的连接状态，下拉框打开时会轮询刷新。
连接断开后状态点变红；重新检测或再次 attach 会恢复绿色。设置
`BRIDGE_AUTO_CONNECT=0` 可以关闭自动连接，恢复按需连接。

### 设置悬浮层

设置弹窗左侧是导航，右侧是内容：

- **管理桥接**：列出已配置桥接，可新增、编辑、删除。
- 新增桥接：
  - **桥接模式**：CLI / Web
  - **引擎**：
    - CLI → Pi、Codex、OpenCode
    - Web → DSH
  - 不同引擎展示不同配置项。Pi 当前包括：
    - Session 根目录
    - Bin 地址
    - 离线启动
  - DSH 包括服务地址和访问令牌。令牌不会出现在 API 响应里；编辑时留空会保留原值。

### 选中桥接后

1. 打开 Bridge 主面板；
2. 用一个 `sidebar.workspaces` occupant 替换原生工作区浏览器，展示该桥接的
   工作区 / 会话树。该浏览器复用 dsh 的 `dsh-client-ui-primitives`、视觉令牌与
   行高 / 图标 / 菜单规格，支持按工作区、工作区树、单列表分组，手动排序与最近
   更新排序，归档筛选，搜索按钮和目录选择弹窗；
3. 右侧加载会话历史；
4. composer 和实时流继续绑定该桥接。

composer 采用 dsh 的停靠卡片规格（`--dsh-composer-*` 尺寸、面板圆角、输入
surface 和阴影）。右下角控制行包含：

- **模型选择器**：读取当前 attachment 的模型目录，按 provider 分组，切换时
  调用引擎原生的 `set_model` RPC；
- 圆形**发送**按钮，agent 运行时切换为**停止**。

卡片下方是仿 dsh 的 statusline：仪表盘 pill 展示轮次/步数，数据库 pill 展示
总 Token 与缓存命中率；点击可展开同款详情面板。Bridge 的统计来自引擎的
`get_session_stats` RPC，不支持统计的引擎则回退到对话记录汇总。这里是视觉
与交互对齐，而不是复用 dsh 的 session projection：外部 agent 有自己的会话模型。

选择 **本机** 后释放 Bridge 侧边栏 occupant，恢复 dsh 原生侧边栏。

## 架构

```text
Browser (dsh web)
  ├─ 品牌下拉框 ───────────> GET /api/bridge/settings
  ├─ Bridge 设置悬浮层 ────> POST/PUT/DELETE /api/bridge/bridges
  └─ Bridge 主面板 ────────> GET /api/bridge/sessions?bridge=<id>
                              /api/bridge/{session,attach,prompt,events,…}

Host bridge core
  ├─ 桥接实例存储（bridge.json）
  ├─ 引擎注册表（Pi / Codex / OpenCode / DSH）
  ├─ 不透明 key（`bridgeId.base64url(nativeKey)`）
  └─ 通用 attachment + SSE 生命周期

Engine adapters
  ├─ Pi（已实现）
  ├─ Codex（待接入）
  ├─ OpenCode（待接入）
  └─ DSH（待接入）
```

Host 只在 `src/backends/registry.js` import 具体适配器；浏览器不 import 任何
引擎或 CLI 实现。

### 引擎适配器契约

| 成员 | 作用 |
| --- | --- |
| `id`, `label`, `mode` | 身份与 `cli`/`web` 传输类型 |
| `available`, `unavailableReason` | 未完成适配时如实显示状态 |
| `capabilities` | UI 可开放的能力 |
| `configFields`, `defaultConfig()` | 新增/编辑表单字段 |
| `listSessions(config, env)` | 工作区 / 会话摘要 |
| `readSession(nativeKey, config, env)` | 归一化历史 |
| `createAttachment({session, config, env})` | 实时 agent 句柄 |
| `normalizeEvent(nativeEvent)` | 原生事件 → Bridge 事件 |

统一事件为 `agent-start`、`agent-end`、`message-start`、`message-update`、
`message-end`、`tool-start`、`tool-update`、`tool-end`、`session-name`、
`backend-event`。

## Host 路由

| 路由 | 用途 |
| --- | --- |
| `GET /api/bridge/settings` | 模式、引擎和脱敏后的桥接列表 |
| `GET/POST/PUT/DELETE /api/bridge/bridges` | 管理桥接 |
| `GET/POST /api/bridge/status` | 读取或刷新每个桥接的连接状态 |
| `GET /api/bridge/sessions?bridge=<id>` | 某个桥接的会话/工作区 |
| `GET/POST /api/bridge/directories` | 浏览 / 新建本地工作区目录 |
| `GET /api/bridge/session?key=…` | 单个会话历史 |
| `GET /api/bridge/capabilities` | 协议版本与 attachment 表 |
| `POST /api/bridge/attach` | 启动实时 attachment |
| `POST /api/bridge/detach` | 关闭 attachment |
| `GET /api/bridge/state?key=…` | 引擎状态快照 |
| `GET /api/bridge/events?key=…` | 归一化事件与扩展 UI 的 SSE |
| `POST /api/bridge/prompt` | 提问、steer、follow up |
| `POST /api/bridge/abort` | 中断当前回复 |
| `POST /api/bridge/ui-response` | 回复扩展对话框 |
| `GET /api/bridge/models?key=…` | 模型目录 |
| `POST /api/bridge/models` | 在实时 attachment 上选择 provider/model |
| `GET /api/bridge/stats?key=…` | 引擎会话统计 |
| `GET /api/bridge/history-message?key=…` | 纯文本历史 |

会话 key 为 `<bridgeId>.<base64url(nativeKey)>`，只能解析到该桥接；修改桥接的
会话根目录后，旧路径会像之前一样被拒绝。

## 配置

桥接保存在 `$DSH_HOME/bridge.json`（0600，原子写入）。旧的
`$DSH_HOME/pi-bridge.json` 和更早的按引擎 `backends` 结构会自动迁移。

```json
{
  "version": 3,
  "bridges": [
    {
      "id": "pi-local",
      "name": "Pi",
      "mode": "cli",
      "engine": "pi",
      "config": {
        "sessionsRoot": null,
        "binPath": null,
        "offline": true
      }
    }
  ]
}
```

Pi 环境变量仍作为适配器默认值：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PI_BIN` | 自动探测 | 桥接未设置 `binPath` 时使用 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi 配置目录 |
| `PI_CODING_AGENT_SESSION_DIR` | `$PI_CODING_AGENT_DIR/sessions` | Session 根目录 |

## 开发

```bash
npm test              # 单元测试
npm run test:secrets  # 凭证泄漏检查
node tests/live-smoke.mjs                    # 只读实时检查
DSH_SMOKE_ATTACH=1 node tests/live-smoke.mjs # attach、prompt、stream、detach
```

完整设计见 [docs/architecture.md](docs/architecture.md)。

## License

MIT
