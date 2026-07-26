Original prompt: 在保持现有视觉、控制、deterministic window.advanceTime/render_game_to_text 和单测语义的前提下，对 Cosmic Vanguard 做生产级性能重构，消除不必要的双循环与每帧全树 React 更新，限制渲染成本并加入合理的自适应质量。

## 2026-07-25

- 架构：移除组件外独立 RAF，模拟由 R3F 的单一帧循环驱动；固定 60Hz 步长与累加余数保持不变。
- 渲染：敌人、子弹、粒子改为 InstancedMesh，玩家变换走 ref；敌人/子弹实例池按需扩容、不随质量档隐藏交互实体，Canvas 不再接收每帧 GameState。
- UI：React 仅发布 mode/score/health/wave/entity-count 低频快照；位置遥测和冷却条直接同步 DOM，避免整棵 React/R3F 树逐帧更新。
- 质量：新增带迟滞、冷却和后台帧过滤的 high/balanced/low 自适应档位，只缩放 DPR、星数与装饰粒子预算；关闭上下文 MSAA 以降低集成 GPU/软件渲染器的常驻填充成本。
- 引擎：弹体和粒子移动/剔除合并为单遍；密集实体使用保持原实体顺序语义的 Z 轴 sweep-and-prune broadphase，小规模场景保留低开销直接比较。
- 控制：修复 Launch click 事件误当 shootOnStart、重启/失焦/停用残留输入；检测官方客户端预注入标记并从挂载时接管手动时钟，普通环境则在首次 advanceTime 接管，拒绝非有限时长。
- 视觉：粒子继续单 draw call，并通过 instanceLife shader attribute 保留逐粒子 scale/opacity 衰减；低多边形实体改用 Lambert、弹体/粒子改用高亮 Basic 材质，保留原配色与发光感同时降低 PBR 像素着色成本。
- 已通过：根 typecheck、根生产 build、独立游戏 build；全仓 6 文件 / 23 测试，游戏固定步与引擎聚焦测试全部通过。
- 浏览器：官方客户端两次完全相同流程的 state JSON SHA-256 一致；移动、射击、命中得分、冷却/遥测同步、粒子 shader 编译及截图均通过，未生成 console error 文件。
- 时钟：固定步累加使用精确有理步进单位，等价 elapsed-time 分片严格产生相同 tick 数；最小化保持游戏组件挂载并暂停，恢复后继续同一战局。
- 当前无未完成事项。

## 2026-07-26 Agent 共玩接入

- 迁移图：`gameEngine` 继续作为纯确定性模拟；新增的 `SpaceGameMatch` 组合并独占共享 `FixedStepRuntime`，通过 `game-platform/agent` 的 AGAP v1 类型与稳定错误码发布 seat-bound `ParticipantPort`；App 继续复用 `game-platform/web` 与 `game-platform/r3f`，没有新增 RAF、模拟时钟或玩法镜像。
- 形式能力：单一 `pilot` 座位；人类键鼠和 Agent 都只提交 `SpaceGameAction`。playing 的完整 legal set 为 9 个移动方向 × fire on/off × 5×3 量化瞄准格，共 270 个复合锁存控制，加 pause/restart；start、resume 与 restart 在对应 phase 进入同一权威验证路径。
- 实时决策：60 Hz tick 仅更新 `observationTick`，不会逐帧让 LLM 重规划；控制窗为 15 tick / 250 ms，异步 Agent driver 限定 250–500 ms 调度并对 phase/health/wave 关键变化提前唤醒。inactive/hidden/unmount 会 abort 在途请求并清除锁存输入；失败不会注入未验证的后备动作。
- 安全/一致性测试：覆盖 descriptor 和 272 项 playing legal actions、human/Agent 相同 action timeline、seat 绑定、隐藏 seed/nextId/particles、stale phase/revision/nonce、非法 action、幂等冲突/重放、event/receipt 容量 fail-closed、250 ms 控制窗、async cancel/failure、lifecycle stop/restart request-id 隔离、paused/lifecycle freeze、restart 与 one-call/two-part 2000 ms 确定性。聚焦 4 files / 22 tests 通过。
- 官方客户端：使用仓库规定的 `develop-web-game` Playwright 客户端验证 Launch、左右移动、Space 射击、可见 Pause/Resume、Restart、Fullscreen、虚拟时钟和 `render_game_to_text`。逐张人工核对 playing/fire/paused/resumed/restarted/fullscreen 截图与 JSON；fire 截图和文本均显示同一枚 bullet；两次全新页面的相同 fire timeline 状态文件 SHA-256 完全一致；所有最终场景均无 console/page error。
- 门禁/生产构建：根 typecheck、10 项脚手架测试、36 files / 257 项 Vitest、独立游戏 build 与根 production build 通过；独立 Vite 产物 `assets/index-0L7dkMiv.js`、根游戏 chunk `assets/space-game-DjxzdQSr.js`。没有基于软件/未知 WebGL renderer 声称绝对 FPS。浏览器验证目录和预览进程已精确清理，`test-artifacts` 不存在。
- 当前无未完成项、临时目录或已知失败。

