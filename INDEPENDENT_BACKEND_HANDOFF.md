# AI-Plugin 独立后端重构交接文档

> 文档用途：为后续将 AI-Plugin 从 Yunzai-Bot 插件改造成独立 Bot 后端提供完整的架构基线、风险清单、拆分方案和验收标准。
>
> 当前建议：不要一次性推倒重写。先抽离平台无关核心，再把 Yunzai 实现保留为一个适配器，最后增加独立 OneBot 服务入口。

## 1. 项目定位

AI-Plugin 当前是一个运行在 Yunzai-Bot 上的 Node.js ESM 插件，主要负责：

- 多供应商、多模型和模型组调度。
- 多轮对话、个人记忆、个人档案和向量记忆。
- Agent 工具规划、工具执行、结果观察、后续规划和任务状态管理。
- Shell、tmux、工作区文件、配置、群管理、群消息代发等工具。
- 联网搜索、网页抓取、天气查询和图片搜索。
- 当前消息图片、引用图片、合并转发图片和 Vision Relay。
- QQ 群聊畅聊捕获、图片语义摘要和群上下文检索。
- AI 作图、图片审查、文件收发和定时记忆总结。

目标不是简单地“让插件脱离云崽启动”，而是把这些能力拆成：

```text
平台无关核心
    ↓
统一事件、媒体、会话、权限和发送接口
    ↓
Yunzai 适配器 / 独立 OneBot 适配器 / 其他平台适配器
```

## 2. 当前技术基线

### 2.1 语言和运行时

- 当前语言：JavaScript ESM。
- 推荐目标语言：TypeScript。
- 运行时：Node.js，当前依赖 Node.js 18 以上的现代 Fetch/ESM 能力。
- 数据库：SQLite，通过 `sqlite3` 使用。
- 缓存和短期状态：Redis，由 Yunzai 环境提供客户端。
- 向量服务：Python `sentence-transformers`/ChromaDB 服务，由 Node 进程按需管理。
- 浏览器能力：当前网页抓取依赖云崽环境中的浏览器/Puppeteer 能力。
- 消息平台：当前间接依赖 Yunzai 支持的 OneBot/QQ 实现。

### 2.2 当前验证命令

在插件目录执行：

```bash
npm test
```

测试包含：

- `scripts/model_config_eval.js`：模型配置、供应商、别名和模型能力评估。
- `scripts/agent_eval.js`：工具意图、路由、安全、Agent 循环和多模态策略评估。
- `scripts/agent_replay_eval.js`：历史事故回放评估。

现有测试重点覆盖工具路由和安全策略，不等价于真实 QQ、浏览器、网络、Redis、向量服务和上游模型的集成测试。

## 3. 启动和生命周期

当前入口是 `index.js`，启动顺序大致如下：

```text
加载 Config
  ↓
注册全部工具
  ↓
初始化 AiClient
  ↓
初始化 ConversationManager 和数据库迁移
  ↓
初始化 vectorMemory
  ↓
修复历史迁移日期（必要时）
  ↓
启动 AIScheduler
  ↓
扫描 apps/*.js 并动态导入
  ↓
将导出的插件类交给 Yunzai 加载器
```

### 3.1 关键入口依赖

`index.js` 当前直接使用：

- 全局 `logger`。
- 全局 `segment`，并在缺失时尝试加载 `icqq` 或 `oicq`。
- 全局 `AIPluginClient`。
- 全局 `AIPluginConversationManager`。
- 全局 `AIPluginScheduler`。
- `Bot` 和 Yunzai 的插件扫描/加载机制。
- 当前工作目录下的 `plugins/AI-Plugin` 路径结构。

独立后端不能继续依赖这些全局变量。第一阶段可以建立 `RuntimeContext` 统一承载它们，第二阶段再逐个消除全局访问。

## 4. 目录和模块地图

### 4.1 应用层 `apps/`

