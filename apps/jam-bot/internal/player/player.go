// Package player plays one Opus track per LiveKit room, paced in real time against an absolute
// clock, and keeps playing across LiveKit reconnections. Files may still be growing while they
// play: the room waits for their packets without bursting. It does not know about HTTP, files
// or the LiveKit SDK: those come through Source, Connector and Conn.
package player

import (
	"context"
	"errors"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/bryanljf/Concord/apps/jam-bot/internal/webmopus"
)

// State of a room, as API.md names it.
type State string

const (
	Idle    State = "idle" // joined (Connect), nothing loaded yet
	Playing State = "playing"
	Paused  State = "paused"
	Ended   State = "ended"
	Error   State = "error"
)

// Status is API.md's RoomStatus.
type Status struct {
	Room       string `json:"room"`
	ItemID     string `json:"itemId"`
	State      State  `json:"state"`
	PositionMs int64  `json:"positionMs"`
	DurationMs int64  `json:"durationMs"` // end of the packets parsed so far
	Message    string `json:"message,omitempty"`
}

// Event is API.md's BotEvent.
type Event struct {
	Type    string `json:"type"` // "ended" or "error"
	Room    string `json:"room"`
	ItemID  string `json:"itemId"`
	Message string `json:"message,omitempty"` // always set on "error"
}

// Source is the file a room plays (*webmopus.Source), possibly still being written. Its methods
// are safe for concurrent use.
type Source interface {
	Channels() int
	// Packet blocks until packet i is parsed. io.EOF past the end of a complete file;
	// webmopus.ErrFailed, ErrStalled or ErrInvalidAudio when it will never come; ctx.Err().
	Packet(ctx context.Context, i int) (webmopus.Packet, error)
	// IndexAt returns the first packet starting at or after off, waiting while the file grows
	// (its length past the end of a complete file).
	IndexAt(ctx context.Context, off time.Duration) (int, error)
	// Parsed never blocks: packets available now, the end of the last one, and whether the
	// whole file was parsed.
	Parsed() (n int, end time.Duration, complete bool)
	Close() error
}

var _ Source = (*webmopus.Source)(nil)

// Conn is a live connection to one LiveKit room, with the jam track published and bound.
type Conn interface {
	// WriteSample sends one Opus packet; at is its time on the playback schedule.
	WriteSample(data []byte, dur time.Duration, at time.Time) error
	// SetMuted mutes or unmutes the published track (kept across the SDK's reconnections).
	SetMuted(muted bool)
	// Close unpublishes the track and leaves the room. Idempotent.
	Close()
}

// Link receives what happens to a Conn once established. Its functions never block and may be
// called from any goroutine, even after the Conn was closed.
type Link struct {
	Down         func()                          // reconnecting: packets written now are lost
	Up           func()                          // reconnected, the track is bound again
	Disconnected func(reason string, retry bool) // gone for good; retry: worth joining again
}

// Connector joins a LiveKit room with a token and publishes the jam track. Its errors must not
// contain the token.
type Connector interface {
	Connect(ctx context.Context, url, token string, link Link) (Conn, error)
}

// PlayRequest is a parsed PUT /v1/rooms/{room}.
type PlayRequest struct {
	URL    string
	Token  string
	ItemID string
	// Source belongs to the Manager from the moment it is given to Play, whatever Play answers:
	// it is closed when replaced, after the song ended or failed, on Leave and Close, and when
	// Play fails.
	Source Source
	Offset time.Duration
	Paused bool
}

var (
	// ErrNotPlaying: the room has nothing to pause or resume (unknown, idle, ended or failed).
	ErrNotPlaying = errors.New("not playing")
	// ErrClosed: the bot is shutting down.
	ErrClosed = errors.New("shutting down")

	errRoomGone = errors.New("room closed")
	errNoSource = errors.New("player: no source to play")
)

// LiveKitError means connecting to LiveKit (or publishing the track) failed.
type LiveKitError struct{ Err error }

func (e *LiveKitError) Error() string { return "livekit: " + e.Err.Error() }
func (e *LiveKitError) Unwrap() error { return e.Err }

// Options configure a Manager. Connector is required.
type Options struct {
	Connector Connector
	Clock     Clock        // default RealClock
	Log       *slog.Logger // default slog.Default()
	Emit      func(Event)  // must not block; default drops
	Timeouts  Timeouts     // zero fields get the defaults

	backoff func(int) time.Duration
	fetched func() // tests: called by a room after it took in what it waited for from its Source
}

// Timeouts of the LiveKit side.
type Timeouts struct {
	// Connect bounds one join + publish + bind (default 10 s).
	Connect time.Duration
	// Rejoin is how long a room that lost LiveKit for good keeps trying to join again before
	// giving up on the song (default 2 min; the SDK already retried for about a minute).
	Rejoin time.Duration
	// UnmuteDelay holds the packets back after unmuting the track (default 80 ms; negative:
	// none). The SDK sends media while the track is muted, so without it the first packets
	// after a resume beat the unmute (sent over the signalling WebSocket) and the SFU drops them.
	UnmuteDelay time.Duration
}

// Manager owns the rooms, one goroutine each.
type Manager struct {
	opts Options

	mu     sync.Mutex
	rooms  map[string]*room
	closed bool
}

