package webmopus_test

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"
	"time"

	"github.com/at-wat/ebml-go"

	"github.com/bryanljf/Concord/apps/jam-bot/internal/webmopus"
	"github.com/bryanljf/Concord/apps/jam-bot/internal/webmtest"
)

// el encodes an element by hand, with an 8-byte size.
func el(id uint32, payload ...[]byte) []byte {
	var b []byte
	for s := 24; s >= 0; s -= 8 {
		if c := byte(id >> s); c != 0 || len(b) > 0 {
			b = append(b, c)
		}
	}
	size := 0
	for _, p := range payload {
		size += len(p)
	}
	b = binary.BigEndian.AppendUint64(b, uint64(size)|1<<56)
	for _, p := range payload {
		b = append(b, p...)
	}
	return b
}

// elUnknown encodes an element of unknown size (its payload follows).
func elUnknown(id uint32, payload ...[]byte) []byte {
	b := el(id)
	b = append(b[:len(b)-8], 0xFF)
	for _, p := range payload {
		b = append(b, p...)
	}
	return b
}

func simpleBlock(track byte, tc int16, flags byte, data ...[]byte) []byte {
	head := []byte{0x80 | track, byte(uint16(tc) >> 8), byte(tc), flags}
	return el(0xA3, append(head, bytes.Join(data, nil)...))
}

// ebmlHeader is the EBML header element of webmtest's files.
func ebmlHeader() []byte {
	full := webmtest.New().Bytes()
	return full[:bytes.Index(full, []byte{0x18, 0x53, 0x80, 0x67})]
}

// headOnly is a file up to its tracks, in a Segment of unknown size: raw elements appended to
// it are Segment children.
func headOnly() []byte {
	f := webmtest.New()
	f.UnknownSizeSegment = true
	return f.Bytes()
}

func samePackets(t *testing.T, got, want []webmopus.Packet) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%d packets, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i].TS != want[i].TS || got[i].Dur != want[i].Dur || !bytes.Equal(got[i].Data, want[i].Data) {
			t.Fatalf("packet %d: at %v for %v (% x), want at %v for %v (% x)", i,
				got[i].TS, got[i].Dur, got[i].Data, want[i].TS, want[i].Dur, want[i].Data)
		}
	}
}

// mergeOrderFile stores BlockGroups after the SimpleBlocks of each cluster, out of order.
func mergeOrderFile() webmtest.File {
	f := webmtest.New()
	f.Clusters = []webmtest.Cluster{
		{Timecode: 0, Blocks: []webmtest.Block{
			{Timecode: 0, Frames: [][]byte{webmtest.Packet(webmtest.TOC20ms, 0)}},
			{Timecode: 20, Group: true, Frames: [][]byte{webmtest.Packet(webmtest.TOC20ms, 1)}},
			{Timecode: 40, Frames: [][]byte{webmtest.Packet(webmtest.TOC20ms, 2)}},
		}},
		{Timecode: 60, Blocks: []webmtest.Block{
			{Timecode: 20, Frames: [][]byte{webmtest.Packet(webmtest.TOC20ms, 4)}},
			{Timecode: 0, Group: true, Discard: 5_000_000, Frames: [][]byte{webmtest.Packet(webmtest.TOC20ms, 3)}},
		}},
	}
	return f
}

func TestParseUnknownSizes(t *testing.T) {
	for _, base := range []webmtest.File{webmtest.Simple(120), mergeOrderFile()} {
		want := parse(t, base).Packets
		for _, v := range []struct{ seg, cl bool }{{true, false}, {false, true}, {true, true}} {
			f := base
			f.UnknownSizeSegment, f.UnknownSizeClusters = v.seg, v.cl
			if bytes.Equal(f.Bytes(), base.Bytes()) {
				t.Fatal("webmtest ignored the unknown sizes")
			}
			samePackets(t, parse(t, f).Packets, want)
		}
	}
}