| 文件 | 当前职责 | 独立化处理 |
| --- | --- | --- |
| `apps/chat.js` | 普通 `#c` 对话、工具规划、Agent 循环、最终回复和记忆保存 | 拆成 `ConversationService` + 平台命令入口 |
| `apps/fast_chat.js` | 畅聊捕获、自然触发、群流水同步、畅聊 Agent | 拆成 `FastChatService` + 消息监听适配器 |
| `apps/image.js` | `#d`/预设作图、参考图和图片发送 | 拆成 `ImageGenerationService` + 媒体发送适配器 |
| `apps/memory.js` | 记忆查看、导出、总结管理 | 拆成 `MemoryAdminService` |
| `apps/management.js` | 模型、权限、向量和开关管理 | 拆成 `AdminService` |
| `apps/group_request.js` | 入群申请监听和处理 | 作为 QQ/OneBot 专用适配器能力 |
| `apps/update.js` | 插件自身 `git fetch/pull/reset` | 独立后端改为部署/管理服务，不应属于对话核心 |
| `apps/help.js` | 帮助文本和命令说明 | 改成平台命令注册或 HTTP/OpenAPI 帮助 |

### 4.2 AI 和会话核心

| 文件 | 当前职责 | 重构优先级 |
| --- | --- | --- |
| `client/AiClient.js` | 模型配置、模型池、请求、失败熔断、图片请求、Vision Relay 关联 | 高，保留为模型网关 |
| `model/conversation.js` | 用户历史读取/保存、摘要计数、迁移 | 高，改为存储接口调用 |
| `utils/agent_runtime.js` | 工具调用去重、结果协议、连续循环和停滞保护 | 高，基本可直接保留并 TypeScript 化 |
| `utils/agent_policy.js` | 风险、完成状态和继续规划决策 | 高，变成核心安全策略 |
| `utils/agent_plan.js` | 结构化计划和步骤依赖 | 高 |
| `utils/agent_verifier.js` | 独立结果验证器 | 高 |
| `utils/agent_task_runtime.js` | Agent 任务持久化、步骤和风险更新 | 高 |
| `utils/tool_result.js` | 工具结果统一协议 | 高，必须先稳定协议 |
| `utils/tool_intent.js` | 规则预路由、语义工具发现和参数意图辅助 | 中高，后续替换成结构化路由器 |
| `utils/model_output.js` | Markdown/思考区块清洗和无依据完成声明拦截 | 高 |

### 4.3 工具层 `tools/`

工具已经有统一注册表，是最适合抽离的部分。当前主要工具包括：

```text
web_search              联网搜索和图片搜索
web_fetch               网页抓取
weather                 天气
vision_relay            纯文本模型视觉转述
image_gen               对话内作图
system_info             服务器状态
shell_exec              一次性 Shell
shell_session           持久 tmux Shell
workspace               目录、搜索、读取、补丁和校验
config_manage           结构化配置修改
file_send/file_download 文件收发
group_file              群文件列表和下载
group_chat_context      群流水查询
group_chat_digest       长时间范围群聊总结
group_member_aliases    群成员称呼记忆
group_send_message      群消息代发
group_leave             退群
group_admin             群管理
memory_search           向量记忆检索
user_profile_update     个人档案维护
```

未来工具不应直接调用 `e`、`Bot`、`redis` 或全局变量，而应通过工具执行上下文获取能力：

```ts
interface ToolContext {
  actor: ActorIdentity
  conversation: ConversationRef
  permissions: PermissionSnapshot
  platform: PlatformAdapter
  media: MediaResolver
  storage: StorageServices
  logger: Logger
  taskId?: string
}
```

## 5. 当前消息处理流程

### 5.1 普通对话流程

当前 `apps/chat.js` 的逻辑可以概括为：

