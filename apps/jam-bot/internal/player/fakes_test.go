package player

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/bryanljf/Concord/apps/jam-bot/internal/webmopus"
)

const ms = time.Millisecond

var t0 = time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)

// ---------------------------------------------------------------- clock

type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers map[*fakeTimer]struct{}
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: t0, timers: map[*fakeTimer]struct{}{}}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) NewTimer(d time.Duration) Timer {
	t := &fakeTimer{c: c, ch: make(chan time.Time, 1)}
	c.mu.Lock()
	c.timers[t] = struct{}{}
	c.mu.Unlock()
	t.Reset(d)
	return t
}

// Advance moves the clock and fires every timer due by then.
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	for t := range c.timers {
		t.fireLocked()
	}
}

type fakeTimer struct {
	c      *fakeClock
	ch     chan time.Time
	at     time.Time
	active bool
}

func (t *fakeTimer) C() <-chan time.Time { return t.ch }

func (t *fakeTimer) fireLocked() {
	if t.active && !t.at.After(t.c.now) {
		t.active = false
		select {
		case t.ch <- t.c.now:
		default:
		}
	}
}

func (t *fakeTimer) drainLocked() {
	select {
	case <-t.ch:
	default:
	}
}

func (t *fakeTimer) Reset(d time.Duration) {
	t.c.mu.Lock()
	defer t.c.mu.Unlock()
	t.drainLocked()
	t.at, t.active = t.c.now.Add(d), true
	t.fireLocked()
}

func (t *fakeTimer) ResetAt(at time.Time) {
	t.c.mu.Lock()
	defer t.c.mu.Unlock()
	t.drainLocked()
	t.at, t.active = at, true
	t.fireLocked()
}

func (t *fakeTimer) Stop() {
	t.c.mu.Lock()
	defer t.c.mu.Unlock()
	t.drainLocked()
	t.active = false
}

// ---------------------------------------------------------------- source

// fakeSource is a file whose growth the test controls. Packet i lasts 20 ms, starts at i*20 ms
// and its data is {i}.
type fakeSource struct {
	mu       sync.Mutex
	packets  []webmopus.Packet
	complete bool
	err      error
	closes   int
	changed  chan struct{} // closed (and replaced) on every change
}

var errSourceClosed = errors.New("fake source closed")

func newSource(n int, complete bool) *fakeSource {
	s := &fakeSource{changed: make(chan struct{})}
	s.grow(n)
	s.complete = complete
	return s
}

// src is a complete file of n packets.
func src(n int) *fakeSource { return newSource(n, true) }

// growing is a file of n packets so far, still being written.
func growing(n int) *fakeSource { return newSource(n, false) }

func packet(i int) webmopus.Packet {
	return webmopus.Packet{TS: time.Duration(i) * 20 * ms, Dur: 20 * ms, Data: []byte{byte(i)}}
}

func (s *fakeSource) changedLocked() {
	close(s.changed)
	s.changed = make(chan struct{})
}

func (s *fakeSource) grow(n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for range n {
		s.packets = append(s.packets, packet(len(s.packets)))
	}
	s.changedLocked()
}

// add appends p as it is (to make gaps in the timestamps).
func (s *fakeSource) add(p webmopus.Packet) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.packets = append(s.packets, p)
	s.changedLocked()
}

func (s *fakeSource) finish() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.complete = true
	s.changedLocked()
}

func (s *fakeSource) failWith(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.err = err
	s.changedLocked()
}

func (s *fakeSource) closeCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closes
}

func (s *fakeSource) Channels() int { return 2 }

