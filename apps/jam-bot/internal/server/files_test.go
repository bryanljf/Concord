package server

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/bryanljf/Concord/apps/jam-bot/internal/webmopus"
	"github.com/bryanljf/Concord/apps/jam-bot/internal/webmtest"
)

func probeBody(t *testing.T, file string) string {
	return mustJSON(t, map[string]string{"file": file})
}

func TestProbe(t *testing.T) {
	e := newEnv(t, testToken)
	song := e.write("cache/song.webm", stereoSong())
	e.write("cache/a/b/mono.webm", monoSong())
	const stereo = `{"durationMs":1000,"channels":2,"sampleRate":48000,"codec":"opus"}`
	for _, file := range []string{"song.webm", song, "a/../song.webm", "./song.webm"} {
		wantJSON(t, e.do(http.MethodPost, "/v1/probe", probeBody(t, file)), http.StatusOK, stereo)
	}
	wantJSON(t, e.do(http.MethodPost, "/v1/probe", probeBody(t, "a/b/mono.webm")), http.StatusOK,
		`{"durationMs":500,"channels":1,"sampleRate":48000,"codec":"opus"}`)
}

func TestProbeInvalidAudio(t *testing.T) {
	e := newEnv(t, testToken)
	e.write("cache/song.webm", stereoSong())
	e.write("cache/garbage.webm", []byte("definitely not a webm file"))
	e.write("cache/empty.webm", nil)
	vorbis := webmtest.Simple(5)
	vorbis.CodecID = "A_VORBIS"
	e.write("cache/vorbis.webm", vorbis.Bytes())
	cd := webmtest.Simple(5)
	cd.SampleRate = 44100
	e.write("cache/44k.webm", cd.Bytes())
	big := e.write("cache/big.webm", nil)
	if err := os.Truncate(big, webmopus.MaxFileSize+1); err != nil {
		t.Fatal(err)
	}
	e.write("cache/header.webm", upTo(t, stereoSong(), 0)) // fine for a partial probe only
	for _, file := range []string{
		"garbage.webm", "empty.webm", "vorbis.webm", "44k.webm", "big.webm", "header.webm",
		"missing.webm",
		"nodir/missing.webm",
		"song.webm/x", // through a file
	} {
		t.Run(file, func(t *testing.T) {
			wantError(t, e.do(http.MethodPost, "/v1/probe", probeBody(t, file)), http.StatusUnprocessableEntity, "invalid_audio")
		})
	}
	// A partial probe reads the header: a bad one is refused at once.
	for _, file := range []string{"garbage.webm", "vorbis.webm", "44k.webm", "missing.webm", "song.webm/x"} {
		t.Run("partial "+file, func(t *testing.T) {
			start := time.Now()
			wantError(t, e.do(http.MethodPost, "/v1/probe", partialBody(t, file)), http.StatusUnprocessableEntity, "invalid_audio")
			if d := time.Since(start); d > 3*time.Second {
				t.Fatalf("answered after %v", d)
			}
		})
	}
}

func partialBody(t *testing.T, file string) string {
	return mustJSON(t, map[string]any{"file": file, "partial": true})
}

