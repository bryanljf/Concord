// Package server is the bot's internal HTTP API (apps/jam-bot/API.md).
package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/bryanljf/Concord/apps/jam-bot/internal/player"
	"github.com/bryanljf/Concord/apps/jam-bot/internal/webmopus"
)

const (
	maxBodyBytes = 16 << 10
	maxRoomLen   = 128
	maxItemLen   = 256
	maxTokenLen  = 8 << 10
	maxURLLen    = 2 << 10
	maxOffset    = 24 * time.Hour

	pingInterval = 15 * time.Second
)

// timeouts of the handlers (a server field, so tests can shorten them).
type timeouts struct {
	bodyRead time.Duration // reading a request's JSON body
	play     time.Duration // PUT and probe open the file, PUT and connect may join LiveKit (the api waits 15 s)
	control  time.Duration // pause, resume, leave
	write    time.Duration // one write to an event stream
}

var defaultTimeouts = timeouts{
	bodyRead: 10 * time.Second,
	play:     20 * time.Second,
	control:  10 * time.Second,
	write:    10 * time.Second,
}

// Rooms is what the API drives (player.Manager).
type Rooms interface {
	Connect(ctx context.Context, room, url, token string) (player.Status, error)
	Play(ctx context.Context, room string, req player.PlayRequest) (player.Status, error)
	Pause(ctx context.Context, room string) (player.Status, error)
	Resume(ctx context.Context, room string) (player.Status, error)
	Leave(ctx context.Context, room string)
	List() []player.Status
}

// Config of the API.
type Config struct {
	Token        string // JAM_BOT_TOKEN; empty: no auth
	Files        *Files
	Rooms        Rooms
	Hub          *Hub
	Log          *slog.Logger
	PingInterval time.Duration // default 15 s
	// Redact scrubs error messages from LiveKit before they are answered or logged.
	Redact func(string) string
}

type server struct {
	Config
	tokenSum [32]byte
	timeouts timeouts
}

// apiError is an error answered as {error, message}.
type apiError struct {
	status  int
	code    string
	message string
}

func (e *apiError) Error() string { return e.code + ": " + e.message }

// New returns the API's handler.
func New(cfg Config) http.Handler { return newServer(cfg).handler() }

func newServer(cfg Config) *server {
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	if cfg.PingInterval <= 0 {
		cfg.PingInterval = pingInterval
	}
	if cfg.Redact == nil {
		cfg.Redact = func(s string) string { return s }
	}
	return &server{Config: cfg, tokenSum: sha256.Sum256([]byte(cfg.Token)), timeouts: defaultTimeouts}
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	var paths []string
	allowed := map[string][]string{}
	route := func(method, path string, h http.Handler) {
		mux.Handle(method+" "+path, h)
		if allowed[path] == nil {
			paths = append(paths, path)
		}
		allowed[path] = append(allowed[path], method)
		if method == http.MethodGet { // the GET pattern serves HEAD too
			allowed[path] = append(allowed[path], http.MethodHead)
		}
	}
	route(http.MethodGet, "/healthz", http.HandlerFunc(s.healthz))
	route(http.MethodPost, "/v1/probe", s.auth(s.probe))
	route(http.MethodPost, "/v1/rooms/{room}/connect", s.auth(s.connect))
	route(http.MethodPut, "/v1/rooms/{room}", s.auth(s.play))
	route(http.MethodPost, "/v1/rooms/{room}/pause", s.auth(s.pause))
	route(http.MethodPost, "/v1/rooms/{room}/resume", s.auth(s.resume))
	route(http.MethodDelete, "/v1/rooms/{room}", s.auth(s.leave))
	route(http.MethodGet, "/v1/rooms", s.auth(s.list))
	route(http.MethodGet, "/v1/events", s.auth(s.events))
	route(http.MethodPost, "/v1/files/complete", s.auth(s.fileDone((*Files).Complete)))
	route(http.MethodPost, "/v1/files/failed", s.auth(s.fileDone((*Files).Fail)))
	// Any other method on those paths: a JSON 405. ServeMux only answers 405 itself when no other
	// pattern matches (here "/" always does, so it would be a 404), and in plain text.
	for _, path := range paths {
		allow := strings.Join(allowed[path], ", ")
		mux.Handle(path, s.auth(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Allow", allow)
			s.fail(w, r, &apiError{http.StatusMethodNotAllowed, "method_not_allowed",
				"this endpoint only answers " + allow})
		}))
	}
	mux.Handle("/", s.auth(func(w http.ResponseWriter, r *http.Request) {
		s.fail(w, r, &apiError{http.StatusNotFound, "not_found", "no such endpoint"})
	}))
	return mux
}

