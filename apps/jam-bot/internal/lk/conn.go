// Package lk connects the players to LiveKit with the server SDK: one participant per room
// publishing one stereo Opus track, fed with the file's original packets.
package lk

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/bryanljf/Concord/apps/jam-bot/internal/player"
)

// TrackName is the jam track's name (API.md).
const TrackName = "concord:music:jam"

// bindTimeout bounds the wait for the track to be negotiated after publishing (or after the SDK
// republished it on a full reconnection): packets written before that are silently dropped.
const bindTimeout = 10 * time.Second

// Opus passthrough, stereo. The fmtp is what this side claims; what makes the server keep both
// channels is TrackPublicationOptions.Stereo (AddTrackRequest.stereo, TF_STEREO).
var opusStereo = webrtc.RTPCodecCapability{
	MimeType:    webrtc.MimeTypeOpus,
	ClockRate:   48000,
	Channels:    2,
	SDPFmtpLine: "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1",
}

// Connector joins rooms with the LiveKit server SDK.
type Connector struct {
	Log *slog.Logger
}

var _ player.Connector = (*Connector)(nil)

// conn is one joined room with the jam track published.
type conn struct {
	log   *slog.Logger
	link  player.Link
	room  *lksdk.Room
	track *lksdk.LocalTrack
	bound chan struct{} // signalled on every bind
	leave sync.Once

	mu     sync.Mutex
	pub    *lksdk.LocalTrackPublication // replaced when the SDK republishes
	muted  bool
	closed bool
}

// Connect joins the room the token is for (identity and name come from the token), publishes
// the track and waits until it is bound.
func (c *Connector) Connect(ctx context.Context, url, token string, link player.Link) (player.Conn, error) {
	rememberHost(url)
	log := c.Log
	if log == nil {
		log = slog.Default()
	}
	cn := &conn{log: log, link: link, bound: make(chan struct{}, 1)}

	cb := lksdk.NewRoomCallback()
	cb.OnReconnecting = cn.onReconnecting
	cb.OnReconnected = cn.onReconnected
	cb.OnDisconnectedWithReason = func(lksdk.DisconnectionReason) { cn.onDisconnected() }
	cb.OnLocalTrackPublished = cn.onPublished
	cn.room = lksdk.NewRoom(cb)

	track, err := lksdk.NewLocalTrack(opusStereo)
	if err != nil {
		return nil, redactErr("creating the track", err)
	}
	track.OnBind(func() {
		select {
		case cn.bound <- struct{}{}:
		default:
		}
	})
	cn.track = track

	if err := cn.room.JoinWithContextAndToken(ctx, url, token,
		lksdk.WithAutoSubscribe(false), lksdk.WithDisableRegionDiscovery()); err != nil {
		cn.Close()
		return nil, redactErr("joining", err)
	}
	pub, err := cn.room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{
		Name:       TrackName,
		Source:     livekit.TrackSource_MICROPHONE,
		DisableDTX: true,
		Stereo:     true,
	})
	if err != nil {
		cn.Close()
		return nil, redactErr("publishing", err)
	}
	cn.mu.Lock()
	cn.pub = pub
	cn.mu.Unlock()
	if !cn.waitBound(ctx) {
		cn.Close()
		if err := ctx.Err(); err != nil {
			return nil, redactErr("waiting for the track", err)
		}
		return nil, errors.New("the track was not negotiated in time")
	}
	return cn, nil
}

// waitBound waits until the track is bound to the publisher connection.
func (c *conn) waitBound(ctx context.Context) bool {
	timer := time.NewTimer(bindTimeout)
	defer timer.Stop()
	for !c.track.IsBound() {
		select {
		case <-c.bound:
		case <-timer.C:
			return c.track.IsBound()
		case <-ctx.Done():
			return false
		}
	}
	return true
}

func (c *conn) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

func (c *conn) onReconnecting() {
	if !c.isClosed() {
		c.link.Down()
	}
}

func (c *conn) onReconnected() {
	// After a full reconnection the SDK republishes the track: wait for the new binding first.
	go func() {
		ok := c.waitBound(context.Background())
		if c.isClosed() {
			return
		}
		if !ok {
			c.disconnect("track not negotiated after reconnecting", true)
			c.leave.Do(c.room.Disconnect)
			return
		}
		c.link.Up()
	}()
}

func (c *conn) onDisconnected() {
	reason := c.room.DisconnectReason()
	c.disconnect(reason.String(), rejoinable(reason))
}

func (c *conn) disconnect(reason string, retry bool) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	c.mu.Unlock()
	c.link.Disconnected(reason, retry)
}

// rejoinable tells the reasons worth joining again for (the server went away or the connection
// failed) from the deliberate ones (removed, replaced by another bot, room gone).
func rejoinable(reason livekit.DisconnectReason) bool {
	switch reason {
	case livekit.DisconnectReason_CLIENT_INITIATED,
		livekit.DisconnectReason_DUPLICATE_IDENTITY,
		livekit.DisconnectReason_PARTICIPANT_REMOVED,
		livekit.DisconnectReason_ROOM_DELETED,
		livekit.DisconnectReason_ROOM_CLOSED,
		livekit.DisconnectReason_USER_UNAVAILABLE,
		livekit.DisconnectReason_USER_REJECTED,
		livekit.DisconnectReason_SIP_TRUNK_FAILURE:
		return false
	}
	return true
}

// onPublished follows the publication (the SDK makes a new one when it republishes after a full
// reconnection, unmuted) and keeps it muted while paused.
func (c *conn) onPublished(pub *lksdk.LocalTrackPublication, _ *lksdk.LocalParticipant) {
	if pub.Name() != TrackName {
		return
	}
	c.mu.Lock()
	c.pub = pub
	muted := c.muted
	c.mu.Unlock()
	if muted {
		pub.SetMuted(true)
	}
}

func (c *conn) WriteSample(data []byte, dur time.Duration, at time.Time) error {
	return c.track.WriteSample(media.Sample{Data: data, Duration: dur, Timestamp: at}, nil)
}

func (c *conn) SetMuted(muted bool) {
	c.mu.Lock()
	c.muted = muted
	pub := c.pub
	c.mu.Unlock()
	if pub != nil {
		pub.SetMuted(muted)
	}
}

// Close unpublishes the track and leaves the room.
func (c *conn) Close() {
	c.mu.Lock()
	c.closed = true
	pub := c.pub
	c.pub = nil
	c.mu.Unlock()
	c.leave.Do(func() {
		if pub != nil && c.room.ConnectionState() == lksdk.ConnectionStateConnected {
			if err := c.room.LocalParticipant.UnpublishTrack(pub.SID()); err != nil {
				c.log.Debug("could not unpublish the track", "err", Redact(err.Error()))
			}
		}
		c.room.Disconnect()
	})
}
