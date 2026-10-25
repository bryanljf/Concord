package server

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/bryanljf/Concord/apps/jam-bot/internal/player"
	"github.com/bryanljf/Concord/apps/jam-bot/internal/webmopus"
	"github.com/bryanljf/Concord/apps/jam-bot/internal/webmtest"
)

func TestHealthz(t *testing.T) {
	for _, token := range []string{"", testToken} {
		e := newEnv(t, token)
		// Never needs the token (the Docker healthcheck has none).
		wantJSON(t, e.send(http.MethodGet, "/healthz", "", ""), http.StatusOK, `{"ok":true}`)
		if res := e.send(http.MethodHead, "/healthz", "", ""); res.status != http.StatusOK {
			t.Fatalf("HEAD /healthz: %d", res.status)
		}
	}
}

// protected lists a request for every route but GET /healthz, unknown paths and wrong methods
// included (GET /v1/events is tested with the token in events_test.go: it streams).
func protected(e *env) []struct{ method, path, body string } {
	e.write("cache/song.webm", stereoSong())
	return []struct{ method, path, body string }{
		{http.MethodPost, "/v1/probe", `{"file":"song.webm"}`},
		{http.MethodPost, "/v1/probe", `{"file":"song.webm","partial":true}`},
		{http.MethodPost, "/v1/rooms/r1/connect", connectBody(e.t, nil)},
		{http.MethodPut, "/v1/rooms/r1", playBody(e.t, "song.webm", nil)},
		{http.MethodPost, "/v1/rooms/r1/pause", ""},
		{http.MethodPost, "/v1/rooms/r1/resume", ""},
		{http.MethodDelete, "/v1/rooms/r1", ""},
		{http.MethodGet, "/v1/rooms", ""},
		{http.MethodPost, "/v1/files/complete", `{"file":"song.webm"}`},
		{http.MethodPost, "/v1/files/failed", `{"file":"other.webm"}`},
		{http.MethodGet, "/v1/nope", ""},
		{http.MethodGet, "/v1/probe", ""},
		{http.MethodGet, "/v1/files/complete", ""},
		{http.MethodPost, "/healthz", ""},
	}
}

func TestAuthRejects(t *testing.T) {
	e := newEnv(t, testToken)
	reqs := protected(e)
	reqs = append(reqs, struct{ method, path, body string }{http.MethodGet, "/v1/events", ""})
	bad := []string{
		"",                          // none
		"Bearer wrong",              // wrong token
		testToken,                   // no scheme
		"Basic " + testToken,        // other scheme
		"Bearer " + testToken[:4],   // prefix of the token
		"Bearer " + testToken + "x", // token plus more
		"Bearer",                    // empty token
		"Bearer " + strings.Repeat("x", 4096),
	}
	for _, r := range reqs {
		for _, auth := range bad {
			res := e.send(r.method, r.path, r.body, auth)
			wantError(t, res, http.StatusUnauthorized, "unauthorized")
			if !strings.HasPrefix(res.header.Get("WWW-Authenticate"), "Bearer") {
				t.Fatalf("%s %s: WWW-Authenticate %q", r.method, r.path, res.header.Get("WWW-Authenticate"))
			}
		}
	}
	if calls := e.rooms.calls(); len(calls) != 0 {
		t.Fatalf("the player was driven without the token: %v", calls)
	}
	if n := e.hub.Len(); n != 0 {
		t.Fatalf("%d event streams opened without the token", n)
	}
}

func TestAuthAccepts(t *testing.T) {
	e := newEnv(t, testToken)
	for _, r := range protected(e) {
		if res := e.do(r.method, r.path, r.body); res.status == http.StatusUnauthorized {
			t.Fatalf("%s %s with the token: 401 %s", r.method, r.path, res.body)
		}
	}
	if got := fmt.Sprint(e.rooms.calls()); got != "[connect r1 play r1 pause r1 resume r1 leave r1]" {
		t.Fatalf("player calls %v", got)
	}
}

