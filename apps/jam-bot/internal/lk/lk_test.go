package lk

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
)

const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJAamFtIn0.c2lnbmF0dXJl"

func TestRedact(t *testing.T) {
	rememberHost("wss://lk.private.example:7443/")
	cases := map[string]string{
		`Get "https://lk.private.example:7443/rtc/validate?access_token=abc.def&auto_subscribe=0": EOF`: `Get "https://[livekit]/rtc/validate?access_token=[redacted]&auto_subscribe=0": EOF`,
		"dial tcp lk.private.example:7443: refused":                                                     "dial tcp [livekit]: refused",
		"lookup lk.private.example: no such host":                                                       "lookup [livekit]: no such host",
		"token " + jwt + " expired":                                                                     "token [token] expired",
		"nothing to hide":                                                                               "nothing to hide",
	}
	for in, want := range cases {
		if got := Redact(in); got != want {
			t.Errorf("Redact(%q) = %q, want %q", in, got, want)
		}
	}
	err := redactErr("joining", errors.New("dial lk.private.example:7443 with "+jwt))
	if got := err.Error(); got != "joining: dial [livekit] with [token]" {
		t.Errorf("redactErr: %q", got)
	}
}

func TestRejoinable(t *testing.T) {
	for _, r := range []livekit.DisconnectReason{
		livekit.DisconnectReason_UNKNOWN_REASON, livekit.DisconnectReason_SERVER_SHUTDOWN,
		livekit.DisconnectReason_SIGNAL_CLOSE, livekit.DisconnectReason_JOIN_FAILURE,
		livekit.DisconnectReason_STATE_MISMATCH, livekit.DisconnectReason_MIGRATION,
		livekit.DisconnectReason_CONNECTION_TIMEOUT, livekit.DisconnectReason_MEDIA_FAILURE,
	} {
		if !rejoinable(r) {
			t.Errorf("%v: want a rejoin", r)
		}
	}
	for _, r := range []livekit.DisconnectReason{
		livekit.DisconnectReason_CLIENT_INITIATED, livekit.DisconnectReason_DUPLICATE_IDENTITY,
		livekit.DisconnectReason_PARTICIPANT_REMOVED, livekit.DisconnectReason_ROOM_DELETED,
		livekit.DisconnectReason_ROOM_CLOSED,
	} {
		if rejoinable(r) {
			t.Errorf("%v: want no rejoin", r)
		}
	}
}

func TestSDKLogger(t *testing.T) {
	rememberHost("ws://lk.private.example:7880")
	var buf bytes.Buffer
	l := newSDKLogger(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})), time.Now)
	l.Debugw("debug noise", "k", 1)
	l.Infow("attempting join plan", "url", "ws://lk.private.example:7880?access_token="+jwt)
	if buf.Len() != 0 {
		t.Fatalf("debug/info logged at info level: %s", buf.String())
	}
	sub := l.WithValues("room", "sala", "odd").WithComponent("engine")
	sub.Warnw("restart failed on lk.private.example:7880", errors.New("bad token "+jwt),
		"attempt", struct{ Token string }{jwt}, "count", 3)
	l.Errorw("validate failed", nil, "status", 401)
	out := buf.String()
	for _, leak := range []string{"lk.private.example", jwt, "attempting"} {
		if strings.Contains(out, leak) {
			t.Fatalf("log leaks %q: %s", leak, out)
		}
	}
	for _, want := range []string{"level=WARN", "level=ERROR", "room=sala", "logger=engine", "count=3", "[livekit]", "[token]", "status=401"} {
		if !strings.Contains(out, want) {
			t.Fatalf("log lacks %q: %s", want, out)
		}
	}
	unlikely := l.WithUnlikelyValues("x", 1)
	_ = unlikely
	if d, _ := l.WithDeferredValues(); d == nil {
		t.Fatal("no deferred logger")
	}
}

