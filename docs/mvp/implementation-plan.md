# AIOS MVP 实施计划

> 状态：执行基线 v1
> 日期：2026-07-25
> 原则：先交付可点击、可重复的体验纵向切片，再把相同领域边界下沉到生产桌面可信核心

## 1. 计划目标

本计划交付两个清晰分级、不可混淆的结果：

1. **Demo Release**：无需模型密钥和外部账户，任何评审者都能在数分钟内体验 Agent Store、安装 Agent、发起 Mission、Agent 通过 A2UI 生成任务界面、多 Agent 作业推进、系统可信确认、Artifact、Receipt 与 Activity 的完整故事。
2. **Desktop MVP**：以 Tauri 2/Rust Core 为可信边界，接入少量真实 Agent 能力和受保护资源，具备安装验证、隔离运行、最小 Capability Broker、持久化、恢复与安全审计，可以对有限能力作生产级承诺。

Demo Release 用于验证“AIOS 是否比聊天框或 Agent 启动器更像一种新的操作环境”；Desktop MVP 用于验证“这种体验能否建立真实、可恢复、不可旁路的能力治理”。前者不是后者的安全替代品。

## 2. 核心假设与成功定义

MVP 要验证五个最危险的产品与技术假设：

| 假设 | 可观测成功信号 | 失败信号 |
|---|---|---|
| Agent 可以替代传统 App 成为能力安装单元 | 用户理解“安装的是能力定义”，并能从 Store 到 Workbench 直接使用 | Store 看起来只是提示词市场 |
| A2UI 可以让能力按任务生成原生界面 | 同一 Mission 不靠聊天记录也能展示结构、状态和操作 | 界面只是静态卡片或网页 iframe |
| Mission 是比会话更稳定的工作对象 | 用户能看到 Job DAG、阻塞、进度、恢复和成果 | 关闭聊天窗口就失去任务状态 |
| 自动化与安全可以同时可见 | 高风险动作在系统确认前暂停，确认内容精确且产生 Receipt | Agent 自画确认或安装时一次性全授权 |
| 结果能成为可复用资产 | Artifact 有版本、来源和 Receipt 关联，刷新后仍可找到 | 最终结果只留在临时消息里 |

### 2.1 Demo Release 完成定义

Demo Release 只有同时满足以下条件才算完成：

- 首次进入即能理解 Workbench、Agent Store、Activity、Artifacts 四个系统场景。
- 六个演示 Agent 具有独立图标、发布者、能力、风险与协议说明。
- 安装是显式多阶段流程，重复安装不产生重复 Installation。
- 已安装 Agent 能发起 Mission；Mission 至少经历 planning、running、awaiting-approval、completed。
- Agent Surface 由官方 A2UI v0.9 兼容处理器消费消息；非法消息 fail closed。
- Mission DAG、A2UI Surface 与 Activity 对同一状态给出一致反馈。
- 高风险日历写动作由独立 Trusted Approval Sheet 展示动作、目标、时间、共享数据、风险和 digest。
- 同一 approval digest 无论重复提交多少次，最多出现一个 Receipt/effect key。
- 完成后生成 Artifact、来源链与 Receipt；刷新后稳定结果可恢复。
- macOS 风格使用经评估的开源 UI 组件，通过本地 UI System 适配层使用，不在业务代码散落第三方 API。
- typecheck、单元/组件测试、production build 和真实浏览器关键路径全部通过；浏览器控制台无未解释错误。

### 2.2 Desktop MVP 完成定义

在 Demo 门槛之上还必须满足：

- Agent 包按 digest 验证、锁定、安装和回滚，安装不隐式授权。
- Agent Worker 默认无宿主权限和环境秘密，崩溃与核心隔离。
- 至少一类只读能力和一类需要 Trusted Approval 的写能力完整经过 Capability Broker。
- Trusted Approval 由可信核心提供，不与 Agent A2UI 共享可伪造的渲染通道。
- 真实副作用产生系统 Receipt；超时或断线进入 `unknown` 并可对账，不盲目重试。
- SQLite/内容寻址存储支持 Run、Checkpoint、Artifact、Outbox 与 Receipt 的崩溃恢复。
- 包版本、Principal chain、ActionIntent、Policy 决定、Grant、Receipt 与 Artifact Lineage 可串成责任链。
- 安全、协议、无障碍、性能和恢复测试全部达到发布门槛。