```text
收到 Yunzai 事件
  ↓
匹配 #c/#chat 及 f/p/u、v/n/w 等标志
  ↓
展开回复、引用、合并转发、卡片和 QQ 表情
  ↓
收集当前图片、引用图片、头像和本地图片
  ↓
确定操作者、群聊、权限和隐私主体
  ↓
加载历史、增量摘要、个人档案和语义记忆
  ↓
根据当前指令筛选工具候选
  ↓
主模型规划工具，意图模型编译参数
  ↓
安全检查、权限检查、待确认检查和参数校验
  ↓
Agent 最多循环执行工具并观察结果
  ↓
根据模型能力决定直接多模态或 Vision Relay
  ↓
构造最终模型上下文
  ↓
清洗最终回复、拦截无依据完成声明
  ↓
发送消息、记录历史、更新 Agent 任务和摘要计数
```

### 5.2 上下文优先级

当前已经加入了分层设计，目标顺序是：

1. 当前用户本条指令。
2. 本轮真实工具结果。
3. 当前引用或回复内容。
4. 明确请求的群聊上下文。
5. 个人档案、语义记忆和普通历史。
6. 无关群聊流水。

后续重构必须保留这个顺序。最重要的原则是：

```text
背景信息可以帮助理解当前任务，但不能改写当前任务。
```

### 5.3 历史保存原则

历史记录只能保存：

- 用户实际发言。
- 必要的引用正文。
- 必要的图片占位或图片语义摘要。
- AI 最终回复。

不得保存：

- 完整工具说明。
- Agent 规划提示词。
- 工具原始结果的重复副本。
- 畅聊自动上下文流水的完整副本。
- 环境提示和安全系统提示。
- 纯临时的图片 base64。

否则会形成：

```text
历史变长 → 下轮加载 → 再次注入 → 再保存 → 指数式膨胀
```

## 6. 多模态和图片处理

### 6.1 普通对话图片

当前消息图片、回复图片、合并转发图片和头像会经过统一收集与压缩。

模型选择规则：

- 如果目标模型配置 `multimodal: true`，直接发送图片给该模型。
- 如果目标模型不支持多模态且 Vision Relay 开启，则先调用视觉模型生成描述，再把描述交给文本模型。
- Vision Relay 失败时应保留失败事实，不得伪造图片内容。
- 纯文本模型不得接收未处理的图片并假装已经看见。

### 6.2 畅聊图片

畅聊模式保存：

- 消息发送者和时间。
- 图片元信息。
- 可选的视觉摘要。

不保存：

- 图片本体。
- base64。
- 永久依赖 QQ 临时图片 URL。

当前消息不超过配置的直接图片数量时，可以直接交给多模态模型；历史图片则按摘要、有效期和批次策略处理。

独立后端必须把媒体分成三个生命周期：

```text
临时媒体：只服务当前请求
缓存媒体：短时间供回复/工具复用
语义媒体：只保存摘要、哈希、时间和来源元数据
```

## 7. 模型层

### 7.1 当前配置概念

新版配置已经将供应商和模型拆开：

```yaml
providers:
  - id: provider-id
    name: provider-name
    base_url: https://api.example.com/v1
    api_key: secret

models:
  - id: stable-internal-id
    alias: human-readable-name
    provider: provider-id
    model: upstream-model-name
    multimodal: true

model_groups:
  flash:
    chat_models: [stable-internal-id]
    draw_models: []
```

独立化时应保留：

- 供应商连接信息与模型能力分离。
- 模型级多模态声明。
- 模型组作为任务偏好，而不是供应商优先级。
- 模型状态、成功率、延迟和熔断信息。
- 统一 OpenAI-compatible 请求层，但允许供应商覆盖特殊端点。

### 7.2 请求网关必须解决的问题

- 聊天模型和绘图模型端点可能不同。
- 图片输入可能需要 chat content、`images/edits` 或 `images/generations`。
- 供应商返回格式可能是 JSON、SSE、Markdown 图片或 base64。
- 网络异常需要展开底层错误，不能只返回 `AggregateError`。
- 代理、超时、重定向和私网访问必须由独立网络层管理。
- API Key 不能写入日志、任务记录或错误消息。

推荐抽象：

