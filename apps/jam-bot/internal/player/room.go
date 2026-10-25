package player

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/bryanljf/Concord/apps/jam-bot/internal/webmopus"
)

type cmdKind int

const (
	cmdPlay cmdKind = iota
	cmdConnect
	cmdPause
	cmdResume
	cmdStatus
)

type command struct {
	kind       cmdKind
	play       *PlayRequest
	url, token string     // cmdConnect
	reply      chan reply // buffered: the room never blocks on it
}

type reply struct {
	status Status
	err    error
	fatal  bool // the room stops after answering
}

type linkKind int

const (
	linkDown linkKind = iota
	linkUp
	linkGone
)

type linkEvent struct {
	gen    int
	kind   linkKind
	reason string
	retry  bool
}

// linkQueue hands connection events to the room goroutine in order, without ever blocking the
// SDK goroutine that reports them.
type linkQueue struct {
	mu     sync.Mutex
	events []linkEvent
	notify chan struct{}
}

func (q *linkQueue) push(e linkEvent) {
	q.mu.Lock()
	q.events = append(q.events, e)
	q.mu.Unlock()
	select {
	case q.notify <- struct{}{}:
	default:
	}
}

func (q *linkQueue) drain() []linkEvent {
	q.mu.Lock()
	defer q.mu.Unlock()
	events := q.events
	q.events = nil
	return events
}

// fetchResult is what a goroutine waiting on the source (a file still growing) got.
type fetchResult struct {
	seek bool // IndexAt (idx), else Packet (pkt)
	idx  int
	pkt  webmopus.Packet
	err  error
}

// room plays one LiveKit room. Everything below the mutex belongs to its goroutine.
type room struct {
	name   string
	m      *Manager
	clock  Clock
	log    *slog.Logger
	cmds   chan command
	links  linkQueue
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}

	mu         sync.Mutex
	status     Status // DurationMs comes from statusSrc while it is set
	statusSrc  Source
	listed     bool   // in LiveKit or with a song: List shows it
	stopReason string // set by Leave and Close

	url, token string
	conn       Conn
	gen        int       // connection generation: events from older ones are ignored
	linkUp     bool      // conn can carry packets right now
	muted      bool      // what conn was told
	holdUntil  time.Time // just unmuted: no packet before then

	itemID  string
	state   State
	message string

	src      Source
	srcCtx   context.Context    // ends when src is closed
	srcStop  context.CancelFunc // ends srcCtx
	seeking  bool               // next is not known yet: the first packet at or after seekOff
	seekOff  time.Duration
	next     int             // index of the next packet to send
	pkt      webmopus.Packet // packet next, when have
	have     bool
	fetch    chan fetchResult // set while a goroutine waits on src
	pos      time.Duration    // where the next packet starts
	duration time.Duration    // of the last source closed

	// Schedule: a packet starting at TS is due at anchorAt + (TS - anchorTS). After reanchor the
	// next packet sent starts a new schedule at max(now, lastEnd, holdUntil).
	anchorTS      time.Duration
	anchorAt      time.Time
	anchorPending bool
	// lastEnd is when the last packet sent ends on the schedule: the next schedule never starts
	// before it, so sample timestamps only move forward and a new song never overlaps the old.
	lastEnd time.Time

	pace         Timer
	retry        Timer
	retryArmed   bool
	rejoinUntil  time.Time
	rejoinTries  int
	writeErrs    int
	writeErrLogT time.Time
}

func newRoom(m *Manager, name string) *room {
	ctx, cancel := context.WithCancel(context.Background())
	r := &room{
		name:   name,
		m:      m,
		clock:  m.opts.Clock,
		log:    m.opts.Log.With("room", name),
		cmds:   make(chan command),
		links:  linkQueue{notify: make(chan struct{}, 1)},
		ctx:    ctx,
		cancel: cancel,
		done:   make(chan struct{}),
	}
	return r
}