## 3. 范围

### 3.1 Demo Release 范围

包含：

- macOS 启发的桌面壳、侧栏、窗口 chrome、系统导航与响应式布局。
- Agent Store 的发现、搜索、分类、详情、能力风险、协议与安装体验。
- Workbench 的意图输入、上下文对象、已安装 Agent 选择与 Mission Control。
- 确定性演示运行时、多 Job 状态推进和 Mission DAG。
- 官方 A2UI React/Web Core 处理器、版本化 fixture、受限 Surface 和 action intent 回调。
- Trusted Approval、Artifact、Lineage、Receipt、Activity 与演示重置。
- 浏览器内最小持久化、幂等保护和可重复演示数据。

不包含：

- 真实模型推理、Prompt/Skill 执行、MCP/A2A 网络调用。
- 真实宿主文件、账号、日历、通知、支付或 secret 操作。
- 包签名、SBOM、远程 Store、自动更新和吊销。
- 浏览器 DOM 级“不可伪造系统确认”的安全承诺。

### 3.2 Desktop MVP 范围

包含：

- Tauri 2 桌面宿主与 Rust 模块化单体核心。
- First-party、fixed-digest、本地目录 Agent 安装。
- 一个可替换模型 Provider 和本地 Prompt/Skill 装配。
- 受限 MCP client；A2A 先支持本地可验证委托，远程对端保持实验开关。
- A2UI v0.9.1 AIOS Profile、Catalog 与 TCK。
- 文件只读 handle 与日历测试账户写入两类 Resource Broker。
- R0–R3 风险判定、短期 Grant、可信确认、Receipt 与撤销。
- SQLite/CAS、Checkpoint、Outbox、恢复、导出和本地审计查询。

明确不做：

- 自研 OS 内核、驱动、窗口系统或 Linux 发行版。
- 任意第三方 Agent 开放上架和未经验证的自动更新。
- 支付、删除整目录、任意 shell、无域名限制网络等 R4 能力。
- 企业多租户控制平面、跨设备同步和云端长期 Memory。
- 用大而全的微服务平台替代本地模块化单体。

## 4. 实施原则

1. **纵向闭环优先**：每个阶段必须产生从用户动作到可见结果的闭环，而不是先堆一批无法使用的底层模块。
2. **领域语义只定义一次**：Demo 与 Desktop 共享 Mission、Job、Agent、Approval、Artifact、Receipt 等语言；替换基础设施，不重写产品模型。
3. **外部协议均经 Adapter**：A2UI、MCP、A2A 的 wire type 不进入核心领域；协议升级先过兼容测试。
4. **系统能力无旁路**：业务 UI、Agent Runtime、MCP 和 A2UI action 都不能直接调用宿主资源。
5. **演示可重复**：无网络、无密钥、无随机模型输出也能完整演示；所有时序可由测试控制。
6. **生产能力默认拒绝**：能力面宁可小，也不以“先直连、以后加安全”换取进度。
7. **成熟开源优先、关键边界自持**：UI、协议 SDK、图可视化、数据库、Policy 与 sandbox 优先评估成熟项目；Capability ABI、领域模型、AIOS UI Profile 与安全不变量由 AIOS 控制。
8. **每阶段有退出证据**：代码合并不等于完成，必须产出测试、构建、截图/录像、故障注入或审计查询证据。

## 5. 代码与依赖基线

Demo 基线采用：

| 能力 | 采用项 | 使用边界 |
|---|---|---|
| 应用框架 | React 19、TypeScript、Vite | 交互层与开发构建 |
| macOS 风格 UI | `liquidify-react`、Ark UI、Lucide | 经 `src/ui-system` 防腐层使用；业务不依赖内部样式实现 |
| A2UI | `@a2ui/react`、`@a2ui/web_core` | 固定 v0.9 compatibility entry；适配到 AIOS Surface 语义 |
| Mission DAG | `@xyflow/react` | 只读任务投影，不拥有 Mission 状态 |
| 状态与持久化 | Zustand persist | 仅 Demo；生产替换为 Rust Core + SQLite |
| 动效 | Framer Motion | 状态转换与空间连续性；遵守 reduced-motion |
| 验证 | Zod | Demo 输入边界；生产核心使用 Rust 类型和 schema |
| 测试 | Vitest、Testing Library、Playwright CLI | 领域、组件与真实浏览器验收 |

