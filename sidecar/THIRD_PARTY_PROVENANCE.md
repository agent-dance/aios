# Third-party provenance: Agent sidecar

This record covers the direct execution SDK used by the AlSniper OS Go sidecar. It records source identity and release status; it is not a substitute for a complete software-bill-of-materials generated from `go.mod` and `go.sum`.

## agent-adaptor

| Field | Recorded value |
| --- | --- |
| Module | `github.com/agent-dance/agent-adaptor` |
| Source repository | `https://github.com/agent-dance/agent-adaptor.git` |
| Upstream release | `v1.0.0` |
| Upstream ref | `refs/tags/v1.0.0^{}` |
| Resolved commit | `e33f0f3eb2dd51a47e2397e1e39a5fef94d8aa38` |
| Go module version | `v1.0.0` |
| Module sum | `h1:eF5qUeFbsj7CYWIsnmnx9J3IbeLRaQcLe3OMmR/86mA=` |
| Pin location | `sidecar/go.mod` and `sidecar/go.sum` |
| Used capability | `adaptor.New`, `codex.Driver`, `profile.CloneFrom` with copied settings and linked OAuth state, one-shot execution, Inspector diagnostics, strict local JSON Schema output, `Result`/`RunError`, and `Agent.Close` |

Resolution can be checked without switching the working tree:

```powershell
git ls-remote https://github.com/agent-dance/agent-adaptor.git refs/tags/v1.0.0 refs/tags/v1.0.0^{}
go list -m -json github.com/agent-dance/agent-adaptor
go mod verify
```

The annotated release tag dereferences to the recorded commit. `go.mod` uses the formal release directly and contains no local `replace`.

## License status and release decision

The source tree at release commit `e33f0f3eb2dd51a47e2397e1e39a5fef94d8aa38` contains no `LICENSE`, `LICENSE.*`, `COPYING`, `NOTICE`, or equivalent license file. A scan of the upstream root documentation also found no usable copyright license grant.

Consequently, redistribution is not authorized by repository metadata. This is a legal blocker for publishing an AlSniper OS binary that incorporates this Go module, and for vendoring or redistributing its source. Repository visibility and the ability to download or build the source do not imply redistribution permission.

Release may proceed only after the rights holder publishes a compatible explicit license for the pinned code or legal counsel records a separate redistribution grant applicable to AlSniper OS. Until then, this integration is restricted to local development and evaluation and must not be represented as cleared for distribution.

Transitive Go dependencies remain pinned by `sidecar/go.sum`; their notices and licenses require a separate release SBOM/license review even after the direct dependency blocker is resolved.
