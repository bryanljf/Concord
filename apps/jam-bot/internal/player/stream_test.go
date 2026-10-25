package player

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/bryanljf/Concord/apps/jam-bot/internal/webmopus"
)

// ---------------------------------------------------------------- files still growing

func TestWaitsForGrowthWithoutBurst(t *testing.T) {
	h := newHarness(t)
	s := growing(5)
	st := h.play("sala", PlayRequest{ItemID: "a", Source: s})
	if st.State != Playing || st.PositionMs != 0 || st.DurationMs != 100 {
		t.Fatalf("status %+v", st)
	}
	c := h.lk.conn(t, 0)
	h.clock.Advance(80 * ms)
	checkSamples(t, c.waitSamples(t, 5), 0, 0, at(0), at(20*ms), at(40*ms), at(60*ms), at(80*ms))
	// Packet 5 is not written yet: nothing is sent, the position stays, no event.
	h.clock.Advance(time.Second)
	if st := h.sync("sala"); c.count() != 5 || st.State != Playing || st.PositionMs != 100 || st.DurationMs != 100 {
		t.Fatalf("%d packets while waiting, status %+v", c.count(), st)
	}
	h.noEvent()
	// It arrives 980 ms late: it goes out now, and the rest follows in real time from there.
	s.grow(5)
	checkSamples(t, c.waitSamples(t, 6), 5, 5, at(1080*ms))
	if st := h.sync("sala"); c.count() != 6 || st.DurationMs != 200 {
		t.Fatalf("%d packets right after the growth (want no burst), status %+v", c.count(), st)
	}
	h.clock.Advance(20 * ms)
	checkSamples(t, c.waitSamples(t, 7), 6, 6, at(1100*ms))
	h.clock.Advance(40 * ms)
	checkSamples(t, c.waitSamples(t, 9), 7, 7, at(1120*ms), at(1140*ms))
	h.noEvent()
}

func TestGrowthInTimeKeepsTheSchedule(t *testing.T) {
	h := newHarness(t)
	s := growing(3)
	h.play("sala", PlayRequest{ItemID: "a", Source: s})
	c := h.lk.conn(t, 0)
	h.clock.Advance(40 * ms)
	c.waitSamples(t, 3) // 0..2, the last one ends at 60 ms
	h.sync("sala")
	// The next packet arrives before its time; it starts 10 ms after the previous one ends
	// (a gap in the file), which a new schedule would lose.
	s.add(webmopus.Packet{TS: 70 * ms, Dur: 20 * ms, Data: []byte{3}})
	h.waitFetches(1)
	h.clock.Advance(20 * ms)
	if h.sync("sala"); c.count() != 3 {
		t.Fatalf("%d packets: sent before its time", c.count())
	}
	h.clock.Advance(10 * ms)
	checkSamples(t, c.waitSamples(t, 4), 3, 3, at(70*ms))
}

func TestGrowingFileEndsWhenComplete(t *testing.T) {
	h := newHarness(t)
	s := growing(3)
	h.play("sala", PlayRequest{ItemID: "a", Source: s})
	c := h.lk.conn(t, 0)
	h.clock.Advance(40 * ms)
	c.waitSamples(t, 3)
	h.sync("sala")
	h.noEvent()
	s.finish()
	if e := h.event(); e != (Event{Type: "ended", Room: "sala", ItemID: "a"}) {
		t.Fatalf("event %+v", e)
	}
	if st := h.sync("sala"); st.State != Ended || st.PositionMs != 60 || st.DurationMs != 60 {
		t.Fatalf("status %+v", st)
	}
	if n := s.closeCount(); n != 1 {
		t.Fatalf("source closed %d times after the end", n)
	}
	if c.isClosed() {
		t.Fatal("left the room after the song ended")
	}
}

