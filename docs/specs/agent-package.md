# AIOS Agent Package 与 Agent Store 规范

- 规范版本：1.0.0
- `agent.json` Schema 版本：1.0
- 状态：架构基线
- 日期：2026-07-25

## 1. 范围

本文定义 AIOS Agent 的逻辑清单、物理制品、身份、版本、依赖、权限、数据实践、评测、安装、更新与吊销规则，并定义 Agent Store 对这些对象的最小治理职责。

本文不定义模型推理 API、MCP/A2A/A2UI 协议本身，也不把任何单一外部 Registry 当作安全信任根。

文中的 **MUST**、**MUST NOT**、**SHOULD**、**SHOULD NOT**、**MAY** 分别表示必须、禁止、建议、不建议、可选。实现只有满足所有 MUST 与 MUST NOT 才能声明符合本规范。

## 2. 设计原则

1. `agent.json` 是 Agent 的可移植、规范化逻辑契约；OCI/ORAS 是承载和分发该契约及其文件的物理机制。二者 MUST 严格分离。
2. Agent 版本是作者声明的兼容性；OCI digest 是制品字节身份；签名是发布者身份与完整性证据；审核 attestation 是商店在某策略版本下的判断。四者 MUST NOT 混为一个“安全认证”。
3. Prompt、Skill、模型策略和远程 MCP 均属于供应链与行为面。审核 MUST 同时覆盖静态内容、依赖、动态行为与运行期漂移。
4. `agent.json` 声明 Agent 可能请求的最大能力；用户或组织实际授权 MUST 是该集合的子集。
5. A2UI 只表达界面和用户意图，MUST NOT 直接授予系统权限。权限、支付、凭据、安装和不可逆操作的确认 MUST 由 AIOS 系统界面渲染。
6. 用户状态、记忆、凭据、商店评论、价格和排名不属于 Agent Package，MUST NOT 被打入制品。
7. 所有可执行或可影响行为的输入 MUST 可按 digest 追踪；远程服务无法被内容寻址时，MUST 明确标记其可变性并持续监控。

## 3. Agent Store 与传统 App Store 的对应

| 传统操作系统 | AIOS |
|---|---|
| App Bundle | Agent Package：Prompt、Skill、策略、评测、图标、可选运行时 |
| 可执行文件 | Agent 行为定义：模型要求、Prompt、Skill、MCP/A2A 连接与策略 |
| App Manifest | canonical `agent.json` |
| Code Signing / Notarization | 发布者签名、构建 provenance、商店审核 attestation |
| App Sandbox | Agent Runtime、Capability Broker、MCP Broker、A2UI 安全 Renderer |
| App 权限 | 任务级、资源级、时效级和预算级 capability grant |
| App Extension / Intent | A2A Skill、可组合 Agent、类型化输入输出契约 |
| App Store Listing | Agent 能力、风险、数据流、成本、质量和依赖说明页 |
| Malware Review | Prompt/Skill/MCP 静态分析、沙箱引爆、注入与外泄评测 |
| In-App Purchase | 订阅、额度、任务结果或底层模型/MCP 用量计费 |
| Crash Report | Agent trace、工具错误、循环中止、成本异常和用户撤销 |
| 自动更新 | 不可变制品、灰度通道、评测门禁、权限差异确认 |
| MDM / 企业商店 | 私有 Registry、组织信任根、策略覆盖、审批和版本 pin |
| 卸载 | 停止任务、撤销凭据、移除 Agent、保留或导出用户数据 |

Agent Store 因而不是下载页。它是制品目录、供应链验证器、权限与数据实践展示层、行为审核系统、质量观测系统和吊销入口。

## 4. 三类对象必须分离

### 4.1 Canonical Agent Manifest

`agent.json` 描述 Agent 的逻辑身份、行为资产、接口、依赖、权限和生命周期。它 MUST 与 Registry、镜像地址、Store SKU、价格、评论和安装状态无关，从而允许同一字节不经修改地镜像到公共、企业或离线 Store。

`agent.json` MUST：

- 使用 UTF-8，无 BOM；
- 是单个 JSON object；
- 通过本规范的 JSON Schema；
- 在摘要或签名前按 RFC 8785 JSON Canonicalization Scheme 规范化；
- 使用小写十六进制 `sha256:<64 hex>` 表示摘要；
- 不包含自身摘要或所处 OCI Manifest 的摘要，以避免循环引用；
- 不包含秘密、访问令牌、用户数据或设备专属绝对路径。

`agent.json` 中的 `path` 是包内逻辑路径，不是文件系统路径或网络地址。路径 MUST 使用 `/`，MUST 是相对路径，MUST NOT 包含空段、`.`、`..`、反斜杠或 NUL。

### 4.2 Physical Agent Artifact

物理制品 MUST 是 OCI Image Manifest 兼容 Artifact，并使用：

- `artifactType`: `application/vnd.aios.agent.package.v1`
- `config.mediaType`: `application/vnd.aios.agent.config.v1+json`
- `config.digest`: canonical `agent.json` 字节的 SHA-256
- 每个文件一个 OCI blob descriptor；descriptor 的 `org.opencontainers.image.title` MUST 等于 `agent.json` 中的逻辑 `path`

示意：