```ts
interface ModelGateway {
  chat(request: ChatRequest): Promise<ModelResponse>
  generateImage(request: ImageRequest): Promise<ImageResponse>
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>
  health(model: ModelRef): Promise<ModelHealth>
}
```

## 8. 记忆和数据层

### 8.1 SQLite 当前主要数据

当前数据库包含以下逻辑数据：

```text
user_histories       用户对话历史
memory_checkpoints   全量记忆锚点
summary_cache        增量总结
user_profiles        个人档案
group_message_logs   畅聊群消息流水
group_member_aliases 群成员称呼记录
agent_tasks          Agent 任务
agent_steps          Agent 步骤和工具观察
migration_status     数据迁移状态
```

### 8.2 Redis 当前用途

Redis 主要用于：

- 对话历史短期缓存。
- 自动总结计数。
- 待确认动作和短期任务状态。
- 引用文件、最近图片等短期关联。

独立化时 Redis 不是必需依赖。建议：

- SQLite 作为持久事实源。
- Redis 作为可选缓存和分布式锁。
- 所有关键状态即使 Redis 丢失也能从 SQLite 恢复。

### 8.3 向量记忆

当前向量系统由 Node 调度 Python 服务，索引来源包括：

- 对话历史。
- 群聊流水。
- 全量记忆。
- 增量总结。
- 个人档案。

向量检索只能提供相关线索，不能替代当前工具结果，也不能绕过隐私权限。

独立后端应把向量系统包装为：

```ts
interface SemanticMemoryStore {
  upsert(documents: SemanticDocument[]): Promise<void>
  search(query: string, scope: MemoryScope): Promise<MemoryHit[]>
  delete(filter: MemoryFilter): Promise<void>
  health(): Promise<HealthStatus>
}
```

## 9. Agent 运行模型

当前 Agent 不是自主无限循环，而是受预算和安全策略约束的有限状态机：

```text
收到任务
  ↓
候选工具召回
  ↓
主模型生成结构化计划
  ↓
参数编译和 Schema 校验
  ↓
权限、风险和当前指令安全过滤
  ↓
执行一轮工具
  ↓
统一结果协议
  ↓
观察器判断 ready / continue / waiting / blocked
  ↓
必要时进入下一轮，最多 8 轮
```

### 9.1 Agent 必须保留的机制

- 当前指令与历史资料隔离。
- 工具参数 Schema 校验。
- 工具调用去重。
- 依赖真实结果的动作延后。
- 高风险操作待确认或显式授权。
- 任务状态持久化。
- 失败结果和不确定结果不能伪装成功。
- 三轮无新信息自动止损。
- 任务达到轮次上限时保守结束。
- 独立验证器不能接受未满足成功标准的 `ready`。
- 纯聊天不创建 Agent 任务。

### 9.2 未来建议：把 Agent 拆成四层

```text
Planner       只负责理解任务、拆步骤、选择工具
Executor      只负责调用工具和返回结构化结果
Observer      只负责判断结果是否满足成功标准
Responder     只负责根据事实生成最终回复
```

不要让最终回复模型自行推断“工具大概成功了”。所有事实应来自 `ToolResult` 和 `TaskState`。

推荐统一结果：

```ts
interface ToolResult<T = unknown> {
  ok: boolean
  pending?: boolean
  verified?: boolean
  changed?: boolean
  recoverable?: boolean
  summary: string
  facts?: Record<string, unknown>
  artifacts?: ArtifactRef[]
  nextHints?: string[]
  metrics?: Record<string, number | string>
  data?: T
  error?: ToolError
}
```

## 10. 云崽耦合清单

### 10.1 强耦合部分

这些部分必须通过适配器替换：

- `apps/*.js` 继承云崽 `plugin`。
- Yunzai 事件对象 `e`。
- `Bot` 全局对象。
- `logger` 全局对象。
- `segment` 消息段。
- `redis` 全局客户端。
- `e.reply()`、`e.group.sendMsg()`、`e.friend.sendMsg()`。
- 群管理、文件上传、转发消息和头像读取。
- 插件目录扫描和动态加载。
- 云崽提供的浏览器实例。

