package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func envOf(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadConfig(t *testing.T) {
	c, err := loadConfig(envOf(nil))
	if err != nil || c.listen != "127.0.0.1:3001" || c.token != "" || c.cacheDir != "../../infra/jam-cache" {
		t.Fatalf("defaults: %+v, %v", c, err)
	}
	c, err = loadConfig(envOf(map[string]string{
		"JAM_BOT_LISTEN": " 0.0.0.0:4001 ", "JAM_BOT_TOKEN": " s3cret\n", "JAM_CACHE_DIR": " /var/lib/concord-jam ",
	}))
	if err != nil || c.listen != "0.0.0.0:4001" || c.token != "s3cret" || c.cacheDir != "/var/lib/concord-jam" {
		t.Fatalf("trimmed: %+v, %v", c, err)
	}
	// Compose always passes JAM_BOT_TOKEN, maybe empty: no auth.
	if c, _ := loadConfig(envOf(map[string]string{"JAM_BOT_TOKEN": "  "})); c.token != "" {
		t.Fatalf("blank token %q", c.token)
	}
	if _, err := loadConfig(envOf(map[string]string{"JAM_BOT_LISTEN": "3001"})); err == nil {
		t.Fatal("listen without host accepted")
	}
}

func TestHealthcheckURL(t *testing.T) {
	cases := map[string]string{
		"127.0.0.1:3001": "http://127.0.0.1:3001/healthz",
		"0.0.0.0:3001":   "http://127.0.0.1:3001/healthz",
		":3001":          "http://127.0.0.1:3001/healthz",
		"[::]:3001":      "http://[::1]:3001/healthz",
		"localhost:3001": "http://localhost:3001/healthz",
	}
	for listen, want := range cases {
		if got := healthcheckURL(listen); got != want {
			t.Errorf("healthcheckURL(%q) = %q, want %q", listen, got, want)
		}
	}
}

func TestHealthcheck(t *testing.T) {
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer healthy.Close()
	addr := healthy.Listener.Addr().String()
	if code := healthcheck(envOf(map[string]string{"JAM_BOT_LISTEN": addr})); code != 0 {
		t.Fatalf("healthy: exit %d", code)
	}

	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer failing.Close()
	if code := healthcheck(envOf(map[string]string{"JAM_BOT_LISTEN": failing.Listener.Addr().String()})); code != 1 {
		t.Fatalf("503: exit %d", code)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closed := ln.Addr().String()
	ln.Close()
	if code := healthcheck(envOf(map[string]string{"JAM_BOT_LISTEN": closed})); code != 1 {
		t.Fatalf("nothing listening: exit %d", code)
	}
}
