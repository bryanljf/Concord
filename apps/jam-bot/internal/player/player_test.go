package player

import (
	"context"
	"errors"
	"testing"
	"time"
)

func at(d time.Duration) time.Time { return t0.Add(d) }

func TestPlayPacesAgainstAbsoluteClock(t *testing.T) {
	h := newHarness(t)
	st := h.play("sala", PlayRequest{ItemID: "a", Source: src(100)})
	if st.State != Playing || st.ItemID != "a" || st.Room != "sala" || st.PositionMs != 0 || st.DurationMs != 2000 {
		t.Fatalf("status %+v", st)
	}
	c := h.lk.conn(t, 0)
	if c.url != "ws://livekit.test" || c.token != "token-1" {
		t.Fatalf("connected to %q with %q", c.url, c.token)
	}
	checkSamples(t, c.waitSamples(t, 1), 0, 0, at(0)) // the first packet is due right away
	h.clock.Advance(20 * ms)
	checkSamples(t, c.waitSamples(t, 2), 1, 1, at(20*ms))
	// Late (the clock jumps 100 ms): the missed packets go out at once, each with its own time
	// on the schedule, not "now".
	h.clock.Advance(100 * ms)
	got := c.waitSamples(t, 7)
	checkSamples(t, got, 2, 2, at(40*ms), at(60*ms), at(80*ms), at(100*ms), at(120*ms))
	if st := h.sync("sala"); st.PositionMs != 140 || c.count() != 7 {
		t.Fatalf("position %d after %d packets", st.PositionMs, c.count())
	}
	if mutes := c.muteLog(); len(mutes) != 0 {
		t.Fatalf("mutes %v while playing", mutes)
	}
}

func TestPlayFromOffset(t *testing.T) {
	h := newHarness(t)
	st := h.play("sala", PlayRequest{ItemID: "a", Source: src(100), Offset: 105 * ms})
	if st.PositionMs != 120 {
		t.Fatalf("position %d, want the first packet after the offset (120)", st.PositionMs)
	}
	c := h.lk.conn(t, 0)
	checkSamples(t, c.waitSamples(t, 1), 0, 6, at(0))
	h.clock.Advance(20 * ms)
	checkSamples(t, c.waitSamples(t, 2), 1, 7, at(20*ms))
}

func TestPauseAndResume(t *testing.T) {
	h := newHarness(t)
	h.play("sala", PlayRequest{ItemID: "a", Source: src(100)})
	c := h.lk.conn(t, 0)
	h.clock.Advance(40 * ms)
	c.waitSamples(t, 3)

	st, err := h.m.Pause(context.Background(), "sala")
	if err != nil || st.State != Paused || st.PositionMs != 60 {
		t.Fatalf("Pause: %+v, %v", st, err)
	}
	if mutes := c.muteLog(); len(mutes) != 1 || !mutes[0] {
		t.Fatalf("mutes %v, want [true]", mutes)
	}
	h.clock.Advance(5 * time.Second)
	if st := h.sync("sala"); c.count() != 3 || st.PositionMs != 60 {
		t.Fatalf("%d packets sent while paused, position %d", c.count(), st.PositionMs)
	}
	if st, err := h.m.Pause(context.Background(), "sala"); err != nil || st.State != Paused {
		t.Fatalf("Pause again: %+v, %v", st, err)
	}

	st, err = h.m.Resume(context.Background(), "sala")
	if err != nil || st.State != Playing || st.PositionMs != 60 {
		t.Fatalf("Resume: %+v, %v", st, err)
	}
	if mutes := c.muteLog(); len(mutes) != 2 || mutes[1] {
		t.Fatalf("mutes %v, want [true false]", mutes)
	}
	// From the same packet, once the unmute reached the SFU, and no burst to catch up.
	resumed := 5*time.Second + 40*ms
	h.clock.Advance(unmute - ms)
	if st := h.sync("sala"); c.count() != 3 || st.State != Playing || st.PositionMs != 60 {
		t.Fatalf("%d packets before the unmute delay, status %+v", c.count(), st)
	}
	h.clock.Advance(ms)
	checkSamples(t, c.waitSamples(t, 4), 3, 3, at(resumed+unmute))
	if h.sync("sala"); c.count() != 4 {
		t.Fatalf("%d packets right after resuming, want 4", c.count())
	}
	h.clock.Advance(20 * ms)
	checkSamples(t, c.waitSamples(t, 5), 4, 4, at(resumed+unmute+20*ms))
	if st, err := h.m.Resume(context.Background(), "sala"); err != nil || st.State != Playing {
		t.Fatalf("Resume again: %+v, %v", st, err)
	}
}

