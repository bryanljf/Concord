package webmopus_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math/rand/v2"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bryanljf/Concord/apps/jam-bot/internal/webmopus"
	"github.com/bryanljf/Concord/apps/jam-bot/internal/webmtest"
)

func testCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func songPath(t *testing.T) string { return filepath.Join(t.TempDir(), "song.webm") }

func writeSong(t *testing.T, data []byte) string {
	t.Helper()
	path := songPath(t)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// fast shortens the timings: polls are near instant, timeouts long enough never to fire by
// accident.
func fast(o webmopus.TestOptions) webmopus.TestOptions {
	if o.Poll == 0 {
		o.Poll = time.Microsecond
	}
	if o.Stall == 0 {
		o.Stall = 5 * time.Second
	}
	if o.Header == 0 {
		o.Header = 5 * time.Second
	}
	return o
}

func openT(t *testing.T, path string, g *webmopus.Growth, o webmopus.TestOptions) *webmopus.Source {
	t.Helper()
	s, err := webmopus.OpenForTest(path, g, fast(o))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func newProgressive(t *testing.T, path string, data []byte) *webmtest.Progressive {
	t.Helper()
	w, err := webmtest.NewProgressive(path, data)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })
	return w
}

// readAll reads packets from the first one until an error.
func readAll(ctx context.Context, s *webmopus.Source) ([]webmopus.Packet, error) {
	var out []webmopus.Packet
	for i := 0; ; i++ {
		p, err := s.Packet(ctx, i)
		if err != nil {
			return out, err
		}
		out = append(out, p)
	}
}

func readWhole(t *testing.T, s *webmopus.Source) []webmopus.Packet {
	t.Helper()
	pkts, err := readAll(testCtx(t), s)
	if err != io.EOF {
		t.Fatalf("after %d packets: %v, want io.EOF", len(pkts), err)
	}
	return pkts
}

func unknownSizes(f webmtest.File) webmtest.File {
	f.UnknownSizeSegment, f.UnknownSizeClusters = true, true
	return f
}

func TestOpenWholeFile(t *testing.T) {
	f := webmtest.Simple(120)
	s := openT(t, writeSong(t, f.Bytes()), nil, webmopus.TestOptions{})
	if s.Channels() != 2 {
		t.Fatalf("%d channels", s.Channels())
	}
	samePackets(t, readWhole(t, s), parse(t, f).Packets)
	ctx := testCtx(t)
	if _, err := s.Packet(ctx, 500); err != io.EOF {
		t.Fatalf("past the end: %v", err)
	}
	if _, err := s.Packet(ctx, -1); err == nil {
		t.Fatal("negative index accepted")
	}
	if n, end, complete := s.Parsed(); n != 120 || end != 2400*ms || !complete {
		t.Fatalf("Parsed: %d, %v, %v", n, end, complete)
	}
	cases := []struct {
		off  time.Duration
		want int
	}{{-time.Second, 0}, {0, 0}, {1 * ms, 1}, {20 * ms, 1}, {1005 * ms, 51}, {2380 * ms, 119}, {2381 * ms, 120}, {time.Hour, 120}}
	for _, c := range cases {
		if got, err := s.IndexAt(ctx, c.off); got != c.want || err != nil {
			t.Errorf("IndexAt(%v) = %d, %v; want %d", c.off, got, err, c.want)
		}
	}

	mono := webmtest.Simple(3)
	mono.Channels = 1
	if s := openT(t, writeSong(t, mono.Bytes()), nil, webmopus.TestOptions{}); s.Channels() != 1 {
		t.Fatalf("mono: %d channels", s.Channels())
	}
}