// do hands a command to the room goroutine and waits for its answer. taken: the room got it.
func (r *room) do(ctx context.Context, c command) (Status, bool, error) {
	c.reply = make(chan reply, 1)
	select {
	case r.cmds <- c:
	case <-r.done:
		return Status{}, false, errRoomGone
	case <-ctx.Done():
		return Status{}, false, ctx.Err()
	}
	select {
	case rep := <-c.reply:
		return rep.status, true, rep.err
	case <-ctx.Done():
		return Status{}, true, ctx.Err()
	}
}

// stop makes the room leave (Leave, Close).
func (r *room) stop(reason string) {
	r.mu.Lock()
	if r.stopReason == "" {
		r.stopReason = reason
	}
	r.mu.Unlock()
	r.cancel()
}

func (r *room) snapshot() (Status, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	st := r.status
	if r.statusSrc != nil {
		_, end, _ := r.statusSrc.Parsed()
		st.DurationMs = end.Milliseconds()
	}
	return st, r.listed
}

func (r *room) run() {
	r.pace = r.clock.NewTimer(time.Hour)
	r.pace.Stop()
	r.retry = r.clock.NewTimer(time.Hour)
	r.retry.Stop()
	defer r.exit()
	for {
		if r.state == Playing && r.src != nil && !r.have && r.fetch == nil && !r.fetchNow(true) {
			r.startWait()
		}
		var paceC <-chan time.Time
		if r.sending() {
			due := r.due()
			if due.After(r.clock.Now()) {
				r.pace.ResetAt(due)
				paceC = r.pace.C()
			} else {
				// Due (or late): look at commands first, so late packets never starve them.
				select {
				case c := <-r.cmds:
					if r.handle(c) {
						return
					}
					continue
				case <-r.links.notify:
					r.onLinks()
					continue
				case <-r.ctx.Done():
					return
				default:
				}
				r.write(due)
				continue
			}
		} else {
			r.pace.Stop()
		}
		var retryC <-chan time.Time
		if r.retryArmed {
			retryC = r.retry.C()
		}
		select {
		case <-paceC:
		case <-retryC:
			r.retryArmed = false
			r.rejoin()
		case res := <-r.fetch:
			r.fetched(res)
		case c := <-r.cmds:
			if r.handle(c) {
				return
			}
		case <-r.links.notify:
			r.onLinks()
		case <-r.ctx.Done():
			return
		}
	}
}

func (r *room) exit() {
	r.pace.Stop()
	r.retry.Stop()
	r.closeSource()
	r.closeConn()
	r.m.forget(r)
	r.cancel()
	r.mu.Lock()
	reason := r.stopReason
	r.mu.Unlock()
	if reason != "" {
		r.log.Info("left the room", "reason", reason)
	}
	close(r.done)
}

func (r *room) sending() bool {
	return r.state == Playing && r.conn != nil && r.linkUp && r.have
}

// due is when the packet in hand goes out.
func (r *room) due() time.Time { return r.anchorAt.Add(r.pkt.TS - r.anchorTS) }

// reanchor restarts the schedule at the next packet: now, or when the last packet ends, or when
// the unmute hold is over, whichever is last. "Now" is when the packet is in hand: at once
// usually, when it arrives if the file has to grow first.
func (r *room) reanchor() {
	r.anchorPending = true
	if r.have {
		r.anchor()
	}
}

func (r *room) anchor() {
	r.anchorPending = false
	r.anchorTS = r.pkt.TS
	r.anchorAt = r.clock.Now()
	if r.lastEnd.After(r.anchorAt) {
		r.anchorAt = r.lastEnd
	}
	if r.holdUntil.After(r.anchorAt) {
		r.anchorAt = r.holdUntil
	}
}

func (r *room) write(due time.Time) {
	pk := r.pkt
	if err := r.conn.WriteSample(pk.Data, pk.Dur, due); err != nil {
		r.writeErrs++
		if now := r.clock.Now(); now.Sub(r.writeErrLogT) >= 10*time.Second {
			r.log.Warn("could not send audio", "err", err, "errors", r.writeErrs)
			r.writeErrLogT, r.writeErrs = now, 0
		}
	}
	r.next++
	r.pkt, r.have = webmopus.Packet{}, false
	r.lastEnd = due.Add(pk.Dur)
	r.pos = pk.TS + pk.Dur
	r.publish()
}

