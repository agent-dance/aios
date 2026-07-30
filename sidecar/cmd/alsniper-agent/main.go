package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/buthim/alsniper-os/sidecar/internal/agent"
	"github.com/buthim/alsniper-os/sidecar/internal/config"
	"github.com/buthim/alsniper-os/sidecar/internal/protocol"
	"github.com/buthim/alsniper-os/sidecar/internal/server"
)

type runnerFactory func(config.Config) (agent.Runner, func() error, error)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version-json" {
		if err := writeVersionJSON(os.Stdout); err != nil {
			_, _ = os.Stderr.WriteString("write version metadata: " + err.Error() + "\n")
			os.Exit(1)
		}
		return
	}
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	cfg, err := config.Load()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(2)
	}
	service, closeRunner, degraded, err := buildAgentService(cfg, newCodexRunner)
	if err != nil {
		logger.Error("initialize Agent service", "error", err)
		os.Exit(2)
	}
	if degraded {
		logger.Warn("Codex runtime unavailable; authenticated Agent capabilities are degraded")
	}
	closeAgent := func() {
		if err := closeRunner(); err != nil {
			logger.Error("release Codex profile lease", "error", err)
		}
	}
	handler, err := server.New(cfg, service)
	if err != nil {
		logger.Error("initialize HTTP service", "error", err)
		closeAgent()
		os.Exit(2)
	}
	httpServer := &http.Server{
		Addr:              cfg.ListenAddress,
		Handler:           handler.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      max(cfg.ChatTimeout, cfg.GameTimeout) + 10*time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}
	listener, err := net.Listen("tcp", cfg.ListenAddress)
	if err != nil {
		logger.Error("open HTTP listener", "error", err)
		closeAgent()
		os.Exit(1)
	}
	signalContext, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	ctx, cancel := context.WithCancel(signalContext)
	defer cancel()
	if os.Getenv("AIOS_SIDECAR_SHUTDOWN_STDIN") == "1" {
		go cancelWhenStdinCloses(os.Stdin, cancel)
	}
	serveDone := make(chan error, 1)
	go func() {
		serveDone <- httpServer.Serve(listener)
	}()
	logger.Info("AlSniper Agent sidecar listening", "address", cfg.ListenAddress, "protocol", protocol.Version)
	var serveErr error
	select {
	case <-ctx.Done():
		shutdownContext, stopShutdown := context.WithTimeout(context.Background(), 10*time.Second)
		if err := httpServer.Shutdown(shutdownContext); err != nil {
			logger.Error("graceful shutdown failed", "error", err)
			if closeErr := httpServer.Close(); closeErr != nil {
				logger.Error("force HTTP shutdown failed", "error", closeErr)
			}
		}
		stopShutdown()
		serveErr = <-serveDone
	case serveErr = <-serveDone:
		cancel()
	}
	if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
		logger.Error("HTTP server failed", "error", serveErr)
		closeAgent()
		os.Exit(1)
	}
	closeAgent()
}

type versionMetadata struct {
	ProtocolVersion      string `json:"protocolVersion"`
	AgentAdaptorVersion  string `json:"agentAdaptorVersion"`
	CodexRequiredVersion string `json:"codexRequiredVersion"`
}

func writeVersionJSON(output io.Writer) error {
	return json.NewEncoder(output).Encode(versionMetadata{
		ProtocolVersion:      protocol.Version,
		AgentAdaptorVersion:  agent.AgentAdaptorVersion,
		CodexRequiredVersion: agent.AuditedCodexCLIVersion,
	})
}

func cancelWhenStdinCloses(input io.Reader, cancel context.CancelFunc) {
	buffer := make([]byte, 1)
	for {
		if _, err := input.Read(buffer); err != nil {
			cancel()
			return
		}
	}
}

func newCodexRunner(cfg config.Config) (agent.Runner, func() error, error) {
	runner, err := agent.NewCodexRunner(cfg)
	if err != nil {
		return nil, nil, err
	}
	return runner, runner.Close, nil
}

func buildAgentService(cfg config.Config, factory runnerFactory) (*agent.Service, func() error, bool, error) {
	runner, closeRunner, err := factory(cfg)
	degraded := err != nil
	if degraded {
		runner = agent.NewUnavailableRunner()
		closeRunner = func() error { return nil }
	}
	service, err := agent.NewService(runner, cfg.MaxConcurrentRuns)
	if err != nil {
		if closeRunner != nil {
			_ = closeRunner()
		}
		return nil, nil, degraded, err
	}
	return service, closeRunner, degraded, nil
}