依赖必须精确锁版本并提交 lockfile。开源许可、维护状态、供应链风险与退出路径见 [开源技术评估](../research/open-source-evaluation.md)。其中 `liquidify-react` 维护成熟度不足以直接成为平台 ABI，因此只能存在于 UI System 防腐层；若替换，业务 Feature 不应修改。

Desktop MVP 的目标基线为 Tauri 2、Rust、SQLite WAL、内容寻址存储、Cedar Policy 和 Wasmtime/受限 Worker；正式引入前必须以适配 Spike、许可证、维护活跃度和威胁面重新过评估门槛。

## 6. 目录与所有权

```text
src/
  app/              应用装配、导航和 Demo store
  domain/           框架无关领域类型与状态不变量
  runtime/          可替换的 Demo runtime / engine
  data/             固定演示目录与 fixture
  ui-system/        开源 macOS UI 防腐层与 AIOS token
  features/
    store/           Agent Store 与安装体验
    workbench/       Intent、Context Shelf、Mission DAG
    a2ui/            Adapter、fixture、processor、Surface Host
    approval/        System-owned Trusted Approval
    artifacts/       Artifact、Lineage、Receipt
    activity/        用户活动投影
  test/              跨模块确定性测试
docs/
  product/           产品定位与体验语义
  architecture/      系统边界、信任与恢复
  specs/             Agent Package 与 UI Profile 契约
  decisions/         不可随意漂移的 ADR
  research/          开源证据、风险与退出路径
  mvp/               实施顺序与验收
```

Desktop 阶段新增 Rust workspace 时沿用 [系统架构](../architecture/system-architecture.md) 的模块边界。前端不得成为领域真相源；所有命令通过生成的 typed IPC client 调用 Application Use Case。

## 7. Demo Release 用户故事

### 故事 D1：发现并安装 Agent

**用户目标**：像浏览 App Store 一样理解可安装的 Agent 能力，但不会误认为安装等于授权。

主路径：

1. 用户从桌面侧栏进入 Agent Store。
2. 通过搜索或分类查看六个 Agent，聚焦 featured Agent。
3. 详情区显示发布者、版本、digest、Skill、协议、能力和风险激活方式。
4. 用户点击安装，依次看到 verify → install → commit → completed。
5. 安装成功后回到 Workbench；Agent 出现在能力区域并可被选择。

异常与边界：

- 重复安装返回同一 Installation，不产生重复项。
- 搜索无结果有明确空状态和恢复入口。
- 安装过程中按钮不可重入；关闭 Sheet 不会提交半安装状态。
- 任何能力描述都不显示成“已授权”。

### 故事 D2：Agent 自主生成 A2UI 工作界面

**用户目标**：输入目标并附加上下文后，不依赖聊天滚动，也能看到 Agent 按任务生成结构化工作界面。

主路径：

1. 用户选择已安装 Agent，保留默认目标或输入新目标，确认上下文对象。
2. 启动 Mission 后，状态从 planning 进入 running。
3. Mission DAG 展示研究、综合、日历守卫等 Job 的依赖、进度与阻塞。
4. A2UI Surface 通过正式 processor 依次消费 create/update data model 消息，随 Mission 更新布局和内容。
5. Surface action 只发出 intent；它不能直接改变宿主资源或伪造成功。

异常与边界：

- 未安装 Agent 时启动入口保持禁用并给出前往 Store 的直接动作。
- 无效组件、未知 action、超额或错误消息 fail closed，并呈现可理解的降级状态。
- 快速重复启动只保留最新 Mission 的定时推进，旧 timer 不得污染新状态。

### 故事 D3：自动化在可信确认前停下

**用户目标**：Agent 可自主工作，但对真实世界的高风险动作保留清晰、可验证的最终控制。

主路径：