// wait runs f under the lock until it reports done, waiting for changes in between.
func (s *fakeSource) wait(ctx context.Context, f func() bool) error {
	for {
		s.mu.Lock()
		if s.closes > 0 {
			s.mu.Unlock()
			return errSourceClosed
		}
		if f() {
			s.mu.Unlock()
			return nil
		}
		ch := s.changed
		s.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (s *fakeSource) Packet(ctx context.Context, i int) (webmopus.Packet, error) {
	var p webmopus.Packet
	var perr error
	err := s.wait(ctx, func() bool {
		switch {
		case i < len(s.packets):
			p = s.packets[i]
		case s.err != nil:
			perr = s.err
		case s.complete:
			perr = io.EOF
		default:
			return false
		}
		return true
	})
	if err != nil {
		return webmopus.Packet{}, err
	}
	return p, perr
}

func (s *fakeSource) IndexAt(ctx context.Context, off time.Duration) (int, error) {
	idx := -1
	var ierr error
	err := s.wait(ctx, func() bool {
		for i, p := range s.packets {
			if p.TS >= off {
				idx = i
				return true
			}
		}
		switch {
		case s.err != nil:
			ierr = s.err
		case s.complete:
			idx = len(s.packets)
		default:
			return false
		}
		return true
	})
	if err != nil {
		return 0, err
	}
	return idx, ierr
}

func (s *fakeSource) Parsed() (int, time.Duration, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var end time.Duration
	if n := len(s.packets); n > 0 {
		end = s.packets[n-1].TS + s.packets[n-1].Dur
	}
	return len(s.packets), end, s.complete
}

func (s *fakeSource) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closes++
	s.changedLocked()
	return nil
}

// ---------------------------------------------------------------- LiveKit

type sample struct {
	data []byte
	dur  time.Duration
	at   time.Time
}

type fakeConn struct {
	url, token string
	link       Link

	mu      sync.Mutex
	samples []sample
	mutes   []bool
	closed  bool
	changed chan struct{}
}

func (c *fakeConn) WriteSample(data []byte, dur time.Duration, at time.Time) error {
	c.mu.Lock()
	c.samples = append(c.samples, sample{data, dur, at})
	c.mu.Unlock()
	c.signal()
	return nil
}

func (c *fakeConn) SetMuted(muted bool) {
	c.mu.Lock()
	c.mutes = append(c.mutes, muted)
	c.mu.Unlock()
}

func (c *fakeConn) Close() {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	c.signal()
}

func (c *fakeConn) signal() {
	select {
	case c.changed <- struct{}{}:
	default:
	}
}

func (c *fakeConn) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

func (c *fakeConn) muteLog() []bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]bool(nil), c.mutes...)
}

func (c *fakeConn) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.samples)
}

// waitSamples waits (in real time, briefly) until n samples were written, and returns them.
func (c *fakeConn) waitSamples(t *testing.T, n int) []sample {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		c.mu.Lock()
		got := append([]sample(nil), c.samples...)
		c.mu.Unlock()
		if len(got) >= n {
			return got
		}
		select {
		case <-c.changed:
		case <-deadline:
			t.Fatalf("%d samples written, want %d", len(got), n)
		}
	}
}

type fakeConnector struct {
	mu      sync.Mutex
	conns   []*fakeConn
	fails   int // the next fails Connect calls fail
	calls   int
	changed chan struct{}
}

// waitCalls waits (in real time, briefly) until Connect was called n times.
func (f *fakeConnector) waitCalls(t *testing.T, n int) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		if calls, _ := f.count(); calls >= n {
			return
		}
		select {
		case <-f.changed:
		case <-deadline:
			calls, _ := f.count()
			t.Fatalf("%d connection attempts, want %d", calls, n)
		}
	}
}

var errRefused = errors.New("connection refused")

