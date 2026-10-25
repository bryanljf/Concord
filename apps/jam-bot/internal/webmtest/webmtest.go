// Package webmtest builds small WebM/Opus files for tests, with ebml-go's marshaller. The Opus
// packets are not decodable audio: only their TOC byte is meaningful (it sets each duration).
package webmtest

import (
	"bytes"
	"encoding/binary"
	"os"
	"time"

	"github.com/at-wat/ebml-go"
	"github.com/at-wat/ebml-go/webm"
)

// TOC bytes of CELT fullband stereo packets (RFC 6716 §3.1), code 0 (one frame).
const (
	TOC10ms = 30<<3 | 0x04
	TOC20ms = 31<<3 | 0x04
)

// Block is one SimpleBlock (or BlockGroup) of the Opus track.
type Block struct {
	Timecode int16 // relative to the cluster, in TimecodeScale units
	Frames   [][]byte
	Lacing   ebml.LacingMode
	Group    bool  // a BlockGroup instead of a SimpleBlock
	Discard  int64 // DiscardPadding (BlockGroup only), ns
	Track    uint64
}

// Cluster groups blocks under one timecode.
type Cluster struct {
	Timecode uint64
	Blocks   []Block
}

// File describes a WebM file; New fills sensible defaults.
type File struct {
	DocType       string
	CodecID       string
	Channels      int     // in OpusHead and the Audio element
	Family        byte    // OpusHead channel mapping family
	SampleRate    float64 // Audio element
	CodecPrivate  []byte  // overrides the generated OpusHead when not nil
	TimecodeScale uint64
	Clusters      []Cluster

	// Unknown sizes, as a live muxer writes them: the Segment runs to the end of the file, a
	// Cluster to the next top-level element.
	UnknownSizeSegment  bool
	UnknownSizeClusters bool
}

// New is a stereo 48 kHz Opus file with no clusters yet.
func New() File {
	return File{DocType: "webm", CodecID: "A_OPUS", Channels: 2, SampleRate: 48000, TimecodeScale: 1_000_000}
}

// OpusHead builds the CodecPrivate of an Opus track (RFC 7845 §5.1), pre-skip 312.
func OpusHead(channels int, family byte) []byte {
	b := []byte("OpusHead")
	b = append(b, 1, byte(channels))
	b = binary.LittleEndian.AppendUint16(b, 312)
	b = binary.LittleEndian.AppendUint32(b, 48000)
	b = binary.LittleEndian.AppendUint16(b, 0)
	return append(b, family)
}

// Packet is an Opus packet with the given TOC byte and a payload marking its index.
func Packet(toc byte, index int) []byte {
	return []byte{toc, byte(index >> 8), byte(index), 0xA5}
}

// Simple returns a file of n 20 ms packets, one SimpleBlock each, 50 per cluster (1 s).
func Simple(n int) File {
	f := New()
	for i := 0; i < n; i++ {
		if i%50 == 0 {
			f.Clusters = append(f.Clusters, Cluster{Timecode: uint64(i * 20)})
		}
		cl := &f.Clusters[len(f.Clusters)-1]
		cl.Blocks = append(cl.Blocks, Block{
			Timecode: int16(uint64(i*20) - cl.Timecode),
			Frames:   [][]byte{Packet(TOC20ms, i)},
		})
	}
	return f
}

// SimpleDuration is Simple long enough for d (rounded up to 20 ms).
func SimpleDuration(d time.Duration) File {
	return Simple(int((d + 20*time.Millisecond - 1) / (20 * time.Millisecond)))
}

type blockGroup struct {
	Block          ebml.Block `ebml:"Block"`
	DiscardPadding int64      `ebml:"DiscardPadding,omitempty"`
}

type cluster struct {
	Timecode    uint64       `ebml:"Timecode"`
	SimpleBlock []ebml.Block `ebml:"SimpleBlock"`
	BlockGroup  []blockGroup `ebml:"BlockGroup"`
}

type segment struct {
	Info    webm.Info   `ebml:"Info"`
	Tracks  webm.Tracks `ebml:"Tracks"`
	Cluster []cluster   `ebml:"Cluster"`
}

// segmentUC is a segment whose clusters have an unknown size.
type segmentUC struct {
	Info    webm.Info   `ebml:"Info"`
	Tracks  webm.Tracks `ebml:"Tracks"`
	Cluster []cluster   `ebml:"Cluster,size=unknown"`
}

type file[S any] struct {
	Header  webm.EBMLHeader `ebml:"EBML"`
	Segment S               `ebml:"Segment"`
}