// A partial probe reads the header of a file still being written: format, no duration.
func TestProbePartial(t *testing.T) {
	e := newEnv(t, testToken)
	song := webmtest.Simple(100).Bytes()
	mono := webmtest.Simple(100)
	mono.Channels = 1
	e.write("cache/header.webm", upTo(t, song, 0))            // no cluster yet
	e.write("cache/half.webm", upTo(t, song, 1))              // one of two clusters
	e.write("cache/mid.webm", song[:len(upTo(t, song, 1))+7]) // cut inside a cluster
	e.write("cache/mono.webm", upTo(t, mono.Bytes(), 1))
	e.write("cache/whole.webm", song)
	const stereo = `{"durationMs":0,"channels":2,"sampleRate":48000,"codec":"opus"}`
	for _, file := range []string{"header.webm", "half.webm", "mid.webm", "whole.webm"} {
		start := time.Now()
		wantJSON(t, e.do(http.MethodPost, "/v1/probe", partialBody(t, file)), http.StatusOK, stereo)
		if d := time.Since(start); d > time.Second {
			t.Fatalf("%s: answered after %v, want at once (the header is there)", file, d)
		}
	}
	wantJSON(t, e.do(http.MethodPost, "/v1/probe", partialBody(t, "mono.webm")), http.StatusOK,
		`{"durationMs":0,"channels":1,"sampleRate":48000,"codec":"opus"}`)
	// partial false is a full probe.
	wantJSON(t, e.do(http.MethodPost, "/v1/probe", `{"file":"whole.webm","partial":false}`), http.StatusOK,
		`{"durationMs":2000,"channels":2,"sampleRate":48000,"codec":"opus"}`)
	// A partial probe neither completes nor fails the file for the rooms playing it.
	src, err := webmopus.Open(filepath.Join(e.dir, "half.webm"), e.growth)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	wantJSON(t, e.do(http.MethodPost, "/v1/probe", partialBody(t, "half.webm")), http.StatusOK, stereo)
	waitingAt(t, src, 50)
	for _, body := range []string{`{"file":"half.webm","partial":"yes"}`, `{"file":"half.webm","partial":1}`} {
		wantError(t, e.do(http.MethodPost, "/v1/probe", body), http.StatusBadRequest, "invalid_body")
	}
}

// A full probe waits for the whole file to be parsed: its duration is exact, however long.
func TestProbeFullDuration(t *testing.T) {
	e := newEnv(t, testToken)
	e.write("cache/long.webm", webmtest.SimpleDuration(4*time.Minute+30*time.Second+20*time.Millisecond).Bytes())
	wantJSON(t, e.do(http.MethodPost, "/v1/probe", probeBody(t, "long.webm")), http.StatusOK,
		`{"durationMs":270020,"channels":2,"sampleRate":48000,"codec":"opus"}`)
}

func TestProbeOutsideTheCache(t *testing.T) {
	e := newEnv(t, testToken)
	outside := e.write("outside.webm", stereoSong())
	sibling := e.write("cache-evil/song.webm", stereoSong()) // shares the directory's prefix
	e.write("cache/sub/song.webm", stereoSong())
	for _, file := range []string{
		"../outside.webm",
		"sub/../../outside.webm",
		outside,
		"../cache-evil/song.webm",
		sibling,
		e.dir + "/../outside.webm",
		"..",
		".",
		e.dir,
		"sub",    // a directory
		"a\x00b", // NUL
		"",       // nothing
	} {
		t.Run(fmt.Sprintf("%q", file), func(t *testing.T) {
			wantError(t, e.do(http.MethodPost, "/v1/probe", probeBody(t, file)), http.StatusBadRequest, "invalid_file")
		})
	}
}

// symlink makes link point at target, skipping the test where the OS does not allow it.
func symlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("cannot create symlinks here (needs Developer Mode or admin): %v", err)
		}
		t.Fatal(err)
	}
}

func TestProbeSymlinks(t *testing.T) {
	e := newEnv(t, testToken)
	outside := e.write("outside/song.webm", stereoSong())
	inside := e.write("cache/real/song.webm", stereoSong())
	symlink(t, outside, filepath.Join(e.dir, "escape.webm"))
	symlink(t, filepath.Dir(outside), filepath.Join(e.dir, "escape-dir"))
	symlink(t, inside, filepath.Join(e.dir, "alias.webm"))
	symlink(t, filepath.Dir(inside), filepath.Join(e.dir, "alias-dir"))

	for _, file := range []string{"escape.webm", "escape-dir/song.webm", filepath.Join(e.dir, "escape.webm")} {
		wantError(t, e.do(http.MethodPost, "/v1/probe", probeBody(t, file)), http.StatusBadRequest, "invalid_file")
	}
	const stereo = `{"durationMs":1000,"channels":2,"sampleRate":48000,"codec":"opus"}`
	for _, file := range []string{"alias.webm", "alias-dir/song.webm"} {
		wantJSON(t, e.do(http.MethodPost, "/v1/probe", probeBody(t, file)), http.StatusOK, stereo)
	}
	// Files may come from inside the cache's real directory, or through the symlink that names it.
	if p, err := e.files.Resolve("alias.webm"); err != nil || filepath.Base(p) != "song.webm" {
		t.Fatalf("Resolve(alias.webm) = %q, %v", p, err)
	}
}