1. 日历写 Job 到达 guard，Mission 进入 awaiting-approval。
2. Trusted Approval Sheet 位于 Agent Surface 之外，具有稳定系统 chrome。
3. Sheet 展示规范化动作、目标、时间、共享数据、R3 风险、可逆性和 transaction digest。
4. 用户批准后生成唯一 effect key 与 Receipt，Mission 完成并跳转 Artifacts。
5. 用户可在 Activity 看到“为何暂停、为何允许、发生了什么”。

异常与边界：

- 审批不存在或已过期时提交不产生 Receipt。
- 对同一 digest 重复批准返回已存在 Receipt，不重复 effect。
- 用户拒绝时不发生受保护写；状态与 Activity 明确记录拒绝结果。

### 故事 D4：成果、来源与回执可追溯

**用户目标**：任务结束后获得可复用成果，而不是一段消失在聊天记录中的文本。

主路径：

1. Artifact 视图展示标题、版本、摘要、重点与来源对象。
2. Lineage 将 Mission、输入来源、Agent 和 Receipt 关联起来。
3. Receipt 展示 action、principal、policy、result、timestamp、digest 和 effect key。
4. 刷新页面后，Installation、稳定 Mission、Artifact、Receipt 与 Activity 仍可恢复。
5. 用户可一键重置演示，回到确定性首次启动状态。

## 8. Demo Release 实施阶段

阶段按依赖顺序执行。每个阶段退出前不得把未满足项留给后续阶段兜底。

### P0：设计冻结与安全声明

产出：产品愿景、体验规范、统一术语、系统架构、Trust Kernel、Agent Package、AIOS UI Profile、开源评估、ADR 与本文。

退出门槛：

- “AIOS 是宿主之上的元操作环境而非内核”在全部文档中一致。
- Space/Mission/Run/Job/Surface/Artifact/Principal/Grant/ActionIntent/Receipt 无重名异义。
- A2UI/A2A/MCP/Capability ABI 边界和 Trusted UI 所属平面无冲突。
- Demo 能力与生产能力的声明边界明确。

### P1：UI System 与桌面壳

产出：全局 token、开源组件适配、macOS 风格窗口、导航、AgentIcon、键盘焦点、响应式规则和 reduced-motion。

退出门槛：

- 1440×900、1280×800 和 1024×768 下无关键内容裁切或不可达操作。
- 交互目标不小于 44×44 CSS px；键盘可遍历主导航和主要动作。
- 第三方 UI 组件只从 `ui-system` 暴露；Feature 不散落深层导入。
- 对比度、焦点可见性和 reduced-motion 人工检查通过。

### P2：Agent Store 与安装闭环

产出：固定目录、搜索/分类、featured 详情、能力风险、协议标签、安装 Sheet、幂等 Installation 与 Activity。

退出门槛：

- D1 主路径和边界路径在真实浏览器通过。
- 安装状态刷新后恢复；digest 与 AgentDefinition 匹配。
- 两次安装同一 Agent 后 Installation 数量仍为 1。
- 安装文案不暗示永久授权。

### P3：Mission Runtime 与 Workbench

产出：Intent 输入、上下文对象、Agent 选择、Mission/Job 确定性状态机、DAG、取消旧 timer 和 Activity 投影。

退出门槛：

- planning → running → awaiting-approval 顺序稳定、可由 fake timer 测试。
- DAG 状态源自 Mission，不维护第二份业务状态。
- 连续启动两个 Mission 时，前一组 timer 不改变后一 Mission。
- 未安装 Agent 无法进入执行路径。

### P4：A2UI Surface Host

产出：A2UI v0.9 fixture、官方 processor、AIOS component catalog、Surface Host、action intent callback、无效消息降级。

退出门槛：

- D2 全路径通过；createSurface 和增量更新来自 processor 状态。
- 未知/非法消息不渲染危险组件、不执行副作用，并有测试证据。
- A2UI action 只产生 intent event；代码审计找不到直连宿主能力路径。
- Trusted Approval 组件未注册到 Agent Catalog。

### P5：Trusted Approval、Artifact 与 Receipt

产出：系统确认 Sheet、digest/effect key、批准与拒绝、Artifact、Lineage、Receipt、Artifacts/Activity 场景。

退出门槛：

- D3、D4 全路径通过。
- 同一审批提交两次只有一个 Receipt；不存在审批时为 no-op/typed rejection。
- 批准后的 Artifact 与 Receipt 引用同一 Mission 和 action digest。
- Agent Surface 与系统确认的视觉层级、来源标识和代码边界均清楚。