// Without the token, the growth of the files is untouched too.
func TestAuthRejectsFileMarks(t *testing.T) {
	e := newEnv(t, testToken)
	path := e.write("cache/song.webm", upTo(t, webmtest.Simple(100).Bytes(), 1))
	src, err := webmopus.Open(path, e.growth)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	for _, route := range []string{"/v1/files/complete", "/v1/files/failed"} {
		wantError(t, e.send(http.MethodPost, route, `{"file":"song.webm"}`, "Bearer wrong"), http.StatusUnauthorized, "unauthorized")
	}
	waitingAt(t, src, 50)
}

func TestNoTokenNoAuth(t *testing.T) {
	e := newEnv(t, "")
	for _, r := range protected(e) {
		for _, auth := range []string{"", "Bearer anything"} {
			if res := e.send(r.method, r.path, r.body, auth); res.status == http.StatusUnauthorized {
				t.Fatalf("%s %s (auth %q) without a configured token: 401", r.method, r.path, auth)
			}
		}
	}
}

func TestUnknownPathAndWrongMethods(t *testing.T) {
	e := newEnv(t, testToken)
	for _, path := range []string{"/", "/v1", "/v1/nope", "/v1/rooms/r1/skip", "/healthz/x", "/v1/files",
		"/v1/files/song.webm", "/v1/rooms/r1/connect/x"} {
		wantError(t, e.do(http.MethodGet, path, ""), http.StatusNotFound, "not_found")
	}
	for _, c := range []struct{ method, path, allow string }{
		{http.MethodGet, "/v1/probe", "POST"},
		{http.MethodPut, "/v1/probe", "POST"},
		{http.MethodPost, "/v1/rooms", "GET, HEAD"},
		{http.MethodDelete, "/v1/rooms", "GET, HEAD"},
		{http.MethodGet, "/v1/rooms/r1", "PUT, DELETE"},
		{http.MethodPost, "/v1/rooms/r1", "PUT, DELETE"},
		{http.MethodPatch, "/v1/rooms/r1", "PUT, DELETE"},
		{http.MethodGet, "/v1/rooms/r1/pause", "POST"},
		{http.MethodPut, "/v1/rooms/r1/resume", "POST"},
		{http.MethodGet, "/v1/rooms/r1/connect", "POST"},
		{http.MethodPut, "/v1/rooms/r1/connect", "POST"},
		{http.MethodGet, "/v1/files/complete", "POST"},
		{http.MethodPut, "/v1/files/complete", "POST"},
		{http.MethodDelete, "/v1/files/failed", "POST"},
		{http.MethodPost, "/v1/events", "GET, HEAD"},
		{http.MethodPost, "/healthz", "GET, HEAD"},
		{http.MethodDelete, "/healthz", "GET, HEAD"},
	} {
		res := e.do(c.method, c.path, "")
		wantError(t, res, http.StatusMethodNotAllowed, "method_not_allowed")
		if got := res.header.Get("Allow"); got != c.allow {
			t.Fatalf("%s %s: Allow %q, want %q", c.method, c.path, got, c.allow)
		}
	}
	if calls := e.rooms.calls(); len(calls) != 0 {
		t.Fatalf("player calls %v", calls)
	}
}

// playBody is a valid PUT body for file, changed by mod (a nil value deletes the key).
func playBody(t *testing.T, file string, mod map[string]any) string {
	t.Helper()
	m := map[string]any{
		"livekitUrl": "wss://livekit.example.test",
		"token":      "lk-token",
		"itemId":     "item-1",
		"file":       file,
		"offsetMs":   0,
		"paused":     false,
	}
	for k, v := range mod {
		if v == nil {
			delete(m, k)
		} else {
			m[k] = v
		}
	}
	return mustJSON(t, m)
}

