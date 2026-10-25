package webmopus

import (
	"path/filepath"
	"sync"
	"time"
)

// growthTTL is how long a Complete or Fail is remembered.
const growthTTL = 10 * time.Minute

type growthState int

const (
	growing growthState = iota // nothing said yet
	grown                      // Complete
	failed                     // Fail
)

type growthEntry struct {
	state growthState
	at    time.Time
}

// Growth is the writer-side state of files still being written, keyed by cleaned absolute
// path. One per process, shared by the server and every Source. A state set before or between
// opens counts; it is forgotten 10 minutes after Complete/Fail. Safe for concurrent use.
type Growth struct {
	mu      sync.Mutex
	entries map[string]growthEntry
	now     func() time.Time
}

// NewGrowth returns an empty Growth.
func NewGrowth() *Growth {
	return &Growth{entries: map[string]growthEntry{}, now: time.Now}
}

// Complete records that the file at path is whole: Sources reading it play to its real end.
func (g *Growth) Complete(path string) { g.set(path, grown) }

// Fail records that the file at path will never be whole: Sources reading it fail with
// ErrFailed.
func (g *Growth) Fail(path string) { g.set(path, failed) }

// growthKey is the cleaned absolute form of path, its directory's symlinks resolved (not the
// file's own: it may be renamed or gone by the time the writer reports on it).
func growthKey(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		return filepath.Clean(path)
	}
	if dir, err := filepath.EvalSymlinks(filepath.Dir(abs)); err == nil {
		return filepath.Join(dir, filepath.Base(abs))
	}
	return abs
}

func (g *Growth) set(path string, s growthState) {
	if g == nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	g.expire(now)
	g.entries[growthKey(path)] = growthEntry{state: s, at: now}
}

// state is what the writer said about the file with this key (growing when nothing).
func (g *Growth) state(key string) growthState {
	if g == nil {
		return growing
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.expire(g.now())
	return g.entries[key].state
}

func (g *Growth) expire(now time.Time) {
	for k, e := range g.entries {
		if now.Sub(e.at) >= growthTTL {
			delete(g.entries, k)
		}
	}
}
