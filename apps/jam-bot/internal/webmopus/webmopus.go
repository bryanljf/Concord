// Package webmopus demuxes the Opus track of a WebM (Matroska) file into its original packets,
// untouched (no decode, no re-encode), with their timestamps and durations. The parser streams:
// it reads element by element, so a file can be played while it is still being written (Open
// with a Growth), and Parse reads a whole stream with the same code.
package webmopus

import (
	"errors"
	"fmt"
	"io"
	"sort"
	"time"
)

const (
	// SampleRate is the only rate Opus packets are timed in (and the one WebRTC negotiates).
	SampleRate = 48000
	// MaxFileSize bounds what is read from a file: a song from YouTube Music (itag 251) is a
	// few MB.
	MaxFileSize = 64 << 20

	// maxLeafSize bounds one element read in memory (an Opus block is at most a few KB).
	maxLeafSize = 8 << 20
	// maxPacketSamples is the longest Opus packet (120 ms, RFC 6716 §3.2.5).
	maxPacketSamples = 5760
)

// ErrInvalidAudio wraps every reason a stream is not a usable WebM/Opus file.
var ErrInvalidAudio = errors.New("invalid audio")

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidAudio, fmt.Sprintf(format, args...))
}

// Packet is one Opus packet as stored in the file.
type Packet struct {
	TS   time.Duration // start, relative to the first packet
	Dur  time.Duration // from the packet's TOC
	Data []byte        // original bytes
}

// Track is the demuxed Opus track of a whole file.
type Track struct {
	Channels int // 1 or 2, from OpusHead
	PreSkip  uint16
	Packets  []Packet // sorted by TS, never empty
	Duration time.Duration
}

// IndexAt returns the index of the first packet starting at or after off (len(Packets) when
// off is past the last one).
func (t *Track) IndexAt(off time.Duration) int {
	return sort.Search(len(t.Packets), func(i int) bool { return t.Packets[i].TS >= off })
}

// Parse reads a whole WebM stream (at most MaxFileSize bytes) and returns its Opus track. A
// stream cut short keeps the whole packets before the cut. Errors about the content wrap
// ErrInvalidAudio; anything else is a read failure.
func Parse(r io.Reader) (*Track, error) {
	var packets []Packet
	d := newDemuxer(newReader(r, MaxFileSize, nil), func(p []Packet) { packets = append(packets, p...) })
	if err := d.header(); err != nil {
		return nil, err
	}
	if err := d.body(); err != nil {
		return nil, err
	}
	d.flush()
	if len(packets) == 0 {
		return nil, invalid("no Opus packets")
	}
	last := packets[len(packets)-1]
	return &Track{Channels: d.channels, PreSkip: d.preSkip, Packets: packets, Duration: last.TS + last.Dur}, nil
}

func samplesToDuration(n int) time.Duration { return time.Duration(n) * time.Second / SampleRate }

// PacketSamples returns the number of 48 kHz samples in an Opus packet, from its TOC byte
// (RFC 6716 §3.1).
func PacketSamples(p []byte) (int, error) {
	if len(p) < 1 {
		return 0, errors.New("empty packet")
	}
	toc := p[0]
	cfg := toc >> 3
	var frame int
	switch {
	case cfg < 12: // SILK-only: 10, 20, 40, 60 ms
		frame = [...]int{480, 960, 1920, 2880}[cfg&3]
	case cfg < 16: // Hybrid: 10, 20 ms
		frame = [...]int{480, 960}[cfg&1]
	default: // CELT-only: 2.5, 5, 10, 20 ms
		frame = [...]int{120, 240, 480, 960}[cfg&3]
	}
	frames := 1
	switch toc & 3 {
	case 1, 2:
		frames = 2
	case 3:
		if len(p) < 2 {
			return 0, errors.New("code 3 packet without a frame count")
		}
		frames = int(p[1] & 0x3F)
		if frames == 0 {
			return 0, errors.New("code 3 packet with no frames")
		}
	}
	if n := frame * frames; n <= maxPacketSamples {
		return n, nil
	}
	return 0, errors.New("packet longer than 120 ms")
}