func TestPlayPaused(t *testing.T) {
	h := newHarness(t)
	st := h.play("sala", PlayRequest{ItemID: "a", Source: src(100), Offset: time.Second, Paused: true})
	if st.State != Paused || st.PositionMs != 1000 {
		t.Fatalf("status %+v", st)
	}
	c := h.lk.conn(t, 0)
	h.clock.Advance(time.Second)
	if h.sync("sala"); c.count() != 0 {
		t.Fatalf("%d packets sent while paused", c.count())
	}
	if mutes := c.muteLog(); len(mutes) != 1 || !mutes[0] {
		t.Fatalf("mutes %v", mutes)
	}
	if _, err := h.m.Resume(context.Background(), "sala"); err != nil {
		t.Fatal(err)
	}
	h.clock.Advance(unmute)
	checkSamples(t, c.waitSamples(t, 1), 0, 50, at(time.Second+unmute))
}

func TestReplaceSongKeepsConnection(t *testing.T) {
	h := newHarness(t)
	h.play("sala", PlayRequest{ItemID: "a", Source: src(100)})
	c := h.lk.conn(t, 0)
	h.clock.Advance(50 * ms) // packets 0..2 (the last one ends at 60 ms)
	c.waitSamples(t, 3)
	st := h.play("sala", PlayRequest{ItemID: "b", Source: src(10), Token: "token-2", Offset: 20 * ms})
	if st.ItemID != "b" || st.State != Playing || st.PositionMs != 20 || st.DurationMs != 200 {
		t.Fatalf("status %+v", st)
	}
	if calls, _ := h.lk.count(); calls != 1 || c.isClosed() {
		t.Fatalf("%d connections, closed %v: want the same one", calls, c.isClosed())
	}
	// The new song starts when the old one's last packet ends: no overlap, timestamps forward.
	if h.sync("sala"); c.count() != 3 {
		t.Fatalf("%d packets before the old last one ended", c.count())
	}
	h.clock.Advance(10 * ms)
	checkSamples(t, c.waitSamples(t, 4), 3, 1, at(60*ms))
}

func TestEndedThenNextSongIsGapless(t *testing.T) {
	h := newHarness(t)
	h.play("sala", PlayRequest{ItemID: "a", Source: src(5)})
	c := h.lk.conn(t, 0)
	h.clock.Advance(80 * ms)
	c.waitSamples(t, 5)
	if e := h.event(); e != (Event{Type: "ended", Room: "sala", ItemID: "a"}) {
		t.Fatalf("event %+v", e)
	}
	st := h.sync("sala")
	if st.State != Ended || st.PositionMs != 100 || st.DurationMs != 100 {
		t.Fatalf("status %+v", st)
	}
	if c.isClosed() {
		t.Fatal("left the room after the song ended")
	}
	if _, err := h.m.Pause(context.Background(), "sala"); !errors.Is(err, ErrNotPlaying) {
		t.Fatalf("Pause after the end: %v", err)
	}
	if _, err := h.m.Resume(context.Background(), "sala"); !errors.Is(err, ErrNotPlaying) {
		t.Fatalf("Resume after the end: %v", err)
	}
	if rooms := h.m.List(); len(rooms) != 1 || rooms[0].State != Ended {
		t.Fatalf("rooms %+v", rooms)
	}
	// The next PUT arrives before the last packet finished playing: it continues the schedule.
	h.play("sala", PlayRequest{ItemID: "b", Source: src(5)})
	h.clock.Advance(20 * ms)
	checkSamples(t, c.waitSamples(t, 6), 5, 0, at(100*ms))
	h.noEvent()
}

func TestOffsetPastTheEnd(t *testing.T) {
	h := newHarness(t)
	st := h.play("sala", PlayRequest{ItemID: "a", Source: src(5), Offset: time.Minute})
	if st.State != Ended || st.PositionMs != 100 {
		t.Fatalf("status %+v", st)
	}
	h.sync("sala")
	h.noEvent() // the answer said it; no event on top
}

func TestLinkDownAndUpResumesWhereItWas(t *testing.T) {
	h := newHarness(t)
	h.play("sala", PlayRequest{ItemID: "a", Source: src(100)})
	c := h.lk.conn(t, 0)
	h.clock.Advance(40 * ms)
	c.waitSamples(t, 3)
	c.link.Down()
	h.sync("sala")
	h.clock.Advance(3 * time.Second)
	if st := h.sync("sala"); c.count() != 3 || st.State != Playing || st.PositionMs != 60 {
		t.Fatalf("%d packets while reconnecting, status %+v", c.count(), st)
	}
	c.link.Up()
	h.sync("sala")
	checkSamples(t, c.waitSamples(t, 4), 3, 3, at(3*time.Second+40*ms))
	if calls, _ := h.lk.count(); calls != 1 {
		t.Fatalf("%d connections", calls)
	}
}

