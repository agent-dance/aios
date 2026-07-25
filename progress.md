Original prompt: 参考 macOS 最新操作系统，创建一个现代、有精美桌面和 UI 的浏览器内操作系统，命名为“AlSniper OS”；包含系统状态弹窗、时钟、底部快捷栏、主题切换、可交互 3D 太空射击游戏、Finder、计算器、设置、命令行终端和 App Store。

## 2026-07-25

- 仓库没有既有应用源码或提交，采用 React 19 + Vite 8 + TypeScript 7。
- 3D 游戏采用 Three.js + React Three Fiber，桌面/窗口/应用由 React 与 Zustand 组成。
- 已完成：桌面壳、窗口管理、Dock、状态中心、时钟/日历/Focus、主题和响应式窗口约束。
- 已完成：Finder、Calculator、Settings、Terminal、App Store 与 Cosmic Vanguard 3D 射击游戏。
- 已验证：生产构建、15 个单元测试、Playwright 桌面关键路径、App Store 安装、主题切换、Terminal 命令、Calculator 键盘计算。
- 已验证游戏：`render_game_to_text` / `advanceTime`、移动、射击、命中得分、生命、波次、暂停语义、重开以及实际游戏截图。
- 修复：Clock 重复 key 警告、非活动应用全局键盘冲突、游戏父级 pointer capture 阻断按钮点击、Calculator 默认窗口裁切。
- 发布复验：800×700 下 Finder 自动收起预览栏、工具栏无横向溢出且窗口与 Dock 保持间距；1440×900 下 Calculator 全部按键、历史和说明完整可见。
- 窄窗复验：基于窗口容器查询重排 Settings 与 App Store；390×700 下均无横向溢出，App Store 可滚动到安装操作并完成持久化安装。
- 最终门禁：`npm run typecheck`、`npm test`（4 文件 / 15 测试）、`npm run build` 全部通过；非游戏桌面关键路径控制台无 error/warning。
- 当前无功能 TODO。

## 2026-07-25 性能优化

- 优化前基线（1440×900、相同 Chromium headless 环境）：桌面 idle 约 60 FPS；游戏开始界面约 22 FPS；游戏进行中约 23 FPS，P95 帧时间约 50 ms。
- 已保存 develop-web-game 官方客户端的优化前动作/状态/截图到 `output/perf-baseline`；后续使用同一动作序列对比。
- 已定位主要热路径：游戏固定步每帧触发 React/R3F 全树更新、R3F 与独立 rAF 双循环、高 DPR/抗锯齿，以及窗口 pointermove 高频写全局 Zustand。
- 游戏主循环已收敛为 R3F 单一帧时钟与固定步模拟；React 不再逐帧接收完整游戏状态，非运行态使用 demand rendering，暂停/开始界面稳定后为 0 WebGL draw call。
- 敌人、子弹与粒子已改为动态实例池和批量绘制；当前硬件 WebGL 实测约 6.8 draw calls/frame，质量控制具备 EMA、迟滞和冷却，MSAA 与不必要的高成本材质已移除。
- 窗口拖拽/缩放改为 requestAnimationFrame 合帧的局部 DOM 预览，只在 pointerup 提交一次全局状态；游戏窗口及交互期间不再执行无收益的背景模糊合成。
- 修复游戏启动点击误触发射击、重启/失焦残留输入、手动时钟非有限输入、键盘默认行为与密集碰撞路径；两次相同官方动作序列的最终状态哈希一致。
- 最终硬件性能门禁（Chromium 149、Intel D3D11、1440×900、DPR 1）：运行与移动射击均约 170 FPS，P95/P99 约 6 ms，最长帧 6.3 ms，0 个 >20 ms 帧、Long Task 或 Long Animation Frame；暂停/Ready 为 0 draw call；重启 next-paint 中位数 8.1 ms。
- 最终终审修复：固定步时钟改用有理步进单位，`advanceTime(2000)` 与 `advanceTime(1000)` 两次严格等价；最小化窗口保持应用挂载，游戏自动暂停但完整保留玩家、敌人、分数与波次会话。
- 最终验证：`npm run typecheck`、`npm test`（6 文件 / 23 测试）、`npm run build`、官方游戏客户端确定性回归、暂停/恢复/重启/最小化恢复、窗口拖拽/缩放及控制台检查全部通过。原始性能数据位于 `output/playwright/final-performance-results.json`。
- 当前无功能或性能 TODO。

## 2026-07-25 游戏开发基座

- 新增 `src/game-platform` 四层共享基座：纯 TypeScript 的确定性 runtime、浏览器生命周期/自动化/fullscreen 适配、R3F 单循环/自适应 DPR/资源作用域，以及稳定序列化/回放/时间分片等价性 testkit。
- 新增零依赖原子脚手架 `npm run game:create -- --id <kebab-id> --name "<name>"`；严格校验应用 id、保留名、路径穿越与目标冲突，生成失败不遗留半成品。
- 生成模板是共享平台的真实消费者，内建固定步模拟、单一 R3F 帧循环、demand 渲染、失焦/隐藏/停用清理、Fullscreen API、`advanceTime` / `render_game_to_text` 和确定性单测。
- Cosmic Vanguard 已迁移到共享 runtime、web 与 r3f 层；删除重复基础设施，同时保留玩法引擎、视觉 profile、操作方式、自动化 schema 与会话恢复语义。
- 已实际生成临时游戏并通过 typecheck、全部测试和生产构建后清理，证明脚手架产物不是示例伪代码；完整接入契约见 `docs/games/README.md`。
- 生产级硬化：同步推进限制为 240 tick / 4 秒且超限原子失败；发布观察者不可重入；Fullscreen 按目标隔离；R3F 非法 priority 快速失败；持续极慢前台帧可可靠触发画质降档；高位实例容量不会因浮点舍入低配。
- 最终门禁：7 项脚手架测试、17 文件 / 120 项 Vitest、typecheck 与 build 全部通过；真实生成临时游戏的独立 typecheck/测试通过并已精确清理；官方客户端两次动作回放状态哈希严格一致。
- 当前硬件性能复验：最新生产 chunk 在 Intel D3D11 / Chromium 149 下 Playing/Input 中位数约 170 FPS，P95/P99 6/6ms，0 Long Task/LoAF；Ready/Paused/Minimized/Restore 为 0 draw；0 console/page error。证据见 `output/playwright/performance-gate-report.md`。
- 当前无功能、架构或迁移 TODO。

## 2026-07-26 Agent 游戏治理

- 根 `AGENTS.md` 已收敛为短小、fail-closed 的 `$game-scaffold` 强制路由，避免所有非游戏任务常驻完整游戏策略上下文。
- 完整治理迁移到仓库标准路径 `.agents/skills/game-scaffold`；Skill 通过 frontmatter 精确触发，并按核心契约、新游戏、既有游戏/平台、验证四类 reference 渐进加载。
- 新游戏首写必须执行 `npm run game:create`；既有游戏禁止删除重生成；非 R3F 可替换渲染层但必须保留 domain/runtime/web/testkit；任何旁路必须事前获得用户明确批准。
- `tools/game-scaffold/agents-policy.test.mjs` 同时防止根路由丢失、详细策略回流 `AGENTS.md`、Skill 触发描述退化、reference 孤儿化或关键契约被删除。
- 验证：Codex 官方 Skill 校验通过；Node 测试 10/10（治理 3 + 生成器 7）、Vitest 17 文件 / 120 项、typecheck 与生产 build 全部通过。
- 当前无治理 TODO。