func (s *server) auth(h http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.Token != "" {
			got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			sum := sha256.Sum256([]byte(got))
			if subtle.ConstantTimeCompare(sum[:], s.tokenSum[:]) != 1 || !ok {
				w.Header().Set("WWW-Authenticate", `Bearer realm="jam-bot"`)
				s.fail(w, r, &apiError{http.StatusUnauthorized, "unauthorized", "missing or wrong bearer token"})
				return
			}
		}
		h(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *server) fail(w http.ResponseWriter, r *http.Request, err error) {
	var ae *apiError
	if !errors.As(err, &ae) {
		var lk *player.LiveKitError
		switch {
		case errors.As(err, &lk):
			ae = &apiError{http.StatusBadGateway, "livekit_error", s.Redact(lk.Err.Error())}
		case errors.Is(err, player.ErrNotPlaying):
			ae = &apiError{http.StatusNotFound, "not_playing", "the bot is not playing in this room"}
		case errors.Is(err, player.ErrClosed):
			ae = &apiError{http.StatusServiceUnavailable, "shutting_down", "the bot is shutting down"}
		case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
			ae = &apiError{http.StatusServiceUnavailable, "timeout", "the bot did not finish in time"}
		default:
			ae = &apiError{http.StatusInternalServerError, "internal", s.Redact(err.Error())}
		}
	}
	level := slog.LevelInfo
	if ae.status >= 500 {
		level = slog.LevelWarn
	}
	s.Log.Log(r.Context(), level, "request failed", "method", r.Method, "path", r.URL.Path,
		"status", ae.status, "error", ae.code, "message", ae.message)
	writeJSON(w, ae.status, map[string]string{"error": ae.code, "message": ae.message})
}

func badBody(msg string) *apiError {
	return &apiError{http.StatusBadRequest, "invalid_body", msg}
}

// decode reads a small JSON body into v.
func (s *server) decode(w http.ResponseWriter, r *http.Request, v any) error {
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(s.timeouts.bodyRead))
	body := http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(body)
	if err := dec.Decode(v); err != nil {
		var tooBig *http.MaxBytesError
		switch {
		case errors.As(err, &tooBig):
			return &apiError{http.StatusRequestEntityTooLarge, "payload_too_large", "the body is too large"}
		case errors.Is(err, io.EOF):
			return badBody("a JSON body is required")
		default:
			return badBody("the body is not valid JSON for this endpoint")
		}
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return badBody("unexpected data after the JSON body")
	}
	return nil
}

// roomName validates the {room} path segment.
func roomName(r *http.Request) (string, error) {
	name := r.PathValue("room")
	if name == "" || len(name) > maxRoomLen || !utf8.ValidString(name) ||
		strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return "", &apiError{http.StatusBadRequest, "invalid_room", "invalid room name"}
	}
	return name, nil
}

func (s *server) healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type probeRequest struct {
	File    string `json:"file"`
	Partial bool   `json:"partial"` // still being written: read its header only
}

type probeResult struct {
	DurationMs int64  `json:"durationMs"`
	Channels   int    `json:"channels"`
	SampleRate int    `json:"sampleRate"`
	Codec      string `json:"codec"`
}

func (s *server) probe(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), s.timeouts.play)
	defer cancel()
	var req probeRequest
	if err := s.decode(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	path, err := s.Files.Resolve(req.File)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	channels, duration, err := s.Files.Probe(ctx, path, req.Partial)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, probeResult{
		DurationMs: duration.Milliseconds(),
		Channels:   channels,
		SampleRate: webmopus.SampleRate,
		Codec:      "opus",
	})
}

// validateLiveKit checks where to join LiveKit, and with what.
func validateLiveKit(livekitURL, token string) error {
	u, err := url.Parse(livekitURL)
	switch {
	case err != nil || len(livekitURL) > maxURLLen || u.Host == "" ||
		(u.Scheme != "ws" && u.Scheme != "wss" && u.Scheme != "http" && u.Scheme != "https"):
		return badBody("livekitUrl must be a ws:// or wss:// URL")
	case token == "" || len(token) > maxTokenLen:
		return badBody("token is required")
	}
	return nil
}

type connectRequest struct {
	LivekitURL string `json:"livekitUrl"`
	Token      string `json:"token"`
}