### P6：集成硬化与演示交付

产出：应用装配、持久化恢复、错误边界、自动化浏览器脚本、关键截图、演示说明和生产构建。

退出门槛：

- 清洁安装依赖后 `typecheck`、测试和 production build 全部成功。
- Playwright 从首次状态走完 D1–D4，刷新恢复与演示重置通过。
- 控制台无 uncaught exception、React key/hydration 警告或资源 404。
- 关键视图截图无文字截断、遮挡、焦点丢失和不合理滚动。
- 断网环境可完成整个 Demo；时间、ID 和数据不暴露真实凭证。

## 9. Desktop MVP 实施阶段

### M1：Tauri/Rust 可信核心骨架

建立 Rust workspace、Application/Domain/Ports/Adapters 模块、typed IPC、SQLite migration、CAS、Keychain adapter、错误码和 tracing。React store 降级为 query cache/view state，领域命令由核心处理。

退出门槛：应用可在三大桌面平台的目标环境构建；WebView 无任意 command；数据库升级和降级失败进入可恢复模式；核心 Domain 无 UI/网络依赖。

### M2：Agent Package 与安装生命周期

实现 canonical manifest、schema/语义校验、digest、签名验证、install lock、fixed catalog、启用/禁用、更新、回滚与吊销检查。

退出门槛：篡改 bundle、未知 schema、digest 不匹配、依赖冲突、吊销版本均 fail closed；安装事务崩溃不留下半安装；运行和 Receipt 固定引用已安装 digest。

### M3：隔离 Runtime、真实模型与 Skill

实现低权限 Agent Worker、Provider port、Prompt/Skill 装配、预算、取消、超时、Checkpoint 与结构化输出。先接一个 Provider，Provider 不进入 Domain。

退出门槛：Worker 无默认宿主权限/环境 secret；强制终止后 Core 可恢复；预算和取消可硬性生效；敏感日志脱敏；模型不可直接调用 Tauri/Resource Adapter。

### M4：A2UI Profile 与受控 MCP/A2A

把 Demo Surface 语义迁移到 Rust Core 管理的 revision/checkpoint；实现 A2UI adapter/TCK。接入 allowlisted MCP client 和本地 A2A delegation，完整保留 provenance 与 Principal chain。

退出门槛：协议 fuzz/限额测试通过；版本不兼容确定性拒绝；远端内容进入 Content Plane；MCP/A2A 无法跳过 Broker；Surface 可在 WebView 重载后恢复。

### M5：Capability Broker 纵向能力

实现 Principal、Grant、Policy、ActionIntent、PreparedTransaction、Trusted Approval、effect journal、Receipt、Audit Ledger；开放文件只读 handle 和测试日历写两类 Broker。

退出门槛：

- 没有 Grant、Grant 过期、主体不匹配、目标变化、digest 变化和重放全部拒绝。
- R3 日历写必须通过 transaction-bound Trusted Approval。
- 注入“确认后崩溃”“外部已提交但回写前崩溃”“网络超时”后，不产生不可解释重复副作用。
- 重复 commit 得到同一已提交 Receipt 或明确 replay result。

### M6：恢复、审计与发布硬化

完成 Outbox、启动恢复、unknown 对账、Artifact CAS/Lineage、Activity projection、诊断导出、自动更新安全策略、SBOM、依赖扫描与签名发布。

退出门槛：全部 Desktop MVP 完成定义成立；安全审查、架构审查、无障碍检查和独立验收无未关闭的发布阻断项。

## 10. 端到端架构追踪

| 用户能力 | 入口 | 领域对象 | 可信边界 | 最终证据 |
|---|---|---|---|---|
| 安装 Agent | Store | Bundle、Installation | Package verifier | Installation + audit entry |
| 发起任务 | Workbench | Mission、Run、Job | Application Core | Run checkpoint |
| Agent 生成 UI | Surface Host | Surface revision | A2UI validator/renderer | validated revision + provenance |
| 调用工具 | Runtime | Invocation、ActionIntent | MCP adapter → Broker | tool result provenance / Receipt |
| 委托 Agent | Mission Control | Delegation | A2A adapter + Grant attenuation | principal chain + child Run |
| 日历写入 | Trusted Approval | PreparedTransaction、Grant | Capability Broker | committed Receipt |
| 保存成果 | Artifact View | ArtifactVersion、Lineage | Artifact service | digest + lineage |