func TestSourceErrorsFailTheSong(t *testing.T) {
	cases := []struct {
		err  error
		want string
	}{
		{webmopus.ErrFailed, "the upload failed"},
		{webmopus.ErrStalled, "the upload stalled"},
		{fmt.Errorf("%w: lacing out of range", webmopus.ErrInvalidAudio), "invalid audio"},
		{errors.New("read /var/lib/concord-jam/x.webm: i/o error"), "could not read the file"},
	}
	for _, tc := range cases {
		t.Run(tc.want, func(t *testing.T) {
			h := newHarness(t)
			s := growing(2)
			h.play("sala", PlayRequest{ItemID: "a", Source: s})
			c := h.lk.conn(t, 0)
			h.clock.Advance(20 * ms)
			c.waitSamples(t, 2)
			h.sync("sala")
			s.failWith(tc.err)
			e := h.event()
			if e != (Event{Type: "error", Room: "sala", ItemID: "a", Message: tc.want}) {
				t.Fatalf("event %+v", e)
			}
			st := h.sync("sala")
			if st.State != Error || st.Message != tc.want || st.PositionMs != 40 || st.DurationMs != 40 {
				t.Fatalf("status %+v", st)
			}
			if n := s.closeCount(); n != 1 {
				t.Fatalf("source closed %d times after the error", n)
			}
			if _, err := h.m.Resume(context.Background(), "sala"); !errors.Is(err, ErrNotPlaying) {
				t.Fatalf("Resume after the error: %v", err)
			}
			if c.isClosed() {
				t.Fatal("left the room after the error")
			}
		})
	}
}

func TestDurationFollowsTheGrowth(t *testing.T) {
	h := newHarness(t)
	s := growing(5)
	if st := h.play("sala", PlayRequest{ItemID: "a", Source: s, Paused: true}); st.DurationMs != 100 {
		t.Fatalf("status %+v", st)
	}
	s.grow(5)
	if st := h.sync("sala"); st.DurationMs != 200 || st.State != Paused {
		t.Fatalf("status %+v", st)
	}
	if rooms := h.m.List(); len(rooms) != 1 || rooms[0].DurationMs != 200 {
		t.Fatalf("rooms %+v", rooms)
	}
}

func TestOffsetNotWrittenYet(t *testing.T) {
	h := newHarness(t)
	s := growing(5) // 0..100 ms
	st := h.play("sala", PlayRequest{ItemID: "a", Source: s, Offset: 150 * ms})
	if st.State != Playing || st.PositionMs != 150 || st.DurationMs != 100 {
		t.Fatalf("status %+v", st)
	}
	c := h.lk.conn(t, 0)
	h.clock.Advance(time.Second)
	if h.sync("sala"); c.count() != 0 {
		t.Fatalf("%d packets before the offset was written", c.count())
	}
	s.grow(5) // up to 200 ms: the offset falls in packet 8 (160 ms)
	checkSamples(t, c.waitSamples(t, 1), 0, 8, at(time.Second))
	h.clock.Advance(20 * ms)
	checkSamples(t, c.waitSamples(t, 2), 1, 9, at(time.Second+20*ms))
	h.noEvent()
}

func TestOffsetPastTheEndOfAGrowingFile(t *testing.T) {
	h := newHarness(t)
	s := growing(5)
	if st := h.play("sala", PlayRequest{ItemID: "a", Source: s, Offset: time.Minute}); st.State != Playing {
		t.Fatalf("status %+v", st)
	}
	s.finish() // shorter than the offset: the answer said playing, so the event says it ended
	if e := h.event(); e.Type != "ended" || e.ItemID != "a" {
		t.Fatalf("event %+v", e)
	}
	if st := h.sync("sala"); st.State != Ended || st.PositionMs != 100 {
		t.Fatalf("status %+v", st)
	}
	if c := h.lk.conn(t, 0); c.count() != 0 {
		t.Fatalf("%d packets", c.count())
	}
}

// ---------------------------------------------------------------- unmute delay