func TestParseUnknownClusterEndsAtTopLevelElement(t *testing.T) {
	f := webmtest.Simple(60) // 2 clusters: 0..980 ms, 1000..1180 ms
	f.UnknownSizeSegment, f.UnknownSizeClusters = true, true
	data := f.Bytes()
	data = append(data, el(0x1254C367, el(0x7373, []byte("tag")))...) // Tags
	data = append(data, el(0x1F43B675, el(0xE7, []byte{0x04, 0xB0}),  // known-size Cluster at 1200 ms
		simpleBlock(1, 0, 0x80, webmtest.Packet(webmtest.TOC20ms, 60)),
		el(0xEC, []byte{0, 0}), // Void
		simpleBlock(1, 20, 0x80, webmtest.Packet(webmtest.TOC20ms, 61)))...)
	data = append(data, el(0x1C53BB6B, el(0xBB))...)                        // Cues
	data = append(data, elUnknown(0x1F43B675, el(0xE7, []byte{0x05, 0x14}), // unknown-size, 1300 ms
		simpleBlock(1, -60, 0x80, webmtest.Packet(webmtest.TOC20ms, 62)))...)
	tr, err := webmopus.Parse(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	samePackets(t, tr.Packets, parse(t, webmtest.Simple(63)).Packets)
}

func TestParseStopsAtTheEndOfTheSegment(t *testing.T) {
	f := webmtest.Simple(30)
	data := append(f.Bytes(), simpleBlock(1, 0, 0x80, webmtest.Packet(webmtest.TOC20ms, 99))...)
	data = append(data, "trailing junk"...)
	tr, err := webmopus.Parse(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	samePackets(t, tr.Packets, parse(t, f).Packets)
	// After an unknown-size Segment, a new EBML header starts another file: not read.
	data = append(headOnly(), el(0x1F43B675, el(0xE7, []byte{0}),
		simpleBlock(1, 0, 0x80, webmtest.Packet(webmtest.TOC20ms, 0)))...)
	data = append(data, webmtest.Simple(5).Bytes()...)
	if tr, err := webmopus.Parse(bytes.NewReader(data)); err != nil || len(tr.Packets) != 1 {
		t.Fatalf("chained file: %v", err)
	}
}

func TestParseBigLacedFrames(t *testing.T) {
	frame := func(i, size int) []byte {
		return append(webmtest.Packet(webmtest.TOC20ms, i), bytes.Repeat([]byte{byte(i)}, size)...)
	}
	// ebml-go writes a Xiph size that is a multiple of 255 without its final 0: avoided here,
	// covered by hand below.
	cases := map[ebml.LacingMode][][]byte{
		ebml.LacingXiph:  {frame(0, 600), frame(1, 2), frame(2, 252), frame(3, 250), frame(4, 70)},
		ebml.LacingEBML:  {frame(0, 300), frame(1, 2), frame(2, 9000), frame(3, 10), frame(4, 70)},
		ebml.LacingFixed: {frame(0, 300), frame(1, 300), frame(2, 300)},
	}
	frames := [][]byte{frame(0, 251), frame(1, 506), frame(2, 3)} // 255 and 510 bytes
	data := append(headOnly(), el(0x1F43B675, el(0xE7, []byte{0}),
		simpleBlock(1, 0, 0x82, []byte{2, 0xFF, 0x00, 0xFF, 0xFF, 0x00}, bytes.Join(frames, nil)))...)
	tr, err := webmopus.Parse(bytes.NewReader(data))
	if err != nil || len(tr.Packets) != len(frames) {
		t.Fatalf("xiph by hand: %v", err)
	}
	for i, p := range tr.Packets {
		if !bytes.Equal(p.Data, frames[i]) {
			t.Fatalf("xiph by hand, packet %d: %d bytes", i, len(p.Data))
		}
	}
	for lacing, frames := range cases {
		f := webmtest.New()
		f.Clusters = []webmtest.Cluster{{Blocks: []webmtest.Block{{Lacing: lacing, Frames: frames}}}}
		tr := parse(t, f)
		if len(tr.Packets) != len(frames) {
			t.Fatalf("lacing %d: %d packets", lacing, len(tr.Packets))
		}
		for i, p := range tr.Packets {
			if !bytes.Equal(p.Data, frames[i]) || p.TS != time.Duration(i)*20*ms {
				t.Fatalf("lacing %d, packet %d: %d bytes at %v", lacing, i, len(p.Data), p.TS)
			}
		}
	}
}

func TestParseHeaderVariants(t *testing.T) {
	// A Void before the Segment, Void and SeekHead before the tracks, a video track before the
	// Opus one, Info after the tracks, and blocks of the other track in the cluster.
	tracks := el(0x1654AE6B,
		el(0xAE, el(0xD7, []byte{2}), el(0x86, []byte("V_VP9"))),
		el(0xAE, el(0xD7, []byte{1}), el(0x86, []byte("A_OPUS\x00")), el(0x63A2, webmtest.OpusHead(1, 0)),
			el(0xE1, el(0xB5, []byte{0x47, 0x3B, 0x80, 0x00}))), // 48000 as a float32
	)
	info := el(0x1549A966, el(0x2AD7B1, []byte{0x07, 0xA1, 0x20})) // 500 000 ns
	cluster := el(0x1F43B675, el(0xE7, []byte{0x00}),
		simpleBlock(1, 0, 0x80, webmtest.Packet(webmtest.TOC20ms, 0)),
		simpleBlock(2, 10, 0x80, []byte{0xFF}),
		simpleBlock(1, 40, 0x80, webmtest.Packet(webmtest.TOC20ms, 1))) // 40 × 0.5 ms
	data := append(ebmlHeader(), el(0xEC, []byte{0})...)
	data = append(data, elUnknown(0x18538067, el(0xEC), el(0x114D9B74, el(0x4DBB)), tracks, info, cluster)...)
	tr, err := webmopus.Parse(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if tr.Channels != 1 || len(tr.Packets) != 2 || tr.Packets[1].TS != 20*ms {
		t.Fatalf("%d channels, %d packets", tr.Channels, len(tr.Packets))
	}
}

func TestParseRejectsCorruptElements(t *testing.T) {
	good := webmtest.Packet(webmtest.TOC20ms, 0)
	cluster := func(children ...[]byte) []byte {
		return append(headOnly(), el(0x1F43B675, append([][]byte{el(0xE7, []byte{0})}, children...)...)...)
	}
	segment := func(children ...[]byte) []byte {
		return append(ebmlHeader(), el(0x18538067, children...)...)
	}
	opusEntry := func(audio []byte) []byte {
		return el(0x1654AE6B, el(0xAE, el(0x86, []byte("A_OPUS")), el(0x63A2, webmtest.OpusHead(2, 0)), audio))
	}
	overflow := append(headOnly(), 0x1F, 0x43, 0xB6, 0x75, 0x84, 0xA3, 0x88, 0x81, 0, 0, 0x80, 0xFC, 0, 0, 0)
	whole := webmtest.Simple(1).Bytes()
	cases := map[string][]byte{
		"zero ID":                   cluster(simpleBlock(1, 0, 0x80, good), []byte{0x00, 0x81, 0x00}),
		"5-byte ID":                 cluster(simpleBlock(1, 0, 0x80, good), []byte{0x08, 1, 2, 3, 4, 0x81, 0}),
		"zero size":                 cluster(simpleBlock(1, 0, 0x80, good), []byte{0xA3, 0x00}),
		"unknown-size leaf":         cluster(simpleBlock(1, 0, 0x80, good), []byte{0xA3, 0xFF, 0x81, 0, 0, 0x80}),
		"overflows cluster":         overflow,
		"short block":               cluster(el(0xA3, []byte{0x81, 0})),
		"bad track number":          cluster(el(0xA3, []byte{0x00, 0, 0, 0x80, 0xFC})),
		"bad xiph lacing":           cluster(simpleBlock(1, 0, 0x82, []byte{2, 255, 255})),
		"xiph too long":             cluster(simpleBlock(1, 0, 0x82, []byte{1, 200}, good)),
		"no frame count":            cluster(simpleBlock(1, 0, 0x86)),
		"bad ebml lacing":           cluster(simpleBlock(1, 0, 0x86, []byte{2, 0x00})),
		"ebml too long":             cluster(simpleBlock(1, 0, 0x86, []byte{1, 0xC0}, good)),
		"ebml negative":             cluster(simpleBlock(1, 0, 0x86, []byte{2, 0x82, 0x80}, good, good)),
		"bad fixed lacing":          cluster(simpleBlock(1, 0, 0x84, []byte{1}, good, []byte{1})),
		"bad block group":           cluster(el(0xA0, []byte{0xA1, 0x85, 0x81})),
		"big timecode":              cluster(el(0xE7, make([]byte, 9))),
		"bad float":                 segment(opusEntry(el(0xE1, el(0xB5, []byte{1, 2, 3})))),
		"bad audio":                 segment(opusEntry(el(0xE1, []byte{0xB5}))),
		"unknown-size info":         append(headOnly(), 0x15, 0x49, 0xA9, 0x66, 0xFF),
		"void overflows segment":    segment(opusEntry(nil), []byte{0xEC, 0x90, 0, 0}),
		"cluster overflows segment": segment(opusEntry(nil), []byte{0x1F, 0x43, 0xB6, 0x75, 0x90, 0xE7, 0x81, 0x00}),
		"huge element":              append(headOnly(), 0x1F, 0x43, 0xB6, 0x75, 0xFF, 0xA3, 0x10, 0x90, 0, 0), // 9 MB block
		"truncated header":          whole[:30],
		"no segment":                ebmlHeader(),
		"bad ebml header":           append([]byte{0x1A, 0x45, 0xDF, 0xA3, 0x83, 0x42, 0x82, 0x85}, "webm"...),
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			if err := parseErr(t, data); !errors.Is(err, webmopus.ErrInvalidAudio) {
				t.Fatalf("error %v does not wrap ErrInvalidAudio", err)
			}
		})
	}
}

func TestParseLimit(t *testing.T) {
	// An unknown-size Segment is read to the end of the stream: exactly the limit is fine, one
	// byte more is not.
	for _, f := range []webmtest.File{webmtest.Simple(200), unknownSizes(webmtest.Simple(200))} {
		data := f.Bytes()
		if _, err := webmopus.ParseWith(data, int64(len(data)), 0); err != nil {
			t.Fatalf("at the limit: %v", err)
		}
		for _, limit := range []int{len(data) - 1, len(data) / 2} {
			if _, err := webmopus.ParseWith(data, int64(limit), 0); !errors.Is(err, webmopus.ErrInvalidAudio) {
				t.Fatalf("limit %d of %d: %v", limit, len(data), err)
			}
		}
	}
}

func TestParseSmallBuffers(t *testing.T) {
	// Elements and their headers straddle every buffer boundary.
	files := map[string][]byte{
		"simple":       webmtest.Simple(120).Bytes(),
		"unknown":      unknownSizes(webmtest.Simple(120)).Bytes(),
		"merge order":  mergeOrderFile().Bytes(),
		"groups, lace": unknownSizes(inOrderMix()).Bytes(),
	}
	for name, data := range files {
		want, err := webmopus.Parse(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		for _, size := range []int{1, 2, 5, 13, 100} {
			got, err := webmopus.ParseWith(data, 0, size)
			if err != nil {
				t.Fatalf("%s, buffer %d: %v", name, size, err)
			}
			samePackets(t, got, want.Packets)
		}
	}
}