这张表必须随能力扩展更新。出现“用户能力没有最终证据”或“可信边界不明确”的行，代表实现尚未完成。

## 11. 测试策略

### 11.1 测试金字塔

- **Domain unit**：状态转换、权限衰减、digest、幂等键、预算与错误分类；纯函数、无时钟/网络。
- **Application contract**：用 fake Clock/Repository/Provider/Resource Adapter 验证事务、重试和恢复。
- **Adapter conformance**：A2UI/MCP/A2A schema、版本、配额、恶意输入和兼容 fixture。
- **Component**：Store、A2UI Surface、Approval、Artifact、Activity 的语义与事件。
- **Integration**：SQLite migration、Outbox、CAS、Keychain、IPC 与 Worker 生命周期。
- **E2E**：真实浏览器/桌面从安装走到 Receipt；刷新、崩溃、断网和重放。
- **Security**：权限旁路、Prompt Injection 载荷、UI 冒充、TOCTOU、replay、secret 泄漏与供应链篡改。

### 11.2 Demo 必跑命令

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Playwright 必须使用本项目锁定版本运行真实浏览器关键路径。每次发布保存测试输出、浏览器控制台检查和关键视口截图；截图是视觉证据，不替代语义断言。

### 11.3 必测不变量

1. 未安装 Agent 不能启动 Mission。
2. 重复安装不会产生第二个 Installation。
3. 旧 Mission timer 不会推进当前 Mission。
4. A2UI 非法消息不渲染、不触发 action。
5. Agent action 不等于 Trusted Approval。
6. 同一 effect key 至多一个 Receipt。
7. Receipt 与 Artifact 引用同一 Mission/digest。
8. 持久化只恢复稳定状态，不把半完成的演示状态伪装成成功。
9. Desktop 中任意受保护资源访问都经过 Broker。
10. 委托后的 Grant 范围不超过父 Grant。

## 12. 发布证据包

每个 Demo Release 必须包含：

- 可复现的 commit 与 lockfile。
- 清洁环境安装、typecheck、test、build 日志。
- 1440×900 和 1024×768 的 Store、Workbench running、Trusted Approval、Artifact 截图。
- D1–D4 自动化路径结果及控制台检查。
- 依赖许可证与安全评估快照。
- 已知限制声明，明确模拟与真实能力边界。

Desktop MVP 额外包含：

- 三平台目标构建与签名证据。
- SBOM、依赖/许可证扫描和包 provenance。
- Broker 安全测试、crash injection、replay/TOCTOU 与 unknown 对账结果。
- 数据迁移、备份恢复、吊销和回滚演练。
- 威胁模型复核与独立安全审查结论。

## 13. 风险登记与 pre-mortem

假设项目失败，最可能不是“界面不够像 macOS”，而是以下系统性原因：

