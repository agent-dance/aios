# AlSniper OS Agent Instructions

本文件作用于整个仓库。除非用户明确覆盖，所有 Agent 都必须遵守。

## 通用实施标准

- 必须以生产级架构师思维实施，保持 SOLID、单向依赖、明确所有权、鲁棒错误语义和可验证完成条件。
- 代码量较大或需要新增基础设施前，必须先调研成熟框架与仓库既有能力；能复用成熟实现时不得重复造轮子。
- 优先把可独立验证的工作交给合适的高能力 subagent，并在完成前安排独立终审。
- 不得留下 TODO、FIXME、死代码、临时样例、未清理生成目录或已知失败门禁。
- 未达到全部验收条件时不得宣称完成。

## Web 游戏开发强制基座

本节在以下任务中强制触发：新建或修改浏览器游戏、玩法模拟、游戏输入、渲染循环、生命周期、Fullscreen、自动化、确定性或游戏性能。普通非游戏系统应用不受本节约束。

以下“必须”和“禁止”均为不可省略的完成条件。

### 1. 开工前必须读取

任何游戏实现工作开始前，Agent 必须完整阅读：

- `docs/games/README.md`
- `docs/games/template-contract.md`
- 目标游戏目录中的 `README.md` 和 `progress.md`（如存在）
- 已安装的 `develop-web-game` 技能说明

如果 `develop-web-game` 技能不可用，必须明确报告，并执行等价的真实浏览器操作、截图、文本状态和控制台验证；不得只依赖单元测试。

### 2. 新游戏必须从脚手架创建

新游戏的第一项写操作必须从仓库根目录运行：

```powershell
npm run game:create -- --id <lowercase-kebab-id> --name "<Display Name>"
```

- 必须直接以生成的 `src/apps/<id>` 为实现起点；禁止先手工创建游戏目录或自行拼装替代模板。
- 禁止复制 `src/apps/space-game` 或其他游戏作为新游戏模板。既有游戏只能作为玩法或视觉参考，不能作为基础设施来源。
- CLI 只支持 `--id` 和 `--name`。不得绕开它的保留名、路径、冲突、拒绝覆盖和原子创建保护。
- 生成后可以替换玩法、场景、UI、输入映射与渲染内容，但必须保留下述平台边界和运行时契约。

### 3. 既有游戏与平台修改

- 生成器拒绝覆盖已有目录。迁移或重构既有游戏时，禁止删除原目录后重生成；必须保留玩法与 UI，并逐层迁移到同一脚手架契约。
- 若既有游戏缺少当前模板要求的边界，必须先审计其与生成模板的差异。需要可执行对照时，使用唯一临时 id 生成未注册基线；验收后只删除已确认的精确临时目录并记录清理结果。
- 修改 `src/game-platform/**` 本身不要求在开工前生成游戏；但公共契约发生变化时，完成前必须实际生成一个唯一临时游戏，执行其 typecheck/测试/构建验证，然后精确清理。
- 通用能力缺失时，必须优先以向后兼容方式扩展 `src/game-platform` 并补测试，禁止在单个游戏中复制近似基础设施。

### 4. 强制分层与依赖方向

所有游戏必须复用 `src/game-platform`，保持以下单向依赖：

```text
纯游戏领域引擎
    → game-platform/runtime
    → game-platform/web 与可选的 game-platform/r3f
    → React 游戏应用

game-platform/testkit → 领域引擎与 runtime 验证
```

- 游戏领域引擎必须是纯 TypeScript，不得依赖 React、DOM、Three.js 或 OS Shell。
- 固定步模拟、状态/输入替换、发布、重置和同步工作预算必须使用 `game-platform/runtime`。
- 自动化桥、blur/visibility/inactive 生命周期、输入清理、暂停和 Fullscreen 必须使用 `game-platform/web`。
- R3F 游戏必须使用 `game-platform/r3f` 的单一帧驱动、自适应 DPR、容量和资源所有权能力。
- 稳定序列化、时间线回放和时间分片等价验证必须使用 `game-platform/testkit`。
- `src/game-platform` 禁止反向依赖 `src/apps` 或任何具体游戏。
- OS store 只管理窗口和焦点，禁止接收逐帧游戏状态。

生成模板默认使用 R3F，但并不强制所有游戏使用 R3F。DOM、Canvas2D 或其他渲染器可以替换渲染层；即使替换，也必须保留生成器建立的 domain/runtime/web/testkit 边界、单一模拟时钟、生命周期与自动化契约。需要复用的新渲染器 adapter 应进入 `game-platform` 并带测试，不得在多个游戏中复制。

### 5. 禁止旁路基座

未经下述例外流程批准，禁止：

