package agent

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const (
	auditedCodexCLIVersion = "0.145.0"
	maxCodexVersionOutput  = 4 << 10
	codexVersionTimeout    = 5 * time.Second
)

type boundedCommandOutput struct {
	mu        sync.Mutex
	contents  bytes.Buffer
	truncated bool
}

func (w *boundedCommandOutput) Write(value []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	remaining := maxCodexVersionOutput - w.contents.Len()
	if remaining > 0 {
		stored := value
		if len(stored) > remaining {
			stored = stored[:remaining]
		}
		_, _ = w.contents.Write(stored)
	}
	if len(value) > remaining {
		w.truncated = true
	}
	return len(value), nil
}

func (w *boundedCommandOutput) String() (string, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.contents.String(), w.truncated
}

// validateCodexCLIVersion pins the host feature denylist and config semantics
// to the exact CLI build audited by this sidecar. New Codex versions must be
// reviewed before they can introduce previously unknown execution surfaces.
func validateCodexCLIVersion(parent context.Context, command string) error {
	ctx, cancel := context.WithTimeout(parent, codexVersionTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, command, "--version")
	cmd.Env = codexProbeEnvironment(os.Environ())
	var output boundedCommandOutput
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := cmd.Run(); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		return fmt.Errorf("Codex CLI version probe failed: %w", err)
	}
	raw, truncated := output.String()
	if truncated {
		return errors.New("Codex CLI version output exceeds the safe size limit")
	}
	want := "codex-cli " + auditedCodexCLIVersion
	if strings.TrimSpace(raw) != want {
		return fmt.Errorf("unsupported Codex CLI version; AlSniper Agent Runtime requires exactly %s", want)
	}
	return nil
}

func codexProbeEnvironment(environment []string) []string {
	result := make([]string, 0, len(environment))
	seen := make(map[string]struct{}, len(environment))
	for _, item := range environment {
		name, value, ok := strings.Cut(item, "=")
		if !ok || name == "" || !safeCodexChildEnvironment(name, value) {
			continue
		}
		key := strings.ToUpper(name)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, name+"="+value)
	}
	return result
}
