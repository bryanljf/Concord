package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bryanljf/Concord/apps/jam-bot/internal/player"
	"github.com/bryanljf/Concord/apps/jam-bot/internal/webmopus"
	"github.com/bryanljf/Concord/apps/jam-bot/internal/webmtest"
)

const testToken = "test-token"

// fakeRooms is a scriptable player.Manager.
type fakeRooms struct {
	mu        sync.Mutex
	log       []string             // "connect r1", "play r1", "pause r1", "resume r1", "leave r1"
	connects  [][2]string          // every Connect's URL and token
	plays     []player.PlayRequest // every Play's request
	deadlines []time.Duration      // time left on each call's context when it started (0: none)
	list      []player.Status

	connectFn func(ctx context.Context, room, url, token string) (player.Status, error)
	playFn    func(ctx context.Context, room string, req player.PlayRequest) (player.Status, error)
	pauseFn   func(ctx context.Context, room string) (player.Status, error)
	resumeFn  func(ctx context.Context, room string) (player.Status, error)
}

func (f *fakeRooms) Connect(ctx context.Context, room, url, token string) (player.Status, error) {
	f.record(ctx, "connect "+room)
	f.mu.Lock()
	f.connects = append(f.connects, [2]string{url, token})
	fn := f.connectFn
	f.mu.Unlock()
	if fn != nil {
		return fn(ctx, room, url, token)
	}
	return player.Status{Room: room, State: player.Idle}, nil
}

func (f *fakeRooms) record(ctx context.Context, call string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log = append(f.log, call)
	var left time.Duration
	if dl, ok := ctx.Deadline(); ok {
		left = time.Until(dl)
	}
	f.deadlines = append(f.deadlines, left)
}

func (f *fakeRooms) Play(ctx context.Context, room string, req player.PlayRequest) (player.Status, error) {
	f.record(ctx, "play "+room)
	f.mu.Lock()
	f.plays = append(f.plays, req)
	fn := f.playFn
	f.mu.Unlock()
	if fn != nil {
		return fn(ctx, room, req)
	}
	// The Source is still being parsed: no duration here (tests read the Source itself).
	st := player.Status{Room: room, ItemID: req.ItemID, State: player.Playing, PositionMs: req.Offset.Milliseconds()}
	if req.Paused {
		st.State = player.Paused
	}
	return st, nil
}

// closeSources closes every Source handed to Play (the player owns them), so the files can go.
func (f *fakeRooms) closeSources() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range f.plays {
		if p.Source != nil {
			_ = p.Source.Close()
		}
	}
}

// lastSource is the Source of the last Play.
func (f *fakeRooms) lastSource(t *testing.T) player.Source {
	t.Helper()
	src := f.lastPlay(t).Source
	if src == nil {
		t.Fatal("Play got no Source")
	}
	return src
}

func (f *fakeRooms) Pause(ctx context.Context, room string) (player.Status, error) {
	f.record(ctx, "pause "+room)
	f.mu.Lock()
	fn := f.pauseFn
	f.mu.Unlock()
	if fn != nil {
		return fn(ctx, room)
	}
	return player.Status{Room: room, ItemID: "item-1", State: player.Paused, PositionMs: 1234, DurationMs: 5000}, nil
}

func (f *fakeRooms) Resume(ctx context.Context, room string) (player.Status, error) {
	f.record(ctx, "resume "+room)
	f.mu.Lock()
	fn := f.resumeFn
	f.mu.Unlock()
	if fn != nil {
		return fn(ctx, room)
	}
	return player.Status{Room: room, ItemID: "item-1", State: player.Playing, PositionMs: 1234, DurationMs: 5000}, nil
}

func (f *fakeRooms) Leave(ctx context.Context, room string) { f.record(ctx, "leave "+room) }

func (f *fakeRooms) List() []player.Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.list
}

// set changes the fake's script under its lock (handlers may be running).
func (f *fakeRooms) set(change func(f *fakeRooms)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	change(f)
}

func (f *fakeRooms) calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.log...)
}

func (f *fakeRooms) connectCalls() [][2]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][2]string(nil), f.connects...)
}

func (f *fakeRooms) lastPlay(t *testing.T) player.PlayRequest {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.plays) == 0 {
		t.Fatal("Play was not called")
	}
	return f.plays[len(f.plays)-1]
}

func (f *fakeRooms) lastDeadline(t *testing.T) time.Duration {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.deadlines) == 0 {
		t.Fatal("no call")
	}
	return f.deadlines[len(f.deadlines)-1]
}

// syncBuffer collects the server's logs.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// env is the API served over HTTP, with a fake player, a real hub and real files in a temporary
// cache directory (root/cache; root also holds the "outside" files).
type env struct {
	t      *testing.T
	root   string
	dir    string
	token  string
	rooms  *fakeRooms
	hub    *Hub
	files  *Files
	growth *webmopus.Growth
	srv    *server
	ts     *httptest.Server
	logs   *syncBuffer
}

// redact is the test's Config.Redact: it hides "SECRET".
func redact(s string) string { return strings.ReplaceAll(s, "SECRET", "[redacted]") }

