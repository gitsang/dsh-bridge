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
- [x] 独立 Bridge 设置页内新增 / 编辑 / 删除桥接（视觉规格对齐 dsh 原生设置）
- [x] CLI / Web 模式与按模式过滤的引擎列表
- [x] Pi 引擎完整可用：JSONL 会话、RPC attach、事件归一化、prompt
- [x] 左上角「本机 + 已配置桥接」下拉框，带实时连接状态点
- [x] 启动时只做就绪探测（不启动 agent 进程）
- [x] 按轮次 lazy attach：发送时启动 Pi，结束即关闭
- [x] 侧边栏会话状态：运行中转圈、完成变绿点
- [x] 选中桥接后由侧边栏直接展示该桥接的工作区 / 会话
- [x] 导入模式：外部会话在用户显式导入前不会进入侧边栏
- [x] 导入弹窗支持工作区树 / 单列表、搜索与多选
- [x] 与 dsh Web 一致的侧边栏浏览器：按工作区 / 工作区树 / 单列表分组、手动 / 最近更新排序、会话筛选
- [x] dsh 风格搜索按钮与结果列表
- [x] dsh 风格“选择工作区目录”弹窗，可新建文件夹并加入工作区
- [x] 每个工作区右侧的新建会话按钮，以及工作区重命名 / 软删除
- [x] 工作区映射持久化到 `bridge-workspaces.json`，删除只做标记，不碰 Pi JSONL
- [x] 按桥接隔离的导入成员持久化到 `bridge-imports.json`
- [x] 按桥接隔离的归档状态持久化到 `bridge-archives.json`，并在 attach / prompt 时校验
- [x] dsh 风格对话界面与 composer
- [x] 与 dsh Web 一致的左右内容宽度拖拽手柄，共用宽度偏好
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
- **Bridge 设置**：单独打开 Bridge 设置页，不进入 dsh 原生设置，也不跳转当前对话。

### 连接生命周期

dsh Host 启动时会对每个已配置桥接做一次就绪探测，**不会启动 agent 进程**。
探测只检查 Pi 可执行文件和 Session 根目录。`GET /api/bridge/status` 返回该
状态，下拉框打开时会轮询刷新。

Agent 进程是**按轮次**的：

1. 打开会话只读取 JSONL 历史，composer 直接可用；
2. 第一次发送调用 `POST /api/bridge/attach`，随后 `prompt`；
3. 运行期间侧边栏该会话显示转圈；
4. `agent_settled` 后显示绿点，并在约 1.2 秒后关闭 Pi 进程
   （留一点时间把最后的事件刷给浏览器）。

因此同一时刻每个桥接最多只有一个 Pi 进程，而不是「打开过几个会话就有几个」。
同一会话再次发送会重新 attach。

### 未连接时也能看到当前模型

Pi 会把生效模型持久化在会话 JSONL 里：每次切换写一条 `model_change` 树条目，
每条 assistant 消息也带 `provider` / `model` / `thinkingLevel`。Bridge 解析当前
分支后返回 `session.model`，所以没连接也能显示当前模型，而不是一个占位符。
attach 之后以实时 state 为准。

### 未连接时也能加载模型目录

`get_available_models` 由 Pi 的 model runtime 计算（用户 `models.json`、内置目录、
凭据、扩展注册的 provider），无法从会话文件推出。Bridge 不常驻控制进程，而是
临时启动一个 `pi --mode rpc --no-session`，查询目录后立刻退出；Host 按桥接缓存
10 分钟。

因此 `GET /api/bridge/models?key=…` 在未连接时同样可用：有 attachment 时用实时
目录，否则用短命进程/缓存（`source: "catalog"`）。未连接时选择的模型会先记为
pending，下次 attach 后立即应用。

### 设置页

Bridge 设置是**独立页面**，不注册进 dsh 原生设置；但弹窗外壳、左侧导航、
标题层级、卡片、按钮、输入框与排版均按 dsh 原生设置（尤其是 Models 分页）
1:1 复刻：

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

### 导入会话

Bridge 采用**导入模式**：引擎 Session 根目录下发现的会话只是候选，不会自动
进入侧边栏。用户显式导入之前，侧边栏保持不变，避免外部 CLI 创建的会话悄悄出现
在所有浏览器里。

Bridge 侧边栏标题栏的数据库图标是导入按钮。弹窗会读取该桥接的完整会话列表：

- **树视图**按工作区目录分组，支持工作区级全选（包含子目录中的会话）；
- **列表视图**按最近更新平铺展示，便于快速浏览；
- 搜索可按会话名、首条消息、id 或工作区路径过滤；
- 已导入的行会标记并禁用，弹窗可随时重新打开；
- 点击**导入**后，前端调用 `POST /api/bridge/imports`，选中的会话才会进入左侧
  工作区并补齐对应的工作区记录。

通过 Bridge 新建的会话本身就是显式操作，会立即导入。导入成员按桥接持久化在
`$DSH_HOME/bridge-imports.json`，与 agent JSONL 和归档状态彼此独立。

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

