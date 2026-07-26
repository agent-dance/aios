# AGAP v1：Agent 共玩游戏契约

AGAP（Agent Game Access Protocol）是 AlSniper OS 游戏与参与者之间的统一领域协议。它的目标不是给 Agent 一条“调试后门”，而是把人类 UI 使用的观察、合法动作、提交、回执和事件能力抽成同一个座位能力对象。人类控制器和 Agent 控制器都只能通过绑定到座位的 `ParticipantPort` 参与游戏。

实现位于 `src/game-platform/agent`，只依赖纯 TypeScript，不依赖 React、DOM、渲染器、网络协议或任何具体游戏。

## 能力等价

“人机能力绝对一致”在 AGAP 中有可测试的定义：

1. 同一座位、同一 revision 下，人类与 Agent 获得完全相同的 `SeatObservation`、`LegalActionSet` 和可见事件。
2. 两者提交完全相同的 `ActRequest`，经过同一权威合法性检查和同一状态转移，得到完全相同的回执与结果。
3. `ParticipantKind` 只用于审计和产品展示，绝不参与授权、信息裁剪、合法动作或胜负计算。
4. 不允许 Agent 获取引擎全状态、对手隐藏信息、随机源或人类 UI 不具备的动作；也不允许 UI 绕过协议直接改引擎状态。
5. 视觉、动画和输入设备是不同的呈现方式，不是不同的游戏能力。UI 必须把点击/拖拽/键盘意图映射成 `LegalAction.action`，Agent 则直接选择同一个 action。

因此，“一致”指可决策信息与可产生的游戏效果一致，而不是强迫 Agent 模拟像素坐标或让人类阅读 JSON。

## 分层与标准借鉴

AGAP 不替代现有标准；它位于游戏权威内核和通用 Agent 传输协议之间：

```text
游戏纯领域状态机
  ↕ SequentialGameAdapter（观察投影、合法动作、转移、可见事件）
AGAP 权威 Host
  ↕ 绑定座位的 ParticipantPort
人类 UI 控制器          本地 Agent 控制器
                         ↕ 可选 MCP tool/resource adapter
                         ↕ 可选 A2A remote-agent gateway
远程权威服务则把 AGAP Host 放在服务端，客户端只持有经认证的座位 capability
```

