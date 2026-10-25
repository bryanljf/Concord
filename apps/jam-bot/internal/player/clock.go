package player

import "time"

// Clock is the time source of the players (a fake one in tests).
type Clock interface {
	Now() time.Time
	NewTimer(d time.Duration) Timer
}

// Timer is a resettable one-shot timer. Reset, ResetAt and Stop discard a pending fire (Go 1.23+
// timer semantics): after any of them, C never yields a value from before the call.
type Timer interface {
	C() <-chan time.Time
	Reset(d time.Duration)
	// ResetAt makes the timer fire when the clock reaches t (at once when it already has).
	ResetAt(t time.Time)
	Stop()
}

// RealClock is the system clock.
type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now() }

func (RealClock) NewTimer(d time.Duration) Timer { return realTimer{time.NewTimer(d)} }

type realTimer struct{ t *time.Timer }

func (r realTimer) C() <-chan time.Time   { return r.t.C }
func (r realTimer) Reset(d time.Duration) { r.t.Reset(d) }
func (r realTimer) ResetAt(t time.Time)   { r.t.Reset(time.Until(t)) }
func (r realTimer) Stop()                 { r.t.Stop() }