func TestOpenRejects(t *testing.T) {
	mutate := func(fn func(*webmtest.File)) []byte {
		f := webmtest.Simple(120)
		fn(&f)
		return f.Bytes()
	}
	atOpen := map[string][]byte{
		"empty":         nil,
		"not ebml":      []byte("OggS\x00\x02 definitely not a webm file"),
		"doc type":      mutate(func(f *webmtest.File) { f.DocType = "mp4" }),
		"no opus track": mutate(func(f *webmtest.File) { f.CodecID = "A_VORBIS" }),
		"3 channels":    mutate(func(f *webmtest.File) { f.Channels = 3 }),
		"44.1 kHz":      mutate(func(f *webmtest.File) { f.SampleRate = 44100 }),
	}
	later := map[string][]byte{
		"no packets":   mutate(func(f *webmtest.File) { f.Clusters = nil }),
		"empty packet": mutate(func(f *webmtest.File) { f.Clusters[1].Blocks[2].Frames = [][]byte{{}} }),
	}
	for name, data := range atOpen {
		t.Run(name, func(t *testing.T) {
			if _, err := webmopus.OpenForTest(writeSong(t, data), nil, fast(webmopus.TestOptions{})); !errors.Is(err, webmopus.ErrInvalidAudio) {
				t.Fatalf("Open: %v", err)
			}
		})
	}
	for name, data := range later {
		t.Run(name, func(t *testing.T) {
			s := openT(t, writeSong(t, data), nil, webmopus.TestOptions{})
			pkts, err := readAll(testCtx(t), s)
			if !errors.Is(err, webmopus.ErrInvalidAudio) {
				t.Fatalf("after %d packets: %v", len(pkts), err)
			}
			if _, err := s.IndexAt(testCtx(t), time.Hour); !errors.Is(err, webmopus.ErrInvalidAudio) {
				t.Fatalf("IndexAt: %v", err)
			}
			if _, _, complete := s.Parsed(); complete {
				t.Fatal("complete")
			}
		})
	}
}

func TestOpenMissingOrNotAFile(t *testing.T) {
	missing := songPath(t)
	if _, err := webmopus.Open(missing, nil); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing: %v", err)
	}
	if _, err := webmopus.Open(t.TempDir(), nil); err == nil || errors.Is(err, webmopus.ErrInvalidAudio) {
		t.Fatalf("directory: %v", err)
	}
	g := webmopus.NewGrowth()
	start := time.Now()
	if _, err := webmopus.OpenForTest(missing, g, fast(webmopus.TestOptions{Header: 30 * ms})); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing, growing: %v", err)
	}
	if time.Since(start) < 30*ms {
		t.Fatal("did not wait for the file")
	}
	// Complete: no use waiting (the writer may have renamed it).
	g.Complete(missing)
	if _, err := webmopus.OpenForTest(missing, g, fast(webmopus.TestOptions{Header: time.Hour})); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing, complete: %v", err)
	}
}

