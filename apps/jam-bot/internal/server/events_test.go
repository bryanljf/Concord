package server

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bryanljf/Concord/apps/jam-bot/internal/player"
)

type stream struct {
	resp   *http.Response
	r      *bufio.Reader
	cancel context.CancelFunc
}

// openStream opens GET /v1/events with the token; the hub has the subscription once it returns
// (the handler subscribes before sending the headers).
func (e *env) openStream(t *testing.T) *stream {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.ts.URL+"/v1/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+e.token)
	resp, err := e.ts.Client().Do(req)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cancel()
		_ = resp.Body.Close()
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /v1/events: %d", resp.StatusCode)
	}
	return &stream{resp: resp, r: bufio.NewReader(resp.Body), cancel: cancel}
}

// next reads the next SSE frame, its blank line included.
func (s *stream) next(t *testing.T) string {
	t.Helper()
	type result struct {
		frame string
		err   error
	}
	ch := make(chan result, 1)
	go func() {
		var b strings.Builder
		for {
			line, err := s.r.ReadString('\n')
			b.WriteString(line)
			if err != nil || line == "\n" {
				ch <- result{b.String(), err}
				return
			}
		}
	}()
	select {
	case r := <-ch:
		if r.err != nil {
			t.Fatalf("reading the stream: %v (after %q)", r.err, r.frame)
		}
		return r.frame
	case <-time.After(5 * time.Second):
		t.Fatal("no event within 5 s")
		return ""
	}
}

// ended reads the stream to its end, failing if it does not end within 5 s.
func (s *stream) ended(t *testing.T) string {
	t.Helper()
	var rest []byte
	within5s(t, "the end of the stream", func() {
		var err error
		rest, err = io.ReadAll(s.r)
		if err != nil {
			t.Errorf("stream ended with %v, want a clean end", err)
		}
	})
	return string(rest)
}

func TestEventsHeaders(t *testing.T) {
	e := newEnv(t, testToken)
	s := e.openStream(t)
	for k, want := range map[string]string{
		"Content-Type":      "text/event-stream",
		"Cache-Control":     "no-cache",
		"X-Accel-Buffering": "no",
	} {
		if got := s.resp.Header.Get(k); got != want {
			t.Errorf("%s: %q, want %q", k, got, want)
		}
	}
	if n := e.hub.Len(); n != 1 {
		t.Fatalf("%d subscriptions", n)
	}
}

func TestEventsFrames(t *testing.T) {
	e := newEnv(t, testToken)
	s := e.openStream(t)
	e.hub.Publish(player.Event{Type: "ended", Room: "r1", ItemID: "i1"})
	e.hub.Publish(player.Event{Type: "error", Room: "r1", ItemID: "i2", Message: "LiveKit gone\nfor good"})
	e.hub.Publish(player.Event{Type: "ended", Room: "sala de música", ItemID: "<i3>"})
	for _, want := range []string{
		"data: {\"type\":\"ended\",\"room\":\"r1\",\"itemId\":\"i1\"}\n\n",
		// A newline in the message stays escaped: still one data line.
		"data: {\"type\":\"error\",\"room\":\"r1\",\"itemId\":\"i2\",\"message\":\"LiveKit gone\\nfor good\"}\n\n",
		"data: {\"type\":\"ended\",\"room\":\"sala de música\",\"itemId\":\"\\u003ci3\\u003e\"}\n\n",
	} {
		if got := s.next(t); got != want {
			t.Fatalf("frame %q, want %q", got, want)
		}
	}
}

func TestEventsPing(t *testing.T) {
	e := newEnv(t, testToken, func(s *server) { s.PingInterval = 20 * time.Millisecond })
	s := e.openStream(t)
	for range 2 {
		if got := s.next(t); got != ": ping\n\n" {
			t.Fatalf("frame %q, want a ping", got)
		}
	}
	e.hub.Publish(player.Event{Type: "ended", Room: "r1", ItemID: "i1"})
	for {
		got := s.next(t)
		if got == ": ping\n\n" {
			continue
		}
		if want := "data: {\"type\":\"ended\",\"room\":\"r1\",\"itemId\":\"i1\"}\n\n"; got != want {
			t.Fatalf("frame %q, want %q", got, want)
		}
		break
	}
}