### 10.2 隐式耦合和高风险点

- `process.cwd()` 被用于推断插件、配置和数据目录；独立服务不能假设启动目录。
- 部分代码依赖运行时全局对象是否已经初始化。
- QQ 图片 URL 是临时资源，不能作为长期事实来源。
- 事件字段在不同 OneBot/QQ 实现中不完全一致。
- 多处直接构造 QQ 消息段。
- 发送消息和保存历史目前位于同一条业务链，平台失败可能影响任务收尾。
- 定时任务依赖全局 `AIPluginConversationManager` 和 `AIPluginScheduler`。
- 原生更新模块和 Agent Shell 更新路径是两套逻辑。

### 10.3 应抽象的接口

```ts
interface PlatformAdapter {
  id: string
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(handler: (event: MessageEvent) => Promise<void>): Unsubscribe
  onLifecycle?(handler: (event: LifecycleEvent) => Promise<void>): Unsubscribe
}

interface MessagingService {
  send(target: MessageTarget, message: OutgoingMessage): Promise<SendReceipt>
  reply(event: MessageEvent, message: OutgoingMessage): Promise<SendReceipt>
  react?(event: MessageEvent, reaction: Reaction): Promise<void>
}

interface MediaResolver {
  resolve(input: IncomingMedia): Promise<ResolvedMedia>
  cache(media: ResolvedMedia, ttlMs: number): Promise<MediaRef>
  describe(media: MediaRef, instruction?: string): Promise<MediaDescription>
}

interface GroupService {
  listGroups(): Promise<GroupInfo[]>
  listMembers(groupId: string): Promise<MemberInfo[]>
  mute?(groupId: string, userId: string, duration: number): Promise<void>
  kick?(groupId: string, userId: string): Promise<void>
}

interface FileService {
  send(target: MessageTarget, file: FileRef): Promise<SendReceipt>
  download(input: IncomingFile): Promise<FileRef>
}

interface SchedulerService {
  schedule(id: string, expression: string, handler: () => Promise<void>): Promise<void>
  cancel(id: string): Promise<void>
}
```

## 11. 推荐目标目录

第一阶段不必立刻移动全部文件，但最终建议形成如下结构：

```text
src/
  core/
    agent/
      planner.ts
      executor.ts
      observer.ts
      responder.ts
      task-store.ts
    conversation/
    memory/
    model/
    tools/
    policy/
  contracts/
    message.ts
    media.ts
    platform.ts
    tool.ts
    storage.ts
  adapters/
    yunza/
    onebot/
    telegram/
    discord/
  infrastructure/
    sqlite/
    redis/
    vector/
    browser/
    shell/
    scheduler/
    logging/
  server/
    http.ts
    websocket.ts
    health.ts
  config/
    loader.ts
    schema.ts
  index.ts
```

推荐保留当前目录作为过渡层，避免一次性移动导致 Git 历史和运行环境同时失控。

## 12. OneBot 独立后端方案

### 12.1 推荐连接方式

首期优先实现 OneBot 11 WebSocket：

```text
NapCat/Lagrange/其他 OneBot 实现
              ⇅ WebSocket
独立 AI-Plugin 后端
              ⇅
模型、记忆、工具和任务核心
```

同时可选支持反向 HTTP WebSocket，方便后端作为客户端连接 OneBot 或让 OneBot 连接后端。

### 12.2 OneBot 适配器职责

- 把 OneBot `message` 事件转换成平台无关 `MessageEvent`。
- 统一 text、image、reply、at、file、json、xml、forward 等消息段。
- 负责图片和文件下载。
- 把 `OutgoingMessage` 转换为 OneBot action。
- 处理群、好友、临时会话和频道目标。
- 映射权限、群主、管理员、主人和机器人身份。
- 将发送失败转换为结构化 `SendReceipt`。
- 屏蔽 OneBot 特有字段，不让核心层依赖 QQ 字段名。

