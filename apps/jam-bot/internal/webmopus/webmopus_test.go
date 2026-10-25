package webmopus_test

import (
	"bytes"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/at-wat/ebml-go"

	"github.com/bryanljf/Concord/apps/jam-bot/internal/webmopus"
	"github.com/bryanljf/Concord/apps/jam-bot/internal/webmtest"
)

const ms = time.Millisecond

func parse(t *testing.T, f webmtest.File) *webmopus.Track {
	t.Helper()
	tr, err := webmopus.Parse(bytes.NewReader(f.Bytes()))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return tr
}

func parseErr(t *testing.T, data []byte) error {
	t.Helper()
	_, err := webmopus.Parse(bytes.NewReader(data))
	if err == nil {
		t.Fatal("Parse succeeded, want an error")
	}
	return err
}

func TestParseSimpleBlocks(t *testing.T) {
	f := webmtest.Simple(120) // 2.4 s, 3 clusters
	tr := parse(t, f)
	if tr.Channels != 2 || tr.PreSkip != 312 {
		t.Fatalf("channels %d, pre-skip %d", tr.Channels, tr.PreSkip)
	}
	if len(tr.Packets) != 120 || tr.Duration != 2400*ms {
		t.Fatalf("%d packets, %v", len(tr.Packets), tr.Duration)
	}
	for i, p := range tr.Packets {
		if p.TS != time.Duration(i)*20*ms || p.Dur != 20*ms {
			t.Fatalf("packet %d at %v for %v", i, p.TS, p.Dur)
		}
		if !bytes.Equal(p.Data, webmtest.Packet(webmtest.TOC20ms, i)) {
			t.Fatalf("packet %d changed: % x", i, p.Data)
		}
	}
}

func TestParseMonoAndMatroska(t *testing.T) {
	f := webmtest.Simple(3)
	f.Channels, f.DocType = 1, "matroska"
	if tr := parse(t, f); tr.Channels != 1 {
		t.Fatalf("channels %d", tr.Channels)
	}
}

func TestParseMergesBlockGroupsInOrder(t *testing.T) {
	f := webmtest.New()
	// Marshalled as 0, 40, 100 (SimpleBlocks) then 20, 60, 80 (BlockGroups).
	f.Clusters = []webmtest.Cluster{
		{Timecode: 0, Blocks: []webmtest.Block{
			{Timecode: 0, Frames: [][]byte{webmtest.Packet(webmtest.TOC20ms, 0)}},
			{Timecode: 20, Group: true, Frames: [][]byte{webmtest.Packet(webmtest.TOC20ms, 1)}},
			{Timecode: 40, Frames: [][]byte{webmtest.Packet(webmtest.TOC20ms, 2)}},
			{Timecode: 60, Group: true, Frames: [][]byte{webmtest.Packet(webmtest.TOC20ms, 3)}},
		}},
		{Timecode: 80, Blocks: []webmtest.Block{
			{Timecode: 20, Frames: [][]byte{webmtest.Packet(webmtest.TOC20ms, 5)}},
			{Timecode: 0, Group: true, Discard: 5_000_000, Frames: [][]byte{webmtest.Packet(webmtest.TOC20ms, 4)}},
		}},
	}
	tr := parse(t, f)
	if len(tr.Packets) != 6 {
		t.Fatalf("%d packets", len(tr.Packets))
	}
	for i, p := range tr.Packets {
		if p.TS != time.Duration(i)*20*ms || !bytes.Equal(p.Data, webmtest.Packet(webmtest.TOC20ms, i)) {
			t.Fatalf("packet %d: at %v, % x", i, p.TS, p.Data)
		}
	}
}

func TestParseLacing(t *testing.T) {
	for _, lacing := range []ebml.LacingMode{ebml.LacingXiph, ebml.LacingEBML, ebml.LacingFixed} {
		f := webmtest.New()
		frames := [][]byte{
			webmtest.Packet(webmtest.TOC20ms, 1),
			webmtest.Packet(webmtest.TOC20ms, 2),
			webmtest.Packet(webmtest.TOC20ms, 3),
		}
		f.Clusters = []webmtest.Cluster{{Timecode: 0, Blocks: []webmtest.Block{
			{Timecode: 0, Frames: [][]byte{webmtest.Packet(webmtest.TOC20ms, 0)}},
			{Timecode: 20, Lacing: lacing, Frames: frames},
			{Timecode: 80, Frames: [][]byte{webmtest.Packet(webmtest.TOC20ms, 4)}},
		}}}
		tr := parse(t, f)
		if len(tr.Packets) != 5 || tr.Duration != 100*ms {
			t.Fatalf("lacing %d: %d packets, %v", lacing, len(tr.Packets), tr.Duration)
		}
		for i, p := range tr.Packets {
			if p.TS != time.Duration(i)*20*ms || !bytes.Equal(p.Data, webmtest.Packet(webmtest.TOC20ms, i)) {
				t.Fatalf("lacing %d, packet %d: at %v, % x", lacing, i, p.TS, p.Data)
			}
		}
	}
}