```json
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.manifest.v1+json",
  "artifactType": "application/vnd.aios.agent.package.v1",
  "config": {
    "mediaType": "application/vnd.aios.agent.config.v1+json",
    "digest": "sha256:<agent-json-digest>",
    "size": 4096
  },
  "layers": [
    {
      "mediaType": "text/markdown",
      "digest": "sha256:<prompt-digest>",
      "size": 1024,
      "annotations": {
        "org.opencontainers.image.title": "prompts/main.md"
      }
    }
  ]
}
```

OCI Manifest digest 是完整 Agent Artifact 的唯一字节身份。它 MUST 由 Store Catalog、安装锁文件和安装回执记录，MUST NOT 写回 `agent.json`。

ORAS SHOULD 用于 push、pull、copy、OCI Layout 导入导出和 Referrers 发现。离线 `.aap` 文件 MAY 是 OCI Image Layout 的 tar 封装，但 `.aap` MUST NOT 引入另一套包语义。

### 4.3 Store Record 与 Install Lock

Store Record 是可变的目录与治理数据，至少包含：

- `agentId`、`version`、`artifactDigest`、Registry locator；
- 发布者验证结果；
- 签名、SBOM、provenance、审核和评测 attestation 引用；
- 可售区域、价格、试用、评论、排名；
- 发布通道、灰度比例、暂停和吊销状态；
- Store 策略版本与审核时间。

Install Lock 是某次安装的已解析闭包，至少锁定：

- 根 Agent artifact digest；
- 所有 Agent、Skill、MCP package、运行时和 Catalog digest；
- 远程 MCP endpoint 身份及 capability snapshot digest；
- 模型策略标识；
- 安装时验证的签名者和 Store policy digest。

Store Record 与 Install Lock MUST NOT 修改原始 Artifact。

## 5. 身份、版本与摘要

### 5.1 Agent 与发布者身份

- `id` MUST 是发布者命名空间内永久、全局唯一的小写反向域名标识，例如 `dev.aios.notes.summarizer`。
- `id` 一经公开发布 MUST NOT 转让给无关主体；所有权变更 MUST 产生可审计的 Store 事件。
- `publisher.id` MUST 是稳定 URI。公共 Store SHOULD 以域名控制、组织验证和 OIDC 身份绑定来验证该 URI。
- 图标、显示名称和分类 MAY 改变，但 MUST NOT 改变 Agent 身份。
- 系统 Agent 名称、图标、徽章和系统保留视觉 token MUST 由 AIOS 保留，第三方包 MUST NOT 使用。

### 5.2 版本

`version` MUST 遵循 SemVer 2.0.0：

- MAJOR：公开 Skill、输入输出 schema、状态 schema 或任务语义不兼容；
- MINOR：向后兼容地新增能力；
- PATCH：不扩大权限、数据流和公开契约的修复。

同一 `(id, version)` MUST 只对应一个 artifact digest。Store MUST 拒绝覆盖已发布版本。

Prompt 或 Skill 的任何字节变化都会产生新的 artifact digest。即使作者判断为 PATCH，Store 仍 MUST 重新执行适用的行为评测。SemVer 表达契约兼容性，不保证随机模型输出一致。

### 5.3 摘要

- `agent.json` 中每个 Prompt、Skill、图标、Agent Card、评测集和 bundled MCP MUST 声明其 blob digest 与 size。
- Installer MUST 同时验证 OCI descriptor digest、manifest 中的资产 digest 和实际字节。
- Tag、channel、文件名和版本号 MUST NOT 被当作完整性依据。
- 远程 MCP 的 `capabilitySnapshotDigest` 只证明被审核的 endpoint 元数据、工具描述和 schema 快照，MUST NOT 被描述为远程实现代码的 digest。

## 6. 最小完整 `agent.json`

以下示例覆盖一个可安装 Agent 的全部必需类别，同时保持 first-party、local-only、fixed-digest 的 MVP 约束。示例中的 64 位摘要为格式占位值，实现 MUST 使用真实摘要。