func TestOpenFileAppearingLate(t *testing.T) {
	f := webmtest.Simple(30)
	path := songPath(t)
	type result struct {
		s   *webmopus.Source
		err error
	}
	res := make(chan result, 1)
	go func() {
		s, err := webmopus.OpenForTest(path, webmopus.NewGrowth(), fast(webmopus.TestOptions{Poll: 100 * time.Microsecond}))
		res <- result{s, err}
	}()
	time.Sleep(2 * ms) // let Open find nothing at first
	if err := os.WriteFile(path, f.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	r := <-res
	if r.err != nil {
		t.Fatal(r.err)
	}
	defer r.s.Close()
	samePackets(t, readWhole(t, r.s), parse(t, f).Packets) // known-size Segment: no Complete needed
}

func TestOpenTooLarge(t *testing.T) {
	data := webmtest.Simple(200).Bytes()
	path := writeSong(t, data)
	limit := int64(len(data) / 2)
	if _, err := webmopus.OpenForTest(path, nil, fast(webmopus.TestOptions{MaxSize: limit})); !errors.Is(err, webmopus.ErrInvalidAudio) {
		t.Fatalf("whole file: %v", err)
	}
	// A growing file finds out on the way.
	path = songPath(t)
	w := newProgressive(t, path, data)
	s := openT(t, path, webmopus.NewGrowth(), webmopus.TestOptions{Poll: -1, MaxSize: limit, OnWait: func(int64) { _, _ = w.Next(100) }})
	pkts, err := readAll(testCtx(t), s)
	if !errors.Is(err, webmopus.ErrInvalidAudio) || len(pkts) == 0 || len(pkts) >= 200 {
		t.Fatalf("growing: %d packets, %v", len(pkts), err)
	}
}

// inOrderMix has BlockGroups and laced blocks, all in timestamp order (out-of-order blocks
// cannot be reordered once handed out: growing files must be in order).
func inOrderMix() webmtest.File {
	f := webmtest.Simple(150)
	for i := range f.Clusters {
		cl := &f.Clusters[i]
		cl.Blocks[3].Group = true
		cl.Blocks[4].Group, cl.Blocks[4].Discard = true, 2_000_000
		cl.Blocks[10].Lacing = 1 // Xiph
		cl.Blocks[10].Frames = [][]byte{cl.Blocks[10].Frames[0], cl.Blocks[11].Frames[0]}
		cl.Blocks[11].Timecode, cl.Blocks[11].Track = cl.Blocks[11].Timecode+1, 2 // another track
	}
	// Groups come after the SimpleBlocks in a cluster: keep a cluster of groups only.
	for i := range f.Clusters {
		var sb, bg []webmtest.Block
		for _, b := range f.Clusters[i].Blocks {
			if b.Group {
				bg = append(bg, b)
			} else {
				sb = append(sb, b)
			}
		}
		if len(bg) > 0 {
			f.Clusters[i].Blocks = sb
			f.Clusters = append(f.Clusters, webmtest.Cluster{Timecode: 5000 + uint64(i)*1000})
			for _, b := range bg {
				b.Timecode = int16(f.Clusters[i].Timecode + uint64(b.Timecode) - (5000 + uint64(i)*1000))
				f.Clusters[len(f.Clusters)-1].Blocks = append(f.Clusters[len(f.Clusters)-1].Blocks, b)
			}
		}
	}
	return f
}

func TestGrowingLockstep(t *testing.T) {
	// The test writes the next chunk each time the reader waits at the end of the file: every
	// element ends up split at every position (chunk 1), the header included.
	variants := map[string]webmtest.File{
		"known sizes":      webmtest.Simple(120),
		"unknown segment":  {},
		"unknown clusters": {},
		"both unknown":     unknownSizes(webmtest.Simple(120)),
		"groups, lacing":   unknownSizes(inOrderMix()),
	}
	v := webmtest.Simple(120)
	v.UnknownSizeSegment = true
	variants["unknown segment"] = v
	v = webmtest.Simple(120)
	v.UnknownSizeClusters = true
	variants["unknown clusters"] = v
	patterns := [][]int{{1}, {3, 1, 7, 2, 13}, {64}}
	for name, f := range variants {
		for _, chunks := range patterns {
			if len(chunks) == 1 && chunks[0] == 1 && testing.Short() {
				continue
			}
			t.Run(fmt.Sprintf("%s/%v", name, chunks), func(t *testing.T) {
				data := f.Bytes()
				want := parse(t, f).Packets
				path := songPath(t)
				w := newProgressive(t, path, data)
				g := webmopus.NewGrowth()
				var src atomic.Pointer[webmopus.Source]
				var halfway atomic.Int64
				halfway.Store(-1)
				next := 0
				bufSize := 0
				if len(chunks) > 1 {
					bufSize = 5 // smaller than an element header
				}
				s := openT(t, path, g, webmopus.TestOptions{Poll: -1, BufSize: bufSize, OnWait: func(read int64) {
					if read != int64(w.Written()) {
						t.Errorf("waiting at %d with %d bytes written", read, w.Written())
					}
					if w.Done() {
						g.Complete(path)
						return
					}
					if w.Written() >= len(data)/2 {
						s := src.Load()
						if s == nil {
							return // until Open has returned
						}
						if halfway.Load() < 0 {
							n, _, _ := s.Parsed()
							halfway.Store(int64(n))
						}
					}
					if _, err := w.Next(chunks[next%len(chunks)]); err != nil {
						t.Error(err)
					}
					next++
				}})
				src.Store(s)
				samePackets(t, readWhole(t, s), want)
				if h := halfway.Load(); h <= 0 || h >= int64(len(want)) {
					t.Fatalf("%d packets available halfway", h)
				}
				known := !f.UnknownSizeSegment
				if st := webmopus.GrowthState(g, path); known != (st == "growing") {
					t.Fatalf("state %s: a known-size Segment ends without Complete, an unknown one needs it", st)
				}
			})
		}
	}
}

func TestGrowingConcurrentWritersAndReaders(t *testing.T) {
	for seed := range uint64(4) {
		t.Run(fmt.Sprint(seed), func(t *testing.T) {
			f := unknownSizes(webmtest.Simple(300))
			data := f.Bytes()
			want := parse(t, f).Packets
			path := songPath(t)
			w := newProgressive(t, path, data)
			g := webmopus.NewGrowth()
			ctx := testCtx(t)
			var wg sync.WaitGroup
			wg.Go(func() { // the upload
				rng := rand.New(rand.NewPCG(seed, 7))
				for i := 0; !w.Done(); i++ {
					if _, err := w.Next(1 + rng.IntN(40)); err != nil {
						t.Error(err)
						return
					}
					if i%8 == 0 {
						time.Sleep(20 * time.Microsecond)
					}
				}
				g.Complete(path)
			})
			// Three Sources on the same file, three readers each, opened while it is written.
			for range 3 {
				wg.Go(func() {
					s, err := webmopus.OpenForTest(path, g, fast(webmopus.TestOptions{Poll: 200 * time.Microsecond}))
					if err != nil {
						t.Error(err)
						return
					}
					defer s.Close()
					var rg sync.WaitGroup
					for range 3 {
						rg.Go(func() {
							got, err := readAll(ctx, s)
							if err != io.EOF {
								t.Errorf("after %d packets: %v", len(got), err)
								return
							}
							if len(got) != len(want) {
								t.Errorf("%d packets, want %d", len(got), len(want))
								return
							}
							for i := range want {
								if got[i].TS != want[i].TS || !bytes.Equal(got[i].Data, want[i].Data) {
									t.Errorf("packet %d differs", i)
									return
								}
							}
						})
					}
					rg.Go(func() {
						if i, err := s.IndexAt(ctx, 5*time.Second); i != 250 || err != nil {
							t.Errorf("IndexAt(5s) = %d, %v", i, err)
						}
					})
					rg.Wait()
					if n, end, complete := s.Parsed(); n != 300 || end != 6*time.Second || !complete {
						t.Errorf("Parsed: %d, %v, %v", n, end, complete)
					}
				})
			}
			wg.Wait()
		})
	}
}

func TestPacketsBeforeTheClusterEnds(t *testing.T) {
	f := webmtest.New()
	f.UnknownSizeSegment, f.UnknownSizeClusters = true, true
	f.Clusters = []webmtest.Cluster{{}}
	for i := range 100 {
		f.Clusters[0].Blocks = append(f.Clusters[0].Blocks, webmtest.Block{
			Timecode: int16(i * 20), Frames: [][]byte{webmtest.Packet(webmtest.TOC20ms, i)},
		})
	}
	data := f.Bytes()
	path := songPath(t)
	w := newProgressive(t, path, data)
	if err := w.To(len(data) * 6 / 10); err != nil {
		t.Fatal(err)
	}
	g := webmopus.NewGrowth()
	s := openT(t, path, g, webmopus.TestOptions{})
	ctx := testCtx(t)
	if p, err := s.Packet(ctx, 30); err != nil || p.TS != 600*ms {
		t.Fatalf("packet 30 of the unfinished cluster: %v, %v", p.TS, err)
	}
	if n, end, complete := s.Parsed(); n >= 100 || end != time.Duration(n)*20*ms || complete {
		t.Fatalf("Parsed: %d, %v, %v", n, end, complete)
	}
	if err := w.Rest(); err != nil {
		t.Fatal(err)
	}
	g.Complete(path)
	samePackets(t, readWhole(t, s), parse(t, f).Packets)
}

func TestCompleteBeforeOpen(t *testing.T) {
	f := unknownSizes(webmtest.Simple(60))
	path := writeSong(t, f.Bytes())
	g := webmopus.NewGrowth()
	// The same file, spelled another way.
	g.Complete(filepath.Join(filepath.Dir(path), ".", "x", "..", filepath.Base(path)))
	s := openT(t, path, g, webmopus.TestOptions{Stall: time.Hour})
	samePackets(t, readWhole(t, s), parse(t, f).Packets)
}

func TestCompleteAfterOpen(t *testing.T) {
	f := unknownSizes(webmtest.Simple(150))
	data := f.Bytes()
	path := songPath(t)
	w := newProgressive(t, path, data)
	if err := w.To(len(data) / 2); err != nil {
		t.Fatal(err)
	}
	g := webmopus.NewGrowth()
	s := openT(t, path, g, webmopus.TestOptions{Stall: time.Hour})
	if _, err := s.Packet(testCtx(t), 0); err != nil {
		t.Fatal(err)
	}
	if _, _, complete := s.Parsed(); complete {
		t.Fatal("complete while growing")
	}
	if err := w.Rest(); err != nil {
		t.Fatal(err)
	}
	g.Complete(path)
	samePackets(t, readWhole(t, s), parse(t, f).Packets)
	if n, _, complete := s.Parsed(); n != 150 || !complete {
		t.Fatalf("Parsed: %d, %v", n, complete)
	}
}

func TestFail(t *testing.T) {
	f := unknownSizes(webmtest.Simple(150))
	data := f.Bytes()

	t.Run("before Open", func(t *testing.T) {
		path := writeSong(t, data[:len(data)/2])
		g := webmopus.NewGrowth()
		g.Fail(path)
		if _, err := webmopus.OpenForTest(path, g, fast(webmopus.TestOptions{})); !errors.Is(err, webmopus.ErrFailed) {
			t.Fatalf("Open: %v", err)
		}
	})
	t.Run("during the header", func(t *testing.T) {
		path := writeSong(t, nil)
		g := webmopus.NewGrowth()
		_, err := webmopus.OpenForTest(path, g, fast(webmopus.TestOptions{OnWait: func(int64) { g.Fail(path) }}))
		if !errors.Is(err, webmopus.ErrFailed) {
			t.Fatalf("Open: %v", err)
		}
	})
	t.Run("after Open", func(t *testing.T) {
		path := writeSong(t, data[:len(data)/2])
		g := webmopus.NewGrowth()
		s := openT(t, path, g, webmopus.TestOptions{Stall: time.Hour})
		ctx := testCtx(t)
		if _, err := s.Packet(ctx, 0); err != nil {
			t.Fatal(err)
		}
		g.Fail(path)
		if _, err := s.Packet(ctx, 1000); !errors.Is(err, webmopus.ErrFailed) {
			t.Fatalf("past the parsed packets: %v", err)
		}
		// The song stops: even the packets already parsed are refused.
		if _, err := s.Packet(ctx, 0); !errors.Is(err, webmopus.ErrFailed) {
			t.Fatalf("packet 0: %v", err)
		}
		if _, err := s.IndexAt(ctx, 0); !errors.Is(err, webmopus.ErrFailed) {
			t.Fatalf("IndexAt: %v", err)
		}
		if _, _, complete := s.Parsed(); complete {
			t.Fatal("complete")
		}
	})
}

func TestStall(t *testing.T) {
	data := unknownSizes(webmtest.Simple(150)).Bytes()
	path := writeSong(t, data[:len(data)/2])
	s := openT(t, path, webmopus.NewGrowth(), webmopus.TestOptions{Stall: 30 * ms})
	ctx := testCtx(t)
	pkts, err := readAll(ctx, s)
	if !errors.Is(err, webmopus.ErrStalled) || len(pkts) == 0 {
		t.Fatalf("after %d packets: %v", len(pkts), err)
	}
	if _, err := s.Packet(ctx, 0); err != nil {
		t.Fatalf("parsed packets stay readable: %v", err)
	}
	if i, err := s.IndexAt(ctx, 0); i != 0 || err != nil {
		t.Fatalf("IndexAt(0) = %d, %v", i, err)
	}
	if _, err := s.IndexAt(ctx, time.Hour); !errors.Is(err, webmopus.ErrStalled) {
		t.Fatalf("IndexAt(1h): %v", err)
	}
	if n, _, complete := s.Parsed(); n != len(pkts) || complete {
		t.Fatalf("Parsed: %d, %v", n, complete)
	}
}

func TestHeaderTimeout(t *testing.T) {
	data := webmtest.Simple(10).Bytes()
	for name, part := range map[string][]byte{"empty": nil, "half a header": data[:40]} {
		t.Run(name, func(t *testing.T) {
			path := writeSong(t, part)
			_, err := webmopus.OpenForTest(path, webmopus.NewGrowth(), fast(webmopus.TestOptions{Header: 30 * ms}))
			if !errors.Is(err, webmopus.ErrStalled) {
				t.Fatalf("Open: %v", err)
			}
		})
	}
	// Complete with a header cut short: not a valid file.
	path := writeSong(t, data[:40])
	g := webmopus.NewGrowth()
	g.Complete(path)
	if _, err := webmopus.OpenForTest(path, g, fast(webmopus.TestOptions{Header: time.Hour})); !errors.Is(err, webmopus.ErrInvalidAudio) {
		t.Fatalf("truncated, complete: %v", err)
	}
}

func TestCorruptMidFile(t *testing.T) {
	f := webmtest.Simple(150)
	data := f.Bytes()
	copy(data[len(data)/2:], make([]byte, 10))
	check := func(t *testing.T, s *webmopus.Source) {
		t.Helper()
		pkts, err := readAll(testCtx(t), s)
		if !errors.Is(err, webmopus.ErrInvalidAudio) || len(pkts) < 50 || len(pkts) >= 100 {
			t.Fatalf("after %d packets: %v", len(pkts), err)
		}
		samePackets(t, pkts[:50], parse(t, f).Packets[:50]) // the first cluster is intact
	}
	t.Run("whole", func(t *testing.T) {
		check(t, openT(t, writeSong(t, data), nil, webmopus.TestOptions{}))
	})
	t.Run("growing", func(t *testing.T) {
		path := songPath(t)
		w := newProgressive(t, path, data)
		check(t, openT(t, path, webmopus.NewGrowth(), webmopus.TestOptions{Poll: -1, OnWait: func(int64) { _, _ = w.Next(64) }}))
	})
}

func TestIndexAtWaitsForTheFile(t *testing.T) {
	f := unknownSizes(webmtest.Simple(150))
	data := f.Bytes()
	path := songPath(t)
	w := newProgressive(t, path, data)
	if err := w.To(len(data) / 3); err != nil {
		t.Fatal(err)
	}
	g := webmopus.NewGrowth()
	s := openT(t, path, g, webmopus.TestOptions{Stall: time.Hour})
	ctx := testCtx(t)
	type result struct {
		i   int
		err error
	}
	res := make(chan result, 1)
	go func() {
		i, err := s.IndexAt(ctx, 2*time.Second)
		res <- result{i, err}
	}()
	cctx, cancel := context.WithCancel(ctx)
	cres := make(chan error, 1)
	go func() {
		_, err := s.IndexAt(cctx, 2*time.Second)
		cres <- err
	}()
	if _, err := s.Packet(ctx, 10); err != nil { // the first third is parsed
		t.Fatal(err)
	}
	select {
	case r := <-res:
		t.Fatalf("answered before the data: %d, %v", r.i, r.err)
	default:
	}
	cancel()
	if err := <-cres; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled: %v", err)
	}
	if err := w.Rest(); err != nil {
		t.Fatal(err)
	}
	g.Complete(path)
	if r := <-res; r.i != 100 || r.err != nil {
		t.Fatalf("IndexAt(2s) = %d, %v", r.i, r.err)
	}
	for off, want := range map[time.Duration]int{time.Hour: 150, -time.Second: 0, 2980 * ms: 149} {
		if i, err := s.IndexAt(ctx, off); i != want || err != nil {
			t.Fatalf("IndexAt(%v) = %d, %v", off, i, err)
		}
	}
}

