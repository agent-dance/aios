# AIOS 术语表

> 状态：设计基线 v1
> 日期：2026-07-25

本文是 AIOS 文档的统一语言。相同概念不得在不同模块中换名；协议字段名可以使用英文，产品界面可使用对应中文。

## 产品与运行域

| 英文术语 | 中文界面名 | 定义 | 不是 |
|---|---|---|---|
| `AIOS` | AIOS | 运行在现有桌面操作系统之上的 Agentic Operating Environment，为 Agent 提供安装、身份、编排、UI、安全能力和可审计执行。 | 自研内核、Linux 发行版或把聊天框铺满桌面的皮肤。 |
| `Space` | 空间 | 用户、策略、记忆、Agent 安装和 Artifact 的隔离边界。 | 普通文件夹或一个聊天会话。 |
| `Mission` | 任务 | 用户希望持续完成的目标及其约束、参与者和输出集合。 | 一次模型请求。 |
| `Run` | 运行 | Mission 的一次可暂停、恢复、取消和重试的执行实例。 | 窗口生命周期；关闭窗口不会自动停止 Run。 |
| `Job` | 作业 | Run 中具有明确输入、输出、依赖、预算和状态的执行单元。 | 任意后台线程。 |
| `Delegation` | 委托 | 上游 Principal 将衰减后的能力和工作交给下游 Principal 的关系。 | 复制用户凭证或把全部权限传下去。 |
| `AgentDefinition` | Agent 定义 | Agent 的不可变逻辑身份与契约，包含 Prompt、Skill、连接声明和 UI/权限元数据。 | 某次运行中的进程。 |
| `Bundle` | Agent 包 | 以内容摘要标识、可签名分发的 Agent 物理制品。 | 可变远程服务本身。 |
| `Installation` | 安装 | 某个 Bundle digest 在一个 Space 中的已验证、已启用记录。 | 永久权限授权。 |

## 界面与数据域

| 英文术语 | 中文界面名 | 定义 | 关键约束 |
|---|---|---|---|
| `Surface` | 面板 | Agent 通过 A2UI 请求、由 AIOS Renderer 验证并原生渲染的声明式 UI 实例。 | 只能使用已批准 Catalog；不能绘制系统权限和支付确认。 |
| `AIOS UI Profile` | UI 规范 | AIOS 冻结的 A2UI 兼容层：协议版本、Catalog、行为语义、安全配额、无障碍与一致性规则。 | 外部 A2UI wire schema 不直接等于 OS ABI。 |
| `Artifact` | 成果 | 由用户或 Run 产生的版本化、内容寻址结果，可包含文档、数据、预览和来源链。 | 不等于临时模型消息。 |
| `Checkpoint` | 检查点 | 可恢复 Run 状态、幂等记录和 Surface 快照的原子持久化边界。 | 对外部不可逆副作用的“时间倒流”。 |
| `Workbench` | 工作台 | AIOS 的桌面主场景，承载对象、Intent Router、Mission 窗口和 Activity。 | 传统图标桌面像素复刻。 |
| `Intent Router` | 意图入口 | 将自然语言和直接操作转换成候选 Mission 计划的系统入口。 | 默认自动执行所有建议。 |
| `Mission Control` | 任务控制台 | 展示 Run/Job/Delegation DAG、状态、预算、来源和阻塞项的控制界面。 | 单纯的聊天记录。 |

## 信任与审计域

| 英文术语 | 中文界面名 | 定义 | 关键约束 |
|---|---|---|---|
| `Principal` | 主体 | 可被认证、授权和追责的用户、Agent runtime、下游 Agent、MCP Server 或系统服务。 | 显示名称不构成身份。 |
| `Grant` | 授权 | Broker 签发的、绑定主体、资源、动作、上下文、预算、时效和策略快照的短期能力。 | 安装时声明的最大权限。 |
| `ActionIntent` | 操作意图 | Agent 或 Surface 提交给 Broker 的结构化副作用提案。 | 已获许可的命令。 |
| `Policy` | 策略 | 确定性授权规则及其版本化快照。 | LLM 的风险判断。 |
| `Receipt` | 回执 | Broker 对策略决定和真实副作用生成的可验证记录，包含幂等键、结果摘要与可选补偿句柄。 | 普通应用日志。 |
| `Capability Broker` | 能力代理 | AIOS 唯一可访问宿主文件、网络、账号、秘密、通知和其他副作用能力的受信入口。 | MCP 网关、A2UI Action handler 或 Tauri command 的同义词。 |
| `Trusted Approval` | 系统确认 | 由受信系统进程从规范化 ActionIntent 生成并绑定摘要的高风险确认界面。 | Agent 可以仿制的 A2UI 弹窗。 |

## 协议边界

| 协议 | 在 AIOS 中的职责 | 不承担 |
|---|---|---|
| A2UI | Agent 到 Renderer 的声明式 Surface 消息。 | 身份、安装、OS 权限、工具执行和进程隔离。 |
| MCP | Agent Runtime 与工具、资源、提示词服务的互操作协议。 | Agent 间任务协作、桌面 UI 和最终系统授权。 |
| A2A | 独立 Agent 之间的发现、任务和消息互操作。 | 本地工具 ABI、UI Catalog 和系统权限。 |
| Capability ABI | 对文件、网络、秘密、账号、通知等宿主资源的类型化请求与回执。 | Agent UI 描述或 Agent 发现。 |

## 必须保持的语言纪律

1. “Agent 已安装”不写成“Agent 已授权”。
2. “A2UI 是声明式协议”不写成“A2UI 是安全沙箱”。
3. “Run 可恢复”不写成“所有外部副作用都可回滚”。
4. “系统确认已通过”只指通过 transaction digest 绑定且未过期的 Trusted Approval。
5. “恰好一次”只用于 Broker effect journal 能证明的副作用提交；模型推理和 UI 消息采用至少一次处理与幂等收敛。