func TestPlay(t *testing.T) {
	e := newEnv(t, testToken)
	e.write("cache/song.webm", stereoSong())

	res := e.do(http.MethodPut, "/v1/rooms/r1", playBody(t, "song.webm", map[string]any{"offsetMs": 250.5}))
	wantJSON(t, res, http.StatusOK,
		`{"room":"r1","itemId":"item-1","state":"playing","positionMs":250,"durationMs":0}`)
	req := e.rooms.lastPlay(t)
	if req.URL != "wss://livekit.example.test" || req.Token != "lk-token" || req.ItemID != "item-1" ||
		req.Offset != 250500*time.Microsecond || req.Paused {
		t.Fatalf("play request %+v", req)
	}
	// Not growing: the whole file, read to its end without waiting for the api.
	src := e.rooms.lastSource(t)
	if n, end, err := untilEnd(t, src); err != nil || n != 50 || end != time.Second || src.Channels() != 2 {
		t.Fatalf("source: %d packets, %v, %d channels, %v", n, end, src.Channels(), err)
	}
	if left := e.rooms.lastDeadline(t); left <= 0 || left > defaultTimeouts.play {
		t.Fatalf("Play's context has %v left, want a deadline within %v", left, defaultTimeouts.play)
	}

	// Paused, an absolute path inside the directory, and the error message of a failed room.
	e.rooms.set(func(f *fakeRooms) {
		f.playFn = func(_ context.Context, room string, req player.PlayRequest) (player.Status, error) {
			return player.Status{Room: room, ItemID: req.ItemID, State: player.Error, DurationMs: 1000, Message: "gave up"}, nil
		}
	})
	res = e.do(http.MethodPut, "/v1/rooms/r2", playBody(t, e.dir+"/song.webm", map[string]any{"paused": true, "itemId": "item-2"}))
	wantJSON(t, res, http.StatusOK,
		`{"room":"r2","itemId":"item-2","state":"error","positionMs":0,"durationMs":1000,"message":"gave up"}`)
	if req := e.rooms.lastPlay(t); !req.Paused || req.Offset != 0 {
		t.Fatalf("play request %+v", req)
	}
}

func TestPlayOffsetIsBounded(t *testing.T) {
	e := newEnv(t, testToken)
	e.write("cache/song.webm", stereoSong())
	res := e.do(http.MethodPut, "/v1/rooms/r1", playBody(t, "song.webm", map[string]any{"offsetMs": 1e300}))
	if res.status != http.StatusOK {
		t.Fatalf("status %d: %s", res.status, res.body)
	}
	if got := e.rooms.lastPlay(t).Offset; got != maxOffset {
		t.Fatalf("offset %v, want %v", got, maxOffset)
	}
}

func TestPlayRejectsBadBodies(t *testing.T) {
	e := newEnv(t, testToken)
	e.write("cache/song.webm", stereoSong())
	valid := func(mod map[string]any) string { return playBody(t, "song.webm", mod) }
	for name, body := range map[string]string{
		"no body":               "",
		"not JSON":              "{",
		"not an object":         `["song.webm"]`,
		"null":                  "null",
		"empty object":          "{}",
		"trailing data":         valid(nil) + "{}",
		"two values":            valid(nil) + valid(nil),
		"no livekitUrl":         valid(map[string]any{"livekitUrl": nil}),
		"empty livekitUrl":      valid(map[string]any{"livekitUrl": ""}),
		"livekitUrl no scheme":  valid(map[string]any{"livekitUrl": "livekit.example.test"}),
		"livekitUrl ftp":        valid(map[string]any{"livekitUrl": "ftp://livekit.example.test"}),
		"livekitUrl no host":    valid(map[string]any{"livekitUrl": "wss://"}),
		"livekitUrl unparsable": valid(map[string]any{"livekitUrl": "wss://%zz"}),
		"livekitUrl too long":   valid(map[string]any{"livekitUrl": "wss://h/" + strings.Repeat("a", maxURLLen)}),
		"livekitUrl a number":   valid(map[string]any{"livekitUrl": 5}),
		"no token":              valid(map[string]any{"token": nil}),
		"empty token":           valid(map[string]any{"token": ""}),
		"token too long":        valid(map[string]any{"token": strings.Repeat("t", maxTokenLen+1)}),
		"no itemId":             valid(map[string]any{"itemId": nil}),
		"itemId too long":       valid(map[string]any{"itemId": strings.Repeat("i", maxItemLen+1)}),
		"itemId a number":       valid(map[string]any{"itemId": 7}),
		"no file":               valid(map[string]any{"file": nil}),
		"empty file":            valid(map[string]any{"file": ""}),
		"negative offsetMs":     valid(map[string]any{"offsetMs": -1}),
		"offsetMs a string":     valid(map[string]any{"offsetMs": "10"}),
		"offsetMs overflows":    strings.Replace(valid(nil), `"offsetMs":0`, `"offsetMs":1e400`, 1),
		"paused a string":       valid(map[string]any{"paused": "yes"}),
		"growing a string":      valid(map[string]any{"growing": "yes"}),
		"growing a number":      valid(map[string]any{"growing": 1}),
	} {
		t.Run(name, func(t *testing.T) {
			wantError(t, e.do(http.MethodPut, "/v1/rooms/r1", body), http.StatusBadRequest, "invalid_body")
		})
	}
	if calls := e.rooms.calls(); len(calls) != 0 {
		t.Fatalf("player calls %v", calls)
	}
}