func TestClose(t *testing.T) {
	data := unknownSizes(webmtest.Simple(150)).Bytes()
	path := writeSong(t, data[:len(data)/2])
	s, err := webmopus.OpenForTest(path, webmopus.NewGrowth(), fast(webmopus.TestOptions{Stall: time.Hour, Poll: time.Hour}))
	if err != nil {
		t.Fatal(err)
	}
	ctx := testCtx(t)
	if _, err := s.Packet(ctx, 0); err != nil {
		t.Fatal(err)
	}
	errs := make(chan error, 2)
	go func() {
		_, err := s.Packet(ctx, 1000)
		errs <- err
	}()
	go func() {
		_, err := s.IndexAt(ctx, time.Hour)
		errs <- err
	}()
	// Close wakes the waiting calls, and the parser out of its (hour-long) poll.
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := <-errs; !errors.Is(err, fs.ErrClosed) {
			t.Fatalf("waiting call: %v", err)
		}
	}
	if err := s.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if _, err := s.Packet(ctx, 0); !errors.Is(err, fs.ErrClosed) {
		t.Fatalf("Packet after Close: %v", err)
	}
	if _, err := s.IndexAt(ctx, 0); !errors.Is(err, fs.ErrClosed) {
		t.Fatalf("IndexAt after Close: %v", err)
	}
	if n, _, complete := s.Parsed(); n != 0 || complete {
		t.Fatalf("Parsed after Close: %d, %v", n, complete)
	}
	if err := os.Remove(path); err != nil {
		t.Fatalf("the file is still held: %v", err)
	}
}

