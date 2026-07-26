# AI 共玩斗地主

AlSniper OS 的第一款 Agent 原生游戏，使用 `classic-3p-score-bid@1` 三人规则。默认阵容是 `seat-0` 本地玩家与 `seat-1`、`seat-2` 两名内置 Agent。

## 安全与能力对等

- 权威牌局只存在于 AGAP Host 内。React UI 不读取 `DoudizhuState`，只读取与 Agent 完全相同的 seat-0 `ParticipantPort` 投影。
- 人类点击、键盘操作和 Agent 策略最终都调用 `DoudizhuMatch.submit`，经过相同的 revision、phase、turn nonce、合法动作与幂等校验。
- seat 投影仅包含自己的手牌、公开底牌、公开牌墩、剩余牌数和公开事件；对手手牌、牌堆与随机状态不会进入 UI、ARIA 或自动化文本。
- 洗牌使用 256-bit seed 驱动的 ChaCha20 流、rejection sampling 与 Fisher–Yates；本地 seed 和公开对局 ID 由 Web Crypto 的不同字节生成，重发牌会派生新的 256-bit 密钥。
- Agent UI 只展示“思考中”“已行动”等可验证公共状态，不展示或记录模型思维链。

## 分层

- `DoudizhuCards.ts`：牌与 256-bit ChaCha20 确定性洗牌。
- `DoudizhuCombinations.ts`：完整牌型分类、枚举与比较。
- `DoudizhuEngine.ts`：纯 TypeScript 权威规则状态机。
- `DoudizhuProjection.ts`：座位级信息投影与基线 Agent 策略。
- `DoudizhuAgentAdapter.ts`：斗地主到 AGAP v1 的类型化映射。
- `DoudizhuMatch.ts`：不暴露完整状态的 UI/Agent facade。
- `DoudizhuApp.tsx` 与 `DoudizhuApp.css`：DOM 牌桌、输入、生命周期和自动化。

## 操作

- 鼠标或触控：选牌与操作按钮。
- `←` / `→`：移动手牌焦点；`Space`：选择或取消当前牌。
- `Enter`：出牌；`0`–`3`：叫分；`P`：不要；`H`：提示；`F`：全屏。
- 牌局结算后可选择“再来一局”。

布局使用容器查询适配到 320px 窗口宽度。手牌与动作条在空间不足时独立横向滚动，主要动作保持可达；系统启用 reduced motion 或 forced colors 时会自动降级。

## 运行时保证

- DOM 渲染不引入 Canvas、WebGL、独立 RAF 或第二个模拟循环。
- Agent 思考延迟由共享 `createFixedStepRuntime` 驱动；窗口失活、失焦或隐藏时停止，自动化请求手动时钟后保持 sticky，不再恢复墙钟推进。
- `useGameLifecycle` 统一清理输入和时钟，`useFullscreenController` 负责 Fullscreen。
- 自动化桥仅在窗口活动时注册。`window.render_game_to_text()` 输出紧凑的 seat-0 投影、最近公开事件和合法动作摘要；完整合法动作仍只通过正式 `ParticipantPort` 获取。`window.advanceTime(ms)` 可确定性推进当前连续 Agent 回合。