- 自行实现另一套 fixed-step accumulator/runtime；
- 添加独立 `requestAnimationFrame`、第二个模拟时钟或并行模拟循环；
- 自行安装不兼容的 `window.advanceTime` 或 `window.render_game_to_text`；
- 重复实现 blur、visibility、inactive、Fullscreen、自适应 DPR、资源释放或容量增长基础设施；
- 在逐帧路径写 React state 或全局 Zustand state；
- 在 blur、hidden、inactive、suspend、restart 或 unmount 后遗留输入；
- 在模拟中读取墙钟、DOM、React 状态、Three.js 场景或直接使用 `Math.random()`；随机性必须以显式种子保存在状态中。

runtime 的 state/input 按引用移交并只提供浅只读契约。游戏与模拟函数不得原地修改已移交值，否则会破坏批次原子性。

碰撞、玩法实体、HUD、关卡、键位、物理、ECS、联网和资源管线属于游戏级能力，不应无条件加入共享基座。

### 6. 不可破坏的运行时契约

每个游戏必须保持：

- 一个模拟时钟；R3F 游戏只能有一个可见 Canvas 和一个自动渲染帧循环；
- active 且 playing 时使用实时帧推进；ready、paused、inactive 和 completed 时使用 `frameloop="demand"`；
- `window.advanceTime(ms)` 通过共享 bridge 同步、确定性地推进有效时间；
- `window.render_game_to_text()` 返回简洁 JSON，包含坐标系和做出玩法决策所需的可见状态；
- 首次 React render 检查官方客户端的 `__vt_pending`，并用同步 ref 封闭 bridge effect / React state commit 竞争窗口；
- `onManualClockRequested` 幂等，手动时钟所有权在本次组件挂载期间保持 sticky；两次 `advanceTime()` 之间禁止恢复实时模拟；
- 默认 240 tick / 4000ms 同步预算，并保持 `advanceTime(2000)` 精确产生 120 个 60Hz tick，且与两次 1000ms 分片等价；
- blur、hidden、inactive、suspend、restart 和 unmount 均清除输入；
- `F` 切换目标游戏元素的 Fullscreen，Escape 遵循浏览器 Fullscreen 契约；
- 动态 Three.js 资源具有明确、幂等的释放责任。

### 7. 显式产品注册

生成器不会自动修改产品注册。新游戏必须显式检查并完成：

1. 在 `src/system/types.ts` 的 `AppId` 注册 id；
2. 在 `src/system/appRegistry.ts` 的 `APP_REGISTRY` 添加元数据；
3. 只有产品需求明确时才加入 `DOCK_APPS`；
4. 在 `src/App.tsx` lazy import；
5. 加入 `appContents` 并转发 Shell 的 `isActive`；
6. 若需展示在 App Store，再更新 `src/apps/store/AppStoreApp.tsx` 的 listing 与 icon 映射；
7. 检查图标、默认窗口、Dock 策略及懒加载代码分割边界。

### 8. 强制验证门禁

每次有意义的游戏变更必须执行 `develop-web-game` 的“实现 → 操作 → 暂停 → 观察 → 修正”循环。完成前必须：

```powershell
npm run typecheck
npm test
npm run build
```

并且必须完成：

- 确定性分片等价、两秒单次/分段推进、paused/inactive 冻结、restart 和受影响玩法结果测试；
- 使用官方游戏客户端执行真实的开始、主要移动/交互、暂停恢复、restart、Fullscreen、inactive/恢复及关键玩法状态转换；
- 实际查看最新截图，并与 `render_game_to_text()` 对照；
- 重复同一输入与虚拟时间流程至少两次，比较稳定状态或 hash；
- 检查并修复所有新增 console error 和 page error；
- 场景之间重置状态，避免测试互相污染；
- 性能相关变更记录 renderer、viewport、生产游戏 chunk/hash、FPS、P50/P95/P99、draw calls、Long Task/LoAF 与 restart latency；绝对 FPS 只能来自硬件 renderer。

单元测试、类型检查或一张截图单独通过均不足以宣称游戏任务完成。

### 9. 例外流程

只有共享平台被证明确实无法满足需求时才允许申请例外。Agent 必须在旁路基座之前：

1. 指出具体不兼容 API 或约束并给出复现证据；
2. 比较扩展共享平台、采用成熟框架和游戏内特例；
3. 说明依赖方向、确定性、性能、测试和长期维护影响；
4. 请求并获得用户明确批准。

用户未回复、时间紧张、实现方便或既有代码已经如此，都不构成批准。不得默许或事后补报例外。即使例外获批，除非用户同时明确豁免，共享自动化桥、生命周期清理和全部质量门禁仍然必须保留。

### 10. 完成证据

最终交付必须在目标游戏 `progress.md` 和结果说明中留下可审计证据：

- 新游戏实际执行的脚手架命令，或既有游戏的平台复用/迁移映射；
- 临时生成目录的生成、验证和精确清理结果（如适用）；
- `runtime/web/r3f/testkit` 的复用情况和显式注册位置；
- typecheck、test、build、官方客户端、截图、文本状态和错误检查结果；
- 确定性重复结果、性能证据与生产产物 hash；
- 所有获批例外及批准依据。

任一必需证据缺失，或仍有 TODO、死代码、重复基座、失败测试、未解决错误或临时目录时，任务不视为完成。
