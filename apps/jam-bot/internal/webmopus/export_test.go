package webmopus

import (
	"bytes"
	"time"
)

// TestOptions shortens a Source's timings for tests (zero fields keep the defaults).
type TestOptions struct {
	Poll, Stall, Header time.Duration
	MaxSize             int64
	BufSize             int              // the reader's buffer
	OnWait              func(read int64) // before each poll at the end of a growing file
}

// OpenForTest is Open with test timings.
func OpenForTest(path string, g *Growth, t TestOptions) (*Source, error) {
	o := defaultOptions()
	if t.Poll != 0 {
		o.poll = max(t.Poll, 0) // < 0: no sleep at all (OnWait writes the file)
	}
	if t.Stall > 0 {
		o.stall = t.Stall
	}
	if t.Header > 0 {
		o.header = t.Header
	}
	if t.MaxSize > 0 {
		o.limit = t.MaxSize
	}
	o.bufSize = t.BufSize
	o.onWait = t.OnWait
	return open(path, g, o)
}

// SetGrowthClock replaces the clock Growth expires its entries with.
func SetGrowthClock(g *Growth, now func() time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.now = now
}

// GrowthState is what g says about path: "growing", "complete" or "failed".
func GrowthState(g *Growth, path string) string {
	return [...]string{"growing", "complete", "failed"}[g.state(growthKey(path))]
}

// ParseWith is Parse with another size limit and read buffer (0: the defaults), returning the
// packets of a whole stream.
func ParseWith(data []byte, limit int64, bufSize int) ([]Packet, error) {
	if limit == 0 {
		limit = MaxFileSize
	}
	r := newReader(bytes.NewReader(data), limit, nil)
	if bufSize > 0 {
		r.buf = make([]byte, bufSize)
	}
	var out []Packet
	d := newDemuxer(r, func(p []Packet) { out = append(out, p...) })
	if err := d.header(); err != nil {
		return nil, err
	}
	err := d.body()
	d.flush()
	return out, err
}