func TestEventsDefaultPing(t *testing.T) {
	s := newServer(Config{})
	if s.PingInterval != 15*time.Second {
		t.Fatalf("default ping every %v, API.md says 15 s", s.PingInterval)
	}
}

func TestEventsFanOut(t *testing.T) {
	e := newEnv(t, testToken)
	streams := []*stream{e.openStream(t), e.openStream(t), e.openStream(t)}
	if n := e.hub.Len(); n != 3 {
		t.Fatalf("%d subscriptions", n)
	}
	for i := range 5 {
		e.hub.Publish(player.Event{Type: "ended", Room: "r1", ItemID: fmt.Sprint("i", i)})
	}
	for _, s := range streams {
		for i := range 5 {
			want := fmt.Sprintf("data: {\"type\":\"ended\",\"room\":\"r1\",\"itemId\":\"i%d\"}\n\n", i)
			if got := s.next(t); got != want {
				t.Fatalf("frame %q, want %q", got, want)
			}
		}
	}
}

func TestEventsClientGoneUnsubscribes(t *testing.T) {
	e := newEnv(t, testToken)
	a, b := e.openStream(t), e.openStream(t)
	a.cancel()
	eventually(t, "the hub to drop the closed stream", func() bool { return e.hub.Len() == 1 })
	e.hub.Publish(player.Event{Type: "ended", Room: "r1", ItemID: "i1"})
	if got := b.next(t); !strings.Contains(got, `"itemId":"i1"`) {
		t.Fatalf("frame %q", got)
	}
	b.cancel()
	eventually(t, "the hub to drop every stream", func() bool { return e.hub.Len() == 0 })
}

func TestEventsEndWithTheHub(t *testing.T) {
	e := newEnv(t, testToken)
	s := e.openStream(t)
	e.hub.Publish(player.Event{Type: "ended", Room: "r1", ItemID: "i1"})
	e.hub.Close() // shutting down
	// What was queued is still delivered, then the stream ends.
	if got, want := s.ended(t), "data: {\"type\":\"ended\",\"room\":\"r1\",\"itemId\":\"i1\"}\n\n"; got != want {
		t.Fatalf("rest of the stream %q, want %q", got, want)
	}
	wantError(t, e.do(http.MethodGet, "/v1/events", ""), http.StatusServiceUnavailable, "shutting_down")
}

// blockingWriter is an event stream whose client stopped reading: every Write waits for unblock.
type blockingWriter struct {
	header  http.Header
	entered chan struct{} // closed on the first Write
	unblock chan struct{}
	once    sync.Once
	mu      sync.Mutex
	buf     bytes.Buffer
}

func newBlockingWriter() *blockingWriter {
	return &blockingWriter{header: http.Header{}, entered: make(chan struct{}), unblock: make(chan struct{})}
}

func (w *blockingWriter) Header() http.Header { return w.header }
func (w *blockingWriter) WriteHeader(int)     {}
func (w *blockingWriter) Flush()              {}

func (w *blockingWriter) Write(p []byte) (int, error) {
	w.once.Do(func() { close(w.entered) })
	<-w.unblock
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}