func TestCacheDirBehindSymlink(t *testing.T) {
	root := t.TempDir()
	real := filepath.Join(root, "real")
	writeFile(t, filepath.Join(real, "song.webm"), stereoSong())
	writeFile(t, filepath.Join(root, "outside.webm"), stereoSong())
	link := filepath.Join(root, "cache")
	symlink(t, real, link)
	f, err := NewFiles(link, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{"song.webm", filepath.Join(link, "song.webm")} {
		if _, err := f.Resolve(file); err != nil {
			t.Fatalf("Resolve(%q): %v", file, err)
		}
	}
	for _, file := range []string{"../outside.webm", filepath.Join(real, "song.webm")} {
		if _, err := f.Resolve(file); !isAPIError(err, "invalid_file") {
			t.Fatalf("Resolve(%q): %v, want invalid_file", file, err)
		}
	}
}

// A missing file is unusable audio (422), on every OS: Linux's EvalSymlinks answers a path
// through a file ("song.webm/x") with a bare ENOTDIR, Windows with "path not found".
func TestNotFound(t *testing.T) {
	for _, err := range []error{
		fs.ErrNotExist,
		syscall.ENOTDIR,
		&fs.PathError{Op: "lstat", Path: "song.webm/x", Err: syscall.ENOTDIR},
		&fs.PathError{Op: "open", Path: "song.webm", Err: syscall.ENOENT},
	} {
		if got := notFound(err); !isAPIError(got, "invalid_audio") {
			t.Errorf("notFound(%v) = %v, want invalid_audio", err, got)
		}
	}
	if err := notFound(fs.ErrPermission); err != fs.ErrPermission {
		t.Errorf("notFound(ErrPermission) = %v, want it unchanged (a 500)", err)
	}
}

func isAPIError(err error, code string) bool {
	ae, ok := err.(*apiError)
	return ok && ae.code == code
}

func TestProbeBadBodies(t *testing.T) {
	e := newEnv(t, testToken)
	for _, body := range []string{"", "{", `{"file":5}`, `"song.webm"`, `{"file":"a"} {}`} {
		wantError(t, e.do(http.MethodPost, "/v1/probe", body), http.StatusBadRequest, "invalid_body")
	}
}

func TestWithin(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cache")
	for path, want := range map[string]bool{
		filepath.Join(dir, "a"):               true,
		filepath.Join(dir, "a", "b"):          true,
		filepath.Join(dir, "..a"):             true, // a name starting with dots is not a parent
		dir:                                   false,
		filepath.Dir(dir):                     false,
		dir + "-evil":                         false,
		filepath.Join(dir+"-evil", "a"):       false,
		filepath.Join(filepath.Dir(dir), "a"): false,
	} {
		if got := within(dir, path); got != want {
			t.Errorf("within(%q, %q) = %v, want %v", dir, path, got, want)
		}
	}
}

func TestLoadErrors(t *testing.T) {
	e := newEnv(t, testToken)
	e.write("cache/song.webm", stereoSong())
	for _, c := range []struct {
		err    error
		status int
		code   string
	}{
		{fmt.Errorf("%w: no Opus track", webmopus.ErrInvalidAudio), http.StatusUnprocessableEntity, "invalid_audio"},
		{fmt.Errorf("opening: %w", webmopus.ErrFailed), http.StatusUnprocessableEntity, "invalid_audio"},
		{webmopus.ErrStalled, http.StatusUnprocessableEntity, "invalid_audio"},
		{&fs.PathError{Op: "open", Path: "song.webm", Err: fs.ErrNotExist}, http.StatusUnprocessableEntity, "invalid_audio"},
		{&fs.PathError{Op: "read", Path: "song.webm", Err: fs.ErrPermission}, http.StatusInternalServerError, "internal"},
	} {
		e.files.open = func(string, *webmopus.Growth) (*webmopus.Source, error) { return nil, c.err }
		for _, growing := range []bool{false, true} {
			wantError(t, e.do(http.MethodPost, "/v1/probe", mustJSON(t, map[string]any{"file": "song.webm", "partial": growing})),
				c.status, c.code)
			wantError(t, e.do(http.MethodPut, "/v1/rooms/r1", playBody(t, "song.webm", map[string]any{"growing": growing})),
				c.status, c.code)
		}
	}
	if calls := e.rooms.calls(); len(calls) != 0 {
		t.Fatalf("player calls %v", calls)
	}
}

// Only a file still being written is opened with the process' Growth: a PUT with growing, a
// partial probe. A whole file is read to its end without waiting for anyone.
func TestLoadPassesGrowth(t *testing.T) {
	e := newEnv(t, testToken)
	e.write("cache/song.webm", stereoSong())
	var mu sync.Mutex
	var got []*webmopus.Growth
	e.files.open = func(path string, growth *webmopus.Growth) (*webmopus.Source, error) {
		mu.Lock()
		got = append(got, growth)
		mu.Unlock()
		return openSource(path, growth)
	}
	for _, c := range []struct {
		method, path, body string
		growing            bool
	}{
		{http.MethodPut, "/v1/rooms/r1", playBody(t, "song.webm", map[string]any{"growing": true}), true},
		{http.MethodPut, "/v1/rooms/r1", playBody(t, "song.webm", map[string]any{"growing": false}), false},
		{http.MethodPut, "/v1/rooms/r1", playBody(t, "song.webm", nil), false},
		{http.MethodPost, "/v1/probe", partialBody(t, "song.webm"), true},
		{http.MethodPost, "/v1/probe", probeBody(t, "song.webm"), false},
	} {
		if res := e.do(c.method, c.path, c.body); res.status != http.StatusOK {
			t.Fatalf("%s %s: %d %s", c.method, c.body, res.status, res.body)
		}
		mu.Lock()
		last := got[len(got)-1]
		mu.Unlock()
		switch {
		case c.growing && last != e.growth:
			t.Fatalf("%s %s: opened with %p, want the process' Growth %p", c.method, c.body, last, e.growth)
		case !c.growing && last != nil:
			t.Fatalf("%s %s: a whole file opened with a Growth", c.method, c.body)
		}
	}
}

// openTracker counts the opens running at once; each waits for release.
type openTracker struct {
	active, peak atomic.Int32
	release      chan struct{}
}

func (o *openTracker) open(path string, growth *webmopus.Growth) (*webmopus.Source, error) {
	n := o.active.Add(1)
	defer o.active.Add(-1)
	for {
		p := o.peak.Load()
		if n <= p || o.peak.CompareAndSwap(p, n) {
			break
		}
	}
	<-o.release
	return openSource(path, growth)
}

// Opening parses the header and may wait up to 10 s for a growing file's: a few at once, and a
// request waiting for its turn gives up with its deadline.
func TestOpensAreBounded(t *testing.T) {
	e := newEnv(t, testToken, func(s *server) { s.timeouts.play = 300 * time.Millisecond })
	e.write("cache/song.webm", stereoSong())
	o := &openTracker{release: make(chan struct{})}
	e.files.open = o.open
	results := make(chan response, maxOpens)
	for i := range maxOpens {
		method, path, body := http.MethodPost, "/v1/probe", partialBody(t, "song.webm")
		if i%2 == 1 {
			method, path, body = http.MethodPut, "/v1/rooms/r1", playBody(t, "song.webm", map[string]any{"growing": true})
		}
		go func() { results <- e.do(method, path, body) }()
	}
	eventually(t, "every slot taken", func() bool { return o.active.Load() == maxOpens })
	// One more waits for a slot, and times out.
	wantError(t, e.do(http.MethodPost, "/v1/probe", partialBody(t, "song.webm")), http.StatusServiceUnavailable, "timeout")
	if p := o.peak.Load(); p != maxOpens {
		t.Fatalf("%d opens at once, want %d", p, maxOpens)
	}
	close(o.release)
	for range maxOpens {
		// The held requests outlived their own deadline: whatever they answer, they answer.
		<-results
	}
	// The slots are free again.
	wantJSON(t, e.do(http.MethodPost, "/v1/probe", probeBody(t, "song.webm")), http.StatusOK,
		`{"durationMs":1000,"channels":2,"sampleRate":48000,"codec":"opus"}`)
}

// A full probe holds a whole file's packets until it is parsed (the memory peak): one at a time.
// A partial probe or a PUT does not wait for it.
func TestFullProbesOneAtATime(t *testing.T) {
	e := newEnv(t, testToken, func(s *server) { s.timeouts.play = 300 * time.Millisecond })
	e.write("cache/song.webm", stereoSong())
	e.files.full <- struct{}{} // a full probe in progress
	wantError(t, e.do(http.MethodPost, "/v1/probe", probeBody(t, "song.webm")), http.StatusServiceUnavailable, "timeout")
	wantJSON(t, e.do(http.MethodPost, "/v1/probe", partialBody(t, "song.webm")), http.StatusOK,
		`{"durationMs":0,"channels":2,"sampleRate":48000,"codec":"opus"}`)
	if res := e.do(http.MethodPut, "/v1/rooms/r1", playBody(t, "song.webm", nil)); res.status != http.StatusOK {
		t.Fatalf("PUT: %d %s", res.status, res.body)
	}
	<-e.files.full
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			if res := e.do(http.MethodPost, "/v1/probe", probeBody(t, "song.webm")); res.status != http.StatusOK {
				t.Errorf("status %d: %s", res.status, res.body)
			}
		})
	}
	wg.Wait()
}

