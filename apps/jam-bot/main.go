// Command jam-bot plays each room's Jam into LiveKit: concord-api tells it which file to play in
// which room (apps/jam-bot/API.md) and it sends the file's original Opus packets as a stereo
// track, paced in real time, starting while the upload is still being written.
//
//	jam-bot              serve the API on JAM_BOT_LISTEN
//	jam-bot healthcheck  exit 0 when GET /healthz answers (the Docker healthcheck)
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/bryanljf/Concord/apps/jam-bot/internal/lk"
	"github.com/bryanljf/Concord/apps/jam-bot/internal/player"
	"github.com/bryanljf/Concord/apps/jam-bot/internal/server"
	"github.com/bryanljf/Concord/apps/jam-bot/internal/webmopus"
)

const (
	defaultListen   = "127.0.0.1:3001"
	defaultCacheDir = "../../infra/jam-cache" // the dev cache, next to the api's
	shutdownBudget  = 8 * time.Second         // Docker waits 10 s before killing
)

type config struct {
	listen   string
	token    string
	cacheDir string
}

func loadConfig(getenv func(string) string) (config, error) {
	c := config{
		listen:   strings.TrimSpace(getenv("JAM_BOT_LISTEN")),
		token:    strings.TrimSpace(getenv("JAM_BOT_TOKEN")),
		cacheDir: strings.TrimSpace(getenv("JAM_CACHE_DIR")),
	}
	if c.listen == "" {
		c.listen = defaultListen
	}
	if _, _, err := net.SplitHostPort(c.listen); err != nil {
		return c, fmt.Errorf("JAM_BOT_LISTEN must be host:port: %w", err)
	}
	if c.cacheDir == "" {
		c.cacheDir = defaultCacheDir
	}
	return c, nil
}

func main() {
	if len(os.Args) > 1 {
		if os.Args[1] != "healthcheck" || len(os.Args) > 2 {
			fmt.Fprintln(os.Stderr, "usage: jam-bot [healthcheck]")
			os.Exit(2)
		}
		os.Exit(healthcheck(os.Getenv))
	}
	os.Exit(run())
}

// healthcheckURL is where the healthcheck finds the API (a wildcard address means loopback).
func healthcheckURL(listen string) string {
	host, port, _ := net.SplitHostPort(listen)
	switch host {
	case "", "0.0.0.0":
		host = "127.0.0.1"
	case "::":
		host = "::1"
	}
	return "http://" + net.JoinHostPort(host, port) + "/healthz"
}

func healthcheck(getenv func(string) string) int {
	cfg, err := loadConfig(getenv)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(healthcheckURL(cfg.listen))
	if err != nil {
		fmt.Fprintln(os.Stderr, "unhealthy:", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "unhealthy: status", resp.StatusCode)
		return 1
	}
	return 0
}

func run() int {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		log.Error("invalid configuration", "err", err)
		return 1
	}
	// The files still being written (uploads streaming in): what the API is told about them
	// reaches every Source reading them.
	growth := webmopus.NewGrowth()
	files, err := server.NewFiles(cfg.cacheDir, growth)
	if err != nil {
		log.Error("invalid JAM_CACHE_DIR", "err", err)
		return 1
	}

	lk.InstallLogger(log)
	hub := server.NewHub()
	rooms := player.NewManager(player.Options{
		Connector: &lk.Connector{Log: log},
		Log:       log,
		Emit:      hub.Publish,
	})
	srv := &http.Server{
		Handler: server.New(server.Config{
			Token:  cfg.token,
			Files:  files,
			Rooms:  rooms,
			Hub:    hub,
			Log:    log,
			Redact: lk.Redact,
		}),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}
	ln, err := net.Listen("tcp", cfg.listen)
	if err != nil {
		log.Error("could not listen", "err", err)
		return 1
	}
	log.Info("jam-bot listening", "listen", ln.Addr().String(), "cacheDir", files.Dir(),
		"auth", cfg.token != "", "go", runtime.Version())

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()
	select {
	case <-ctx.Done():
	case err := <-served:
		log.Error("server stopped", "err", err)
		return 1
	}

	log.Info("shutting down")
	budget, cancel := context.WithTimeout(context.Background(), shutdownBudget)
	defer cancel()
	hub.Close() // ends the event streams, which Shutdown would wait for
	shut := make(chan error, 1)
	go func() { shut <- srv.Shutdown(budget) }() // stops accepting now, waits for requests
	rooms.Close(budget)                          // leaves every room (aborts joins in progress)
	if err := <-shut; err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Warn("requests still running at exit", "err", err)
	}
	log.Info("stopped")
	return 0
}
