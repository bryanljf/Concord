package lk

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	protoLogger "github.com/livekit/protocol/logger"
	"github.com/livekit/protocol/logger/zaputil"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

// InstallLogger routes the SDK's logs (and pion's, which go through it) to log: its warnings and
// errors only, scrubbed of tokens, LiveKit hosts and IP addresses. Its info logs, chatty and
// quoting connection details, become debug, and so does pion's ICE noise. The same warning or
// error repeated (the SDK retrying through an outage) is logged once a minute at most, with how
// many were left out. Call it before the first connection.
func InstallLogger(log *slog.Logger) {
	lksdk.SetLogger(newSDKLogger(log.With("component", "livekit"), time.Now))
}

// noise: warnings pion logs while ICE is still being set up or after a peer went away, harmless
// and frequent. Logged at debug level.
var noise = []string{
	"Failed to ping without candidate pairs",
	"mux: no endpoint for packet",
}

// repeatWindow: an identical warning or error is logged at most once per window.
const repeatWindow = time.Minute

// maxRepeatKeys bounds the messages remembered by the limiter.
const maxRepeatKeys = 256

type sdkLogger struct {
	log     *slog.Logger
	limiter *limiter // shared by every logger derived from the installed one
}

var _ protoLogger.Logger = sdkLogger{}

func newSDKLogger(log *slog.Logger, now func() time.Time) sdkLogger {
	return sdkLogger{log: log, limiter: &limiter{now: now, seen: map[string]*repeat{}}}
}

// limiter collapses runs of identical messages.
type limiter struct {
	now func() time.Time

	mu   sync.Mutex
	seen map[string]*repeat
}

type repeat struct {
	logged  time.Time // last time it was logged
	skipped int       // left out since then
}

// allow tells whether key may be logged now and, if so, how many identical ones were left out
// since it was last logged.
func (l *limiter) allow(key string) (bool, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if r := l.seen[key]; r != nil {
		if now.Sub(r.logged) < repeatWindow {
			r.skipped++
			return false, 0
		}
		skipped := r.skipped
		r.logged, r.skipped = now, 0
		return true, skipped
	}
	if len(l.seen) >= maxRepeatKeys {
		for k, r := range l.seen {
			if now.Sub(r.logged) >= repeatWindow {
				delete(l.seen, k)
			}
		}
		if len(l.seen) >= maxRepeatKeys {
			clear(l.seen)
		}
	}
	l.seen[key] = &repeat{logged: now}
	return true, 0
}

func (l sdkLogger) emit(level slog.Level, msg string, err error, kv []any) {
	if level > slog.LevelDebug && isNoise(msg) {
		level = slog.LevelDebug
	}
	if !l.log.Enabled(context.Background(), level) {
		return
	}
	msg = Redact(msg)
	errText := ""
	if err != nil {
		errText = Redact(err.Error())
	}
	skipped := 0
	if level >= slog.LevelWarn && l.limiter != nil {
		var ok bool
		if ok, skipped = l.limiter.allow(level.String() + "\x00" + msg + "\x00" + errText); !ok {
			return
		}
	}
	args := pairs(kv)
	if err != nil {
		args = append(args, "err", errText)
	}
	if skipped > 0 {
		args = append(args, "repeated", skipped)
	}
	l.log.Log(context.Background(), level, msg, args...)
}

func isNoise(msg string) bool {
	for _, n := range noise {
		if strings.Contains(msg, n) {
			return true
		}
	}
	return false
}

// pairs turns the SDK's key/value list into slog arguments, values scrubbed.
func pairs(kv []any) []any {
	args := make([]any, 0, len(kv)+3)
	for i, v := range kv {
		if i%2 == 0 {
			args = append(args, fmt.Sprint(v))
		} else {
			args = append(args, scrub(v))
		}
	}
	if len(kv)%2 == 1 {
		args = append(args, "")
	}
	return args
}

// scrub keeps plain values and turns anything else into a redacted string (structs could hold a
// token or a URL).
func scrub(v any) any {
	switch v := v.(type) {
	case nil, bool, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
		return v
	case error:
		return Redact(v.Error())
	default:
		return Redact(fmt.Sprint(v))
	}
}

func (l sdkLogger) with(log *slog.Logger) sdkLogger { return sdkLogger{log: log, limiter: l.limiter} }

func (l sdkLogger) Debugw(string, ...any) {}

func (l sdkLogger) Infow(msg string, kv ...any) { l.emit(slog.LevelDebug, msg, nil, kv) }

func (l sdkLogger) Warnw(msg string, err error, kv ...any) { l.emit(slog.LevelWarn, msg, err, kv) }

func (l sdkLogger) Errorw(msg string, err error, kv ...any) { l.emit(slog.LevelError, msg, err, kv) }

func (l sdkLogger) WithValues(kv ...any) protoLogger.Logger {
	return l.with(l.log.With(pairs(kv)...))
}

func (l sdkLogger) WithUnlikelyValues(kv ...any) protoLogger.UnlikelyLogger {
	return protoLogger.NewUnlikelyLogger(l, kv...)
}

func (l sdkLogger) WithName(name string) protoLogger.Logger {
	return l.with(l.log.With("logger", name))
}

func (l sdkLogger) WithComponent(component string) protoLogger.Logger {
	return l.with(l.log.With("logger", component))
}

func (l sdkLogger) WithCallDepth(int) protoLogger.Logger { return l }
func (l sdkLogger) WithItemSampler() protoLogger.Logger  { return l }
func (l sdkLogger) WithoutSampler() protoLogger.Logger   { return l }

func (l sdkLogger) WithDeferredValues() (protoLogger.Logger, protoLogger.DeferredFieldResolver) {
	return l, zaputil.NoOpDeferrer{}
}