func TestParseDurationsFromTOC(t *testing.T) {
	f := webmtest.New()
	f.Clusters = []webmtest.Cluster{{Timecode: 0, Blocks: []webmtest.Block{
		{Timecode: 0, Frames: [][]byte{{webmtest.TOC10ms, 1}}},                                 // CELT 10 ms
		{Timecode: 10, Frames: [][]byte{{31<<3 | 0x04 | 1, 1}}},                                // code 1: 2 × 20 ms
		{Timecode: 50, Frames: [][]byte{{31<<3 | 0x04 | 3, 3, 1}}},                             // code 3: 3 × 20 ms
		{Timecode: 110, Frames: [][]byte{{3 << 3, 1}}},                                         // SILK NB 60 ms
		{Timecode: 170, Frames: [][]byte{{16 << 3, 1}}},                                        // CELT NB 2.5 ms
		{Timecode: 172, Lacing: ebml.LacingXiph, Frames: [][]byte{{13 << 3, 1}, {12 << 3, 1}}}, // Hybrid 20 ms, 10 ms
	}}}
	tr := parse(t, f)
	want := []struct{ ts, dur time.Duration }{
		{0, 10 * ms}, {10 * ms, 40 * ms}, {50 * ms, 60 * ms}, {110 * ms, 60 * ms},
		{170 * ms, 2500 * time.Microsecond}, {172 * ms, 20 * ms}, {192 * ms, 10 * ms},
	}
	if len(tr.Packets) != len(want) {
		t.Fatalf("%d packets", len(tr.Packets))
	}
	for i, w := range want {
		if p := tr.Packets[i]; p.TS != w.ts || p.Dur != w.dur {
			t.Errorf("packet %d: at %v for %v, want at %v for %v", i, p.TS, p.Dur, w.ts, w.dur)
		}
	}
	if tr.Duration != 202*ms {
		t.Errorf("duration %v", tr.Duration)
	}
}

func TestParseTimecodeScaleAndOffsetStart(t *testing.T) {
	f := webmtest.New()
	f.TimecodeScale = 500_000                                                  // 0.5 ms units
	f.Clusters = []webmtest.Cluster{{Timecode: 2000, Blocks: []webmtest.Block{ // starts at 1 s
		{Timecode: -40, Frames: [][]byte{webmtest.Packet(webmtest.TOC20ms, 0)}}, // 980 ms
		{Timecode: 0, Frames: [][]byte{webmtest.Packet(webmtest.TOC20ms, 1)}},
		{Timecode: 40, Frames: [][]byte{webmtest.Packet(webmtest.TOC20ms, 2)}},
	}}}
	tr := parse(t, f)
	for i, p := range tr.Packets {
		if p.TS != time.Duration(i)*20*ms {
			t.Fatalf("packet %d at %v (relative to the first packet)", i, p.TS)
		}
	}
}

func TestParseIgnoresOtherTracks(t *testing.T) {
	f := webmtest.Simple(2)
	f.Clusters[0].Blocks = append(f.Clusters[0].Blocks,
		webmtest.Block{Timecode: 10, Track: 2, Frames: [][]byte{{0xFF, 0xFF}}})
	if tr := parse(t, f); len(tr.Packets) != 2 {
		t.Fatalf("%d packets", len(tr.Packets))
	}
}