```json
{
  "$schema": "https://schemas.aios.dev/agent-manifest/v1.schema.json",
  "schemaVersion": "1.0",
  "id": "dev.aios.notes.summarizer",
  "version": "1.0.0",
  "publisher": {
    "id": "https://aios.dev/publishers/core",
    "name": "AIOS",
    "supportUrl": "https://aios.dev/support",
    "securityContact": "security@aios.dev"
  },
  "display": {
    "name": "摘要助手",
    "summary": "为用户选择的本地文档生成结构化摘要",
    "categories": ["productivity"]
  },
  "compatibility": {
    "aios": ">=0.1.0 <1.0.0",
    "locales": ["zh-CN", "en-US"],
    "modelCapabilities": ["structured-output", "tool-calling"]
  },
  "runtime": {
    "kind": "prompt",
    "entrypoint": "prompt.main"
  },
  "prompts": [
    {
      "id": "prompt.main",
      "role": "system",
      "path": "prompts/main.md",
      "mediaType": "text/markdown",
      "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "size": 1024
    }
  ],
  "skills": [
    {
      "id": "skill.summarize-document",
      "version": "1.0.0",
      "path": "skills/summarize/SKILL.md",
      "mediaType": "text/markdown",
      "digest": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      "size": 2048,
      "entrypoint": "summarize"
    }
  ],
  "mcp": [
    {
      "id": "dev.aios.mcp.local-documents",
      "kind": "bundled",
      "version": "1.0.0",
      "protocolVersion": "2025-11-25",
      "transport": "stdio",
      "artifact": {
        "path": "mcp/local-documents.wasm",
        "mediaType": "application/wasm",
        "digest": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        "size": 65536
      },
      "tools": ["documents.read-selected"],
      "capabilitySnapshotDigest": "sha256:4444444444444444444444444444444444444444444444444444444444444444",
      "failureMode": "fail-closed"
    }
  ],
  "a2a": {
    "protocolVersion": "1.0",
    "exposure": "local-only",
    "card": {
      "path": "a2a/agent-card.json",
      "mediaType": "application/json",
      "digest": "sha256:5555555555555555555555555555555555555555555555555555555555555555",
      "size": 1536
    }
  },
  "a2ui": {
    "protocolVersion": "0.9.1",
    "inlineCatalogs": false,
    "executableComponents": false,
    "catalogs": [
      {
        "id": "aios://catalog/system/v1",
        "source": "system",
        "digest": "sha256:6666666666666666666666666666666666666666666666666666666666666666"
      }
    ]
  },
  "icons": [
    {
      "purpose": "primary",
      "theme": "any",
      "path": "icons/icon-1024.png",
      "mediaType": "image/png",
      "digest": "sha256:7777777777777777777777777777777777777777777777777777777777777777",
      "size": 24576,
      "sizePx": 1024,
      "accessibleName": "摘要助手"
    }
  ],
  "permissions": [
    {
      "capability": "files.read",
      "purpose": "读取用户在当前任务中主动选择的文档",
      "activation": "user-gesture",
      "lifetime": "task",
      "constraints": {
        "selector": "user-selected",
        "access": "read-only"
      }
    }
  ],
  "dataPractices": [
    {
      "source": "user-selected-files",
      "categories": ["documents"],
      "destination": "aios://local",
      "purpose": "document-summarization",
      "retention": "session",
      "trainingUse": "prohibited"
    }
  ],
  "evaluations": {
    "suites": [
      {
        "path": "evals/conformance.jsonl",
        "mediaType": "application/jsonl",
        "digest": "sha256:8888888888888888888888888888888888888888888888888888888888888888",
        "size": 8192
      }
    ],
    "gates": [
      {
        "metric": "agent.task.success_rate",
        "minimum": 0.95
      }
    ]
  },
  "dependencies": [],
  "lifecycle": {
    "update": {
      "mode": "explicit",
      "channel": "stable",
      "permissionExpansion": "reconsent",
      "stateSchemaVersion": 1
    },
    "revocation": {
      "onRevoke": "disable",
      "credentialDisposition": "revoke",
      "userDataDisposition": "preserve",
      "gracefulStopSeconds": 5
    }
  },
  "license": "Apache-2.0",
  "extensions": {}
}
```

## 7. JSON Schema