func TestBodyTooLarge(t *testing.T) {
	e := newEnv(t, testToken)
	e.write("cache/song.webm", stereoSong())
	huge := playBody(t, "song.webm", map[string]any{"token": strings.Repeat("t", maxBodyBytes)})
	wantError(t, e.do(http.MethodPut, "/v1/rooms/r1", huge), http.StatusRequestEntityTooLarge, "payload_too_large")
	huge = mustJSON(t, map[string]string{"file": strings.Repeat("a", maxBodyBytes)})
	wantError(t, e.do(http.MethodPost, "/v1/probe", huge), http.StatusRequestEntityTooLarge, "payload_too_large")
	if calls := e.rooms.calls(); len(calls) != 0 {
		t.Fatalf("player calls %v", calls)
	}
}

func TestPlayFileErrors(t *testing.T) {
	e := newEnv(t, testToken)
	e.write("outside.webm", stereoSong())
	e.write("cache/garbage.webm", []byte("not a webm file"))
	for _, c := range []struct {
		file   string
		status int
		code   string
	}{
		{"../outside.webm", http.StatusBadRequest, "invalid_file"},
		{e.root + "/outside.webm", http.StatusBadRequest, "invalid_file"},
		{"garbage.webm", http.StatusUnprocessableEntity, "invalid_audio"},
		{"missing.webm", http.StatusUnprocessableEntity, "invalid_audio"},
	} {
		wantError(t, e.do(http.MethodPut, "/v1/rooms/r1", playBody(t, c.file, nil)), c.status, c.code)
	}
	if calls := e.rooms.calls(); len(calls) != 0 {
		t.Fatalf("player calls %v", calls)
	}
}

func TestPlayErrors(t *testing.T) {
	e := newEnv(t, testToken)
	e.write("cache/song.webm", stereoSong())
	for _, c := range []struct {
		err    error
		status int
		code   string
	}{
		{&player.LiveKitError{Err: errors.New("could not join wss://lk/?access_token=SECRET: refused")},
			http.StatusBadGateway, "livekit_error"},
		{fmt.Errorf("joining: %w", &player.LiveKitError{Err: errors.New("SECRET rejected")}),
			http.StatusBadGateway, "livekit_error"},
		{player.ErrClosed, http.StatusServiceUnavailable, "shutting_down"},
		{context.DeadlineExceeded, http.StatusServiceUnavailable, "timeout"},
		{errors.New("unexpected SECRET"), http.StatusInternalServerError, "internal"},
	} {
		e.rooms.set(func(f *fakeRooms) {
			f.playFn = func(context.Context, string, player.PlayRequest) (player.Status, error) {
				return player.Status{}, c.err
			}
		})
		msg := wantError(t, e.do(http.MethodPut, "/v1/rooms/r1", playBody(t, "song.webm", nil)), c.status, c.code)
		if strings.Contains(msg, "SECRET") {
			t.Fatalf("%v: message not redacted: %q", c.err, msg)
		}
		if c.code == "livekit_error" && !strings.Contains(msg, "[redacted]") {
			t.Fatalf("%v: message %q, want LiveKit's (redacted) reason", c.err, msg)
		}
	}
	if strings.Contains(e.logs.String(), "SECRET") {
		t.Fatalf("a secret reached the logs:\n%s", e.logs.String())
	}
}