func fileBody(t *testing.T, file string) string {
	return mustJSON(t, map[string]string{"file": file})
}

// openGrowing opens a file still being written as a PUT with growing does (the test owns the
// Source).
func (e *env) openGrowing(t *testing.T, file string) *webmopus.Source {
	t.Helper()
	path, err := e.files.Resolve(file)
	if err != nil {
		t.Fatal(err)
	}
	src, err := e.files.Load(context.Background(), path, true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = src.Close() })
	return src
}

// mark posts to /v1/files/complete or /v1/files/failed and wants a 204.
func (e *env) mark(t *testing.T, route, file string) {
	t.Helper()
	res := e.do(http.MethodPost, "/v1/files/"+route, fileBody(t, file))
	if res.status != http.StatusNoContent || len(res.body) != 0 {
		t.Fatalf("%s %q: %d %q", route, file, res.status, res.body)
	}
}

// The api names a file as in its PUT: relative or absolute, any spelling that cleans to it.
func TestFilesComplete(t *testing.T) {
	e := newEnv(t, testToken)
	half := upTo(t, webmtest.Simple(100).Bytes(), 1)
	for _, c := range []struct{ file, opened, marked string }{
		{"a.webm", "a.webm", "a.webm"},
		{"b.webm", "sub/../b.webm", "./b.webm"},
		{"c.webm", e.dir + "/c.webm", "c.webm"},
		{"d.webm", "d.webm", e.dir + "/d.webm"},
		{"sub/e.webm", "sub/e.webm", "sub//e.webm"},
	} {
		e.write("cache/"+c.file, half)
		src := e.openGrowing(t, c.opened)
		waitingAt(t, src, 50)
		e.mark(t, "complete", c.marked)
		if n, end, err := untilEnd(t, src); err != nil || n != 50 || end != time.Second {
			t.Fatalf("%+v: %d packets, %v, %v", c, n, end, err)
		}
	}
}

