package main

import (
	"context"
	"errors"
	"log/slog"
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			logger.Error("graceful shutdown failed", "error", err)
		}
	}()
	logger.Info("AlSniper Agent sidecar listening", "address", cfg.ListenAddress, "protocol", protocol.Version)
	serveErr := httpServer.ListenAndServe()
	if ctx.Err() != nil {
		<-shutdownDone
	}
	if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
		logger.Error("HTTP server failed", "error", serveErr)
		closeAgent()
		os.Exit(1)
	}
	closeAgent()
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