// fetchNow takes the next packet from the source when that does not block, or learns that the
// song is over (state changes; emit: send the event). false: the packet (or, when seeking, the
// packet at the offset) is not parsed yet, the source has to be waited for.
func (r *room) fetchNow(emit bool) bool {
	if r.seeking {
		idx, ok := r.indexNow()
		if !ok {
			return false
		}
		r.seeking, r.next = false, idx
	}
	n, _, complete := r.src.Parsed()
	if r.next >= n && !complete {
		return false
	}
	pk, err := r.src.Packet(r.srcCtx, r.next)
	r.took(pk, err, emit)
	return true
}

// indexNow resolves the offset when the packets parsed so far already reach it.
func (r *room) indexNow() (int, bool) {
	n, _, complete := r.src.Parsed()
	if !complete {
		if n == 0 {
			return 0, false
		}
		last, err := r.src.Packet(r.srcCtx, n-1)
		if err != nil || last.TS < r.seekOff {
			return 0, false
		}
	}
	idx, err := r.src.IndexAt(r.srcCtx, r.seekOff)
	if err != nil {
		return 0, false // the wait reports it
	}
	return idx, true
}

// startWait waits for the file to grow in a goroutine; the room goes on (commands, LiveKit),
// sending nothing, its position frozen.
func (r *room) startWait() {
	ch := make(chan fetchResult, 1)
	r.fetch = ch
	src, ctx, seek, off, next := r.src, r.srcCtx, r.seeking, r.seekOff, r.next
	go func() {
		res := fetchResult{seek: seek}
		if seek {
			res.idx, res.err = src.IndexAt(ctx, off)
		} else {
			res.pkt, res.err = src.Packet(ctx, next)
		}
		ch <- res
	}()
}

// fetched takes in what the waiting goroutine got.
func (r *room) fetched(res fetchResult) {
	r.fetch = nil
	defer r.m.opts.fetched()
	switch {
	case res.err != nil:
		r.sourceErr(res.err, true)
		return
	case res.seek:
		r.seeking, r.next = false, res.idx
		if !r.fetchNow(true) {
			return // the loop waits for that packet
		}
	default:
		r.took(res.pkt, nil, true)
	}
	if !r.have {
		return
	}
	// It came later than its time on the schedule: start a new one with it, no burst.
	if !r.anchorPending && r.anchorAt.Add(r.pkt.TS-r.anchorTS).Before(r.clock.Now()) {
		r.reanchor()
	}
	r.publish()
}

func (r *room) took(pk webmopus.Packet, err error, emit bool) {
	if err != nil {
		r.sourceErr(err, emit)
		return
	}
	r.pkt, r.have, r.pos = pk, true, pk.TS
	if r.anchorPending {
		r.anchor()
	}
}

// sourceErr ends the song on io.EOF and fails it on anything else.
func (r *room) sourceErr(err error, emit bool) {
	if r.ctx.Err() != nil {
		return // leaving
	}
	if errors.Is(err, io.EOF) {
		r.end(emit)
		return
	}
	r.fail(sourceMessage(err), "err", err)
}

// sourceMessage is the "error" event's message for a source that gave up.
func sourceMessage(err error) string {
	switch {
	case errors.Is(err, webmopus.ErrFailed):
		return "the upload failed"
	case errors.Is(err, webmopus.ErrStalled):
		return "the upload stalled"
	case errors.Is(err, webmopus.ErrInvalidAudio):
		return "invalid audio"
	default:
		return "could not read the file"
	}
}

// end: the song played to its end (emit: tell the api; not when a PUT's answer says it).
func (r *room) end(emit bool) {
	r.closeSource()
	r.state = Ended
	r.pos = r.duration
	r.applyMute()
	r.publish()
	if emit {
		r.log.Info("song ended", "itemId", r.itemID)
		r.m.opts.Emit(Event{Type: "ended", Room: r.name, ItemID: r.itemID})
	}
}