func TestFilesFailed(t *testing.T) {
	e := newEnv(t, testToken)
	e.write("cache/song.webm", upTo(t, webmtest.Simple(100).Bytes(), 1))
	a, b := e.openGrowing(t, "song.webm"), e.openGrowing(t, "song.webm") // two rooms
	waitingAt(t, a, 50)
	e.mark(t, "failed", "song.webm")
	for _, src := range []*webmopus.Source{a, b} {
		if _, _, err := untilEnd(t, src); !errors.Is(err, webmopus.ErrFailed) {
			t.Fatalf("after failed: %v, want ErrFailed", err)
		}
	}
}

// A completion that arrives before the PUT counts (the api may finish the upload first).
func TestFilesCompleteBeforeOpen(t *testing.T) {
	e := newEnv(t, testToken)
	e.write("cache/song.webm", upTo(t, webmtest.Simple(100).Bytes(), 1))
	e.mark(t, "complete", "song.webm")
	res := e.do(http.MethodPut, "/v1/rooms/r1", playBody(t, "song.webm", map[string]any{"growing": true}))
	if res.status != http.StatusOK {
		t.Fatalf("PUT: %d %s", res.status, res.body)
	}
	if n, _, err := untilEnd(t, e.rooms.lastSource(t)); err != nil || n != 50 {
		t.Fatalf("%d packets, %v", n, err)
	}
	// Nobody reading the file, or no such file at all: still a 204.
	e.mark(t, "complete", "missing.webm")
	e.mark(t, "failed", "nodir/missing.webm")
}