// fileUS is a file whose segment has an unknown size.
type fileUS[S any] struct {
	Header  webm.EBMLHeader `ebml:"EBML"`
	Segment S               `ebml:"Segment,size=unknown"`
}

// Bytes marshals the file. Within a cluster every SimpleBlock comes before every BlockGroup,
// whatever their timecodes (that is what readers must reorder).
func (f File) Bytes() []byte {
	cp := f.CodecPrivate
	if cp == nil {
		cp = OpusHead(f.Channels, f.Family)
	}
	header := webm.EBMLHeader{
		EBMLVersion: 1, EBMLReadVersion: 1, EBMLMaxIDLength: 4, EBMLMaxSizeLength: 8,
		DocType: f.DocType, DocTypeVersion: 4, DocTypeReadVersion: 2,
	}
	seg := segment{
		Info: webm.Info{TimecodeScale: f.TimecodeScale, MuxingApp: "webmtest", WritingApp: "webmtest"},
		Tracks: webm.Tracks{TrackEntry: []webm.TrackEntry{{
			Name: "Audio", TrackNumber: 1, TrackUID: 1, CodecID: f.CodecID, CodecPrivate: cp,
			CodecDelay: 6_500_000, TrackType: 2, SeekPreRoll: 80_000_000,
			Audio: &webm.Audio{SamplingFrequency: f.SampleRate, Channels: uint64(f.Channels)},
		}}},
	}
	for _, c := range f.Clusters {
		cl := cluster{Timecode: c.Timecode}
		for _, b := range c.Blocks {
			track := b.Track
			if track == 0 {
				track = 1
			}
			eb := ebml.Block{TrackNumber: track, Timecode: b.Timecode, Keyframe: !b.Group, Lacing: b.Lacing, Data: b.Frames}
			if b.Group {
				cl.BlockGroup = append(cl.BlockGroup, blockGroup{Block: eb, DiscardPadding: b.Discard})
			} else {
				cl.SimpleBlock = append(cl.SimpleBlock, eb)
			}
		}
		seg.Cluster = append(seg.Cluster, cl)
	}
	var out any
	switch uc := segmentUC(seg); {
	case f.UnknownSizeSegment && f.UnknownSizeClusters:
		out = &fileUS[segmentUC]{header, uc}
	case f.UnknownSizeSegment:
		out = &fileUS[segment]{header, seg}
	case f.UnknownSizeClusters:
		out = &file[segmentUC]{header, uc}
	default:
		out = &file[segment]{header, seg}
	}
	var buf bytes.Buffer
	if err := ebml.Marshal(out, &buf); err != nil {
		panic(err) // only fixed test structures get here
	}
	return buf.Bytes()
}

// Progressive writes a file in steps, as a streaming upload does: NewProgressive creates it
// empty, each Next appends the following bytes of data.
type Progressive struct {
	f    *os.File
	data []byte
	n    int
}

// NewProgressive creates (or truncates) the file at path.
func NewProgressive(path string, data []byte) (*Progressive, error) {
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	return &Progressive{f: f, data: data}, nil
}

// Next appends up to n more bytes and returns how many are written in all.
func (p *Progressive) Next(n int) (int, error) {
	n = min(n, len(p.data)-p.n)
	if n <= 0 {
		return p.n, nil
	}
	w, err := p.f.Write(p.data[p.n : p.n+n])
	p.n += w
	return p.n, err
}

// To appends bytes up to offset off (the whole data at most).
func (p *Progressive) To(off int) error {
	_, err := p.Next(off - p.n)
	return err
}

// Rest appends everything not written yet.
func (p *Progressive) Rest() error { return p.To(len(p.data)) }

// Written is how many bytes are in the file.
func (p *Progressive) Written() int { return p.n }

// Done reports whether the whole data is written.
func (p *Progressive) Done() bool { return p.n == len(p.data) }

// Close closes the file (what is not written yet stays unwritten).
func (p *Progressive) Close() error { return p.f.Close() }

// WriteProgressively writes data to path in chunks of the given sizes (cycling through them),
// calling after with the bytes written so far after each chunk.
func WriteProgressively(path string, data []byte, chunks []int, after func(written int)) error {
	p, err := NewProgressive(path, data)
	if err != nil {
		return err
	}
	for i := 0; !p.Done(); i++ {
		n, err := p.Next(chunks[i%len(chunks)])
		if err != nil {
			_ = p.Close()
			return err
		}
		if after != nil {
			after(n)
		}
	}
	return p.Close()
}