### 12.3 不要在核心层做的事情

- 不要直接拼 `[CQ:image,...]`。
- 不要直接调用 `send_group_msg`。
- 不要从核心层访问 `e.group`。
- 不要假设有 QQ 号、群号或 `face id`。
- 不要用平台消息格式作为历史数据库格式。

## 13. 配置和部署设计

独立后端不能再以 `process.cwd()` 作为所有路径的根。推荐：

```text
AI_PLUGIN_CONFIG=/etc/ai-plugin/config.yaml
AI_PLUGIN_DATA=/var/lib/ai-plugin
AI_PLUGIN_CACHE=/var/cache/ai-plugin
AI_PLUGIN_LOG=/var/log/ai-plugin
```

配置加载顺序建议：

```text
内置默认值
  ↓
配置文件
  ↓
环境变量覆盖
  ↓
启动时 Schema 校验
  ↓
生成不可变 RuntimeConfig
```

必须支持：

- 配置 Schema 校验。
- API Key 脱敏日志。
- 配置热重载或明确要求重启。
- 数据目录和代码目录分离。
- 代理配置独立于模型配置。
- 各工具能力开关和权限策略独立配置。
- 生产环境禁止把测试默认值当作安全策略。

推荐部署单元：

```text
ai-plugin.service       Node/TypeScript 主服务
ai-plugin-vector.service 可选 Python 向量服务
Redis                   可选缓存服务
SQLite                  主持久化数据库
OneBot                  QQ 平台连接器
```

## 14. 分阶段迁移计划

### 阶段 0：冻结行为基线

目标：在不改业务行为的情况下建立可回归基线。

- 保留现有 `npm test`。
- 为消息归一化、模型请求、工具结果增加单元测试。
- 记录真实 QQ 场景：普通对话、图片、引用、转发、畅聊、天气、搜索、Shell、文件和作图。
- 保存脱敏后的请求/响应回放样本。
- 明确当前配置文件、数据目录和向量服务位置。

完成标准：核心事故都有可重复回放，不依赖真实 API 才能验证路由逻辑。

### 阶段 1：建立平台契约

目标：不改变 Yunzai 功能，先定义接口。

- 新建 `contracts/`。
- 定义 `MessageEvent`、`MessageContent`、`MediaRef`、`MessageTarget`。
- 定义 `PlatformAdapter`、`MessagingService`、`MediaResolver`。
- 定义 `ToolContext` 和统一 `ToolResult`。
- 添加 Yunzai 适配器的薄封装，但旧代码暂时仍可用。

完成标准：新增核心代码不再直接引用 `e`、`Bot`、`segment`。

### 阶段 2：抽离模型、工具和记忆核心

目标：先迁移最独立、收益最大的部分。

- 抽离 `AiClient` 为 `ModelGateway`。
- 抽离 `ToolRegistry` 和工具协议。
- 抽离 `ConversationStore`、`MemoryStore`、`SemanticMemoryStore`。
- 抽离 Agent 四层循环。
- 把普通对话服务改为接收平台无关事件。

完成标准：可以在测试中构造虚拟消息，完整运行“规划→工具→观察→回复”，不启动 Yunzai。

### 阶段 3：重构普通对话入口

目标：把 `apps/chat.js` 降级为薄壳。

```text
Yunzai ChatHandler
  → normalizeEvent()
  → ConversationService.handle()
  → MessagingService.reply()
```

- 事件解析、上下文构造、Agent 运行和回复生成移出 `apps/chat.js`。
- Yunzai 只负责权限入口、事件转换和发送。
- 保留原有命令兼容层。

完成标准：Yunzai 和独立测试入口使用同一个 `ConversationService`。

### 阶段 4：实现 OneBot 独立服务