// closeSource stops waiting on the source and closes it, keeping its duration.
func (r *room) closeSource() {
	if r.src == nil {
		return
	}
	_, r.duration, _ = r.src.Parsed()
	r.srcStop()
	r.mu.Lock()
	r.statusSrc = nil
	r.mu.Unlock()
	if err := r.src.Close(); err != nil {
		r.log.Debug("could not close the file", "err", err)
	}
	r.src, r.srcCtx, r.srcStop, r.fetch = nil, nil, nil, nil
	r.pkt, r.have, r.seeking = webmopus.Packet{}, false, false
}

// publish refreshes the status snapshot.
func (r *room) publish() {
	st := Status{
		Room:       r.name,
		ItemID:     r.itemID,
		State:      r.state,
		PositionMs: r.pos.Milliseconds(),
		DurationMs: r.duration.Milliseconds(),
	}
	if r.state == Error {
		st.Message = r.message
	}
	r.mu.Lock()
	r.status, r.statusSrc, r.listed = st, r.src, true
	r.mu.Unlock()
}

// handle runs a command; true means the room must stop.
func (r *room) handle(c command) bool {
	r.onLinks() // act on the connection as it is now
	var rep reply
	switch c.kind {
	case cmdPlay:
		rep = r.play(c.play)
	case cmdConnect:
		rep = r.connectTo(c.url, c.token)
	case cmdPause:
		rep = r.pause()
	case cmdResume:
		rep = r.resume()
	case cmdStatus:
		st, _ := r.snapshot()
		rep = reply{status: st}
	}
	c.reply <- rep
	return rep.fatal
}

// join leaves the current connection, if any, and joins url.
func (r *room) join(url string) error {
	r.closeConn()
	r.stopRejoin()
	r.url = url
	if err := r.connect(); err != nil {
		r.log.Warn("could not join LiveKit", "err", err)
		return &LiveKitError{err}
	}
	r.log.Info("joined LiveKit")
	return nil
}

func (r *room) connectTo(url, token string) reply {
	r.token = token
	switch {
	case r.conn != nil && r.url == url:
		// Already in: only the token changes.
	case r.conn == nil && r.retryArmed && r.url == url:
		// Joining again on its own (playing or paused): the next try takes the new token.
	default:
		if err := r.join(url); err != nil {
			return reply{err: err, fatal: true}
		}
	}
	if r.state == "" {
		r.state = Idle
	}
	r.publish()
	st, _ := r.snapshot()
	return reply{status: st}
}

func (r *room) play(req *PlayRequest) reply {
	r.token = req.Token
	if r.conn == nil || r.url != req.URL {
		if err := r.join(req.URL); err != nil {
			req.Source.Close()
			return reply{err: err, fatal: true}
		}
	}
	r.closeSource()
	r.src = req.Source
	r.srcCtx, r.srcStop = context.WithCancel(r.ctx)
	channels := req.Source.Channels()
	r.itemID, r.message = req.ItemID, ""
	r.seeking, r.seekOff, r.next, r.pos, r.duration = true, req.Offset, 0, req.Offset, 0
	if req.Paused {
		r.state = Paused
	} else {
		r.state = Playing
	}
	r.applyMute()
	r.reanchor()
	// The position (and the schedule) is known now unless the file has to grow up to the offset
	// first. Nothing left after the offset: the answer says "ended", no event.
	r.fetchNow(false)
	r.publish()
	st, _ := r.snapshot()
	r.log.Info("loaded song", "itemId", r.itemID, "state", r.state, "positionMs", st.PositionMs,
		"durationMs", st.DurationMs, "channels", channels)
	return reply{status: st}
}

func (r *room) pause() reply {
	switch r.state {
	case Playing:
		r.state = Paused
		r.applyMute()
		r.publish()
		st, _ := r.snapshot()
		r.log.Info("paused", "itemId", r.itemID, "positionMs", st.PositionMs)
	case Paused:
	default:
		return reply{err: ErrNotPlaying}
	}
	st, _ := r.snapshot()
	return reply{status: st}
}

func (r *room) resume() reply {
	switch r.state {
	case Paused:
		r.state = Playing
		r.applyMute()
		r.reanchor()
		r.publish()
		st, _ := r.snapshot()
		r.log.Info("resumed", "itemId", r.itemID, "positionMs", st.PositionMs)
	case Playing:
	default:
		return reply{err: ErrNotPlaying}
	}
	st, _ := r.snapshot()
	return reply{status: st}
}