func (f *fakeConnector) Connect(ctx context.Context, url, token string, link Link) (Conn, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	defer func() {
		select {
		case f.changed <- struct{}{}:
		default:
		}
	}()
	if f.fails > 0 {
		f.fails--
		return nil, errRefused
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	c := &fakeConn{url: url, token: token, link: link, changed: make(chan struct{}, 1)}
	f.conns = append(f.conns, c)
	return c, nil
}

func (f *fakeConnector) conn(t *testing.T, i int) *fakeConn {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if i >= len(f.conns) {
		t.Fatalf("%d connections, want connection #%d", len(f.conns), i)
	}
	return f.conns[i]
}

func (f *fakeConnector) count() (calls, conns int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls, len(f.conns)
}

func (f *fakeConnector) failNext(n int) {
	f.mu.Lock()
	f.fails = n
	f.mu.Unlock()
}

// ---------------------------------------------------------------- harness

// unmute is the harness' UnmuteDelay.
const unmute = 80 * ms

type harness struct {
	t      *testing.T
	clock  *fakeClock
	lk     *fakeConnector
	m      *Manager
	events chan Event
	logs   *syncBuffer // the Manager's log, info and up

	fetchMu  sync.Mutex
	fetches  int           // results of waits on a source taken in by a room
	fetchSig chan struct{} // signalled on each
}

func newHarness(t *testing.T) *harness {
	lk := &fakeConnector{changed: make(chan struct{}, 1)}
	h := &harness{t: t, clock: newFakeClock(), lk: lk, events: make(chan Event, 16), logs: &syncBuffer{},
		fetchSig: make(chan struct{}, 1)}
	h.m = NewManager(Options{
		Connector: h.lk,
		Clock:     h.clock,
		Log:       slog.New(slog.NewTextHandler(h.logs, nil)),
		Emit:      func(e Event) { h.events <- e },
		Timeouts:  Timeouts{Connect: time.Second, Rejoin: 10 * time.Second, UnmuteDelay: unmute},
		backoff:   func(int) time.Duration { return time.Second },
		fetched: func() {
			h.fetchMu.Lock()
			h.fetches++
			h.fetchMu.Unlock()
			select {
			case h.fetchSig <- struct{}{}:
			default:
			}
		},
	})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		h.m.Close(ctx)
	})
	return h
}

// waitFetches waits (in real time, briefly) until rooms took in n results of waits on a source.
func (h *harness) waitFetches(n int) {
	h.t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		h.fetchMu.Lock()
		got := h.fetches
		h.fetchMu.Unlock()
		if got >= n {
			return
		}
		select {
		case <-h.fetchSig:
		case <-deadline:
			h.t.Fatalf("%d waits on a source over, want %d", got, n)
		}
	}
}

func (h *harness) play(room string, req PlayRequest) Status {
	h.t.Helper()
	if req.URL == "" {
		req.URL = "ws://livekit.test"
	}
	if req.Token == "" {
		req.Token = "token-1"
	}
	st, err := h.m.Play(context.Background(), room, req)
	if err != nil {
		h.t.Fatalf("Play: %v", err)
	}
	return st
}

// sync waits until the room goroutine handled everything sent to it so far, link events
// included, and returns its status.
func (h *harness) sync(room string) Status {
	h.t.Helper()
	st, err := h.m.control(context.Background(), room, cmdStatus)
	if err != nil {
		h.t.Fatalf("status: %v", err)
	}
	return st
}

func (h *harness) event() Event {
	h.t.Helper()
	select {
	case e := <-h.events:
		return e
	case <-time.After(2 * time.Second):
		h.t.Fatal("no event")
		return Event{}
	}
}

func (h *harness) noEvent() {
	h.t.Helper()
	select {
	case e := <-h.events:
		h.t.Fatalf("unexpected event %+v", e)
	default:
	}
}

// checkSamples asserts packets first..first+len(at)-1 were sent at those times.
func checkSamples(t *testing.T, got []sample, from int, first int, at ...time.Time) {
	t.Helper()
	for i, want := range at {
		s := got[from+i]
		if int(s.data[0]) != first+i || !s.at.Equal(want) || s.dur != 20*ms {
			t.Fatalf("sample %d: packet %d at %v, want packet %d at %v", from+i, s.data[0],
				s.at.Sub(t0), first+i, want.Sub(t0))
		}
	}
}

// syncBuffer is a log destination safe for concurrent use.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