func TestRoomNames(t *testing.T) {
	e := newEnv(t, testToken)
	e.write("cache/song.webm", stereoSong())
	for _, path := range []string{
		"/v1/rooms/a%01b", // control character
		"/v1/rooms/%FF",   // not UTF-8
		"/v1/rooms/" + strings.Repeat("r", maxRoomLen+1), // too long
	} {
		wantError(t, e.do(http.MethodPut, path, playBody(t, "song.webm", nil)), http.StatusBadRequest, "invalid_room")
		wantError(t, e.do(http.MethodPost, path+"/connect", connectBody(t, nil)), http.StatusBadRequest, "invalid_room")
		wantError(t, e.do(http.MethodPost, path+"/pause", ""), http.StatusBadRequest, "invalid_room")
		wantError(t, e.do(http.MethodPost, path+"/resume", ""), http.StatusBadRequest, "invalid_room")
		wantError(t, e.do(http.MethodDelete, path, ""), http.StatusBadRequest, "invalid_room")
	}
	if calls := e.rooms.calls(); len(calls) != 0 {
		t.Fatalf("player calls %v", calls)
	}
	// Escaped by the api (encodeURIComponent); handed over unescaped.
	for path, room := range map[string]string{
		"/v1/rooms/a%2Fb":                              "a/b",
		"/v1/rooms/sala%20de%20m%C3%BAsica":            "sala de música",
		"/v1/rooms/" + strings.Repeat("r", maxRoomLen): strings.Repeat("r", maxRoomLen),
	} {
		if res := e.do(http.MethodPut, path, playBody(t, "song.webm", nil)); res.status != http.StatusOK {
			t.Fatalf("PUT %s: %d %s", path, res.status, res.body)
		}
		if calls := e.rooms.calls(); calls[len(calls)-1] != "play "+room {
			t.Fatalf("PUT %s: calls %v, want room %q", path, calls, room)
		}
		if res := e.do(http.MethodPost, path+"/connect", connectBody(t, nil)); res.status != http.StatusOK {
			t.Fatalf("POST %s/connect: %d %s", path, res.status, res.body)
		}
		if calls := e.rooms.calls(); calls[len(calls)-1] != "connect "+room {
			t.Fatalf("POST %s/connect: calls %v, want room %q", path, calls, room)
		}
	}
}

// connectBody is a valid connect body, changed by mod (a nil value deletes the key).
func connectBody(t *testing.T, mod map[string]any) string {
	t.Helper()
	m := map[string]any{"livekitUrl": "wss://livekit.example.test", "token": "lk-token"}
	for k, v := range mod {
		if v == nil {
			delete(m, k)
		} else {
			m[k] = v
		}
	}
	return mustJSON(t, m)
}