func TestRejoinsAfterDisconnect(t *testing.T) {
	h := newHarness(t)
	h.play("sala", PlayRequest{ItemID: "a", Source: src(100)})
	c := h.lk.conn(t, 0)
	c.waitSamples(t, 1) // packet 0, which ends at 20 ms
	// Same connection, new token (kept for the rejoin); packet 2 is due at 20 ms.
	h.play("sala", PlayRequest{ItemID: "a", Source: src(100), Token: "token-2", Offset: 40 * ms})
	c.link.Disconnected("SIGNAL_CLOSE", true)
	if st := h.sync("sala"); st.State != Playing || st.PositionMs != 40 || !c.isClosed() {
		t.Fatalf("status %+v, closed %v", st, c.isClosed())
	}
	c.link.Up() // events of a closed connection are ignored
	h.lk.failNext(1)
	h.clock.Advance(time.Second) // the first try fails
	h.lk.waitCalls(t, 2)
	h.sync("sala")
	if _, conns := h.lk.count(); conns != 1 {
		t.Fatalf("%d connections", conns)
	}
	h.clock.Advance(time.Second) // the second works
	h.lk.waitCalls(t, 3)
	h.sync("sala")
	c2 := h.lk.conn(t, 1)
	if c2.token != "token-2" {
		t.Fatalf("joined again with %q, want the latest token", c2.token)
	}
	checkSamples(t, c2.waitSamples(t, 1), 0, 2, at(2*time.Second))
	if c.count() != 1 {
		t.Fatalf("%d packets on the lost connection", c.count())
	}
	h.noEvent()
}

func TestRejoinKeepsPause(t *testing.T) {
	h := newHarness(t)
	h.play("sala", PlayRequest{ItemID: "a", Source: src(100), Paused: true})
	c := h.lk.conn(t, 0)
	c.link.Disconnected("SERVER_SHUTDOWN", true)
	h.sync("sala")
	h.clock.Advance(time.Second)
	h.lk.waitCalls(t, 2)
	h.sync("sala")
	c2 := h.lk.conn(t, 1)
	if mutes := c2.muteLog(); len(mutes) != 1 || !mutes[0] {
		t.Fatalf("mutes %v on the new connection", mutes)
	}
	if st := h.sync("sala"); st.State != Paused || c2.count() != 0 {
		t.Fatalf("status %+v, %d packets", st, c2.count())
	}
}

func TestRejoinGivesUp(t *testing.T) {
	h := newHarness(t)
	h.play("sala", PlayRequest{ItemID: "a", Source: src(100)})
	c := h.lk.conn(t, 0)
	c.link.Disconnected("SIGNAL_CLOSE", true) // gives up 10 s from now, trying every second
	h.sync("sala")
	h.lk.failNext(100)
	for i := 1; i <= 10; i++ {
		h.clock.Advance(time.Second)
		h.lk.waitCalls(t, 1+i)
		h.sync("sala")
		if i < 10 {
			h.noEvent()
		}
	}
	e := h.event()
	if e.Type != "error" || e.Room != "sala" || e.ItemID != "a" || e.Message == "" {
		t.Fatalf("event %+v", e)
	}
	st := h.sync("sala")
	if st.State != Error || st.Message != e.Message {
		t.Fatalf("status %+v", st)
	}
	if _, err := h.m.Pause(context.Background(), "sala"); !errors.Is(err, ErrNotPlaying) {
		t.Fatalf("Pause after giving up: %v", err)
	}
	// Stays listed until the api moves on; the next PUT joins again.
	h.lk.failNext(0)
	if st := h.play("sala", PlayRequest{ItemID: "b", Source: src(10)}); st.State != Playing || st.Message != "" {
		t.Fatalf("status %+v", st)
	}
}

func TestRemovedFromRoomFails(t *testing.T) {
	h := newHarness(t)
	h.play("sala", PlayRequest{ItemID: "a", Source: src(100)})
	h.lk.conn(t, 0).link.Disconnected("PARTICIPANT_REMOVED", false)
	if e := h.event(); e.Type != "error" || e.ItemID != "a" {
		t.Fatalf("event %+v", e)
	}
	h.clock.Advance(time.Minute)
	h.sync("sala")
	if calls, _ := h.lk.count(); calls != 1 {
		t.Fatalf("%d connections: it must not join again by itself", calls)
	}
}