func TestParseRejects(t *testing.T) {
	mutate := func(fn func(*webmtest.File)) []byte {
		f := webmtest.Simple(5)
		fn(&f)
		return f.Bytes()
	}
	cases := map[string][]byte{
		"empty":         nil,
		"not ebml":      []byte("OggS\x00\x02 definitely not a webm file"),
		"doc type":      mutate(func(f *webmtest.File) { f.DocType = "mp4" }),
		"no opus track": mutate(func(f *webmtest.File) { f.CodecID = "A_VORBIS" }),
		"no opus head":  mutate(func(f *webmtest.File) { f.CodecPrivate = []byte("OpusTags........") }),
		"short head":    mutate(func(f *webmtest.File) { f.CodecPrivate = []byte("OpusHead\x01\x02") }),
		"head version": mutate(func(f *webmtest.File) {
			f.CodecPrivate = append([]byte("OpusHead\x10"), webmtest.OpusHead(2, 0)[9:]...)
		}),
		"3 channels":     mutate(func(f *webmtest.File) { f.Channels = 3 }),
		"0 channels":     mutate(func(f *webmtest.File) { f.Channels = 0 }),
		"mapping family": mutate(func(f *webmtest.File) { f.Family = 1 }),
		"44.1 kHz":       mutate(func(f *webmtest.File) { f.SampleRate = 44100 }),
		"no packets":     mutate(func(f *webmtest.File) { f.Clusters = nil }),
		"empty packet":   mutate(func(f *webmtest.File) { f.Clusters[0].Blocks[2].Frames = [][]byte{{}} }),
		"code 3, 0 frames": mutate(func(f *webmtest.File) {
			f.Clusters[0].Blocks[2].Frames = [][]byte{{31<<3 | 3, 0}}
		}),
		"code 3, 140 ms": mutate(func(f *webmtest.File) {
			f.Clusters[0].Blocks[2].Frames = [][]byte{{31<<3 | 3, 7}}
		}),
		"code 3, no count": mutate(func(f *webmtest.File) { f.Clusters[0].Blocks[2].Frames = [][]byte{{31<<3 | 3}} }),
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			if err := parseErr(t, data); !errors.Is(err, webmopus.ErrInvalidAudio) {
				t.Fatalf("error %v does not wrap ErrInvalidAudio", err)
			}
		})
	}
}

type failingReader struct {
	data []byte
	err  error
}

func (r *failingReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, r.err
	}
	n := copy(p, r.data)
	r.data = r.data[n:]
	return n, nil
}

func TestParseReadError(t *testing.T) {
	data := webmtest.Simple(200).Bytes()
	boom := errors.New("disk on fire")
	_, err := webmopus.Parse(&failingReader{data: data[:len(data)/2], err: boom})
	if !errors.Is(err, boom) || errors.Is(err, webmopus.ErrInvalidAudio) {
		t.Fatalf("error %v, want the read error", err)
	}
}

func TestParseTruncatedKeepsWholePackets(t *testing.T) {
	data := webmtest.Simple(200).Bytes()
	tr, err := webmopus.Parse(io.LimitReader(bytes.NewReader(data), int64(len(data)*3/4)))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if n := len(tr.Packets); n == 0 || n >= 200 {
		t.Fatalf("%d packets", n)
	}
	for i, p := range tr.Packets {
		if !bytes.Equal(p.Data, webmtest.Packet(webmtest.TOC20ms, i)) {
			t.Fatalf("packet %d changed", i)
		}
	}
}

func TestIndexAt(t *testing.T) {
	tr := parse(t, webmtest.Simple(10)) // 0..180 ms
	cases := []struct {
		off  time.Duration
		want int
	}{
		{-time.Second, 0}, {0, 0}, {1 * ms, 1}, {20 * ms, 1}, {105 * ms, 6}, {180 * ms, 9}, {181 * ms, 10}, {time.Hour, 10},
	}
	for _, c := range cases {
		if got := tr.IndexAt(c.off); got != c.want {
			t.Errorf("IndexAt(%v) = %d, want %d", c.off, got, c.want)
		}
	}
}

func TestPacketSamples(t *testing.T) {
	cases := []struct {
		p    []byte
		want int
	}{
		{[]byte{0 << 3}, 480}, {[]byte{1 << 3}, 960}, {[]byte{2 << 3}, 1920}, {[]byte{3 << 3}, 2880},
		{[]byte{12 << 3}, 480}, {[]byte{13 << 3}, 960},
		{[]byte{16 << 3}, 120}, {[]byte{17 << 3}, 240}, {[]byte{18 << 3}, 480}, {[]byte{19 << 3}, 960},
		{[]byte{31<<3 | 1}, 1920}, {[]byte{31<<3 | 2, 0}, 1920}, {[]byte{31<<3 | 3, 6}, 5760},
		{[]byte{3<<3 | 1}, 5760}, {[]byte{31<<3 | 3, 0x80 | 2}, 1920},
	}
	for _, c := range cases {
		if got, err := webmopus.PacketSamples(c.p); err != nil || got != c.want {
			t.Errorf("PacketSamples(% x) = %d, %v; want %d", c.p, got, err, c.want)
		}
	}
	for _, p := range [][]byte{{}, {31<<3 | 3}, {31<<3 | 3, 0}, {31<<3 | 3, 7}, {3<<3 | 3, 3}} {
		if _, err := webmopus.PacketSamples(p); err == nil {
			t.Errorf("PacketSamples(% x) succeeded", p)
		}
	}
}
