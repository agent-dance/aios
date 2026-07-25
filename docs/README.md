# AIOS 设计文档

> 基线：v1
> 日期：2026-07-25
> 状态：MVP 实施前设计基线

本目录回答三个问题：AIOS 是什么、它为什么能够安全地让 Agent 行动、以及第一版如何以一个可演示又可验证的纵向闭环落地。

## 推荐阅读顺序

### 产品与体验

1. [产品定位](./product/vision.md)：AIOS 与传统操作系统的完整对应、产品边界与成功定义。
2. [桌面体验与 UI](./product/experience.md)：Workbench、Mission Control、A2UI Surface、Agent Store 和可信确认的交互设计。
3. [统一术语](./glossary.md)：跨产品、协议、安全和实现保持一致的领域语言。

### 架构与协议

1. [系统架构](./architecture/system-architecture.md)：领域边界、模块化单体、运行状态和恢复模型。
2. [Trust Kernel](./architecture/trust-kernel.md)：Principal、Grant、Policy、ActionIntent、Receipt 和信任平面。
3. [Agent Package](./specs/agent-package.md)：Agent 身份、内容、依赖、权限声明、签名和更新。
4. [AIOS UI Profile](./specs/ui-profile.md)：A2UI 适配、Catalog、Surface IR、安全渲染和一致性。

### 调研与实施

1. [开源技术评估](./research/open-source-evaluation.md)：build-vs-buy、采用分级、许可证和退出路径。
2. [MVP 实施计划](./mvp/implementation-plan.md)：纵向展示、代码分层、里程碑、验收与 pre-mortem。
3. [演示用户故事](./mvp/demo-user-stories.md)：可点击主线、Given/When/Then、三分钟讲解脚本与完成定义。

### 架构决策记录

- [ADR-0001：以宿主 OS 元操作环境交付 MVP](./decisions/0001-agentic-operating-environment.md)
- [ADR-0002：协议与系统 ABI 分离](./decisions/0002-protocol-and-abi-boundaries.md)
- [ADR-0003：Capability Broker 是唯一系统能力入口](./decisions/0003-capability-broker.md)

## 文档权威性

发生冲突时按以下顺序处理：

1. ADR 记录已批准且难以随意漂移的架构决策。
2. `specs/` 定义跨模块和第三方兼容契约。
3. `architecture/` 定义内部边界、不变量和部署方式。
4. `mvp/implementation-plan.md` 定义第一阶段的范围、顺序和完成门槛。
5. `product/` 定义目标体验；不能以体验文案绕过安全不变量。
6. `research/` 记录基于当时事实的选型证据；依赖升级前必须重新核验。

术语冲突统一回到 [术语表](./glossary.md)。未被文档明确承诺的能力，不得在产品材料中写成已经支持。

## 变更纪律

- 公共 manifest、Capability ABI、Receipt、Surface IR 的破坏性变化必须新增 ADR，并提供迁移与兼容策略。
- 更新 A2UI、MCP、A2A 等外部协议时，先更新 Adapter 和兼容测试，不把 wire type 泄漏到领域层。
- 引入新开源依赖前更新评估矩阵：用途、许可证、维护状态、威胁面、替代方案和移除成本。
- 安全门槛不能以“仅供演示”为理由跳过；MVP 可以缩小能力面，不能开放旁路。
- 每个里程碑必须以可运行测试、可观测证据和用户可见结果退出，不能以代码已合并替代完成。