func TestRedactIPs(t *testing.T) {
	cases := map[string]string{
		"dial udp 203.0.113.7:7882: refused":                        "dial udp [ip]:7882: refused",
		"candidate 192.168.1.20 54321 typ host raddr 0.0.0.0":       "candidate [ip] 54321 typ host raddr [ip]",
		"udp4:10.0.0.1:5000":                                        "udp4:[ip]:5000",
		"from [2001:db8::1]:7881 to fe80::1%eth0.":                  "from [ip]:7881 to [ip].",
		"loopback ::1, mapped ::ffff:198.51.100.2":                  "loopback [ip], mapped [ip]",
		"2001:0db8:0000:0000:0000:ff00:0042:8329 is up":             "[ip] is up",
		"at 21:42:05.123 v1.13.9 mac aa:bb:cc:dd:ee:ff 1.2.3.4.5 x": "at 21:42:05.123 v1.13.9 mac aa:bb:cc:dd:ee:ff 1.2.3.4.5 x",
		"std::vector 999.1.1.1 v1.2.3.4 cafe:babe: Failed: dead::x": "std::vector 999.1.1.1 v1.2.3.4 cafe:babe: Failed: dead::x",
		"ends with 10.1.2.3.":                                       "ends with [ip].",
	}
	for in, want := range cases {
		if got := Redact(in); got != want {
			t.Errorf("Redact(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSDKLoggerNoiseIsDebug(t *testing.T) {
	var buf bytes.Buffer
	l := newSDKLogger(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})), time.Now)
	l.Warnw("Failed to ping without candidate pairs. Connection is not possible yet.", nil)
	l.Warnw("Warning: mux: no endpoint for packet starting with 23, not adding to queue size(0)", nil)
	if buf.Len() != 0 {
		t.Fatalf("ICE noise logged at info level: %s", buf.String())
	}
	var dbg bytes.Buffer
	d := newSDKLogger(slog.New(slog.NewTextHandler(&dbg, &slog.HandlerOptions{Level: slog.LevelDebug})), time.Now)
	d.WithComponent("pion.ice").Warnw("Failed to ping without candidate pairs from 10.0.0.9", nil)
	if out := dbg.String(); !strings.Contains(out, "level=DEBUG") || strings.Contains(out, "10.0.0.9") {
		t.Fatalf("noise at debug: %s", out)
	}
}

func TestSDKLoggerCollapsesRepeats(t *testing.T) {
	var buf bytes.Buffer
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	l := newSDKLogger(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})),
		func() time.Time { return now })
	refused := errors.New("dial tcp 203.0.113.7:7880: connect: connection refused")
	engine := l.WithComponent("engine") // derived loggers share the limiter
	for i := 0; i < 20; i++ {
		engine.Errorw("resume connection failed", refused, "attempt", i)
		l.Errorw("resume connection failed", refused, "attempt", i)
		now = now.Add(time.Second)
	}
	l.Errorw("restart connection failed", refused) // another message: logged
	l.Warnw("resume connection failed", refused)   // another level: logged
	out := buf.String()
	if n := strings.Count(out, "resume connection failed"); n != 2 {
		t.Fatalf("%d lines for the repeated error, want 1 (+1 warning): %s", n, out)
	}
	if n := strings.Count(out, "restart connection failed"); n != 1 {
		t.Fatalf("%d lines for the other error: %s", n, out)
	}
	if strings.Contains(out, "203.0.113.7") || strings.Contains(out, "repeated") {
		t.Fatalf("log: %s", out)
	}
	buf.Reset()
	now = now.Add(time.Minute)
	l.Errorw("resume connection failed", refused, "attempt", 99)
	if out := buf.String(); !strings.Contains(out, "repeated=39") || !strings.Contains(out, "attempt=99") {
		t.Fatalf("after the window: %s", out)
	}
	buf.Reset()
	l.Errorw("resume connection failed", refused)
	if buf.Len() != 0 {
		t.Fatalf("logged again within the window: %s", buf.String())
	}
}

func TestLimiterIsBounded(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	lim := &limiter{now: func() time.Time { return now }, seen: map[string]*repeat{}}
	for i := 0; i < 3*maxRepeatKeys; i++ {
		if ok, _ := lim.allow(strings.Repeat("x", i)); !ok {
			t.Fatalf("new key %d refused", i)
		}
		if len(lim.seen) > maxRepeatKeys {
			t.Fatalf("%d keys", len(lim.seen))
		}
	}
}