- 实现 OneBot WebSocket 客户端/服务端。
- 完成消息、图片、回复、转发、群组、文件发送映射。
- 增加 HTTP 健康检查和运行状态接口。
- 增加优雅退出、断线重连和事件去重。
- 让 Yunzai 和 OneBot 适配器可以分别启动。

完成标准：脱离 Yunzai 后可完成普通文字、图片、回复和群消息发送。

### 阶段 5：迁移畅聊、群管理和定时任务

- 将畅聊捕获变成平台事件订阅。
- 将群管理变成 `GroupService`。
- 将定时总结交给独立 `SchedulerService`。
- 迁移入群申请、群文件和跨群权限策略。
- 对不同平台声明能力矩阵，不支持的能力返回结构化“不支持”。

完成标准：核心服务不再假设平台一定是 QQ。

### 阶段 6：切换和清理

- 双运行时并行回归。
- 迁移旧 SQLite/Redis 数据。
- 对比两套运行时的消息、记忆和 Agent 结果。
- 默认使用独立服务，Yunzai 适配器保留一段时间。
- 最后删除旧全局访问和插件扫描入口。

## 15. 数据迁移注意事项

### 15.1 历史数据

不要直接把当前 JSON/YAML/SQLite 内容原样暴露给新核心。应执行：

1. 备份 SQLite、配置、摘要和向量索引。
2. 验证用户 ID、群 ID 和时间字段。
3. 清理历史中重复的工具提示和自动上下文。
4. 去除图片 base64 和已失效的临时 URL。
5. 为历史记录补充 `platform`、`conversation_id`、`message_id` 和 `visibility`。
6. 重新建立向量索引，而不是盲目复用旧索引。

### 15.2 推荐统一消息记录

```ts
interface ConversationMessage {
  id: string
  conversationId: string
  platform: string
  sender: ActorIdentity
  role: 'user' | 'assistant' | 'tool'
  content: MessageContent[]
  visibility: 'private' | 'group' | 'public'
  createdAt: string
  replyTo?: string
  mediaRefs?: MediaRef[]
  metadata?: Record<string, unknown>
}
```

## 16. 安全边界

独立化后安全责任会从云崽转移到自己的服务，必须重新审计：

- API 认证和 WebSocket 鉴权。
- 主人、管理员、群成员和普通用户的权限映射。
- Shell 和 tmux 的目录安全。
- 文件读写白名单。
- 群消息代发和群管理的确认机制。
- 任务恢复时不能重复执行副作用工具。
- 工具结果中的提示词注入。
- 网页内容、搜索结果和文件内容都只能当作不可信资料。
- 媒体 URL、API Key 和私聊数据的日志脱敏。
- 多租户时不同用户、群和平台之间的记忆隔离。
- 进程、浏览器、向量服务和 OneBot 连接的资源限制。

安全策略必须放在核心层和工具层双重执行，不能只依赖模型提示词。

## 17. 可观测性要求

每个请求应有统一 `requestId`，每个 Agent 任务应有 `taskId`，每个工具调用应有 `toolCallId`。

日志至少记录：

```text
requestId
taskId
conversationId
platform
actorId（脱敏）
route
selectedModel
toolName
toolStatus
elapsedMs
input/output token（若上游提供）
context section sizes
final status
```

日志不得记录：

- API Key。
- 完整图片 base64。
- 私人档案全文。
- 未授权的跨群消息。
- 完整 Shell 敏感输出。
- 完整上传文件内容。

建议增加指标：

- 模型成功率、延迟和熔断次数。
- 工具规划成功率。
- 工具安全拦截次数。
- Agent 平均轮数和停滞次数。
- 最终回复纠正次数。
- 上下文各区块字符数和 Token 数。
- 图片直接多模态成功率和 Vision Relay 成功率。
- OneBot 连接状态、重连次数和发送失败率。

## 18. 测试策略

### 18.1 单元测试

