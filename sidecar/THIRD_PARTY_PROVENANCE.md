# Third-party provenance: Agent sidecar

This record covers the direct execution SDK used by the AlSniper OS Go sidecar. It records source identity and release status; it is not a substitute for a complete software-bill-of-materials generated from `go.mod` and `go.sum`.

## agent-adaptor

| Field | Recorded value |
| --- | --- |
| Module | `github.com/agent-dance/agent-adaptor` |
| Source repository | `https://github.com/agent-dance/agent-adaptor.git` |
| User-requested branch name | `cl/opt/examples` |
| Actual upstream ref | `refs/heads/cl/opt_examples` |
| Resolved commit | `aac715d492a1defd65525c1639dd6a639e36d384` |
| Go pseudo-version | `v0.12.1-0.20260725141943-aac715d492a1` |
| Pin location | `sidecar/go.mod` and `sidecar/go.sum` |
| Used capability | Codex driver binding, auth-link profile cloning, stateless ephemeral execution, deny run policy, environment/profile diagnostics, strict JSON Schema output |

Resolution can be checked without switching the working tree:

```powershell
git ls-remote https://github.com/agent-dance/agent-adaptor.git refs/heads/cl/opt_examples refs/heads/cl/opt/examples
go list -m -json github.com/agent-dance/agent-adaptor
go mod verify
```

At the time of pinning, the remote resolves only `refs/heads/cl/opt_examples` to the recorded commit; the slash-form ref does not exist. The pseudo-version encodes the same commit prefix and is not a floating branch dependency.

## License status and release decision

The source tree at commit `aac715d492a1defd65525c1639dd6a639e36d384` contains no `LICENSE`, `LICENSE.*`, `COPYING`, `NOTICE`, or equivalent license file. A scan of the upstream root documentation also found no usable copyright license grant.

Consequently, redistribution is not authorized by repository metadata. This is a legal blocker for publishing an AlSniper OS binary that incorporates this Go module, and for vendoring or redistributing its source. Repository visibility and the ability to download or build the source do not imply redistribution permission.

Release may proceed only after the rights holder publishes a compatible explicit license for the pinned code or legal counsel records a separate redistribution grant applicable to AlSniper OS. Until then, this integration is restricted to local development and evaluation and must not be represented as cleared for distribution.

Transitive Go dependencies remain pinned by `sidecar/go.sum`; their notices and licenses require a separate release SBOM/license review even after the direct dependency blocker is resolved.
