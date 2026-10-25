package server

import (
	"encoding/json"
	"sync"

	"github.com/bryanljf/Concord/apps/jam-bot/internal/player"
)

// subscriberBuffer is how many events a stream may lag behind before it is dropped (the api
// reconnects and reconciles with GET /v1/rooms).
const subscriberBuffer = 64

// Hub fans the players' events out to the event streams. Publish never blocks.
type Hub struct {
	mu     sync.Mutex
	subs   map[*Subscription]struct{}
	closed bool
}

// Subscription is one event stream: C yields each event's JSON and is closed when the stream is
// dropped (too slow) or the hub closes.
type Subscription struct {
	C   <-chan []byte
	c   chan []byte
	hub *Hub
}

func NewHub() *Hub { return &Hub{subs: map[*Subscription]struct{}{}} }

// Subscribe opens a stream; nil once the hub is closed.
func (h *Hub) Subscribe() *Subscription {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil
	}
	c := make(chan []byte, subscriberBuffer)
	s := &Subscription{C: c, c: c, hub: h}
	h.subs[s] = struct{}{}
	return s
}

// Close ends the subscription (idempotent).
func (s *Subscription) Close() {
	s.hub.mu.Lock()
	defer s.hub.mu.Unlock()
	s.hub.dropLocked(s)
}

func (h *Hub) dropLocked(s *Subscription) {
	if _, ok := h.subs[s]; ok {
		delete(h.subs, s)
		close(s.c)
	}
}

// Publish sends the event to every stream; a stream whose buffer is full is dropped.
func (h *Hub) Publish(ev player.Event) {
	data, err := json.Marshal(ev)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for s := range h.subs {
		select {
		case s.c <- data:
		default:
			h.dropLocked(s)
		}
	}
}

// Close ends every stream and refuses new ones.
func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	for s := range h.subs {
		h.dropLocked(s)
	}
}

// Len is the number of open streams.
func (h *Hub) Len() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
}