- 消息段归一化。
- 引用/转发递归和循环保护。
- QQ 表情降级处理。
- 工具意图和否定句。
- Agent 计划、去重和状态机。
- 权限和目录安全。
- 模型配置和能力筛选。
- 历史压缩和上下文优先级。
- ToolResult 协议。

### 18.2 集成测试

- Mock 模型供应商。
- Mock OneBot WebSocket。
- Mock 图片下载和发送。
- Mock Redis 和 SQLite。
- Mock 浏览器和搜索引擎。
- 向量服务健康检查、写入和检索。

### 18.3 回放测试

保留脱敏事故样本，至少覆盖：

- 工具成功但最终答错旧话题。
- 目录安全误拦截真实插件目录。
- 搜索结果不足却生成确定性结论。
- 图片已经输入但模型未真正看到。
- 高风险工具重复执行。
- 待确认任务被错误标记完成。
- 上游返回空消息或 `AggregateError`。
- 多群消息串线。

## 19. 语言选择结论

首期继续使用 **TypeScript + Node.js**。

原因：

- 最大程度复用当前 JavaScript 代码和依赖。
- OneBot、WebSocket、HTTP、SQLite、浏览器和图片生态成熟。
- 类型系统适合约束复杂消息、工具和模型协议。
- 可以渐进式迁移，不必一次性重写所有功能。
- 后续接入 Telegram、Discord 等平台成本较低。

暂不建议首期改成 Go 或 Rust。只有在核心功能稳定、确实遇到高并发、低内存、单二进制或沙箱执行需求时，再考虑将独立的网关、媒体服务或 Shell 沙箱拆成 Go/Rust 子服务。

## 20. 第一批实际任务清单

开始重构时建议严格按以下顺序执行：

- [ ] 固定当前分支和生产配置备份。
- [ ] 为当前真实日志建立脱敏回放样本。
- [ ] 新建 `contracts/` 并定义消息、媒体、平台和工具协议。
- [ ] 实现 `YunzaiPlatformAdapter`，先只包住事件和发送。
- [ ] 把 `AiClient` 改造成可注入依赖的 `ModelGateway`。
- [ ] 把 SQLite/Redis/向量访问包装成 Store 接口。
- [ ] 把 `ToolRegistry` 的执行上下文改成 `ToolContext`。
- [ ] 把普通对话核心从 `apps/chat.js` 抽出。
- [ ] 为 `ConversationService` 增加无云崽单元测试。
- [ ] 实现 OneBot WebSocket 适配器。
- [ ] 完成文字、图片、回复和群消息发送的端到端测试。
- [ ] 再迁移畅聊、定时任务、群管理和文件工具。

## 21. 结束条件

只有满足以下条件，才可以认为独立后端重构完成：

- 独立服务可以不启动 Yunzai 接收和发送 OneBot 消息。
- 普通文字、图片、引用、合并转发和文件消息行为稳定。
- 多模态直传和 Vision Relay 均有明确能力判定。
- Agent 工具调用、验证、待确认和恢复逻辑可独立运行。
- SQLite、Redis 和向量服务故障有明确降级策略。
- 记忆和群上下文不会跨用户、跨群或跨平台泄露。
- Shell、文件和群管理具备独立后端权限边界。
- 原有 Yunzai 适配器仍能回归通过，或已有明确迁移替代方案。
- 所有关键事故都有自动化回放测试。
- 生产部署具备健康检查、日志、指标、重连和优雅退出。

## 22. 交接结论

当前项目已经具备独立后端的核心雏形：模型网关、工具注册表、Agent 运行时、任务状态、SQLite 记忆和向量索引都相对独立。最大的重构工作集中在消息平台、媒体、权限、文件、浏览器和生命周期管理。

最稳妥的路线不是重写功能，而是：

```text
先定义契约
→ 抽离对话核心
→ 保留 Yunzai 适配器
→ 实现独立 OneBot 适配器
→ 双运行时回归
→ 再迁移平台专用能力
```

下一次正式动工时，建议从阶段 0 和阶段 1 开始，不要先改入口，也不要先迁移语言。
