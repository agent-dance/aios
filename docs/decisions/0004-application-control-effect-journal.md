# ADR 0004：Application Control v1 使用主进程 HMAC 追加式 Effect Journal

- 状态：Accepted
- 日期：2026-07-30

## 背景

内嵌微信发送消息是不可安全自动重试的 R3 外部副作用。系统必须在触发页面发送前持久化
`dispatch-fenced`，在崩溃后恢复为 `Unknown`，保留不可变 Receipt，并且不能把联系人、昵称、
正文、审批详情或 Adapter prepared state 写入磁盘。

仓库已有单实例锁，因此 v1 是 Electron main 单写者。当前没有跨 Broker 关系查询、并发事务或
高吞吐投影需求；权威数据只包含固定 schema 的少量 effect transition。

## 决策

Application Control v1 使用 Electron main-owned、固定 schema、64 MiB 硬上限的 append-only
JSONL journal：

1. 每条记录使用独立本地 256-bit key 做 HMAC-SHA256 链接；调用方的 `intentId` 与
   `idempotencyKey` 只以带序号 AAD 的 AES-256-GCM binding 落盘，请求、Principal 和恢复提示
   只落 keyed fingerprint。journal 不保存这些调用方标识的明文，避免标识字段成为正文旁路。
2. 写 `dispatch-fenced` 后对 journal 执行 `fsync`，再以同目录临时文件 `fsync + atomic rename`
   更新 durable head；两者成功前禁止调用 Adapter。
3. durable head 用于发现完整记录的尾部删除；schema、序号、前序 HMAC、当前 HMAC、key 或 head
   任一异常都 fail closed，禁止应用副作用。`head.sequence` 是唯一提交边界；启动只解析其锚定
   前缀，并截断、`fsync` 丢弃其后的完整或撕裂未提交 tail，禁止把 head rename 失败的终态升级
   为重启后的已提交结果。
4. journal 不可用时保留损坏文件，Application Control 暴露零 capabilities，并返回
   `JOURNAL_UNAVAILABLE`；AlSniper OS shell 与微信浏览功能仍可启动。
5. fence 后抛错、超时、进程终止或终态写失败均为不可重试的 `Unknown`。重启只追加一次恢复
   Receipt；没有新证据时不重复追加 `Unknown`。
6. `Unknown` 对账只能追加引用原 Receipt 的新记录，禁止修改或覆盖原记录。

v1 中 Renderer 提交的 Principal 只作为来源信息参与 HMAC scope，不是授权凭证。当前所有 effect
都必须经过 main-owned 原生逐次确认，因此 Principal 伪造不能绕过发送确认。未来引入基于 Principal
的自动授权、免确认或敏感 Receipt 隔离之前，必须先由 main 签发绑定已认证 sidecar connection、
package digest、user session、intent、revision 与 audience 的短时一次性 authority handle，并把
main-owned Principal chain 纳入持久 Receipt。

## 为什么 v1 不采用 SQLite

SQLite WAL 是成熟的事务与查询存储，但不能单独提供本决策要求的 keyed append-only 审计链，
采用后仍需实现 HMAC event stream 与隐私投影。`better-sqlite3` 还会把 Electron ABI rebuild、
ASAR unpack 和原生二进制供应链加入当前可信基；当前运行环境的 `node:sqlite` 仍会报告实验性
状态。对于单写者、小规模、固定 transition ledger，这些成本没有换来所需的新能力。

因此 JSONL journal 是刻意的 v1 生产选择，不是 localStorage 或内存 Map 式临时方案。当系统增加
多个 Resource Broker、复杂查询投影或高并发写入时，journal repository boundary 可以迁移为
SQLite WAL + HMAC `effect_event` 表；dispatch fence、Receipt 和重放语义保持不变。

## 验证

- 单元测试覆盖正文/联系人不落盘、记录修改、key 丢失、完整尾截断、未提交 tail 隔离、
  dispatch/terminal head rename 失败、torn temporary head、
  幂等复用/冲突、Principal scoped lookup、无新证据时 Unknown 不增长，以及损坏 journal 启动
  后零 capabilities/零 dispatch。
- `npm run desktop:application-control-smoke` 使用真实子进程：在 durable fence 后 `SIGKILL`，重启
  恢复为一次不可重试的 `Unknown`，再连续重启三次验证 Receipt identity 与 journal 字节数稳定。