// connect joins the room and publishes the (silent) track ahead of the first song.
func (s *server) connect(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), s.timeouts.play)
	defer cancel()
	name, err := roomName(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var req connectRequest
	if err := s.decode(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if err := validateLiveKit(req.LivekitURL, req.Token); err != nil {
		s.fail(w, r, err)
		return
	}
	st, err := s.Rooms.Connect(ctx, name, req.LivekitURL, req.Token)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

type playRequest struct {
	LivekitURL string   `json:"livekitUrl"`
	Token      string   `json:"token"`
	ItemID     string   `json:"itemId"`
	File       string   `json:"file"`
	OffsetMs   *float64 `json:"offsetMs"`
	Paused     *bool    `json:"paused"`
	Growing    bool     `json:"growing"` // still being written: played as it grows
}

func (p *playRequest) validate() error {
	if err := validateLiveKit(p.LivekitURL, p.Token); err != nil {
		return err
	}
	switch {
	case p.ItemID == "" || len(p.ItemID) > maxItemLen:
		return badBody("itemId is required")
	case p.File == "":
		return badBody("file is required")
	case p.OffsetMs != nil && (*p.OffsetMs < 0 || math.IsNaN(*p.OffsetMs) || math.IsInf(*p.OffsetMs, 0)):
		return badBody("offsetMs must be a number of milliseconds, 0 or more")
	}
	return nil
}

func (s *server) play(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), s.timeouts.play)
	defer cancel()
	name, err := roomName(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var req playRequest
	if err := s.decode(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if err := req.validate(); err != nil {
		s.fail(w, r, err)
		return
	}
	path, err := s.Files.Resolve(req.File)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	src, err := s.Files.Load(ctx, path, req.Growing)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// The player owns the Source from here: it closes it, even when Play fails.
	pr := player.PlayRequest{URL: req.LivekitURL, Token: req.Token, ItemID: req.ItemID, Source: src}
	if req.OffsetMs != nil {
		// Past any song's end anyway; the bound keeps the conversion from overflowing.
		ms := min(*req.OffsetMs, float64(maxOffset/time.Millisecond))
		pr.Offset = time.Duration(ms * float64(time.Millisecond))
	}
	if req.Paused != nil {
		pr.Paused = *req.Paused
	}
	st, err := s.Rooms.Play(ctx, name, pr)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *server) control(w http.ResponseWriter, r *http.Request,
	op func(context.Context, string) (player.Status, error)) {
	ctx, cancel := context.WithTimeout(r.Context(), s.timeouts.control)
	defer cancel()
	name, err := roomName(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	st, err := op(ctx, name)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *server) pause(w http.ResponseWriter, r *http.Request)  { s.control(w, r, s.Rooms.Pause) }
func (s *server) resume(w http.ResponseWriter, r *http.Request) { s.control(w, r, s.Rooms.Resume) }

func (s *server) leave(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), s.timeouts.control)
	defer cancel()
	name, err := roomName(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.Rooms.Leave(ctx, name)
	w.WriteHeader(http.StatusNoContent)
}

type fileRequest struct {
	File string `json:"file"`
}

// fileDone tells the rooms reading a file still being written how its upload ended (mark is
// Files.Complete or Files.Fail): 204 even when nobody reads it, as the state is kept for a later
// PUT.
func (s *server) fileDone(mark func(f *Files, file string) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req fileRequest
		if err := s.decode(w, r, &req); err != nil {
			s.fail(w, r, err)
			return
		}
		if err := mark(s.Files, req.File); err != nil {
			s.fail(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func (s *server) list(w http.ResponseWriter, _ *http.Request) {
	rooms := s.Rooms.List()
	if rooms == nil {
		rooms = []player.Status{}
	}
	writeJSON(w, http.StatusOK, map[string][]player.Status{"rooms": rooms})
}

// events streams the hub as Server-Sent Events, with a ping comment every PingInterval.
func (s *server) events(w http.ResponseWriter, r *http.Request) {
	sub := s.Hub.Subscribe()
	if sub == nil {
		s.fail(w, r, player.ErrClosed)
		return
	}
	defer sub.Close()
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Time{})
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if rc.Flush() != nil {
		return
	}
	ping := time.NewTicker(s.PingInterval)
	defer ping.Stop()
	for {
		var chunk []byte
		select {
		case data, ok := <-sub.C:
			if !ok {
				return // dropped (too slow) or shutting down
			}
			chunk = append(append([]byte("data: "), data...), '\n', '\n')
		case <-ping.C:
			chunk = []byte(": ping\n\n")
		case <-r.Context().Done():
			return
		}
		_ = rc.SetWriteDeadline(time.Now().Add(s.timeouts.write))
		if _, err := w.Write(chunk); err != nil {
			return
		}
		if rc.Flush() != nil {
			return
		}
	}
}
