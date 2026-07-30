# Trusted local Agent runtime

This is the temporary Windows x64 launch path for running the locally built
`alsniper-agent.exe` beside the production Electron shell. It is deliberately
separate from application packaging.

From the repository root:

```powershell
npm run local-runtime:build
npm run local-runtime:launch
```

`local-runtime:build` packages the production desktop first, preserving its
`AlSniper OS` application identity and `%APPDATA%/AlSniper OS` persistent data
location, then builds a CGO-free Windows amd64 sidecar beneath
`release/local-agent-runtime/`. The build fails unless `go version -m` proves
that the executable embeds the unreplaced
`github.com/agent-dance/agent-adaptor v1.0.0` module with its audited official
module checksum. Its SHA-256 and dependency
checksum are recorded in an adjacent local manifest; launch recomputes the
binary hash and checks the embedded Go metadata before executing it. The whole
`release/` tree remains untracked.

The launcher reserves an available high loopback port, creates a fresh 256-bit
sidecar secret, and passes it only through child-process environments. The value is
never written to disk, placed in command arguments, or printed. It starts the
desktop only after a request and response HMAC-authenticated health check says
the sidecar is ready. Before Electron is spawned, the launcher also listens on
a one-use local named pipe with a fresh 128-bit random suffix and an independent
256-bit secret. Electron consumes and deletes both launch values and the sidecar
bootstrap environment before creating a renderer, connects, sends the fixed
versioned readiness preface, and returns a PID-bound HMAC possession proof. The
launcher does not declare desktop startup successful before that proof. This
temporary Node supervisor treats the same Windows user session as one trust
domain; a distributable hardened supervisor must add OS-enforced peer-PID and
named-pipe DACL checks.

Keep this launcher in the foreground. Closing AlSniper OS, the sidecar, the
launcher, or its controlling input stream stops the other processes. Normal
shutdown gives the sidecar stdin channel 12 seconds and the desktop
named-pipe/storage exit gate 30 seconds to complete before force cleanup;
Windows `taskkill /T /F` is used only as a final exact-PID tree cleanup. Like
other user-space supervisors without a native Windows Job Object, it cannot run
cleanup after power loss or an uncatchable termination of the launcher itself.

The sidecar links the native Codex authentication file and clones the supported
Codex settings into its isolated profile. Run `codex login` first if local
authentication is unavailable. Neither Codex CLI nor its credentials are
included in the desktop package.