// The api renames an upload once it is whole, then says so under the name it was played with.
func TestFilesCompleteAfterRename(t *testing.T) {
	e := newEnv(t, testToken)
	song := webmtest.Simple(100).Bytes()
	part := e.write("cache/song.webm.part", upTo(t, song, 1))
	src := e.openGrowing(t, "song.webm.part")
	waitingAt(t, src, 50)
	appendTo(t, part, song[len(upTo(t, song, 1)):])
	if err := os.Rename(part, filepath.Join(e.dir, "song.webm")); err != nil {
		t.Fatalf("renaming a file being played: %v", err)
	}
	e.mark(t, "complete", "song.webm.part")
	if n, end, err := untilEnd(t, src); err != nil || n != 100 || end != 2*time.Second {
		t.Fatalf("%d packets, %v, %v", n, end, err)
	}
}

// Through a symlink that names the cache, the mark reaches the file opened under its real path.
func TestFilesCompleteCacheBehindSymlink(t *testing.T) {
	root := t.TempDir()
	real := filepath.Join(root, "real")
	path := writeFile(t, filepath.Join(real, "song.webm.part"), upTo(t, webmtest.Simple(100).Bytes(), 1))
	link := filepath.Join(root, "cache")
	symlink(t, real, link)
	f, err := NewFiles(link, nil)
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := f.Resolve("song.webm.part")
	if err != nil {
		t.Fatal(err)
	}
	src, err := f.Load(context.Background(), resolved, true)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	if err := os.Rename(path, filepath.Join(real, "song.webm")); err != nil {
		t.Fatal(err)
	}
	if err := f.Complete(filepath.Join(link, "song.webm.part")); err != nil {
		t.Fatal(err)
	}
	if n, _, err := untilEnd(t, src); err != nil || n != 50 {
		t.Fatalf("%d packets, %v", n, err)
	}
}