func TestConnect(t *testing.T) {
	e := newEnv(t, testToken)
	wantJSON(t, e.do(http.MethodPost, "/v1/rooms/r1/connect", connectBody(t, nil)), http.StatusOK,
		`{"room":"r1","itemId":"","state":"idle","positionMs":0,"durationMs":0}`)
	if got := fmt.Sprint(e.rooms.connectCalls()); got != "[[wss://livekit.example.test lk-token]]" {
		t.Fatalf("connects %v", got)
	}
	if left := e.rooms.lastDeadline(t); left <= 0 || left > defaultTimeouts.play {
		t.Fatalf("Connect's context has %v left, want a deadline within %v", left, defaultTimeouts.play)
	}
	// A room already playing keeps playing: the answer is the player's.
	e.rooms.set(func(f *fakeRooms) {
		f.connectFn = func(_ context.Context, room, _, _ string) (player.Status, error) {
			return player.Status{Room: room, ItemID: "item-1", State: player.Playing, PositionMs: 1500, DurationMs: 3000}, nil
		}
	})
	wantJSON(t, e.do(http.MethodPost, "/v1/rooms/r1/connect", connectBody(t, map[string]any{"token": "lk-token-2"})),
		http.StatusOK, `{"room":"r1","itemId":"item-1","state":"playing","positionMs":1500,"durationMs":3000}`)
	if got := e.rooms.connectCalls(); len(got) != 2 || got[1][1] != "lk-token-2" {
		t.Fatalf("connects %v, want the second with lk-token-2", got)
	}
	if got := fmt.Sprint(e.rooms.calls()); got != "[connect r1 connect r1]" {
		t.Fatalf("calls %v", got)
	}
}

func TestConnectRejectsBadBodies(t *testing.T) {
	e := newEnv(t, testToken)
	valid := func(mod map[string]any) string { return connectBody(t, mod) }
	for name, body := range map[string]string{
		"no body":              "",
		"not JSON":             "{",
		"null":                 "null",
		"empty object":         "{}",
		"trailing data":        valid(nil) + "{}",
		"no livekitUrl":        valid(map[string]any{"livekitUrl": nil}),
		"livekitUrl no scheme": valid(map[string]any{"livekitUrl": "livekit.example.test"}),
		"livekitUrl ftp":       valid(map[string]any{"livekitUrl": "ftp://livekit.example.test"}),
		"livekitUrl no host":   valid(map[string]any{"livekitUrl": "wss://"}),
		"livekitUrl too long":  valid(map[string]any{"livekitUrl": "wss://h/" + strings.Repeat("a", maxURLLen)}),
		"no token":             valid(map[string]any{"token": nil}),
		"empty token":          valid(map[string]any{"token": ""}),
		"token too long":       valid(map[string]any{"token": strings.Repeat("t", maxTokenLen+1)}),
		"token a number":       valid(map[string]any{"token": 5}),
	} {
		t.Run(name, func(t *testing.T) {
			wantError(t, e.do(http.MethodPost, "/v1/rooms/r1/connect", body), http.StatusBadRequest, "invalid_body")
		})
	}
	huge := connectBody(t, map[string]any{"token": strings.Repeat("t", maxBodyBytes)})
	wantError(t, e.do(http.MethodPost, "/v1/rooms/r1/connect", huge), http.StatusRequestEntityTooLarge, "payload_too_large")
	if calls := e.rooms.calls(); len(calls) != 0 {
		t.Fatalf("player calls %v", calls)
	}
}

func TestConnectErrors(t *testing.T) {
	e := newEnv(t, testToken)
	for _, c := range []struct {
		err    error
		status int
		code   string
	}{
		{&player.LiveKitError{Err: errors.New("could not join wss://lk/?access_token=SECRET: refused")},
			http.StatusBadGateway, "livekit_error"},
		{player.ErrClosed, http.StatusServiceUnavailable, "shutting_down"},
		{context.DeadlineExceeded, http.StatusServiceUnavailable, "timeout"},
		{errors.New("unexpected SECRET"), http.StatusInternalServerError, "internal"},
	} {
		e.rooms.set(func(f *fakeRooms) {
			f.connectFn = func(context.Context, string, string, string) (player.Status, error) {
				return player.Status{}, c.err
			}
		})
		msg := wantError(t, e.do(http.MethodPost, "/v1/rooms/r1/connect", connectBody(t, nil)), c.status, c.code)
		if strings.Contains(msg, "SECRET") {
			t.Fatalf("%v: message not redacted: %q", c.err, msg)
		}
	}
	if strings.Contains(e.logs.String(), "SECRET") {
		t.Fatalf("a secret reached the logs:\n%s", e.logs.String())
	}
}