func TestDisconnectWhileSilentWaitsForNextPut(t *testing.T) {
	h := newHarness(t)
	h.play("sala", PlayRequest{ItemID: "a", Source: src(1)})
	h.lk.conn(t, 0).waitSamples(t, 1)
	h.event() // ended
	h.lk.conn(t, 0).link.Disconnected("SIGNAL_CLOSE", true)
	h.clock.Advance(time.Minute)
	if st := h.sync("sala"); st.State != Ended {
		t.Fatalf("status %+v", st)
	}
	h.noEvent()
	if calls, _ := h.lk.count(); calls != 1 {
		t.Fatalf("%d connections", calls)
	}
	h.play("sala", PlayRequest{ItemID: "b", Source: src(10)})
	if calls, _ := h.lk.count(); calls != 2 {
		t.Fatalf("%d connections, want a new one for the PUT", calls)
	}
}

func TestJoinFailureLeavesTheRoom(t *testing.T) {
	h := newHarness(t)
	h.lk.failNext(1)
	_, err := h.m.Play(context.Background(), "sala", PlayRequest{URL: "ws://x", Token: "t", ItemID: "a", Source: src(5)})
	var lkErr *LiveKitError
	if !errors.As(err, &lkErr) || !errors.Is(err, errRefused) {
		t.Fatalf("Play: %v", err)
	}
	if rooms := h.m.List(); len(rooms) != 0 {
		t.Fatalf("rooms %+v", rooms)
	}
	if _, err := h.m.Pause(context.Background(), "sala"); !errors.Is(err, ErrNotPlaying) {
		t.Fatalf("Pause: %v", err)
	}
	if st := h.play("sala", PlayRequest{ItemID: "a", Source: src(5)}); st.State != Playing {
		t.Fatalf("status %+v", st)
	}
}

func TestNewURLJoinsAgain(t *testing.T) {
	h := newHarness(t)
	h.play("sala", PlayRequest{ItemID: "a", Source: src(100)})
	c := h.lk.conn(t, 0)
	h.play("sala", PlayRequest{ItemID: "a", Source: src(100), URL: "wss://other.test"})
	if !c.isClosed() {
		t.Fatal("old connection kept")
	}
	if c2 := h.lk.conn(t, 1); c2.url != "wss://other.test" {
		t.Fatalf("url %q", c2.url)
	}
	c.link.Disconnected("SIGNAL_CLOSE", true) // stale: ignored
	if st := h.sync("sala"); st.State != Playing {
		t.Fatalf("status %+v", st)
	}
	if calls, _ := h.lk.count(); calls != 2 {
		t.Fatalf("%d connections", calls)
	}
}

func TestLeave(t *testing.T) {
	h := newHarness(t)
	h.play("sala", PlayRequest{ItemID: "a", Source: src(100)})
	h.play("outra", PlayRequest{ItemID: "b", Source: src(100), Paused: true})
	if rooms := h.m.List(); len(rooms) != 2 || rooms[0].Room != "outra" || rooms[1].Room != "sala" {
		t.Fatalf("rooms %+v", rooms)
	}
	c := h.lk.conn(t, 0)
	h.m.Leave(context.Background(), "sala")
	if !c.isClosed() {
		t.Fatal("connection not closed")
	}
	h.m.Leave(context.Background(), "sala") // idempotent
	h.m.Leave(context.Background(), "nunca")
	if rooms := h.m.List(); len(rooms) != 1 || rooms[0].Room != "outra" {
		t.Fatalf("rooms %+v", rooms)
	}
	if _, err := h.m.Resume(context.Background(), "sala"); !errors.Is(err, ErrNotPlaying) {
		t.Fatalf("Resume: %v", err)
	}
	if st := h.play("sala", PlayRequest{ItemID: "c", Source: src(10)}); st.ItemID != "c" {
		t.Fatalf("status %+v", st)
	}
}

func TestClose(t *testing.T) {
	h := newHarness(t)
	h.play("sala", PlayRequest{ItemID: "a", Source: src(100)})
	h.play("outra", PlayRequest{ItemID: "b", Source: src(100)})
	h.m.Close(context.Background())
	if !h.lk.conn(t, 0).isClosed() || !h.lk.conn(t, 1).isClosed() {
		t.Fatal("rooms not left")
	}
	if _, err := h.m.Play(context.Background(), "sala", PlayRequest{Source: src(1)}); !errors.Is(err, ErrClosed) {
		t.Fatalf("Play after Close: %v", err)
	}
	if rooms := h.m.List(); len(rooms) != 0 {
		t.Fatalf("rooms %+v", rooms)
	}
}

func TestRejoinBackoff(t *testing.T) {
	want := []time.Duration{500 * ms, time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second,
		15 * time.Second, 15 * time.Second, 15 * time.Second}
	for i, w := range want {
		if got := rejoinBackoff(i); got != w {
			t.Errorf("rejoinBackoff(%d) = %v, want %v", i, got, w)
		}
	}
}