卡片下方是仿 dsh 的 composer statusline：仪表盘 pill 展示轮次/步数，数据库
pill 展示总 Token 与缓存命中率，引擎返回上下文占用时还会显示环形百分比；
点击可展开同款详情面板。Bridge 的统计来自引擎的 `get_session_stats` RPC，
不支持统计的引擎则回退到对话记录汇总。这里是视觉与交互对齐，而不是复用
dsh 的 session projection：外部 agent 有自己的会话模型。

选择 **本机** 后释放 Bridge 侧边栏 occupant，恢复 dsh 原生侧边栏。

## 架构

```text
Browser (dsh web)
  ├─ 品牌下拉框 ───────────> GET /api/bridge/settings
  ├─ Bridge settings page ──> POST/PUT/DELETE /api/bridge/bridges
  ├─ 导入弹窗 ─────────────> GET/POST /api/bridge/imports
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
| `GET/POST /api/bridge/status` | 读取或刷新每个桥接的就绪状态 |
| `GET /api/bridge/activity?bridge=<id>` | 每个会话的运行/空闲/失败状态 |
| `GET/POST /api/bridge/sessions` | 列出某个桥接**已导入**的会话/工作区；在指定工作区新建 Pi 会话 |
| `GET/POST /api/bridge/imports` | 发现全部引擎会话；持久化选中的会话/工作区导入 |
| `GET/POST/PUT/DELETE /api/bridge/workspaces` | 工作区列表、添加、重命名、软删除 |
| `POST /api/bridge/archive` | 在 host 端归档 / 取消归档单个会话 |
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
| `GET /api/bridge/models?key=…` | 模型目录（未连接也可用） |
| `POST /api/bridge/models` | 在实时 attachment 上选择 provider/model |
| `GET /api/bridge/stats?key=…` | 引擎会话统计 |
| `GET /api/bridge/history-message?key=…` | 纯文本历史 |

会话 key 为 `<bridgeId>.<base64url(nativeKey)>`，只能解析到该桥接；修改桥接的
会话根目录后，旧路径会像之前一样被拒绝。

## 会话导入

导入状态由 bridge host 持有，不保存在浏览器。host 把每个桥接的已导入原生 session
key 有序集合写入 `$DSH_HOME/bridge-imports.json`（带版本、0600、原子写入）。

- `GET /api/bridge/imports?bridge=<id>` 返回全部候选会话（带 `imported` 标记）
  和工作区候选；
- `POST /api/bridge/imports` 接收 `{ bridge, sessionKeys, workspacePaths }`，校验
  key/路径确实属于该桥接的候选集，并且是幂等的；
- `GET /api/bridge/sessions` 只返回导入集合内的会话；工作区不再从每次扫描到的
  全部 `cwd` 自动补齐；
- 删除桥接时会一并删除它的导入集合。

## 会话归档

归档状态由 bridge host 持有，不再保存在浏览器里。host 把每个桥接的归档会话
原生 key 有序集合写入 `$DSH_HOME/bridge-archives.json`（带版本、0600、原子写
入）。不会修改 Pi JSONL、workspace 记账或消息历史。

- `GET /api/bridge/sessions` 同时返回 `archivedKeys`（供浏览器使用的带桥接前缀
  key）和每个会话摘要上的 `archived` 标记。
- `POST /api/bridge/archive` 接收 `{ key, archived }`，返回完整的权威 key 集合，
  多个标签页最终看到同一份状态。
- 已归档会话不能通过 bridge attach 或 prompt。归档空闲会话会关闭它的
  attachment；如果回合仍在运行则返回 `409`，需要先 abort。
- 启动自动连接只预热最新的**未归档**会话。
- 删除桥接时会一并删除该桥接的归档集合。
- 旧版浏览器 localStorage 里的 `archivedKeys` 会被忽略而不是迁移，因为它只属于
  某个浏览器 profile，不能当作 host 状态。
- 外部 Pi CLI 直接打开的会话超出 bridge host 的控制范围，不受该 gate 限制。

这与 dsh Web 的持久化归档集合模型一致，同时按 bridge 实例隔离。

## 配置

桥接保存在 `$DSH_HOME/bridge.json`（0600，原子写入）。旧的
`$DSH_HOME/pi-bridge.json` 和更早的按引擎 `backends` 结构会自动迁移。

工作区显示名与删除标记保存在 `$DSH_HOME/bridge-workspaces.json`（0600，
原子写入）。默认显示名取路径最后一段文件夹名（例如 `/work/demo` 显示为
`demo`），旧版本曾把完整路径写成默认名的记录会自动纠正。它是“工作区路径 →
显示名 / 删除标记”的持久映射：重命名只改这里，
删除只写入 `deletedAt`，不会删除 Pi 目录、JSONL 或其中的消息。Pi 侧新增会话
只会出现在导入弹窗中；用户显式导入后才并入左侧工作区。

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