func TestPacketContext(t *testing.T) {
	data := unknownSizes(webmtest.Simple(150)).Bytes()
	s := openT(t, writeSong(t, data[:len(data)/2]), webmopus.NewGrowth(), webmopus.TestOptions{Stall: time.Hour})
	ctx, cancel := context.WithTimeout(context.Background(), 20*ms)
	defer cancel()
	if _, err := s.Packet(ctx, 1000); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Packet: %v", err)
	}
}

func TestRenameAndDeleteWhileOpen(t *testing.T) {
	f := unknownSizes(webmtest.Simple(100))
	data := f.Bytes()
	half := len(data) / 2

	t.Run("rename", func(t *testing.T) {
		path := writeSong(t, data[:half])
		g := webmopus.NewGrowth()
		s := openT(t, path, g, webmopus.TestOptions{Stall: time.Hour})
		if _, err := s.Packet(testCtx(t), 0); err != nil {
			t.Fatal(err)
		}
		moved := path + ".done"
		if err := os.Rename(path, moved); err != nil {
			t.Fatalf("rename while open: %v", err)
		}
		fa, err := os.OpenFile(moved, os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fa.Write(data[half:]); err != nil {
			t.Fatal(err)
		}
		if err := fa.Close(); err != nil {
			t.Fatal(err)
		}
		g.Complete(path) // by the name it was opened with
		samePackets(t, readWhole(t, s), parse(t, f).Packets)
	})
	t.Run("delete", func(t *testing.T) {
		path := writeSong(t, data[:half])
		g := webmopus.NewGrowth()
		s := openT(t, path, g, webmopus.TestOptions{Stall: time.Hour})
		if _, err := s.Packet(testCtx(t), 0); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(path); err != nil {
			t.Fatalf("delete while open: %v", err)
		}
		g.Fail(path)
		if _, err := readAll(testCtx(t), s); !errors.Is(err, webmopus.ErrFailed) {
			t.Fatalf("after Fail: %v", err)
		}
	})
}

func TestGrowthExpiry(t *testing.T) {
	g := webmopus.NewGrowth()
	now := time.Unix(1_000_000, 0)
	webmopus.SetGrowthClock(g, func() time.Time { return now })
	dir := t.TempDir()
	a, b := filepath.Join(dir, "a.webm"), filepath.Join(dir, "b.webm")
	if st := webmopus.GrowthState(g, a); st != "growing" {
		t.Fatalf("new: %s", st)
	}
	g.Complete(a)
	now = now.Add(5 * time.Minute)
	g.Fail(b)
	if st := webmopus.GrowthState(g, filepath.Join(dir, "x", "..", "a.webm")); st != "complete" {
		t.Fatalf("a: %s", st)
	}
	if wd, err := os.Getwd(); err == nil {
		if rel, err := filepath.Rel(wd, b); err == nil {
			if st := webmopus.GrowthState(g, rel); st != "failed" {
				t.Fatalf("b, relative: %s", st)
			}
		}
	}
	now = now.Add(5*time.Minute - 1)
	if st := webmopus.GrowthState(g, a); st != "complete" {
		t.Fatalf("a just before 10 minutes: %s", st)
	}
	now = now.Add(1)
	if st := webmopus.GrowthState(g, a); st != "growing" {
		t.Fatalf("a after 10 minutes: %s", st)
	}
	if st := webmopus.GrowthState(g, b); st != "failed" {
		t.Fatalf("b after 5 minutes: %s", st)
	}
	g.Complete(b) // the latest word wins, and restarts the 10 minutes
	now = now.Add(9 * time.Minute)
	if st := webmopus.GrowthState(g, b); st != "complete" {
		t.Fatalf("b: %s", st)
	}

	var none *webmopus.Growth // a nil Growth is a no-op
	none.Complete(a)
	none.Fail(a)
}

func TestGrowthKeyResolvesTheDirectory(t *testing.T) {
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	g := webmopus.NewGrowth()
	g.Complete(filepath.Join(link, "gone.webm")) // the file itself need not exist
	if st := webmopus.GrowthState(g, filepath.Join(real, "gone.webm")); st != "complete" {
		t.Fatalf("through the real directory: %s", st)
	}
}

func TestGrowthConcurrentUse(t *testing.T) {
	g := webmopus.NewGrowth()
	dir := t.TempDir()
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Go(func() {
			for j := range 200 {
				p := filepath.Join(dir, fmt.Sprintf("%d-%d.webm", i, j%5))
				if j%2 == 0 {
					g.Complete(p)
				} else {
					g.Fail(p)
				}
				_ = webmopus.GrowthState(g, p)
			}
		})
	}
	wg.Wait()
}