以下是 v1 最小完整结构 Schema。它验证可移植结构；跨字段权限、数据流、A2A/MCP/A2UI 内容和 digest 对应关系仍 MUST 由 semantic validator 验证。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.aios.dev/agent-manifest/v1.schema.json",
  "title": "AIOS Agent Manifest v1",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "$schema", "schemaVersion", "id", "version", "publisher", "display",
    "compatibility", "runtime", "prompts", "skills", "mcp", "a2a", "a2ui",
    "icons", "permissions", "dataPractices", "evaluations", "dependencies",
    "lifecycle", "license", "extensions"
  ],
  "properties": {
    "$schema": { "const": "https://schemas.aios.dev/agent-manifest/v1.schema.json" },
    "schemaVersion": { "const": "1.0" },
    "id": { "$ref": "#/$defs/reverseDnsId" },
    "version": { "$ref": "#/$defs/semver" },
    "publisher": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "name", "supportUrl", "securityContact"],
      "properties": {
        "id": { "type": "string", "format": "uri" },
        "name": { "type": "string", "minLength": 1, "maxLength": 120 },
        "supportUrl": { "type": "string", "format": "uri" },
        "securityContact": { "type": "string", "format": "email" }
      }
    },
    "display": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "summary", "categories"],
      "properties": {
        "name": { "type": "string", "minLength": 1, "maxLength": 80 },
        "summary": { "type": "string", "minLength": 1, "maxLength": 300 },
        "categories": {
          "type": "array", "minItems": 1, "uniqueItems": true,
          "items": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,63}$" }
        }
      }
    },
    "compatibility": {
      "type": "object",
      "additionalProperties": false,
      "required": ["aios", "locales", "modelCapabilities"],
      "properties": {
        "aios": { "type": "string", "minLength": 1 },
        "locales": {
          "type": "array", "minItems": 1, "uniqueItems": true,
          "items": { "type": "string", "pattern": "^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$" }
        },
        "modelCapabilities": {
          "type": "array", "uniqueItems": true,
          "items": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,63}$" }
        }
      }
    },
    "runtime": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "entrypoint"],
      "properties": {
        "kind": { "enum": ["prompt", "wasm", "oci", "remote-a2a"] },
        "entrypoint": { "type": "string", "minLength": 1 }
      }
    },
    "prompts": {
      "type": "array", "minItems": 1,
      "items": { "$ref": "#/$defs/prompt" }
    },
    "skills": {
      "type": "array",
      "items": { "$ref": "#/$defs/skill" }
    },
    "mcp": {
      "type": "array",
      "items": { "$ref": "#/$defs/mcp" }
    },
    "a2a": {
      "type": "object",
      "additionalProperties": false,
      "required": ["protocolVersion", "exposure", "card"],
      "properties": {
        "protocolVersion": { "type": "string", "minLength": 1 },
        "exposure": { "enum": ["local-only", "authenticated", "public"] },
        "card": { "$ref": "#/$defs/asset" }
      }
    },
    "a2ui": {
      "type": "object",
      "additionalProperties": false,
      "required": ["protocolVersion", "inlineCatalogs", "executableComponents", "catalogs"],
      "properties": {
        "protocolVersion": { "type": "string", "minLength": 1 },
        "inlineCatalogs": { "type": "boolean" },
        "executableComponents": { "type": "boolean" },
        "catalogs": {
          "type": "array", "minItems": 1,
          "items": { "$ref": "#/$defs/catalog" }
        }
      }
    },
    "icons": {
      "type": "array", "minItems": 1,
      "items": { "$ref": "#/$defs/icon" }
    },
    "permissions": {
      "type": "array",
      "items": { "$ref": "#/$defs/permission" }
    },
    "dataPractices": {
      "type": "array",
      "items": { "$ref": "#/$defs/dataPractice" }
    },
    "evaluations": {
      "type": "object",
      "additionalProperties": false,
      "required": ["suites", "gates"],
      "properties": {
        "suites": {
          "type": "array", "minItems": 1,
          "items": { "$ref": "#/$defs/asset" }
        },
        "gates": {
          "type": "array", "minItems": 1,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["metric"],
            "properties": {
              "metric": { "type": "string", "pattern": "^[a-z][a-z0-9_.-]+$" },
              "minimum": { "type": "number" },
              "maximum": { "type": "number" }
            },
            "anyOf": [
              { "required": ["minimum"] },
              { "required": ["maximum"] }
            ]
          }
        }
      }
    },
    "dependencies": {
      "type": "array",
      "items": { "$ref": "#/$defs/dependency" }
    },
    "lifecycle": {
      "type": "object",
      "additionalProperties": false,
      "required": ["update", "revocation"],
      "properties": {
        "update": {
          "type": "object",
          "additionalProperties": false,
          "required": ["mode", "channel", "permissionExpansion", "stateSchemaVersion"],
          "properties": {
            "mode": { "enum": ["explicit", "security-only", "automatic"] },
            "channel": { "enum": ["stable", "beta", "canary"] },
            "permissionExpansion": { "const": "reconsent" },
            "stateSchemaVersion": { "type": "integer", "minimum": 1 },
            "migration": { "$ref": "#/$defs/asset" }
          }
        },
        "revocation": {
          "type": "object",
          "additionalProperties": false,
          "required": ["onRevoke", "credentialDisposition", "userDataDisposition", "gracefulStopSeconds"],
          "properties": {
            "onRevoke": { "enum": ["disable", "quarantine"] },
            "credentialDisposition": { "const": "revoke" },
            "userDataDisposition": { "enum": ["preserve", "export-then-delete", "delete"] },
            "gracefulStopSeconds": { "type": "integer", "minimum": 0, "maximum": 60 }
          }
        }
      }
    },
    "license": { "type": "string", "minLength": 1 },
    "extensions": {
      "type": "object",
      "propertyNames": { "format": "uri" },
      "additionalProperties": true
    }
  },
  "$defs": {
    "digest": {
      "type": "string",
      "pattern": "^sha256:[a-f0-9]{64}$"
    },
    "semver": {
      "type": "string",
      "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$"
    },
    "reverseDnsId": {
      "type": "string",
      "pattern": "^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$"
    },
    "path": {
      "type": "string",
      "pattern": "^(?!/)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*\\\\)(?!.*//)[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$"
    },
    "asset": {
      "type": "object",
      "additionalProperties": false,
      "required": ["path", "mediaType", "digest", "size"],
      "properties": {
        "path": { "$ref": "#/$defs/path" },
        "mediaType": { "type": "string", "minLength": 3 },
        "digest": { "$ref": "#/$defs/digest" },
        "size": { "type": "integer", "minimum": 0 }
      }
    },
    "prompt": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "role", "path", "mediaType", "digest", "size"],
      "properties": {
        "id": { "type": "string", "pattern": "^prompt\\.[a-z0-9][a-z0-9.-]*$" },
        "role": { "enum": ["system", "developer", "template"] },
        "path": { "$ref": "#/$defs/path" },
        "mediaType": { "type": "string", "minLength": 3 },
        "digest": { "$ref": "#/$defs/digest" },
        "size": { "type": "integer", "minimum": 1 }
      }
    },
    "skill": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "version", "path", "mediaType", "digest", "size", "entrypoint"],
      "properties": {
        "id": { "type": "string", "pattern": "^skill\\.[a-z0-9][a-z0-9.-]*$" },
        "version": { "$ref": "#/$defs/semver" },
        "path": { "$ref": "#/$defs/path" },
        "mediaType": { "type": "string", "minLength": 3 },
        "digest": { "$ref": "#/$defs/digest" },
        "size": { "type": "integer", "minimum": 1 },
        "entrypoint": { "type": "string", "minLength": 1 }
      }
    },
    "mcp": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id", "kind", "version", "protocolVersion", "transport", "tools",
        "capabilitySnapshotDigest", "failureMode"
      ],
      "properties": {
        "id": { "$ref": "#/$defs/reverseDnsId" },
        "kind": { "enum": ["bundled", "package", "remote"] },
        "version": { "$ref": "#/$defs/semver" },
        "protocolVersion": { "type": "string", "minLength": 1 },
        "transport": { "enum": ["stdio", "streamable-http", "sse"] },
        "artifact": { "$ref": "#/$defs/asset" },
        "locator": { "type": "string", "format": "uri" },
        "packageDigest": { "$ref": "#/$defs/digest" },
        "endpoint": { "type": "string", "format": "uri" },
        "remoteMutable": { "type": "boolean" },
        "tools": {
          "type": "array", "uniqueItems": true,
          "items": { "type": "string", "minLength": 1 }
        },
        "capabilitySnapshotDigest": { "$ref": "#/$defs/digest" },
        "auth": {
          "type": "object",
          "additionalProperties": false,
          "required": ["scheme", "scopes", "audience"],
          "properties": {
            "scheme": { "enum": ["none", "oauth2"] },
            "scopes": { "type": "array", "uniqueItems": true, "items": { "type": "string" } },
            "audience": { "type": "string", "minLength": 1 }
          }
        },
        "failureMode": { "enum": ["fail-closed", "degrade"] }
      },
      "allOf": [
        {
          "if": { "properties": { "kind": { "const": "bundled" } } },
          "then": { "required": ["artifact"] }
        },
        {
          "if": { "properties": { "kind": { "const": "package" } } },
          "then": { "required": ["locator", "packageDigest"] }
        },
        {
          "if": { "properties": { "kind": { "const": "remote" } } },
          "then": {
            "required": ["endpoint", "remoteMutable", "auth"],
            "properties": { "remoteMutable": { "const": true } }
          }
        }
      ]
    },
    "catalog": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "source", "digest"],
      "properties": {
        "id": { "type": "string", "format": "uri" },
        "source": { "enum": ["system", "bundled", "store"] },
        "digest": { "$ref": "#/$defs/digest" },
        "asset": { "$ref": "#/$defs/asset" }
      },
      "allOf": [
        {
          "if": { "properties": { "source": { "const": "bundled" } } },
          "then": { "required": ["asset"] }
        }
      ]
    },
    "icon": {
      "type": "object",
      "additionalProperties": false,
      "required": ["purpose", "theme", "path", "mediaType", "digest", "size", "sizePx", "accessibleName"],
      "properties": {
        "purpose": { "enum": ["primary", "monochrome", "notification"] },
        "theme": { "enum": ["any", "light", "dark"] },
        "path": { "$ref": "#/$defs/path" },
        "mediaType": { "enum": ["image/png", "image/webp", "image/svg+xml"] },
        "digest": { "$ref": "#/$defs/digest" },
        "size": { "type": "integer", "minimum": 1 },
        "sizePx": { "type": "integer", "minimum": 16, "maximum": 2048 },
        "accessibleName": { "type": "string", "minLength": 1, "maxLength": 120 }
      }
    },
    "permission": {
      "type": "object",
      "additionalProperties": false,
      "required": ["capability", "purpose", "activation", "lifetime", "constraints"],
      "properties": {
        "capability": { "type": "string", "pattern": "^[a-z][a-z0-9.-]+$" },
        "purpose": { "type": "string", "minLength": 1, "maxLength": 300 },
        "activation": { "enum": ["install", "user-gesture", "per-action", "background-policy"] },
        "lifetime": { "enum": ["once", "task", "session", "persistent"] },
        "constraints": {
          "type": "object",
          "propertyNames": { "pattern": "^[A-Za-z][A-Za-z0-9_.-]*$" },
          "additionalProperties": true
        }
      }
    },
    "dataPractice": {
      "type": "object",
      "additionalProperties": false,
      "required": ["source", "categories", "destination", "purpose", "retention", "trainingUse"],
      "properties": {
        "source": { "type": "string", "minLength": 1 },
        "categories": {
          "type": "array", "minItems": 1, "uniqueItems": true,
          "items": { "type": "string", "pattern": "^[a-z][a-z0-9.-]+$" }
        },
        "destination": { "type": "string", "format": "uri" },
        "purpose": { "type": "string", "pattern": "^[a-z][a-z0-9.-]+$" },
        "retention": { "enum": ["none", "session", "until-user-deletes", "publisher-defined"] },
        "trainingUse": { "enum": ["prohibited", "opt-in", "contractual"] }
      }
    },
    "dependency": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "id", "version", "digest", "optional"],
      "properties": {
        "kind": { "enum": ["agent", "skill", "model", "runtime", "a2ui-catalog"] },
        "id": { "type": "string", "minLength": 1 },
        "version": { "$ref": "#/$defs/semver" },
        "versionRange": { "type": "string", "minLength": 1 },
        "digest": { "$ref": "#/$defs/digest" },
        "optional": { "type": "boolean" }
      }
    }
  }
}
```

### 7.1 Semantic validation

Schema 通过后，Publisher CLI、Store 和 Installer 仍 MUST 执行以下语义检查：

1. `runtime.entrypoint` 必须引用已声明 Prompt、Skill 或运行时入口。
2. 每个 `path` 必须且只能匹配一个 OCI blob descriptor；digest 与 size 必须一致。
3. 所有 `id` 在各自数组内必须唯一。
4. bundled MCP 只可使用 `stdio`，remote MCP 不可使用 `stdio`。
5. 远程 MCP 必须是 HTTPS、`remoteMutable: true`、独立 OAuth audience，并具有 capability snapshot。
6. MCP tool allowlist 必须是审核快照的子集；运行时新增工具默认不可用。
7. `a2a.card` 必须通过目标 A2A 版本校验；公共或认证暴露 SHOULD 含 JWS 签名。
8. A2UI Catalog digest 必须存在于系统、包或 Store 已批准 Catalog；`inlineCatalogs` 和 `executableComponents` 在普通 Agent 中 MUST 为 `false`。
9. 所有网络 destination 必须由对应网络 permission 覆盖；未声明网络默认拒绝。
10. 数据类别、目的、目的地、保留和训练使用必须覆盖每条外发路径。
11. 依赖闭包不得有无法满足的版本、digest 冲突或禁止的循环。
12. 组合后的权限、数据流、委托深度和预算不得超过用户或组织授权。
13. `minimum` 不得大于同一 gate 的 `maximum`。
14. 更新若改变权限、数据流、签名者、远程 endpoint、MCP schema 或 A2UI Catalog，必须标记为需要重新同意或重新审核。

## 8. Prompt、Skill 与模型兼容性

- Prompt MUST 作为普通内容 blob 打包并声明 role、media type、digest 和 size。
- Skill MUST 声明自身 ID、SemVer、入口、digest，并 MUST 进入依赖与行为评测范围。
- Prompt 或 Skill MUST NOT 在安装阶段执行。
- 自修改 Prompt/Skill、运行期下载未声明 Prompt/Skill 或绕过 Store 拉取 `latest` MUST 被拒绝。
- Manifest SHOULD 声明模型能力而非绑定单一商业模型；若行为只能在特定模型或策略上成立，依赖 MUST 明确锁定该模型策略标识与版本。
- Store MUST 按 Agent 版本和模型策略分别记录评测结果。模型升级 MUST 被视为行为变更并经过灰度验证。

## 9. MCP、A2A 与 A2UI Catalog

### 9.1 MCP

MCP Registry `server.json` MAY 作为 MCP 元数据导入来源，但 Registry 收录 MUST NOT 被当作 AIOS 审核通过。

Store 在审核远程 MCP 时 MUST 获取并规范化：

- operator 与 endpoint 身份；
- transport 与认证方案；
- `tools/list`、`resources/list`、`prompts/list`；
- 名称、描述、输入 schema、输出 schema；
- OAuth scopes、audience、数据区域和外发目的地。

这些内容构成 capability snapshot。运行时发现工具名、描述、schema、scope、endpoint 或 operator 改变时 MUST 产生漂移事件。新增或扩大的能力 MUST 默认阻止；高风险变化 MUST 暂停服务并触发重新审核。

### 9.2 A2A

- Agent Card MUST 作为独立 blob 打包并按其协议版本验证。
- `agent.json` 是安装与权限事实源，Agent Card 是互操作与发现投影；冲突时 AIOS MUST 采用更严格者并拒绝未声明能力。
- A2A Agent Card 签名不能替代整个 Artifact 的签名。
- A2A 子委托 MUST 经过 Capability Broker；子 Agent 权限、TTL、预算和委托深度只能衰减。

### 9.3 A2UI Catalog

- AIOS MVP MUST 只支持固定 digest 的系统 Catalog。
- 普通 Agent MUST NOT 携带可执行 UI 代码或 inline Catalog。
- 自定义 Catalog 必须作为独立签名、扫描、版本化制品审核，不能因引用它的 Agent 已审核而自动获得信任。
- Renderer MUST 对组件数量、树深、更新频率、文本长度、资源 URL、图片大小、CPU 和内存设置上限。
- Agent Surface MUST 有不可伪造的来源标识；系统权限和支付界面 MUST 位于 Agent 无法绘制的系统层。

## 10. 图标与品牌

- 包 MUST 至少包含一个 1024×1024 primary 图标，并 SHOULD 提供 monochrome 变体。
- SVG MUST 禁止脚本、事件处理器、外部资源、动态 URL、foreign object，并在审核时清洗或栅格化。
- Store MUST 检测与系统 Agent、知名 Agent、发布者和域名的名称或图标近似仿冒。
- 验证徽章、系统状态和风险标签 MUST 由 Store/Shell 绘制，MUST NOT 成为图标资产的一部分。
- 每个图标 MUST 有 `accessibleName`。

## 11. 权限与数据实践

权限 MUST 采用“声明上限、安装展示、调用时精确授予、资源侧执行”的模型。

每个 permission MUST 声明：

- capability；
- 人可理解的 purpose；
- activation；
- lifetime；
- 资源、动作、域名、金额、写集或数据类别 constraints。

高风险操作，包括支付提交、对外发送、删除、安装、账号绑定、凭据授权、代码执行和管理员操作，MUST 使用系统逐笔确认。Agent 输出的自然语言“用户已同意”不构成授权证据。

每条数据流 MUST 声明来源、数据类别、目的地、目的、保留和训练用途。Store MUST 以独立标签展示：

1. 读取什么；
2. 能修改或发送什么；
3. 数据去哪里；
4. 能自主运行多久；
5. 最坏花费多少。

Agent Runtime MUST 默认拒绝未声明文件、网络、设备、密钥和工具访问。遥测内容默认不得包含 Prompt、文件内容、模型输入或输出；内容采集必须由用户或组织显式开启。

## 12. 依赖、组合与锁定

- `dependencies.version` 表示推荐精确版本；`versionRange` MAY 表达可接受范围；`digest` 始终表示发布时验证的精确候选。
- MVP Installer MUST 禁止重新求解，直接采用 first-party local catalog 给出的 fixed digest。
- 云 Store MAY 使用 SemVer/VERS 求解，但安装前 MUST 生成固定 digest 的完整锁文件。
- 所有 transitive dependencies MUST 进入 SBOM、签名策略、漏洞扫描、权限计算和评测范围。
- 循环依赖默认 MUST 被拒绝；只有无运行时递归语义的 Catalog 元数据引用 MAY 经验证后允许。
- 可组合 Agent MUST 形成显式 DAG/状态机，声明类型化输入输出、超时、重试、幂等、预算和补偿动作。
- 组合包 MUST 自身拥有 artifact digest、签名、评测和审核；组件的评分与审核不得自动传递给组合结果。

## 13. 评测与审核

每个可安装 Agent MUST 携带至少一个离线 conformance suite。Store MUST 记录测试使用的 Agent digest、依赖锁、模型策略、数据集 digest、运行时版本和策略版本。

审核 SHOULD 包含：

1. 签名、来源、SBOM、漏洞、许可证、秘密和仿冒检查；
2. Prompt/Skill 中的隐藏指令、混淆编码、自修改、外泄和破坏行为分析；
3. A2UI schema、URL、action 和系统界面仿冒检查；
4. 在隔离沙箱中使用假文件、假凭据、恶意网页/邮件和受控网络引爆；
5. prompt injection、confused deputy、MCP tool misuse、成本 DoS 和无限循环评测；
6. 权限与实际行为、数据流和网络目的地的一致性检查；
7. 任务成功率、人工接管率、工具错误率、延迟、成本和撤销率回归。

签名证明身份而非善意；静态扫描和沙箱均存在漏报。运行期最小权限、系统确认、漂移检测、异常熔断和吊销 MUST 作为审核后的持续控制。

## 14. 签名、SBOM、Provenance 与安全更新

AIOS 分阶段采用成熟供应链标准：

| 能力 | MVP：first-party local catalog | 云 Store / 第三方发布 |
|---|---|---|
| 制品 | MUST：OCI Image Layout 与固定 SHA-256 | MUST：OCI Distribution 1.1+ 与 ORAS |
| 发布签名 | MUST：随 OS 发布的 first-party 离线信任根 | MUST：Sigstore/Cosign；支持私有信任根 |
| 透明日志 | MAY：使用离线 Sigstore bundle | MUST：Rekor 或等价可审计透明日志 |
| SBOM | MUST：SPDX 3 或 CycloneDX；作为 OCI Referrer | MUST：完整 transitive SBOM 与 VEX |
| 构建 provenance | SHOULD：CI 生成 in-toto/SLSA provenance | MUST：in-toto attestation，至少满足 Store 要求的 SLSA 等级 |
| 更新元数据 | 不适用：目录随 OS 发布且只按 digest 安装 | MUST：TUF Root/Targets/Snapshot/Timestamp |
| 商店审核 | MUST：first-party conformance 与安全测试 | MUST：自动扫描、动态评测、风险分级与人工升级审核 |

签名、SBOM、provenance、评测与 Store review SHOULD 通过 OCI Referrers 关联到 Agent Artifact，MUST NOT 修改被审核的 Artifact。

云 Store 的信任策略 MUST 支持签名者轮换、密钥泄露恢复、阈值签名或双人审核。高风险 Agent SHOULD 要求独立构建身份与发布者身份同时满足策略。

## 15. 更新、回滚、下架与吊销

- Artifact 不可变；`stable`、`beta`、`canary` 只是由 Store/TUF 管理的 digest 指针。
- 云 Store SHOULD 采用 1% → 5% → 25% → 100% 灰度，并以安全、成功率、成本和错误率门禁自动停止。
- 权限、数据目的地、训练用途、签名者、MCP endpoint/schema、A2UI Catalog 或依赖信任扩大的更新 MUST 重新同意并重新审核。
- 回滚 MUST 恢复完整 Install Lock，而不是只恢复 Prompt；包括 Agent、Skill、MCP package/snapshot、模型策略和 Catalog。
- 状态迁移前 MUST 快照用户状态。不可逆迁移 MUST 在安装前由系统明确展示，并禁止自动灰度。
- 本地 SHOULD 保留最近两个已验证版本及其锁文件。
- 远程 MCP 无法由 AIOS 回滚实现；AIOS MUST 能冻结已审核能力、切换预先审核的备用 endpoint 或 fail closed。

Store 状态至少包括：

- `deprecated`：停止推荐，允许现有安装；
- `unlisted`：禁止新安装；
- `suspended`：暂停执行，等待调查；
- `revoked`：确认恶意或密钥失陷，隔离制品并撤销能力与凭据。

吊销状态由 Store 信任根/TUF 元数据决定，不由包内 URL 单方面决定。吊销 MUST 记录理由、证据、时间、策略版本和申诉状态。除非适用的用户或组织策略明确要求，吊销 MUST NOT 静默删除用户数据；卸载和吊销均 MUST 执行 `credentialDisposition`。

## 16. 兼容策略

### 16.1 Schema 兼容

- `schemaVersion` 使用 `MAJOR.MINOR`。
- 同一 MAJOR 的 MINOR 版本只能新增可选字段、枚举的协商式扩展或更宽松的限制，MUST 保持旧 manifest 有效。
- 删除字段、改变字段含义、收紧旧值或改变默认安全语义必须递增 MAJOR。
- Parser MUST 拒绝未知 MAJOR。
- Parser MAY 接受更高 MINOR，但只有在实现理解所有必需语义时才可安装；否则 MUST fail closed。
- 顶层未知字段 MUST 被 Schema 拒绝。扩展只能位于 `extensions`，key MUST 是绝对 URI。
- 安全相关扩展若被标记为 required 而客户端不理解，客户端 MUST 拒绝安装。

### 16.2 协议兼容

- A2A、A2UI、MCP、Catalog 和模型策略版本 MUST 分别协商，不得从 `agent.json.schemaVersion` 推断。
- Store MUST 发布受支持版本矩阵；Installer MUST 在安装前验证所有协议和 Catalog digest。
- A2UI v1.0 在其成为 AIOS 支持的稳定版本前不得替换 v0.9.1 的默认 Profile；升级必须通过适配层和 conformance suite。

### 16.3 行为兼容

行为兼容不能仅由 SemVer 推断。Store MUST 比较新旧版本的：

- Prompt/Skill/MCP/Catalog digest；
- 权限与数据流；
- Agent Card 与工具 schema；
- 模型策略；
- 评测和生产质量分布。

任何高风险维度扩大都使更新失去静默兼容资格。

## 17. MVP 与演进路线

### 17.1 MVP：First-party Fixed-digest Local Catalog

MVP MUST 采用最小可信闭环：

- 只接受 AIOS first-party publisher；
- Catalog 随 OS 发布并使用 OS 离线信任根验证；
- Catalog 条目只包含固定 `(id, version, artifactDigest, ociLayoutPath, status)`；
- Artifact 存在本地 OCI Image Layout；安装过程不访问网络；
- 所有依赖固定 digest，不做在线解析；
- MCP 只允许 bundled、沙箱化、fixed-digest 服务；
- A2A 只允许 `local-only`；
- A2UI 只允许 fixed-digest system Catalog；
- 更新为 `explicit`，通过新的 OS/Catalog 发布完成；
- 必须有 SBOM、资产 digest、first-party 签名、离线评测、权限与数据实践展示；
- 不实现第三方上架、付费、评论、推荐、远程 MCP 或联邦发现。

这不是临时偷懒，而是刻意把第一个版本的信任面限制为“本地、第一方、固定摘要、无远程漂移”。

### 17.2 云 Store

云 Store 在不改变 `agent.json` 或 Artifact 的前提下增加：

- OCI Distribution/ORAS 远程分发与镜像；
- 第三方 publisher onboarding；
- Sigstore/Fulcio/Rekor；
- in-toto/SLSA provenance 强制策略；
- TUF 更新、通道、吊销和密钥恢复；
- 远程 MCP/A2A 身份验证、capability snapshot 和漂移监控；
- 自动/人工审核、灰度、质量观测；
- 试用、计量、价格、评论、排名、退款和争议处理；
- 企业私有 Store、策略 overlay、air-gap mirror 和组织 countersign。

云 Store MUST 继续支持按 digest 安装与 OCI Layout 导出。导入其他 Store 的 Artifact 时 MUST 重新验证来源、依赖、权限和行为，不得继承原 Store 的评分或审核结论。

## 18. 最小符合性检查

### Publisher

- canonical `agent.json` 通过结构与语义校验；
- 所有资产、依赖和 capability snapshot 有真实 digest；
- 无秘密、用户数据、绝对路径或浮动 `latest`；
- 权限与数据实践完整；
- 至少一个 conformance suite；
- OCI Artifact 可按 digest 重建和导出。

### Store

- 验证发布者、Artifact、SBOM、provenance 与审核 attestation；
- 不可变保存 `(id, version, digest)`；
- 展示权限、数据流、远程可变性、质量、成本和吊销状态；
- 生成并保留完整 Install Lock；
- 对高风险变化重新审核和重新同意；
- 能暂停、回滚、吊销和导出审计证据。

### Runtime

- 只运行通过 digest、签名和策略验证的闭包；
- 默认拒绝未声明能力；
- 系统层确认高风险操作；
- 隔离 A2UI、MCP、A2A 与用户凭据；
- 记录不含默认敏感内容的可审计 trace；
- 对能力漂移、预算异常和吊销 fail closed。

## 19. 采用的开放标准与实现

- [OCI Image Specification](https://github.com/opencontainers/image-spec)
- [OCI Distribution Specification](https://github.com/opencontainers/distribution-spec)
- [ORAS](https://github.com/oras-project/oras)
- [Semantic Versioning 2.0.0](https://semver.org/)
- [Package URL](https://github.com/package-url/purl-spec)
- [SPDX Specifications](https://spdx.dev/use/specifications/)
- [CycloneDX Specification](https://cyclonedx.org/specification/overview/)
- [Sigstore](https://docs.sigstore.dev/)
- [in-toto Attestation Framework](https://github.com/in-toto/attestation)
- [SLSA 1.2](https://slsa.dev/spec/v1.2/)
- [The Update Framework](https://theupdateframework.github.io/specification/latest/)
- [MCP Registry `server.json`](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/draft/server.schema.json)
- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- [A2A Specification](https://a2a-protocol.org/latest/specification/)
- [A2UI Specification](https://a2ui.org/)
- [OASF](https://github.com/agntcy/oasf)
- [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)
- [OpenSSF Package Analysis](https://github.com/ossf/package-analysis)
- [OWASP Top 10 for Agentic Applications](https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/)
- [MITRE ATLAS](https://atlas.mitre.org/)