func (w *blockingWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

// A stream that stops reading is dropped once it lags subscriberBuffer events behind; publishing
// (the players' Emit) never waits for it, and the other streams get every event.
func TestEventsSlowStreamIsDropped(t *testing.T) {
	e := newEnv(t, testToken)
	slow := newBlockingWriter()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/v1/events", nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	slowDone := make(chan struct{})
	go func() {
		defer close(slowDone)
		e.srv.handler().ServeHTTP(slow, req)
	}()
	eventually(t, "the slow stream to subscribe", func() bool { return e.hub.Len() == 1 })
	fast := e.openStream(t)

	publish := func(i int) {
		within5s(t, "Publish", func() {
			e.hub.Publish(player.Event{Type: "ended", Room: "r1", ItemID: fmt.Sprint("i", i)})
		})
		want := fmt.Sprintf("data: {\"type\":\"ended\",\"room\":\"r1\",\"itemId\":\"i%d\"}\n\n", i)
		if got := fast.next(t); got != want {
			t.Fatalf("fast stream: frame %q, want %q", got, want)
		}
	}
	publish(0)
	<-slow.entered // the slow stream is stuck writing event 0
	n := 1
	for ; n <= subscriberBuffer; n++ {
		publish(n) // fills the slow stream's buffer
	}
	if l := e.hub.Len(); l != 2 {
		t.Fatalf("%d subscriptions before the overflow, want 2", l)
	}
	publish(n) // one too many: the slow stream is dropped
	if l := e.hub.Len(); l != 1 {
		t.Fatalf("%d subscriptions after the overflow, want 1", l)
	}
	publish(n + 1) // the fast one still gets everything

	// Unstuck, the slow stream writes what it had queued and ends.
	close(slow.unblock)
	select {
	case <-slowDone:
	case <-time.After(5 * time.Second):
		t.Fatal("the dropped stream's handler did not return")
	}
	if got := strings.Count(slow.String(), "data: "); got != subscriberBuffer+1 {
		t.Fatalf("the slow stream got %d events, want %d", got, subscriberBuffer+1)
	}
}

func TestHubDropsSlowSubscriber(t *testing.T) {
	h := NewHub()
	slow, fast := h.Subscribe(), h.Subscribe()
	total := subscriberBuffer + 10
	got := make(chan int, 1)
	go func() {
		n := 0
		for range fast.C {
			n++
			if n == total {
				break
			}
		}
		got <- n
	}()
	within5s(t, "Publish", func() {
		for i := range total {
			h.Publish(player.Event{Type: "ended", Room: "r", ItemID: fmt.Sprint(i)})
			// Let the fast reader keep up: it must never lag a whole buffer behind.
			for len(fast.C) > subscriberBuffer/2 {
				time.Sleep(time.Millisecond)
			}
		}
	})
	if n := <-got; n != total {
		t.Fatalf("the fast subscriber got %d events, want %d", n, total)
	}
	n := 0
	for range slow.C { // closed once dropped
		n++
	}
	if n != subscriberBuffer {
		t.Fatalf("the slow subscriber got %d events before being dropped, want %d", n, subscriberBuffer)
	}
	if l := h.Len(); l != 1 {
		t.Fatalf("%d subscriptions, want 1", l)
	}
	slow.Close() // already dropped: no-op
	fast.Close()
	fast.Close()
	if l := h.Len(); l != 0 {
		t.Fatalf("%d subscriptions, want 0", l)
	}
	if _, ok := <-fast.C; ok {
		t.Fatal("a closed subscription still yields events")
	}
}

func TestHubClose(t *testing.T) {
	h := NewHub()
	a := h.Subscribe()
	h.Publish(player.Event{Type: "error", Room: "r", ItemID: "i", Message: "m"})
	h.Close()
	h.Close() // idempotent
	if data, ok := <-a.C; !ok || string(data) != `{"type":"error","room":"r","itemId":"i","message":"m"}` {
		t.Fatalf("queued event %q, %v", data, ok)
	}
	if _, ok := <-a.C; ok {
		t.Fatal("the subscription is still open after Close")
	}
	a.Close()
	if s := h.Subscribe(); s != nil {
		t.Fatal("Subscribe after Close")
	}
	h.Publish(player.Event{Type: "ended", Room: "r", ItemID: "i"}) // no-op, no panic
	if l := h.Len(); l != 0 {
		t.Fatalf("%d subscriptions", l)
	}
}

// Publishing, subscribing, unsubscribing and closing at once: no panic (send on a closed
// channel), no deadlock.
func TestHubConcurrency(t *testing.T) {
	h := NewHub()
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			for i := range 500 {
				h.Publish(player.Event{Type: "ended", Room: "r", ItemID: fmt.Sprint(i)})
			}
		})
		wg.Go(func() {
			for range 100 {
				s := h.Subscribe()
				if s == nil {
					return
				}
				select {
				case <-s.C:
				default:
				}
				s.Close()
			}
		})
	}
	readers := make([]*Subscription, 4)
	for i := range readers {
		readers[i] = h.Subscribe()
		wg.Go(func() {
			for range readers[i].C {
			}
		})
	}
	time.Sleep(10 * time.Millisecond)
	within5s(t, "Close", h.Close)
	within5s(t, "the goroutines", wg.Wait)
}