func TestFilesMarkRejects(t *testing.T) {
	e := newEnv(t, testToken)
	e.write("outside.webm", stereoSong())
	e.write("cache/song.webm", stereoSong())
	for _, route := range []string{"/v1/files/complete", "/v1/files/failed"} {
		for _, body := range []string{"", "{", `{"file":5}`, `"song.webm"`, fileBody(t, "a") + "{}"} {
			wantError(t, e.do(http.MethodPost, route, body), http.StatusBadRequest, "invalid_body")
		}
		huge := fileBody(t, strings.Repeat("a", maxBodyBytes))
		wantError(t, e.do(http.MethodPost, route, huge), http.StatusRequestEntityTooLarge, "payload_too_large")
		for _, body := range []string{"{}", "null"} { // no file, as in a probe
			wantError(t, e.do(http.MethodPost, route, body), http.StatusBadRequest, "invalid_file")
		}
		for _, file := range []string{
			"", "a\x00b", ".", "..", e.dir, "../outside.webm", "sub/../../outside.webm",
			e.root + "/outside.webm", "../cache-evil/song.webm",
		} {
			wantError(t, e.do(http.MethodPost, route, fileBody(t, file)), http.StatusBadRequest, "invalid_file")
		}
	}
}

// A symlink inside the cache pointing out of it: the mark is refused, as reading it would be.
func TestFilesMarkSymlinkOutside(t *testing.T) {
	e := newEnv(t, testToken)
	outside := e.write("outside/song.webm", stereoSong())
	symlink(t, filepath.Dir(outside), filepath.Join(e.dir, "escape-dir"))
	for _, route := range []string{"/v1/files/complete", "/v1/files/failed"} {
		for _, file := range []string{"escape-dir/song.webm", "escape-dir/gone.webm"} {
			wantError(t, e.do(http.MethodPost, route, fileBody(t, file)), http.StatusBadRequest, "invalid_file")
		}
	}
}

// Since Go 1.23 EvalSymlinks no longer follows Windows junctions, which opening a file does: a
// junction inside the cache could point anywhere, so files behind one are refused.
func TestJunctionInsideTheCache(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("junctions are a Windows thing")
	}
	e := newEnv(t, testToken)
	outside := e.write("outside/song.webm", stereoSong())
	e.write("cache/inside/song.webm", stereoSong())
	for link, target := range map[string]string{
		"junction":        filepath.Dir(outside),
		"inner-junction":  filepath.Join(e.dir, "inside"),
		"inside/junction": filepath.Dir(outside),
	} {
		out, err := exec.Command("cmd", "/c", "mklink", "/J", filepath.Join(e.dir, link), target).CombinedOutput()
		if err != nil {
			t.Skipf("mklink /J: %v: %s", err, out)
		}
	}
	for _, file := range []string{"junction/song.webm", "inner-junction/song.webm", "inside/junction/song.webm",
		filepath.Join(e.dir, "junction", "song.webm")} {
		wantError(t, e.do(http.MethodPost, "/v1/probe", probeBody(t, file)), http.StatusBadRequest, "invalid_file")
		wantError(t, e.do(http.MethodPost, "/v1/probe", partialBody(t, file)), http.StatusBadRequest, "invalid_file")
		wantError(t, e.do(http.MethodPut, "/v1/rooms/r1", playBody(t, file, nil)), http.StatusBadRequest, "invalid_file")
		wantError(t, e.do(http.MethodPost, "/v1/files/complete", fileBody(t, file)), http.StatusBadRequest, "invalid_file")
		wantError(t, e.do(http.MethodPost, "/v1/files/failed", fileBody(t, file)), http.StatusBadRequest, "invalid_file")
	}
	// The junction itself (a directory to the API): not a file either way.
	wantError(t, e.do(http.MethodPost, "/v1/probe", probeBody(t, "junction")), http.StatusBadRequest, "invalid_file")
	wantJSON(t, e.do(http.MethodPost, "/v1/probe", probeBody(t, "inside/song.webm")), http.StatusOK,
		`{"durationMs":1000,"channels":2,"sampleRate":48000,"codec":"opus"}`)
	if calls := e.rooms.calls(); len(calls) != 0 {
		t.Fatalf("player calls %v", calls)
	}
}