// The SDK sends media while muted and the unmute goes over the signalling WebSocket: packets
// sent right after it are dropped by the SFU. They wait UnmuteDelay.
func TestPlayAfterPauseWaitsForTheUnmute(t *testing.T) {
	h := newHarness(t)
	h.play("sala", PlayRequest{ItemID: "a", Source: src(100), Paused: true})
	c := h.lk.conn(t, 0)
	h.clock.Advance(time.Second)
	h.play("sala", PlayRequest{ItemID: "b", Source: src(100)})
	if mutes := c.muteLog(); len(mutes) != 2 || !mutes[0] || mutes[1] {
		t.Fatalf("mutes %v, want [true false]", mutes)
	}
	if h.sync("sala"); c.count() != 0 {
		t.Fatalf("%d packets sent with the unmute", c.count())
	}
	h.clock.Advance(unmute)
	checkSamples(t, c.waitSamples(t, 1), 0, 0, at(time.Second+unmute))
}

func TestNoUnmuteDelayOnANewConnection(t *testing.T) {
	h := newHarness(t)
	h.play("sala", PlayRequest{ItemID: "a", Source: src(100)})
	c := h.lk.conn(t, 0)
	c.waitSamples(t, 1)
	c.link.Disconnected("SIGNAL_CLOSE", true)
	h.sync("sala")
	h.clock.Advance(time.Second)
	h.lk.waitCalls(t, 2)
	h.sync("sala")
	c2 := h.lk.conn(t, 1)
	checkSamples(t, c2.waitSamples(t, 1), 0, 1, at(time.Second))
	if mutes := c2.muteLog(); len(mutes) != 0 {
		t.Fatalf("mutes %v", mutes)
	}
}

func TestDefaultUnmuteDelay(t *testing.T) {
	cases := map[time.Duration]time.Duration{0: 80 * ms, -1: 0, 30 * ms: 30 * ms}
	for in, want := range cases {
		m := NewManager(Options{Connector: &fakeConnector{}, Timeouts: Timeouts{UnmuteDelay: in}})
		if got := m.opts.Timeouts.UnmuteDelay; got != want {
			t.Errorf("UnmuteDelay %v: %v, want %v", in, got, want)
		}
	}
}

// ---------------------------------------------------------------- connect

func (h *harness) connect(room, token string) Status {
	h.t.Helper()
	st, err := h.m.Connect(context.Background(), room, "ws://livekit.test", token)
	if err != nil {
		h.t.Fatalf("Connect: %v", err)
	}
	return st
}

func TestConnectIdleThenPlay(t *testing.T) {
	h := newHarness(t)
	st := h.connect("sala", "token-1")
	if st != (Status{Room: "sala", State: Idle}) {
		t.Fatalf("status %+v", st)
	}
	c := h.lk.conn(t, 0)
	if c.url != "ws://livekit.test" || c.token != "token-1" {
		t.Fatalf("connected to %q with %q", c.url, c.token)
	}
	if rooms := h.m.List(); len(rooms) != 1 || rooms[0] != st {
		t.Fatalf("rooms %+v", rooms)
	}
	if _, err := h.m.Pause(context.Background(), "sala"); !errors.Is(err, ErrNotPlaying) {
		t.Fatalf("Pause while idle: %v", err)
	}
	if _, err := h.m.Resume(context.Background(), "sala"); !errors.Is(err, ErrNotPlaying) {
		t.Fatalf("Resume while idle: %v", err)
	}
	h.clock.Advance(time.Second)
	if h.sync("sala"); c.count() != 0 || len(c.muteLog()) != 0 {
		t.Fatalf("%d packets, mutes %v while idle", c.count(), c.muteLog())
	}
	// The PUT plays on the connection already there, right away.
	st = h.play("sala", PlayRequest{ItemID: "a", Source: src(10)})
	if st.State != Playing || st.ItemID != "a" {
		t.Fatalf("status %+v", st)
	}
	if calls, _ := h.lk.count(); calls != 1 {
		t.Fatalf("%d connections", calls)
	}
	checkSamples(t, c.waitSamples(t, 1), 0, 0, at(time.Second))
}