func newEnv(t *testing.T, token string, tweak ...func(*server)) *env {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "cache")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	growth := webmopus.NewGrowth()
	files, err := NewFiles(dir, growth)
	if err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, root: root, dir: dir, token: token, rooms: &fakeRooms{}, hub: NewHub(), files: files,
		growth: growth, logs: &syncBuffer{}}
	t.Cleanup(e.rooms.closeSources) // before the directory is removed (cleanups run last first)
	e.srv = newServer(Config{
		Token:        token,
		Files:        files,
		Rooms:        e.rooms,
		Hub:          e.hub,
		Log:          slog.New(slog.NewTextHandler(e.logs, nil)),
		PingInterval: time.Hour, // tests that want pings shorten it
		Redact:       redact,
	})
	for _, f := range tweak {
		f(e.srv)
	}
	e.ts = httptest.NewServer(e.srv.handler())
	t.Cleanup(e.ts.Close)
	t.Cleanup(e.hub.Close) // runs first: ends the event streams, which ts.Close waits for
	return e
}

type response struct {
	status int
	header http.Header
	body   []byte
}

// send makes a request with the given Authorization header (none when empty).
func (e *env) send(method, path, body, authorization string) response {
	e.t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, e.ts.URL+path, rd)
	if err != nil {
		e.t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	resp, err := e.ts.Client().Do(req)
	if err != nil {
		e.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		e.t.Fatalf("%s %s: reading the body: %v", method, path, err)
	}
	return response{resp.StatusCode, resp.Header, b}
}

// do makes an authorized request.
func (e *env) do(method, path, body string) response {
	e.t.Helper()
	auth := ""
	if e.token != "" {
		auth = "Bearer " + e.token
	}
	return e.send(method, path, body, auth)
}

// write creates a file under the env's root (parents included) and returns its path.
func (e *env) write(rel string, data []byte) string {
	e.t.Helper()
	return writeFile(e.t, filepath.Join(e.root, filepath.FromSlash(rel)), data)
}

func writeFile(t *testing.T, path string, data []byte) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// stereoSong is a 1 s stereo WebM/Opus file, monoSong a 0.5 s mono one.
func stereoSong() []byte { return webmtest.Simple(50).Bytes() }

func monoSong() []byte {
	f := webmtest.Simple(25)
	f.Channels = 1
	return f.Bytes()
}

// clusterID starts every Cluster element.
var clusterID = []byte{0x1F, 0x43, 0xB6, 0x75}

// upTo returns the bytes of a WebM file before its n-th cluster (0: the header alone), as an
// upload streaming in has them.
func upTo(t *testing.T, data []byte, n int) []byte {
	t.Helper()
	at := 0
	for i := 0; i <= n; i++ {
		j := bytes.Index(data[at:], clusterID)
		if j < 0 {
			t.Fatalf("the file has fewer than %d clusters", n+1)
		}
		if i == n {
			return data[:at+j]
		}
		at += j + len(clusterID)
	}
	return nil
}

// appendTo writes more of a file, as the api does while an upload streams in.
func appendTo(t *testing.T, path string, data []byte) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

// untilEnd waits (up to 5 s) for a Source to be whole and returns its packets and duration, or
// why it never will be.
func untilEnd(t *testing.T, src player.Source) (int, time.Duration, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	n, err := src.IndexAt(ctx, time.Duration(math.MaxInt64))
	if errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("the Source did not end within 5 s")
	}
	if err != nil {
		return 0, 0, err
	}
	pn, end, complete := src.Parsed()
	if !complete || pn != n {
		t.Fatalf("IndexAt past the end: %d; Parsed: %d, %v, complete %v", n, pn, end, complete)
	}
	return n, end, nil
}

// waitingAt checks that a growing Source has parsed n packets and waits for more: neither
// complete nor failed.
func waitingAt(t *testing.T, src player.Source, n int) {
	t.Helper()
	eventually(t, fmt.Sprintf("%d packets parsed", n), func() bool {
		got, _, _ := src.Parsed()
		return got >= n
	})
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond) // a few polls
	defer cancel()
	if _, err := src.IndexAt(ctx, time.Duration(math.MaxInt64)); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("IndexAt past the end: %v, want it waiting for more data", err)
	}
	if got, _, complete := src.Parsed(); got != n || complete {
		t.Fatalf("Parsed: %d packets, complete %v; want %d, still growing", got, complete, n)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// wantError checks an error answer: status, JSON {error: code, message: non-empty}, nothing
// else. It returns the message.
func wantError(t *testing.T, res response, status int, code string) string {
	t.Helper()
	if res.status != status {
		t.Fatalf("status %d, want %d: %s", res.status, status, res.body)
	}
	if ct := res.header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type %q, want application/json", ct)
	}
	var body map[string]any
	if err := json.Unmarshal(res.body, &body); err != nil {
		t.Fatalf("not JSON: %q", res.body)
	}
	msg, ok := body["message"].(string)
	if len(body) != 2 || body["error"] != code || !ok || msg == "" {
		t.Fatalf("body %s, want {error: %q, message: <text>}", res.body, code)
	}
	return msg
}

// wantJSON checks a JSON answer against the expected JSON (compared as values).
func wantJSON(t *testing.T, res response, status int, want string) {
	t.Helper()
	if res.status != status {
		t.Fatalf("status %d, want %d: %s", res.status, status, res.body)
	}
	if ct := res.header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type %q, want application/json", ct)
	}
	var got, exp any
	if err := json.Unmarshal(res.body, &got); err != nil {
		t.Fatalf("not JSON: %q", res.body)
	}
	if err := json.Unmarshal([]byte(want), &exp); err != nil {
		t.Fatalf("bad expectation %q: %v", want, err)
	}
	if !reflect.DeepEqual(got, exp) {
		t.Fatalf("body %s, want %s", bytes.TrimSpace(res.body), want)
	}
}

// eventually polls cond for up to 5 s.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// within5s fails the test when f does not return within 5 s.
func within5s(t *testing.T, what string, f func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		f()
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("%s blocked", what)
	}
}