## 2026-07-26 Lifecycle and connectivity hardening

- Authority/身份：控制模式与 participant binding 在 authority session 挂载时一次锁定；sidecar health 只改变 controller availability。OS composition 固定声明 `assist`，掉线/恢复不会重建 match、matchId、port、seed 或清空战局；不可用的 agent-only 座位通过同一 formal action port 回退给人类。
- 手动时钟：`window.advanceTime` 接管前同步 stop/abort wall-clock Agent driver；初始 `__vt_pending` 同样禁止 driver 启动。controller 即使忽略 AbortSignal，异步结果返回后也会再次检查 sticky manual-clock capability 并被拒绝，挂载期间没有切回实时钟的路径。
- 同步撤销：foreground、simulation、lifecycle、controller identity 统一进入同步 capability gate。旧 keydown/keyup、pointer、Fullscreen、`render_game_to_text`、`advanceTime` 和 Agent async callback 在调用时复验；blur/hidden/inactive 与 controller replacement 在 layout/lifecycle 边界同步 stop driver，消除 passive-effect 授权窗口。
- 关闭窗口：shell 会直接卸载关闭的应用，因此 Space 在组件级 layout cleanup 中先同步撤销 foreground/simulation/lifecycle gate，再 abort Agent driver 并清空锁存输入；旧 Agent 结果、automation global 与键盘闭包即使等待 passive cleanup 也无法再提交或推进 authority。cleanup 的 setup 会恢复 Strict Mode 开发期 effect replay 后的当前挂载能力。
- 全局键盘隔离：keydown 在 Alt/Ctrl/Meta、IME、已被处理事件以及 input/textarea/select/button/link/contenteditable 内 fail closed，避免 `Alt+Space` 助手语音同时触发开火；keyup 只释放此前由玩法实际锁存的移动/开火键，因此编辑器或系统快捷键的孤立 keyup 不产生 action，合法锁存又不会因修饰键或焦点迁移而卡住。
- 平台化复用：键盘隔离规则沉淀为 `game-platform/web/gameKeyboard` 的共享契约并由 Space 与斗地主共同消费；共享谓词 3 项单测覆盖修饰键、IME、已处理事件、交互/可编辑祖先与异常 DOM target。唯一脚手架探针 `keyboard-contract-probe-20260726` 通过 2 files / 6 tests 和根 typecheck 后已精确清理。
- 可执行回归：新增 control-mode latch、capability gate、late async result/manual-clock rejection、同步 unmount 撤销、修饰键/编辑目标隔离及 React wiring contract 测试。Space 聚焦 6 files / 34 tests；此前全仓 45 files / 310 tests、10 项脚手架、根 typecheck 与 production build 均通过；Space chunk 为 `assets/space-game-BzfV7zs5.js`（41.47 kB，gzip 14.29 kB）。官方客户端完成 Launch → Left → Space 两次迭代，人工核对 playing/射击截图及包含 `observationTick/currentControl` 的文本状态，无 console/page error 文件，本次独立验证目录与进程已精确清理。
- 当前无未完成项、临时目录或已知失败。

