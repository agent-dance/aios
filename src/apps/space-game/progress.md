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
- 当前无 TODO。

## 2026-07-25 平台基座迁移

- 运行时：Cosmic Vanguard 已改为 `createFixedStepRuntime` 的真实消费者；固定步长、余数、输入与批次发布由共享 runtime 统一管理，玩法仍完全委托给 `advanceGame`。
- R3F：本地帧驱动、自适应质量状态机和容量计算已删除，改用 `FixedStepDriver`、共享 `AdaptiveDpr` controller 与 `nextPowerOfTwoCapacity`，保留游戏专属画质 profile 和 34ms 防螺旋上限。
- Web：自动化全局、虚拟时钟接管、失焦/隐藏/停用生命周期以及 Fullscreen API 已分别迁移到 `useGameAutomationBridge`、`useGameLifecycle`、`useFullscreenController`；停用仍暂停并保留完整战局。
- 门禁：根 typecheck、生产 build、7 项脚手架测试及 17 文件 / 120 项 Vitest 全部通过；官方 web-game 客户端完成移动、持续射击与确定性时间推进，`render_game_to_text` 保持原 schema，两次动作回放状态哈希严格一致且截图已人工确认视觉正常。
- 平台硬化：单次同步推进采用 240 tick / 4 秒双层预算，保留 `advanceTime(2000)` 契约；R3F 非法正优先级快速失败，持续极慢帧可可靠降档；Fullscreen 只操作本游戏目标元素。
- 当前无 TODO。
