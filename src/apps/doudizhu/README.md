# AI 共玩斗地主

AlSniper OS 的第一款 Agent 原生游戏，使用 `classic-3p-score-bid@1` 三人规则。默认阵容是 `seat-0` 本地玩家与 `seat-1`、`seat-2` 两名内置 Agent。

## 安全与能力对等

- 权威牌局只存在于 AGAP Host 内。React UI 不读取 `DoudizhuState`，只读取与 Agent 完全相同的 seat-0 `ParticipantPort` 投影。
- 人类点击、键盘操作和 Agent 策略最终都调用 `DoudizhuMatch.submit`，经过相同的 revision、phase、turn nonce、合法动作与幂等校验。
- seat 投影仅包含自己的手牌、公开底牌、公开牌墩、剩余牌数和公开事件；对手手牌、牌堆与随机状态不会进入 UI、ARIA 或自动化文本。
- 洗牌使用 256-bit seed 驱动的 ChaCha20 流、rejection sampling 与 Fisher–Yates；本地 seed 和公开对局 ID 由 Web Crypto 的不同字节生成，重发牌会派生新的 256-bit 密钥。
- Agent UI 只展示“思考中”“已行动”等可验证公共状态，不展示或记录模型思维链。
- 真实 Agent 通过 `DoudizhuAgentControllerFactory` 在组合根按 `(matchId, seatId)` 创建独立控制器；传出的 `seatKey` 只用于会话隔离，不是授权凭据。
- 异步控制器只能收到完整的座位级 `SeatObservation` 与同窗口 `LegalActionSet`。决策开始时冻结 revision、phase 与 turn nonce，返回后仍用原窗口提交，过期结果不会通过重新观察被包装成新动作。
- 控制器超时、异常或非法输出按显式策略回退到确定性启发式动作；用户取消、显式暂停、换席、新局替换、窗口关闭或组件卸载只会中止，不会偷偷回退并行动。
- 控制器 factory 属于运行时身份边界。factory 变化会在提交阶段立即中止旧请求、撤销其单飞 token 并清空旧 controller cache；即使旧 controller 忽略取消后延迟返回，AbortSignal 门禁也会阻止其提交动作。

## 分层

- `DoudizhuCards.ts`：牌与 256-bit ChaCha20 确定性洗牌。
- `DoudizhuCombinations.ts`：完整牌型分类、枚举与比较。
- `DoudizhuEngine.ts`：纯 TypeScript 权威规则状态机。
- `DoudizhuProjection.ts`：座位级信息投影与基线 Agent 策略。
- `DoudizhuAgentAdapter.ts`：斗地主到 AGAP v1 的类型化映射。
- `DoudizhuMatch.ts`：不暴露完整状态的 UI/Agent facade。
- `DoudizhuOrchestration.ts`：安全随机新局、sticky 手动时钟与异步 Agent 单飞门禁。
- `DoudizhuApp.tsx` 与 `DoudizhuApp.css`：DOM 牌桌、输入、生命周期和自动化。

## 操作

- 鼠标或触控：选牌与操作按钮。
- `←` / `→`：移动手牌焦点；`Space`：选择或取消当前牌。
- `Enter`：出牌；`0`–`3`：叫分；`P`：不要；`H`：提示；`F`：全屏。
- 牌局结算后可选择“再来一局”。

布局使用容器查询适配到 320px 窗口宽度。手牌与动作条在空间不足时独立横向滚动，主要动作保持可达；系统启用 reduced motion 或 forced colors 时会自动降级。

## 运行时保证

- DOM 渲染不引入 Canvas、WebGL、独立 RAF 或第二个模拟循环。
- Agent 思考延迟由共享 `createFixedStepRuntime` 驱动。经用户明确授权，已打开且未显式暂停的游戏可在其他 OS 窗口取得焦点时继续模拟和调用 Agent，以支持同一 sidecar 并行参与多个对局；浏览器窗口失焦、页面隐藏、游戏关闭或卸载仍会暂停并中止。
- `isActive` 只授予人类键盘输入、Fullscreen 与开发自动化桥；`simulationActive` 独立控制牌局时钟和 Agent。非焦点游戏不会接收人类输入，也不会暴露其 `window.*` 自动化桥给 Agent。
- 焦点、页面可见性和模拟生命周期使用同步 capability ref 撤销：blur/hidden/关闭/卸载会先 Abort 当前 controller，再等待 React 更新；旧按钮闭包、Fullscreen handler 或尚未清理的自动化函数也会在调用时重新校验，不能跨越撤销边界。
- 实时模式每次只允许当前顺序席位有一个异步决策；不同席位拥有不同 controller/session，因而同一 Agent 进程可安全并行服务其他对局与席位。
- `window.advanceTime(ms)` 保持同步确定性，并固定使用本地启发式策略；自动化时钟不会等待网络或 LLM，也不会复用未完成的实时决策。
- `useGameLifecycle` 统一清理输入和时钟，`useFullscreenController` 负责 Fullscreen。
- 自动化桥仅在窗口活动时注册。`window.render_game_to_text()` 输出紧凑的 seat-0 投影、最近公开事件和合法动作摘要；完整合法动作仍只通过正式 `ParticipantPort` 获取。`window.advanceTime(ms)` 可确定性推进当前连续 Agent 回合。