func TestConnectIsIdempotent(t *testing.T) {
	h := newHarness(t)
	h.connect("sala", "token-1")
	if st := h.connect("sala", "token-2"); st.State != Idle {
		t.Fatalf("status %+v", st)
	}
	h.play("sala", PlayRequest{ItemID: "a", Source: src(100)})
	c := h.lk.conn(t, 0)
	c.waitSamples(t, 1)
	if st := h.connect("sala", "token-3"); st.State != Playing || st.ItemID != "a" {
		t.Fatalf("Connect while playing: %+v", st)
	}
	if calls, _ := h.lk.count(); calls != 1 {
		t.Fatalf("%d connections", calls)
	}
	// Joining again on its own after a disconnection: a Connect meanwhile only brings a token.
	c.link.Disconnected("SIGNAL_CLOSE", true)
	h.sync("sala")
	if st := h.connect("sala", "token-4"); st.State != Playing {
		t.Fatalf("Connect while rejoining: %+v", st)
	}
	if calls, _ := h.lk.count(); calls != 1 {
		t.Fatalf("%d connections: Connect joined instead of the rejoin", calls)
	}
	h.clock.Advance(time.Second)
	h.lk.waitCalls(t, 2)
	h.sync("sala")
	if c2 := h.lk.conn(t, 1); c2.token != "token-4" {
		t.Fatalf("joined again with %q, want the latest token", c2.token)
	}
}

func TestConnectJoinsAgainWhenSilentAndGone(t *testing.T) {
	h := newHarness(t)
	h.connect("sala", "token-1")
	c := h.lk.conn(t, 0)
	c.link.Disconnected("SIGNAL_CLOSE", true) // idle: no rejoin by itself
	h.clock.Advance(time.Minute)
	if st := h.sync("sala"); st.State != Idle || !c.isClosed() {
		t.Fatalf("status %+v, closed %v", st, c.isClosed())
	}
	if calls, _ := h.lk.count(); calls != 1 {
		t.Fatalf("%d connections", calls)
	}
	h.connect("sala", "token-2")
	if c2 := h.lk.conn(t, 1); c2.token != "token-2" {
		t.Fatalf("token %q", c2.token)
	}
	// Another URL: joins there.
	h.m.Connect(context.Background(), "sala", "wss://other.test", "token-3")
	if c3 := h.lk.conn(t, 2); c3.url != "wss://other.test" || !h.lk.conn(t, 1).isClosed() {
		t.Fatalf("url %q", c3.url)
	}
}

func TestConnectFailureLeavesTheRoom(t *testing.T) {
	h := newHarness(t)
	h.lk.failNext(1)
	_, err := h.m.Connect(context.Background(), "sala", "ws://x", "t")
	var lkErr *LiveKitError
	if !errors.As(err, &lkErr) || !errors.Is(err, errRefused) {
		t.Fatalf("Connect: %v", err)
	}
	if rooms := h.m.List(); len(rooms) != 0 {
		t.Fatalf("rooms %+v", rooms)
	}
	if st := h.connect("sala", "token-1"); st.State != Idle {
		t.Fatalf("status %+v", st)
	}
	h.m.Close(context.Background())
	if _, err := h.m.Connect(context.Background(), "sala", "ws://x", "t"); !errors.Is(err, ErrClosed) {
		t.Fatalf("Connect after Close: %v", err)
	}
}

// ---------------------------------------------------------------- sources are the rooms'