// largeFile is bigger than the read buffer, with an element to skip and a block bigger than it.
func largeFile() []byte {
	data := unknownSizes(webmtest.Simple(10000)).Bytes()                        // 200 s
	data = append(data, el(0x1254C367, bytes.Repeat([]byte{0xEC}, 200<<10))...) // Tags
	big := append(webmtest.Packet(webmtest.TOC20ms, 10000), bytes.Repeat([]byte{7}, 100<<10)...)
	return append(data, el(0x1F43B675, el(0xE7, []byte{0x03, 0x0D, 0x40}), // at 200 000 ms
		simpleBlock(1, 0, 0x80, big), simpleBlock(1, 20, 0x80, webmtest.Packet(webmtest.TOC20ms, 10001)))...)
}

func checkLarge(t *testing.T, pkts []webmopus.Packet) {
	t.Helper()
	if len(pkts) != 10002 {
		t.Fatalf("%d packets", len(pkts))
	}
	for i, p := range pkts {
		if p.TS != time.Duration(i)*20*ms || !bytes.Equal(p.Data[:4], webmtest.Packet(webmtest.TOC20ms, i)) {
			t.Fatalf("packet %d at %v: % x", i, p.TS, p.Data[:4])
		}
	}
	if len(pkts[10000].Data) != 4+100<<10 {
		t.Fatalf("big packet: %d bytes", len(pkts[10000].Data))
	}
}

func TestLargeFile(t *testing.T) {
	data := largeFile()
	tr, err := webmopus.Parse(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	checkLarge(t, tr.Packets)
	got, err := webmopus.ParseWith(data, 0, 7)
	if err != nil {
		t.Fatal(err)
	}
	checkLarge(t, got)
	checkLarge(t, readWhole(t, openT(t, writeSong(t, data), nil, webmopus.TestOptions{})))

	path := songPath(t)
	w := newProgressive(t, path, data)
	g := webmopus.NewGrowth()
	var wg sync.WaitGroup
	defer wg.Wait()
	wg.Go(func() {
		rng := rand.New(rand.NewPCG(1, 2))
		for !w.Done() {
			if _, err := w.Next(1 + rng.IntN(8<<10)); err != nil {
				t.Error(err)
				return
			}
			time.Sleep(10 * time.Microsecond)
		}
		g.Complete(path)
	})
	checkLarge(t, readWhole(t, openT(t, path, g, webmopus.TestOptions{Poll: 100 * time.Microsecond})))
}