## 2026-07-26 Authority contract hardening

- 权限边界：`SpaceGameMatch` 不再公开完整 `GameState` / `InputState`；R3F、HUD 和 publish observer 仅接收拷贝的 `SpaceGameRenderProjection`，其中没有 seed、nextId、生成调度、实体速度/伤害参数或输入能力。人类控制只读取有限的 formal `currentControl`，仍经同一 `ParticipantPort.act` 提交。
- 原子性：publish observer 执行期间启用 Host reentrancy barrier，seat-bound `observe/listLegalActions/act/readEvents` 和 match mutation 均 fail closed；恶意回调测试证明外层 250ms advance 只旋转一次 revision/nonce，事件流未被插入。
- 热路径：每帧 fixed-step 后仅比较单调的 critical observation version；完整 Agent observation 只在真实 planner 拉取，或 phase/health/wave 改变时构造，不再每帧复制 enemies/bullets。`render_game_to_text` 新增 `currentControl` 与 `observationTick`，paused advance 同时冻结玩法与 observation tick。
- 运行态：新增向后兼容的 `simulationActive`，将已打开后台窗口的模拟/Agent 生命周期与 `isActive` 前台人类输入/automation 能力分离；失焦会清除人类锁存输入，但不会擅自暂停仍在运行的战局。
- 门禁：Space adapter/controller/engine/render-quality 共 4 files / 24 tests 通过，覆盖 restricted projection、observer 重入攻击、轻量 critical version、固定步、Agent 时序及人机 action parity；根 typecheck、10 项脚手架测试、42 files / 290 项 Vitest 与 production build 全部通过，Space 生产 chunk 为 `assets/space-game-BXhc5ZJZ.js`（39.29 kB，gzip 13.57 kB）。
- 官方客户端：使用规定的 `develop-web-game` 客户端两次从全新页面执行 Launch → Left → Space；人工核对两张 playing/射击截图，画面 HUD、舰船位移和弹体与文本一致，state JSON 明确包含 `observationTick` / `currentControl`。两轮 `state-0` SHA-256 均为 `6F2E8C6256D1BD798811FA24E25E93778A6FE922017016F4BA131FA744F13929`，两轮 `state-1` 均为 `BBC2942B775968D3495141729B5CD721DA5359AFDB4086EDEE8DE3CF59C5AD31`，无 console/page error 文件；精确清理验证目录与本次独立 Vite 进程。
- 当前无未完成项、临时目录或已知失败。

## 2026-07-25 平台基座迁移

- 运行时：Cosmic Vanguard 已改为 `createFixedStepRuntime` 的真实消费者；固定步长、余数、输入与批次发布由共享 runtime 统一管理，玩法仍完全委托给 `advanceGame`。
- R3F：本地帧驱动、自适应质量状态机和容量计算已删除，改用 `FixedStepDriver`、共享 `AdaptiveDpr` controller 与 `nextPowerOfTwoCapacity`，保留游戏专属画质 profile 和 34ms 防螺旋上限。
- Web：自动化全局、虚拟时钟接管、失焦/隐藏/停用生命周期以及 Fullscreen API 已分别迁移到 `useGameAutomationBridge`、`useGameLifecycle`、`useFullscreenController`；停用仍暂停并保留完整战局。
- 门禁：根 typecheck、生产 build、7 项脚手架测试及 17 文件 / 120 项 Vitest 全部通过；官方 web-game 客户端完成移动、持续射击与确定性时间推进，`render_game_to_text` 保持原 schema，两次动作回放状态哈希严格一致且截图已人工确认视觉正常。
- 平台硬化：单次同步推进采用 240 tick / 4 秒双层预算，保留 `advanceTime(2000)` 契约；R3F 非法正优先级快速失败，持续极慢帧可可靠降档；Fullscreen 只操作本游戏目标元素。
- 当前无未完成事项。