func TestRoomClosesItsSources(t *testing.T) {
	h := newHarness(t)
	a := src(100)
	h.play("sala", PlayRequest{ItemID: "a", Source: a})
	h.lk.conn(t, 0).waitSamples(t, 1) // packet 0, which ends at 20 ms
	b := growing(1)
	h.play("sala", PlayRequest{ItemID: "b", Source: b})
	if a.closeCount() != 1 || b.closeCount() != 0 {
		t.Fatalf("closed: replaced %d, playing %d", a.closeCount(), b.closeCount())
	}
	// Replaced while waiting for it to grow: the wait ends quietly.
	c := h.lk.conn(t, 0)
	h.clock.Advance(100 * ms)
	c.waitSamples(t, 2)
	h.sync("sala")
	d := src(100)
	h.play("sala", PlayRequest{ItemID: "d", Source: d})
	if b.closeCount() != 1 {
		t.Fatalf("waited-on source closed %d times", b.closeCount())
	}
	h.noEvent()

	// Nothing after the offset: closed with the answer.
	e := src(5)
	if st := h.play("outra", PlayRequest{ItemID: "e", Source: e, Offset: time.Minute}); st.State != Ended {
		t.Fatalf("status %+v", st)
	}
	if e.closeCount() != 1 {
		t.Fatalf("closed %d times", e.closeCount())
	}

	// Leave.
	h.m.Leave(context.Background(), "sala")
	if d.closeCount() != 1 {
		t.Fatalf("closed %d times on Leave", d.closeCount())
	}

	// A failed join: the room never plays it.
	f := src(5)
	h.lk.failNext(1)
	if _, err := h.m.Play(context.Background(), "nova", PlayRequest{URL: "ws://x", Token: "t", Source: f}); err == nil {
		t.Fatal("Play worked")
	}
	if f.closeCount() != 1 {
		t.Fatalf("closed %d times after a failed join", f.closeCount())
	}

	// A context already over: closed at once when the room did not get it, else it plays it
	// (and Close below closes it).
	g := src(100)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := h.m.Play(ctx, "nova", PlayRequest{URL: "ws://x", Token: "t", Source: g}); !errors.Is(err, context.Canceled) {
		t.Fatalf("Play: %v", err)
	}
	if n := g.closeCount(); n == 0 {
		h.sync("nova") // the room may still be joining
		if rooms := h.m.List(); len(rooms) != 2 || rooms[0].Room != "nova" || rooms[0].State != Playing {
			t.Fatalf("canceled Play: source open, rooms %+v", rooms)
		}
	}

	// Close, and Play after Close.
	i := src(100)
	h.play("ultima", PlayRequest{ItemID: "i", Source: i})
	h.m.Close(context.Background())
	if i.closeCount() != 1 {
		t.Fatalf("closed %d times on Close", i.closeCount())
	}
	j := src(1)
	if _, err := h.m.Play(context.Background(), "sala", PlayRequest{Source: j}); !errors.Is(err, ErrClosed) {
		t.Fatalf("Play after Close: %v", err)
	}
	if j.closeCount() != 1 {
		t.Fatalf("closed %d times after Play refused", j.closeCount())
	}
	for name, s := range map[string]*fakeSource{"a": a, "b": b, "d": d, "e": e, "f": f, "g": g} {
		if n := s.closeCount(); n != 1 {
			t.Errorf("source %s closed %d times", name, n)
		}
	}
	if _, err := h.m.Play(context.Background(), "sala", PlayRequest{}); err == nil {
		t.Fatal("Play without a source worked")
	}
}

func TestLeaveIsLogged(t *testing.T) {
	h := newHarness(t)
	h.play("sala", PlayRequest{ItemID: "a", Source: src(100), Token: "secret-token"})
	h.play("outra", PlayRequest{ItemID: "b", Source: src(100), Token: "secret-token"})
	h.m.Leave(context.Background(), "sala")
	h.m.Close(context.Background())
	logs := h.logs.String()
	for _, want := range []string{
		`level=INFO msg="left the room" room=sala reason=delete`,
		`level=INFO msg="left the room" room=outra reason=shutdown`,
	} {
		if strings.Count(logs, want) != 1 {
			t.Fatalf("log lacks %q once:\n%s", want, logs)
		}
	}
	if strings.Contains(logs, "secret-token") || strings.Contains(logs, "livekit.test") {
		t.Fatalf("log leaks the token or the address:\n%s", logs)
	}
}
