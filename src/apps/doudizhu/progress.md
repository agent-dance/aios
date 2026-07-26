Original prompt: 这个项目是一个 AI 原生操作系统，因为这个操作系统是深度融合了 AI 能力的，操作系统内置的游戏上我希望也是如此，从设计上就必须考虑如何让 AI 参与，允许人机混玩。你来设计第一款游戏 - 斗地主。在此之前需要提出一套可标准化应用的、统一的 Agent 共玩的游戏接口，让 Agent 能像人类一样获取信息、参与游戏的各个功能点（跟人类绝对一致的能力）。

## 2026-07-26

- 已执行首写脚手架命令：`npm run game:create -- --id doudizhu --name "斗地主"`。
- 架构冻结：采用传输无关的 AGAP v1；完整领域状态只由 Match Authority 持有，Human 与 Agent 均通过同一座位投影、合法动作集合和 ParticipantPort 行动。
- 成熟方案选择：吸收 OpenSpiel 的不完全信息/合法动作语义与 PettingZoo AEC 的逐席循环；MCP 作为工具适配，A2A 作为发现/组局适配，不把任一 Python 运行时嵌入浏览器包。
- 规则版本冻结为 `classic-3p-score-bid@1`：三人、0/1/2/3 叫分、农民独立加倍、地主再加倍、54 张牌、17×3+3 底牌、完整经典牌型、炸弹/王炸与春天倍率。
- 性能预算：DOM 牌桌不新增 WebGL draw call；活动交互 P95 低于 16.7ms、无新增 Long Task；非活动窗口不推进 Agent 回合；生产 chunk 保持懒加载。
- 领域层完成：确定性发牌、完整叫分/加倍/出牌/结算状态机、14 类牌型与完备语义动作枚举、两次过牌清墩、春天/反春天和零和计分；底牌在加倍结束前对所有席隐藏。
- 座位投影完成：只暴露本席手牌、公开底牌/牌局历史、各席剩余张数和同一合法动作集合；确定性启发式 Agent 仅消费该投影，不接触 FullState。
- 聚焦验证：领域与 AGAP 共 5 个测试文件、44 项通过；OS 已显式注册 `doudizhu`，保持独立 lazy chunk，通过 App Store 安装启动且不常驻 Dock。
- AGAP v1 平台完成：seat-bound `ParticipantPort`、descriptor/observation/legal-actions/receipt/private events、revision/phase/nonce、幂等、single-writer 重入屏障、原子回滚、稳定运行时 shape error 与有界容量；两路独立终审无 blocker/high/medium。
- 斗地主适配完成：Human/Agent 共用 `submitDoudizhuAction`，合法牌按 rank multiplicity 展开为完整 canonical CardId 组合；多 seed 全 Agent 终局、隐藏信息、私有 audience、重发、幂等与安全边界均有测试。
- 本地练习局使用 Web Crypto 分别生成秘密 seed 与不透明公开 `matchId`；领域与 Match API 强制调用方提供 ID，杜绝从公开标识反推出洗牌状态。
- UI 完成：默认一人两 Agent，支持完整叫分、农民加倍、地主再加倍、提示/出牌/不要、结算/重开、鼠标/触控/键盘、Fullscreen、320px 容器查询、reduced motion，以及 active-only 自动化桥和 sticky manual clock。
- 脚手架公共契约已升级：所有新游戏（含单人）默认生成 AGAP descriptor、seat projection、Human/Agent 同动作通道与 contract test；禁止将无鉴权 `window.*` 自动化桥作为 Agent API。
- 公共脚手架真实验证：最终唯一 probe `authority-contract-probe-20260726` 证明 AGAP Host 是唯一 gameplay authority，fixed-step runtime 只持有 presentation time；probe 6/6、全仓 typecheck/build 通过后按绝对路径精确清理，临时目录计数为 0。
- 契约条件化复验：唯一 probe `final-contract-probe-20260726` 在 R3F 模板上通过 6/6 与 typecheck，确认 DOM/R3F 条件化门禁及 in-match restart 模板仍可生成；随后逐文件删除并移除已验证为空的精确目录。
- 官方 develop-web-game 客户端最终复验：依赖注入相同 256-bit seed/不透明 ID/动作的状态和 PNG 两次 SHA-256 分别一致（状态 `FB626378D4B349A3DCA4697AD91237BFD12595198F09C7D81CF930A839E06F9A`、画面 `24DF606DE0383381B4DD62572A1526791F789B929F2C07CECFCDF21A6E675142`），无 console/page error；`render_game_to_text` 保持紧凑摘要，正式 `ParticipantPort` 仍保留完整动作集。
- 真实 Chromium 连续验收：App Store 安装并打开斗地主；完成 3 分叫地主→两 Agent 农民加倍提交→地主再加倍→Human/Agent 连续出牌→地主结算获胜；360×720 窄窗可用，实际截图已人工检查。
- 生命周期真实验收：Fullscreen 进入为 true，`Escape` 退出恢复为 false；最小化后自动化桥移除且状态冻结，重新激活后桥和同一 revision 恢复；同步手动时钟在 400 ms + 250 ms 墙钟等待期间冻结，并只在累计 500 ms 虚拟时间后推进 Agent。
- 新局编排闭环：仅终局后的“新一局”可创建全新 Host、256-bit seed、不透明 `matchId` 与座位绑定，进行中按钮禁用且 handler 二次拒绝，旧终局 Host 保持不可变；7 次端到端新局发布延迟中位数 39.9 ms、最大 46.5 ms，公开 ID 全部唯一且不含 seed。
- DOM 性能复验：180 帧样本平均约 171.3 FPS，P50/P95/P99 为 5.9/6/6 ms，最大 6.6 ms，采样期 0 Long Task、0 Canvas/WebGL；最终生产懒加载 JS chunk 51,324 bytes，SHA-256 `5D433F9142EABF452282CEB7F7F58096089B9F9DEC95C660F8CC7A7CEF0E146C`。
- 最终门禁：Node 10/10、Vitest 26 文件 / 199 项、`npm run typecheck`、`npm run build` 全部通过；斗地主/AGAP 聚焦 9 文件 / 79 项通过；当前无临时游戏目录、功能 TODO 或已知失败门禁。