// applyMute mutes the track while paused, unmutes it otherwise. After unmuting, packets wait
// for UnmuteDelay (holdUntil): sent right away, the first ones would be dropped by the SFU.
func (r *room) applyMute() {
	muted := r.state == Paused
	if r.conn != nil && r.muted != muted {
		r.conn.SetMuted(muted)
		r.muted = muted
		if !muted {
			r.holdUntil = r.clock.Now().Add(r.m.opts.Timeouts.UnmuteDelay)
		}
	}
}

func (r *room) connect() error {
	ctx, cancel := context.WithTimeout(r.ctx, r.m.opts.Timeouts.Connect)
	defer cancel()
	r.gen++
	gen := r.gen
	q := &r.links
	link := Link{
		Down: func() { q.push(linkEvent{gen: gen, kind: linkDown}) },
		Up:   func() { q.push(linkEvent{gen: gen, kind: linkUp}) },
		Disconnected: func(reason string, retry bool) {
			q.push(linkEvent{gen: gen, kind: linkGone, reason: reason, retry: retry})
		},
	}
	conn, err := r.m.opts.Connector.Connect(ctx, r.url, r.token, link)
	if err != nil {
		return err
	}
	// A new track starts unmuted (no unmute to wait for); muted again when paused.
	r.conn, r.linkUp, r.muted = conn, true, false
	r.applyMute()
	r.reanchor()
	return nil
}

func (r *room) closeConn() {
	if r.conn != nil {
		r.conn.Close()
		r.conn, r.linkUp = nil, false
	}
}

func (r *room) onLinks() {
	for _, e := range r.links.drain() {
		if e.gen != r.gen || r.conn == nil {
			continue // from a connection already replaced or closed
		}
		switch e.kind {
		case linkDown:
			if r.linkUp {
				r.linkUp = false
				r.log.Warn("LiveKit connection lost, reconnecting")
			}
		case linkUp:
			if !r.linkUp {
				r.linkUp = true
				r.reanchor()
				r.log.Info("LiveKit connection back")
			}
		case linkGone:
			r.closeConn()
			active := r.state == Playing || r.state == Paused
			r.log.Warn("left LiveKit", "reason", e.reason, "rejoin", e.retry && active)
			switch {
			case !active:
				// Silent anyway: the next PUT or connect joins again.
			case e.retry:
				r.rejoinUntil = r.clock.Now().Add(r.m.opts.Timeouts.Rejoin)
				r.rejoinTries = 0
				r.armRetry()
			default:
				r.fail("left the LiveKit room: " + e.reason)
			}
		}
	}
}

func (r *room) armRetry() {
	r.retry.Reset(r.m.opts.backoff(r.rejoinTries))
	r.retryArmed = true
}

func (r *room) stopRejoin() {
	r.retry.Stop()
	r.retryArmed = false
}

// rejoin tries once to join the room again with the latest token, picking up where it was.
func (r *room) rejoin() {
	if r.conn != nil || (r.state != Playing && r.state != Paused) {
		return
	}
	err := r.connect()
	if err == nil {
		r.log.Info("joined LiveKit again", "tries", r.rejoinTries+1)
		return
	}
	if r.ctx.Err() != nil {
		return
	}
	r.rejoinTries++
	if !r.clock.Now().Before(r.rejoinUntil) {
		r.fail("could not join LiveKit again: " + err.Error())
		return
	}
	if r.rejoinTries == 1 {
		r.log.Warn("could not join LiveKit again, retrying", "err", err)
	}
	r.armRetry()
}

// fail gives up on the song: the room stays, silent, until the next PUT or DELETE.
func (r *room) fail(message string, logArgs ...any) {
	r.closeSource()
	r.state, r.message = Error, message
	r.applyMute()
	r.publish()
	r.log.Warn("gave up on the song", append([]any{"itemId", r.itemID, "message", message}, logArgs...)...)
	r.m.opts.Emit(Event{Type: "error", Room: r.name, ItemID: r.itemID, Message: message})
}