func NewManager(opts Options) *Manager {
	if opts.Clock == nil {
		opts.Clock = RealClock{}
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.Emit == nil {
		opts.Emit = func(Event) {}
	}
	if opts.Timeouts.Connect <= 0 {
		opts.Timeouts.Connect = 10 * time.Second
	}
	if opts.Timeouts.Rejoin <= 0 {
		opts.Timeouts.Rejoin = 2 * time.Minute
	}
	switch {
	case opts.Timeouts.UnmuteDelay == 0:
		opts.Timeouts.UnmuteDelay = 80 * time.Millisecond
	case opts.Timeouts.UnmuteDelay < 0:
		opts.Timeouts.UnmuteDelay = 0
	}
	if opts.backoff == nil {
		opts.backoff = rejoinBackoff
	}
	if opts.fetched == nil {
		opts.fetched = func() {}
	}
	return &Manager{opts: opts, rooms: map[string]*room{}}
}

// rejoinBackoff: 0.5 s, 1 s, 2 s, 4 s, 8 s, then every 15 s.
func rejoinBackoff(attempt int) time.Duration {
	d := 500 * time.Millisecond << min(attempt, 5)
	return min(d, 15*time.Second)
}

func (m *Manager) getOrCreate(name string) (*room, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, ErrClosed
	}
	r := m.rooms[name]
	if r == nil {
		r = newRoom(m, name)
		m.rooms[name] = r
		go r.run()
	}
	return r, nil
}

func (m *Manager) get(name string) *room {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.rooms[name]
}

// forget drops r from the map when it is still the room under its name.
func (m *Manager) forget(r *room) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.rooms[r.name] == r {
		delete(m.rooms, r.name)
	}
}

// send runs c in the room called name (created when needed), in a fresh one when a DELETE or a
// failed join closed it just now. taken: the room got the command.
func (m *Manager) send(ctx context.Context, name string, c command) (st Status, taken bool, err error) {
	for {
		r, err := m.getOrCreate(name)
		if err != nil {
			return Status{}, false, err
		}
		st, taken, err := r.do(ctx, c)
		if errors.Is(err, errRoomGone) && ctx.Err() == nil {
			continue
		}
		return st, taken, err
	}
}

// Play loads the request's source in the room (joining LiveKit first when needed) and answers
// once it is publishing. A failed join leaves the room (LiveKitError). The source is the
// Manager's from now on (see PlayRequest.Source).
func (m *Manager) Play(ctx context.Context, name string, req PlayRequest) (Status, error) {
	if req.Source == nil {
		return Status{}, errNoSource
	}
	st, taken, err := m.send(ctx, name, command{kind: cmdPlay, play: &req})
	if !taken {
		req.Source.Close()
		if errors.Is(err, errRoomGone) {
			err = ctx.Err()
		}
	}
	return st, err
}

// Connect joins the room and publishes the (silent) track ahead of the first song: the room is
// "idle" until a Play. Idempotent: a room already in LiveKit keeps what it is doing and only
// takes the newer token (for its reconnections). A failed join leaves the room (LiveKitError).
func (m *Manager) Connect(ctx context.Context, name, url, token string) (Status, error) {
	st, taken, err := m.send(ctx, name, command{kind: cmdConnect, url: url, token: token})
	if !taken && errors.Is(err, errRoomGone) {
		err = ctx.Err()
	}
	return st, err
}

// Pause stops sending packets (and mutes the track) until Resume.
func (m *Manager) Pause(ctx context.Context, name string) (Status, error) {
	return m.control(ctx, name, cmdPause)
}

// Resume continues from the packet where Pause stopped.
func (m *Manager) Resume(ctx context.Context, name string) (Status, error) {
	return m.control(ctx, name, cmdResume)
}

func (m *Manager) control(ctx context.Context, name string, kind cmdKind) (Status, error) {
	r := m.get(name)
	if r == nil {
		return Status{}, ErrNotPlaying
	}
	st, _, err := r.do(ctx, command{kind: kind})
	if errors.Is(err, errRoomGone) {
		return Status{}, ErrNotPlaying
	}
	return st, err
}

// Leave stops the room, unpublishes and leaves LiveKit. Unknown rooms are fine. It waits for the
// room to be left until ctx ends.
func (m *Manager) Leave(ctx context.Context, name string) {
	m.mu.Lock()
	r := m.rooms[name]
	delete(m.rooms, name)
	m.mu.Unlock()
	if r == nil {
		return
	}
	r.stop("delete")
	select {
	case <-r.done:
	case <-ctx.Done():
	}
}

// List returns the rooms the bot is in, by name.
func (m *Manager) List() []Status {
	m.mu.Lock()
	rooms := make([]*room, 0, len(m.rooms))
	for _, r := range m.rooms {
		rooms = append(rooms, r)
	}
	m.mu.Unlock()
	out := make([]Status, 0, len(rooms))
	for _, r := range rooms {
		if st, ok := r.snapshot(); ok {
			out = append(out, st)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Room < out[j].Room })
	return out
}

// Close leaves every room (waiting until ctx ends) and refuses new ones.
func (m *Manager) Close(ctx context.Context) {
	m.mu.Lock()
	m.closed = true
	rooms := make([]*room, 0, len(m.rooms))
	for _, r := range m.rooms {
		rooms = append(rooms, r)
	}
	clear(m.rooms)
	m.mu.Unlock()
	for _, r := range rooms {
		r.stop("shutdown")
	}
	for _, r := range rooms {
		select {
		case <-r.done:
		case <-ctx.Done():
			return
		}
	}
}