| 风险 | 最早预警 | 影响 | 缓解与停止线 |
|---|---|---|---|
| 退化为聊天壳/Agent 启动器 | 评审只谈 Prompt，不理解 Mission、Artifact、Receipt | 产品定位失效 | 每次演示强制走 D1–D4；没有结构化 Surface 与成果闭环不发布 |
| A2UI 被误当系统 ABI | Feature 直接依赖 wire type；协议升级牵动领域层 | 平台被外部版本绑死 | Adapter + Surface IR + TCK；越层依赖作为架构阻断 |
| Agent 绕过 Broker | 前端/Tauri/MCP 出现直接宿主调用 | 所有安全承诺失效 | 单一 IPC allowlist、静态/运行时审计；发现旁路即停止发布 |
| Trusted UI 可被 Agent 仿制 | Approval 进入 A2UI Catalog 或共享同一来源标识 | 用户被诱导授权 | 系统组件硬隔离、稳定 chrome、transaction digest；冒充测试不通过即阻断 |
| 动态 UI 抖动且不可用 | 焦点丢失、布局跳变、更新风暴 | A2UI 亮点变成负担 | revision、批量更新、布局稳定区、配额、reduced-motion；体验预算超标不扩 Catalog |
| `liquidify-react` 维护停滞 | peer 冲突、安全告警、React 升级受阻 | UI 演进受制 | 仅经 UI System 使用、视觉回归、保留 Ark/原生 CSS 替代；禁止业务深层导入 |
| Demo 伪装成生产安全 | 文案声称真实签名/权限/Receipt | 决策与信任受损 | 明示 Demo badge/限制；生产能力只有 Desktop gate 通过后可声明 |
| 崩溃导致重复副作用 | 恢复后出现两个日历事件 | 数据与信任损失 | prepared transaction、effect journal、Receipt、unknown 对账；crash injection 是发布门槛 |
| 过早微服务化 | 大量 IPC/服务部署但闭环仍不完整 | 进度和一致性失控 | 模块化单体；只有量化隔离/扩缩需求才拆分 |
| 真实 Agent 结果不稳定 | E2E 依赖模型输出、演示频繁失败 | 无法回归与展示 | Demo 固定 fixture；生产用契约测试、record/replay、Provider fallback |
| 供应链失控 | Agent 包/依赖无 digest、SBOM 或回滚 | 恶意更新进入系统 | fixed digest、签名、SBOM、吊销；未验证版本不得运行 |

### 13.1 风险评审节奏

- 每次协议或开源依赖升级：复核 Adapter、许可证、维护状态和退出成本。
- 每增加一类 Resource Broker：更新 threat model、风险分级、Trusted Approval、幂等/补偿和故障注入。
- 每增加一个 Agent Catalog 组件：更新 A2UI TCK、配额、无障碍和冒充风险评估。
- 每个发布候选：由未参与实现的评审者按本文完成定义进行独立验收。

## 14. 决策与变更控制

- 修改“AIOS 是元操作环境”“Capability Broker 唯一入口”“协议与 ABI 分离”必须新增或替代 ADR。
- 修改 Agent Manifest、Capability ABI、Receipt 或 Surface IR 的破坏性契约必须给出版本、迁移与兼容窗口。
- Demo 可替换视觉实现，但不能删除 Agent Store、Mission、A2UI、Trusted Approval、Artifact/Receipt 的闭环。
- Desktop MVP 可缩小真实能力数量，但不能为赶进度开放 Broker 旁路或把 Agent 自绘确认升级为系统确认。
- 任一里程碑的验收证据缺失，状态保持未完成；不存在以阶段性演示代替最终门槛的例外。

## 15. 最终验收清单

### Demo Release

- [ ] D1–D4 可在无网络、无密钥的新环境连续完成。
- [ ] 六个 Agent 可浏览，安装幂等且不等于授权。
- [ ] Mission、DAG、A2UI Surface、Activity 状态一致。
- [ ] 非法 A2UI fail closed，Surface action 只产生 intent。
- [ ] Trusted Approval 独立、精确展示 digest，重复批准不重复 Receipt。
- [ ] Artifact、Lineage、Receipt 可见且稳定状态刷新后恢复。
- [ ] 键盘、焦点、对比度、reduced-motion 和目标视口通过。
- [ ] typecheck、tests、build、Playwright 与控制台检查全部通过。
- [ ] 文档、依赖锁和 Demo 限制声明与实现一致。

### Desktop MVP

- [ ] Tauri/Rust Core 成为领域状态和受保护能力的唯一可信入口。
- [ ] Agent 包 digest/签名/锁定/回滚/吊销闭环通过。
- [ ] Worker 默认无权限、无 secret，崩溃可隔离和恢复。
- [ ] 真实模型、Skill、受限 MCP/A2A 不越过 Adapter 与 Broker。
- [ ] 文件只读与日历写的 Grant/Policy/Approval/Receipt 全链路通过。
- [ ] replay、TOCTOU、crash、timeout/unknown 对账测试通过。
- [ ] SQLite/CAS/Outbox/Checkpoint/Artifact/Audit 可恢复且可迁移。
- [ ] 性能、安全、无障碍、供应链和独立评审均无发布阻断项。

两份清单分别代表不同发布等级；只有第二份全部成立，产品才可以把对应有限能力描述为生产级 AIOS MVP。