// A growing PUT hands the player a Source that waits at the file's current end, then goes on
// to the real end once the api says the upload is complete.
func TestPlayGrowing(t *testing.T) {
	e := newEnv(t, testToken)
	song := webmtest.Simple(100).Bytes() // 2 s, 2 clusters
	path := e.write("cache/song.webm", upTo(t, song, 1))
	res := e.do(http.MethodPut, "/v1/rooms/r1", playBody(t, "song.webm", map[string]any{"growing": true}))
	wantJSON(t, res, http.StatusOK, `{"room":"r1","itemId":"item-1","state":"playing","positionMs":0,"durationMs":0}`)
	src := e.rooms.lastSource(t)
	if src.Channels() != 2 {
		t.Fatalf("%d channels", src.Channels())
	}
	waitingAt(t, src, 50)
	appendTo(t, path, song[len(upTo(t, song, 1)):])
	if res := e.do(http.MethodPost, "/v1/files/complete", `{"file":"song.webm"}`); res.status != http.StatusNoContent || len(res.body) != 0 {
		t.Fatalf("complete: %d %q", res.status, res.body)
	}
	if n, end, err := untilEnd(t, src); err != nil || n != 100 || end != 2*time.Second {
		t.Fatalf("after complete: %d packets, %v, %v", n, end, err)
	}
}

// A growing PUT whose upload fails: the Source gives up (the player turns that into an error
// event).
func TestPlayGrowingFails(t *testing.T) {
	e := newEnv(t, testToken)
	e.write("cache/song.webm", upTo(t, webmtest.Simple(100).Bytes(), 1))
	res := e.do(http.MethodPut, "/v1/rooms/r1", playBody(t, "song.webm", map[string]any{"growing": true}))
	if res.status != http.StatusOK {
		t.Fatalf("status %d: %s", res.status, res.body)
	}
	src := e.rooms.lastSource(t)
	waitingAt(t, src, 50)
	if res := e.do(http.MethodPost, "/v1/files/failed", mustJSON(t, map[string]string{"file": e.dir + "/song.webm"})); res.status != http.StatusNoContent {
		t.Fatalf("failed: %d %s", res.status, res.body)
	}
	if _, _, err := untilEnd(t, src); !errors.Is(err, webmopus.ErrFailed) {
		t.Fatalf("after failed: %v, want ErrFailed", err)
	}
}

func TestPauseResume(t *testing.T) {
	e := newEnv(t, testToken)
	wantJSON(t, e.do(http.MethodPost, "/v1/rooms/r1/pause", ""), http.StatusOK,
		`{"room":"r1","itemId":"item-1","state":"paused","positionMs":1234,"durationMs":5000}`)
	if left := e.rooms.lastDeadline(t); left <= 0 || left > defaultTimeouts.control {
		t.Fatalf("Pause's context has %v left", left)
	}
	wantJSON(t, e.do(http.MethodPost, "/v1/rooms/r1/resume", ""), http.StatusOK,
		`{"room":"r1","itemId":"item-1","state":"playing","positionMs":1234,"durationMs":5000}`)
	if left := e.rooms.lastDeadline(t); left <= 0 || left > defaultTimeouts.control {
		t.Fatalf("Resume's context has %v left", left)
	}

	notPlaying := func(context.Context, string) (player.Status, error) { return player.Status{}, player.ErrNotPlaying }
	e.rooms.set(func(f *fakeRooms) { f.pauseFn, f.resumeFn = notPlaying, notPlaying })
	wantError(t, e.do(http.MethodPost, "/v1/rooms/r2/pause", ""), http.StatusNotFound, "not_playing")
	wantError(t, e.do(http.MethodPost, "/v1/rooms/r2/resume", ""), http.StatusNotFound, "not_playing")

	closed := func(context.Context, string) (player.Status, error) { return player.Status{}, player.ErrClosed }
	e.rooms.set(func(f *fakeRooms) { f.pauseFn = closed })
	wantError(t, e.do(http.MethodPost, "/v1/rooms/r2/pause", ""), http.StatusServiceUnavailable, "shutting_down")

	want := []string{"pause r1", "resume r1", "pause r2", "resume r2", "pause r2"}
	if got := e.rooms.calls(); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("calls %v, want %v", got, want)
	}
}