- [OpenSpiel](https://openspiel.readthedocs.io/en/latest/concepts.html) 提供了 `State → observation/information state → legal actions → apply action`、显式 chance node、顺序/同时行动等成熟博弈抽象。AGAP 借鉴其信息集与合法动作边界，但不引入 C++/Python 运行时，也不把 OpenSpiel action 整数直接暴露为产品协议。
- [PettingZoo AEC API](https://pettingzoo.farama.org/main/api/aec/) 验证了顺序多 Agent 的 observe/action cycle；其 [Parallel API](https://pettingzoo.farama.org/main/api/parallel/) 验证了按 Agent 提交同时动作的模型。AGAP v1 的类型已用 `DecisionWindow.mode` 和 `activeSeatIds` 为两者留出统一形状，当前权威实现只接受 `sequential`，不伪装已经实现同时提交语义。
- [MCP](https://modelcontextprotocol.io/specification/2025-11-25/) 适合把 descriptor/observation/events 暴露为 resources，把 legal-actions/act 暴露为 tools；它负责模型上下文和工具调用，不负责座位授权、回合并发或游戏规则。MCP 适配层必须把认证上下文绑定到一个 `ParticipantPort`，不得让 tool 参数携带可替换的 `seatId`。
- [A2A](https://a2a-protocol.org/latest/specification/) 适合远程 Agent 的发现、能力声明、任务与消息生命周期；它不应成为逐步游戏状态机。A2A gateway 可发现玩家 Agent 并承载“加入/继续比赛”任务，实际每步仍调用受约束的 AGAP capability。

仓库当前不引入 OpenSpiel、PettingZoo、MCP SDK 或 A2A SDK：核心协议不需要这些运行时，贸然添加会让浏览器包承担无收益依赖。需要远程互操作时，应新增独立 adapter，并以 AGAP conformance tests 证明没有扩大能力。

## 核心对象

### Descriptor

`GameDescriptor` 提供稳定的 `gameId` / `gameVersion`、座位、顺序或同时行动模型、完全或不完全信息模型，以及机器可读 metadata。斗地主的 metadata 应声明规则变体、牌型/动作 schema、计分版本、时间约束和可选能力；改变规则语义必须提升 `gameVersion`。

### 座位绑定

`host.bindParticipant({ seatId, participantId, kind })` 是受信任组合根的操作，返回只绑定一个座位的 `ParticipantPort`。Port 的 `observe`、`listLegalActions`、`act`、`readEvents` 均不接受 `seatId`，从接口结构上消除调用者伪造其他座位参数的路径。同一座位不可重复绑定。

本地单机中，受信任组合根是游戏应用创建 Host 并分配人类/Agent 控制器的代码。生产远程场景中，`bindParticipant` 只能在服务端认证与房间授权之后执行，绝不能直接成为公开 RPC。

公开 `matchId` 必须是调用方生成的、不透明且与洗牌种子、随机状态、牌序等秘密完全独立的标识。领域引擎不得从 seed 派生公开 ID；本地练习局使用 Web Crypto 一次生成 48 字节，前 32 字节作为 ChaCha20 确定性洗牌密钥、后 16 字节作为独立公开 ID。生产对局由隔离的权威服务生成并保存至少 256-bit 的秘密随机性。

### Observation 与 legal actions

`observe()` 返回座位裁剪后的快照：`revision`、`terminal`、`DecisionWindow` 和具体游戏 observation。`listLegalActions()` 返回同一个版本窗口内的完整合法动作。斗地主必须只在 observation 暴露本方手牌、公开出牌与人类界面可见统计；底牌、对手手牌和洗牌种子不得泄露。

所有跨边界值必须是 JSON-shaped，Host 会验证并复制输入输出。调用者修改拿到的 descriptor、observation、actions、receipt 或 events 不会改变权威状态。

### Act 与回执

提交格式为：

```ts
port.act({
  requestId: 'agent-7:turn-12:choice-1',
  expectedRevision: observation.revision,
  expectedPhase: observation.decision.phase,
  turnNonce: observation.decision.turnNonce,
  action: chosenLegalAction.action,
});
```

Host 依次验证：

1. `requestId` 幂等记录；
2. 游戏尚未终态；
3. `expectedRevision`、`expectedPhase` 和 `turnNonce` 都属于当前决策窗口；
4. Port 绑定座位是当前 active seat；
5. action 与权威 `legalActions` 中某项规范化后完全一致；
6. 由 adapter 执行一次状态转移并原子提交 revision、事件和 receipt。

相同 `requestId` + 相同完整 payload 始终重放原 receipt，即使网络响应丢失后游戏已继续或终局；相同 `requestId` + 不同 payload 返回 `AGAP_IDEMPOTENCY_CONFLICT`。Sequential Host 的成功 receipt 明确携带 `disposition: 'committed'`，表示 revision 已原子推进。Host 不驱逐幂等记录；达到配置容量时拒绝新动作，以免悄悄破坏 at-most-once 语义。

### Events

每个座位拥有独立、无间断、从 1 开始的事件序列，可用 `afterSequence` 增量续读。公开事件复制到全部座位；私有事件只进入明确目标座位的 channel，因此其他座位不会通过全局序列缺口推断私有事件数量。

具体游戏若在 observation 中提供可见历史，其 `index` 也必须按该座位的可见流重新连续编号；不得透传 authority 全局历史下标。adapter failure 对参与者仅暴露稳定错误码与安全 operation，不得通过 `cause`、异常消息或自定义字段带出原始 adapter 异常；原始诊断只能进入受信任 telemetry。

标准顺序为：`match.started`；每次成功提交后按 adapter 顺序发布 `game.event`，然后发布 `state.advanced`；终局再发布 `match.ended`。失败请求不改变状态、revision、事件或幂等记录。

## 稳定错误语义

所有预期拒绝均抛出 `AgapError`，调用方只应把 `code` 作为程序契约，文案用于诊断：

| code | 含义 |
| --- | --- |
| `AGAP_NOT_YOUR_TURN` | 当前 capability 的座位无权在此窗口行动 |
| `AGAP_STALE_REVISION` | observation 已过期，应重新观察 |
| `AGAP_PHASE_MISMATCH` | 阶段已改变，应重新观察 |
| `AGAP_TURN_NONCE_MISMATCH` | 决策窗口已改变，应重新观察 |
| `AGAP_ILLEGAL_ACTION` | action 不在权威 legal set |
| `AGAP_IDEMPOTENCY_CONFLICT` | requestId 被不同 payload 重用 |
| `AGAP_GAME_TERMINAL` | 比赛已经结束 |
| `AGAP_RECEIPT_CAPACITY_EXCEEDED` | 幂等容量已满，Host fail closed |
| `AGAP_EVENT_CAPACITY_EXCEEDED` | 某座位事件日志已满，Host 原子拒绝而不丢游标历史 |
| `AGAP_REENTRANT_OPERATION` | adapter 回调试图重入 Host；Host 拒绝嵌套读写入口 |
| `AGAP_INVALID_REQUEST` | 请求结构或标量非法 |
| `AGAP_ADAPTER_FAILURE` | 具体游戏 adapter 异常，状态不提交 |

`STALE_REVISION`、`PHASE_MISMATCH`、`TURN_NONCE_MISMATCH` 标记为 retryable，但重试前必须重新 observe/listLegalActions；其他错误不得盲重试。

Adapter 回调必须是纯函数式、不可重入。Host 在完整 `act` 事务以及 `observe`、`legalActions`、状态事实读取和 `transition` 回调期间设置重入屏障；回调不得再次调用 Host/ParticipantPort 的 descriptor、observation、legal-actions、events、act 或 bind 入口。尤其禁止在 `transition` 内提交另一个 action，否则会破坏 single-writer 与原子回滚。重入会被稳定拒绝，且不会产生嵌套 receipt、state 或 event。

## Sequential v1 与未来 simultaneous

斗地主的叫分与出牌主体是顺序决策，首个实现使用 `createSequentialAgentGameHost`。它要求每个非终态恰好一个 active seat，终态没有 active seat。两名农民的加倍采用确定座位顺序提交、提交值私有、全部提交后统一公开，因此后提交者无法观察先提交者的选择；未来 simultaneous Host 可在不改变 action 与 observation schema 的前提下把该阶段升级为真正并发的密封提交。

顺序 Host 支持一个或多个座位，因此同一契约也覆盖由 human 或 Agent 控制的单人游戏；“共玩”能力不是强制多人。默认每座位最多保留 10,000 个事件、每座位最多保留 10,000 个 receipt，应用可按比赛上限显式收紧或提高。达到上限时动作整体回滚并 fail closed，不驱逐仍可能被重试或续读的历史；长期在线游戏应在远程持久化 adapter 中按已确认 cursor 做分段归档，而不是静默丢弃。

未来同时行动游戏复用 descriptor、observation、legal action、event 与座位 capability，但需要独立的 simultaneous Host，并使用已预留的 `SealedActionReceipt`：`disposition: 'sealed'` 只表示该座位动作已密封，公共 revision 尚未推进；全体提交或截止后再产生 `disposition: 'committed'` 的 resolution receipt。实现还必须增加同一 nonce 每座位一次提交、未提交者不可见、原子 resolve、每座位独立幂等与超时策略。不得用当前 sequential Host 逐个收集同时动作，否则提交顺序会泄漏信息并改变博弈语义。

## 本地与生产安全边界

### 本地浏览器

- AGAP 防止普通参与者 API 通过 seat 参数越权，并确保隐藏信息经过 seat projection。
- 同一 JavaScript realm 内的恶意代码仍可能借助开发者工具、模块引用或内存检查突破边界；本地模式的目标是产品正确性、测试一致性和 accidental leakage 防护，不宣称对设备所有者形成机密隔离。
- 人机混玩时，Agent 只能收到绑定 Port 的复制快照；不得把完整 domain state、React store 或调试 bridge 作为上下文。

### 生产远程权威

- 洗牌、随机种子、计时、规则验证、revision、幂等记录和事件日志必须位于服务端权威 Host；客户端只渲染 observation 并提交 action。
- 认证主体、match、seat 和 ParticipantPort capability 必须在服务端绑定；禁止信任请求体中的 `seatId`、`participantKind` 或客户端 legal-actions。
- 远程 MCP 必须遵循其 OAuth resource/audience binding 与最小权限要求，禁止 token passthrough；A2A Agent Card 不放静态秘密，敏感扩展卡必须受认证保护。
- 需要 TLS、速率限制、动作/请求大小限制、截止时间、断线恢复、审计日志和服务端重放保护。日志只记录必要的审计标识与 action hash，不记录未脱敏的隐藏牌面或模型上下文。

## 斗地主接入约束

斗地主 adapter 应把叫分（0/1/2/3）、农民加倍/不加倍、地主再加倍/不再加倍、出牌、不要、托管确认等全部建模为 action，而不是 UI 专用回调。首版规则固定为 `classic-3p-score-bid@1`，不得混入“叫地主/抢地主”规则。每个阶段都由 `Phase`、active seat、legal set 和 turn nonce 完整描述。洗牌/发牌是权威引擎的显式确定性过程；测试使用固定 256-bit 种子，生产种子由安全随机源生成且不进入参与者 observation，不得以 32-bit 非密码学 PRNG 承载隐藏信息牌局。

最小验收必须覆盖：三种 human/agent 座位组合、每个叫牌与出牌阶段、所有牌型与压制规则、非法牌/越权/过期请求、重复请求、事件恢复、断线重连、春天/反春、炸弹倍数、结算、终局冻结，以及相同 seed + action timeline 的确定性重放。