func TestLeaveIsIdempotent(t *testing.T) {
	e := newEnv(t, testToken)
	for range 2 {
		res := e.do(http.MethodDelete, "/v1/rooms/r1", "")
		if res.status != http.StatusNoContent || len(res.body) != 0 {
			t.Fatalf("DELETE: %d %q", res.status, res.body)
		}
	}
	if got := e.rooms.calls(); fmt.Sprint(got) != "[leave r1 leave r1]" {
		t.Fatalf("calls %v", got)
	}
	if left := e.rooms.lastDeadline(t); left <= 0 || left > defaultTimeouts.control {
		t.Fatalf("Leave's context has %v left", left)
	}
}

func TestListRooms(t *testing.T) {
	e := newEnv(t, testToken)
	res := e.do(http.MethodGet, "/v1/rooms", "")
	wantJSON(t, res, http.StatusOK, `{"rooms":[]}`) // an empty array, never null
	e.rooms.set(func(f *fakeRooms) {
		f.list = []player.Status{
			{Room: "a", ItemID: "i1", State: player.Playing, PositionMs: 10, DurationMs: 1000},
			{Room: "b", ItemID: "i2", State: player.Error, PositionMs: 0, DurationMs: 2000, Message: "gave up"},
		}
	})
	wantJSON(t, e.do(http.MethodGet, "/v1/rooms", ""), http.StatusOK, `{"rooms":[
		{"room":"a","itemId":"i1","state":"playing","positionMs":10,"durationMs":1000},
		{"room":"b","itemId":"i2","state":"error","positionMs":0,"durationMs":2000,"message":"gave up"}]}`)
}

// The body's read deadline must not outlive the read: net/http's background read would time out
// with it and cancel the request's context while the player is still joining LiveKit (net/http
// lifts it when that read starts; this guards against a decode that sets one later).
func TestPlayContextOutlivesBodyDeadline(t *testing.T) {
	e := newEnv(t, testToken, func(s *server) { s.timeouts.bodyRead = 50 * time.Millisecond })
	e.write("cache/song.webm", stereoSong())
	e.rooms.set(func(f *fakeRooms) {
		f.playFn = func(ctx context.Context, room string, req player.PlayRequest) (player.Status, error) {
			select {
			case <-ctx.Done():
				return player.Status{}, ctx.Err()
			case <-time.After(400 * time.Millisecond): // a slow LiveKit join
			}
			return player.Status{Room: room, ItemID: req.ItemID, State: player.Playing, DurationMs: 1000}, nil
		}
	})
	res := e.do(http.MethodPut, "/v1/rooms/r1", playBody(t, "song.webm", nil))
	if res.status != http.StatusOK {
		t.Fatalf("status %d: %s", res.status, res.body)
	}
}

// A client that stops sending its body gets a 400 once the body's deadline passes, whether the
// handler is still reading it or gave up on bad JSON with the rest unsent.
func TestBodyReadIsBounded(t *testing.T) {
	e := newEnv(t, testToken, func(s *server) { s.timeouts.bodyRead = 100 * time.Millisecond })
	for _, partial := range []string{`{"file":`, `}`} {
		conn, err := net.Dial("tcp", e.ts.Listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		start := time.Now()
		fmt.Fprintf(conn, "PUT /v1/rooms/r1 HTTP/1.1\r\nHost: jam-bot\r\nAuthorization: Bearer %s\r\n"+
			"Content-Type: application/json\r\nContent-Length: 100\r\n\r\n%s", testToken, partial)
		resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatalf("%q: no answer: %v", partial, err)
		}
		_ = resp.Body.Close()
		_ = conn.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("%q: status %d", partial, resp.StatusCode)
		}
		if d := time.Since(start); d > 3*time.Second {
			t.Fatalf("%q: answered after %v", partial, d)
		}
	}
	if calls := e.rooms.calls(); len(calls) != 0 {
		t.Fatalf("player calls %v", calls)
	}
}
