package webmopus

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"sort"
	"time"
)

// Matroska element IDs read here.
const (
	idEBML              = 0x1A45DFA3
	idDocType           = 0x4282
	idSegment           = 0x18538067
	idSeekHead          = 0x114D9B74
	idInfo              = 0x1549A966
	idTimecodeScale     = 0x2AD7B1
	idTracks            = 0x1654AE6B
	idTrackEntry        = 0xAE
	idTrackNumber       = 0xD7
	idCodecID           = 0x86
	idCodecPrivate      = 0x63A2
	idAudio             = 0xE1
	idSamplingFrequency = 0xB5
	idCluster           = 0x1F43B675
	idTimecode          = 0xE7
	idSimpleBlock       = 0xA3
	idBlockGroup        = 0xA0
	idBlock             = 0xA1
	idCues              = 0x1C53BB6B
	idChapters          = 0x1043A770
	idTags              = 0x1254C367
	idAttachments       = 0x1941A469
)

// topLevel reports whether id is a Segment child (or starts a new file): what ends an
// unknown-size Cluster.
func topLevel(id uint32) bool {
	switch id {
	case idCluster, idCues, idTags, idSeekHead, idInfo, idTracks, idChapters, idAttachments, idEBML, idSegment:
		return true
	}
	return false
}

// eof reports whether err is the end of a whole stream (a truncated file ends there too: the
// whole packets before it are kept).
func eof(err error) bool { return errors.Is(err, io.EOF) }

// block is one parsed Block of the Opus track.
type block struct {
	ts     int64 // ns, absolute
	frames [][]byte
	durs   []time.Duration
}

// demuxer parses a WebM stream element by element: header first, then clusters, handing out
// packets as clusters (or the parsed part of one, when the stream has to wait) are read.
type demuxer struct {
	r       *reader
	publish func([]Packet)

	// From the header.
	scale    int64 // ns per timecode unit
	track    uint64
	channels int
	preSkip  uint16
	segEnd   int64 // where the Segment ends; sizeUnknown when its size is
	gotInfo  bool
	gotTrack bool

	clusterTC int64
	clusters  int
	pending   []block // parsed, not handed out yet (sorted by timestamp first)
	started   bool
	first     int64 // ns, of the first block handed out
	last      int64 // ns, of the latest block handed out
}

func newDemuxer(r *reader, publish func([]Packet)) *demuxer {
	return &demuxer{r: r, publish: publish, scale: 1_000_000, segEnd: sizeUnknown}
}

// readPayload reads the payload of an in-memory element (a leaf, or a small master).
func (d *demuxer) readPayload(e element) ([]byte, error) {
	if e.size == sizeUnknown {
		return nil, invalid("unknown-size element %#x", e.id)
	}
	if e.size > maxLeafSize {
		return nil, invalid("element %#x of %d bytes", e.id, e.size)
	}
	d.r.consume(e.hdr)
	return d.r.readFull(e.size)
}

func (d *demuxer) skip(e element) error {
	if e.size == sizeUnknown {
		return invalid("unknown-size element %#x", e.id)
	}
	d.r.consume(e.hdr)
	return d.r.skip(e.size)
}

// atSegmentEnd reports whether the known-size Segment has been read whole (nothing after it is
// read, so a growing file whose Segment is complete is done without waiting).
func (d *demuxer) atSegmentEnd() bool { return d.segEnd != sizeUnknown && d.r.pos >= d.segEnd }

// header reads up to the tracks and validates the Opus track. Content errors wrap
// ErrInvalidAudio; reading errors (and ErrFailed, ErrStalled) are returned as they are.
func (d *demuxer) header() error {
	magic, err := d.r.peek(4)
	if err != nil {
		if eof(err) {
			return invalid("not a WebM file")
		}
		return err
	}
	if !bytes.Equal(magic, []byte{0x1A, 0x45, 0xDF, 0xA3}) {
		return invalid("not a WebM file")
	}
	e, err := d.r.peekElement()
	if err != nil {
		return d.headerErr(err)
	}
	payload, err := d.readPayload(e)
	if err != nil {
		return d.headerErr(err)
	}
	var docType string
	if err := children(payload, func(id uint32, b []byte) error {
		if id == idDocType {
			docType = str(b)
		}
		return nil
	}); err != nil {
		return err
	}
	if docType != "webm" && docType != "matroska" {
		return invalid("unsupported document type %q", docType)
	}

	for { // the Segment (other top-level elements before it are skipped)
		e, err := d.r.peekElement()
		if err != nil {
			return d.headerErr(err)
		}
		if e.id == idSegment {
			d.r.consume(e.hdr)
			if e.size != sizeUnknown {
				d.segEnd = d.r.pos + e.size
			}
			break
		}
		if err := d.skip(e); err != nil {
			return d.headerErr(err)
		}
	}

	// Segment children up to the tracks (or the first cluster).
	for !d.gotTrack || !d.gotInfo {
		if d.atSegmentEnd() {
			break
		}
		e, err := d.r.peekElement()
		if eof(err) {
			break
		}
		if err != nil {
			return err
		}
		if e.id == idCluster || e.id == idEBML || e.id == idSegment {
			break
		}
		if err := d.level1(e); err != nil {
			return d.headerErr(err)
		}
	}
	return d.validate()
}

// headerErr maps the end of the stream inside the header to an invalid file.
func (d *demuxer) headerErr(err error) error {
	if eof(err) {
		return invalid("truncated header")
	}
	return err
}

// level1 handles a Segment child other than a Cluster.
func (d *demuxer) level1(e element) error {
	switch {
	case e.id == idInfo && d.clusters == 0 && !d.gotInfo:
		payload, err := d.readPayload(e)
		if err != nil {
			return err
		}
		d.gotInfo = true
		return d.info(payload)
	case e.id == idTracks && !d.gotTrack:
		payload, err := d.readPayload(e)
		if err != nil {
			return err
		}
		d.gotTrack = true
		return d.tracks(payload)
	}
	if d.segEnd != sizeUnknown && e.size != sizeUnknown && d.r.pos+int64(e.hdr)+e.size > d.segEnd {
		return invalid("element %#x overflows the segment", e.id)
	}
	return d.skip(e)
}

func (d *demuxer) info(payload []byte) error {
	return children(payload, func(id uint32, b []byte) error {
		if id == idTimecodeScale {
			v, err := uintValue(b)
			if err != nil {
				return err
			}
			if v > 0 && v <= math.MaxInt64/2 {
				d.scale = int64(v)
			}
		}
		return nil
	})
}

type trackEntry struct {
	number       uint64
	codecID      string
	codecPrivate []byte
	rate         float64
}

func (d *demuxer) tracks(payload []byte) error {
	var opus *trackEntry
	err := children(payload, func(id uint32, b []byte) error {
		if id != idTrackEntry || opus != nil {
			return nil
		}
		var te trackEntry
		err := children(b, func(id uint32, b []byte) error {
			var err error
			switch id {
			case idTrackNumber:
				te.number, err = uintValue(b)
			case idCodecID:
				te.codecID = str(b)
			case idCodecPrivate:
				te.codecPrivate = b
			case idAudio:
				err = children(b, func(id uint32, b []byte) error {
					if id == idSamplingFrequency {
						var err error
						te.rate, err = floatValue(b)
						return err
					}
					return nil
				})
			}
			return err
		})
		if err != nil {
			return err
		}
		if te.codecID == "A_OPUS" {
			opus = &te
		}
		return nil
	})
	if err != nil {
		return err
	}
	if opus == nil {
		d.gotTrack = false // another Tracks element may still have it
		return nil
	}
	d.track = opus.number
	if opus.rate != 0 && opus.rate != SampleRate {
		return invalid("sample rate %v Hz (Opus in WebM is 48000)", opus.rate)
	}
	// OpusHead (RFC 7845 §5.1): "OpusHead" version channels pre-skip(le16) rate(le32) gain(le16) family.
	cp := opus.codecPrivate
	if len(cp) < 19 || string(cp[:8]) != "OpusHead" {
		return invalid("missing OpusHead")
	}
	if cp[8]&0xF0 != 0 {
		return invalid("unsupported OpusHead version %d", cp[8])
	}
	if family := cp[18]; family != 0 {
		return invalid("unsupported Opus channel mapping family %d", family)
	}
	d.channels = int(cp[9])
	if d.channels < 1 || d.channels > 2 {
		return invalid("%d channels (mono or stereo only)", d.channels)
	}
	d.preSkip = binary.LittleEndian.Uint16(cp[10:12])
	return nil
}

func (d *demuxer) validate() error {
	if !d.gotTrack {
		return invalid("no Opus track")
	}
	return nil
}

// body reads the clusters to the end of the Segment (or of the stream: nil) and hands out
// their packets.
func (d *demuxer) body() error {
	for {
		if d.atSegmentEnd() {
			return nil
		}
		e, err := d.r.peekElement()
		if eof(err) {
			return nil
		}
		if err != nil {
			return err
		}
		switch e.id {
		case idCluster:
			d.r.consume(e.hdr)
			err = d.cluster(e.size)
		case idEBML, idSegment: // another file follows: not ours
			return nil
		default:
			err = d.level1(e)
		}
		if eof(err) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// cluster reads one cluster's children (its header already consumed). An unknown-size cluster
// ends at the next top-level element, or with the Segment or the stream.
func (d *demuxer) cluster(size int64) error {
	d.clusters++
	d.clusterTC = 0
	defer d.flush()
	end := d.segEnd
	if size != sizeUnknown {
		end = d.r.pos + size
		if d.segEnd != sizeUnknown && end > d.segEnd {
			return invalid("cluster overflows the segment")
		}
	}
	for {
		if end != sizeUnknown && d.r.pos >= end {
			return nil
		}
		e, err := d.r.peekElement()
		if err != nil {
			return err
		}
		if size == sizeUnknown && topLevel(e.id) {
			return nil
		}
		if end != sizeUnknown && e.size != sizeUnknown && d.r.pos+int64(e.hdr)+e.size > end {
			return invalid("element %#x overflows its cluster", e.id)
		}
		switch e.id {
		case idTimecode:
			b, err := d.readPayload(e)
			if err != nil {
				return err
			}
			v, err := uintValue(b)
			if err != nil {
				return err
			}
			d.clusterTC = int64(v)
		case idSimpleBlock:
			b, err := d.readPayload(e)
			if err != nil {
				return err
			}
			if err := d.block(b); err != nil {
				return err
			}
		case idBlockGroup:
			b, err := d.readPayload(e)
			if err != nil {
				return err
			}
			// BlockDuration and DiscardPadding are not needed: durations come from each
			// packet's TOC, and the receiver decodes the padding like any other sample.
			done := false
			if err := children(b, func(id uint32, b []byte) error {
				if id != idBlock || done {
					return nil
				}
				done = true
				return d.block(b)
			}); err != nil {
				return err
			}
		default:
			if err := d.skip(e); err != nil {
				return err
			}
		}
	}
}

// block parses a Block (or SimpleBlock) payload; blocks of other tracks are ignored.
func (d *demuxer) block(b []byte) error {
	track, n, _, ok := vint(b)
	if !ok {
		return invalid("bad block track number")
	}
	if track != d.track {
		return nil
	}
	if len(b) < n+3 {
		return invalid("short block")
	}
	tc := int16(binary.BigEndian.Uint16(b[n:]))
	flags := b[n+2]
	frames, err := unlace(flags, b[n+3:])
	if err != nil {
		return err
	}
	ts := (d.clusterTC + int64(tc)) * d.scale
	durs := make([]time.Duration, len(frames))
	for i, fr := range frames {
		s, err := PacketSamples(fr)
		if err != nil {
			return invalid("packet at %v: %v", time.Duration(ts), err)
		}
		durs[i] = samplesToDuration(s)
	}
	d.pending = append(d.pending, block{ts: ts, frames: frames, durs: durs})
	return nil
}

// unlace splits a block's data into its frames (Matroska lacing: none, Xiph, fixed or EBML).
func unlace(flags byte, data []byte) ([][]byte, error) {
	lacing := flags >> 1 & 3
	if lacing == 0 {
		return [][]byte{data}, nil
	}
	if len(data) < 1 {
		return nil, invalid("laced block without a frame count")
	}
	count := int(data[0]) + 1
	data = data[1:]
	sizes := make([]int, count)
	known := 0 // sum of the coded sizes (every frame but the last)
	switch lacing {
	case 1: // Xiph
		for i := 0; i < count-1; i++ {
			for {
				if len(data) == 0 {
					return nil, invalid("bad Xiph lacing")
				}
				c := data[0]
				data = data[1:]
				sizes[i] += int(c)
				if c != 255 {
					break
				}
			}
			known += sizes[i]
		}
	case 3: // EBML: the first size, then signed differences
		for i := 0; i < count-1; i++ {
			v, n, _, ok := vint(data)
			if !ok {
				return nil, invalid("bad EBML lacing")
			}
			data = data[n:]
			if i == 0 {
				if v > uint64(len(data)) {
					return nil, invalid("bad EBML lacing")
				}
				sizes[0] = int(v)
			} else {
				diff := int64(v) - (1<<(7*n-1) - 1)
				s := int64(sizes[i-1]) + diff
				if s < 0 || s > int64(len(data)) {
					return nil, invalid("bad EBML lacing")
				}
				sizes[i] = int(s)
			}
			known += sizes[i]
		}
	case 2: // fixed
		if len(data)%count != 0 {
			return nil, invalid("bad fixed lacing")
		}
		for i := range sizes {
			sizes[i] = len(data) / count
		}
		known = len(data) - sizes[count-1]
	}
	if known > len(data) {
		return nil, invalid("laced frames longer than their block")
	}
	sizes[count-1] = len(data) - known
	frames := make([][]byte, count)
	for i, s := range sizes {
		frames[i] = data[:s:s]
		data = data[s:]
	}
	return frames, nil
}

// flush hands out the pending blocks in timestamp order (a cluster may store them out of
// order). A block earlier than one already handed out is dropped: it is too late to play it.
func (d *demuxer) flush() {
	if len(d.pending) == 0 {
		return
	}
	sort.SliceStable(d.pending, func(i, j int) bool { return d.pending[i].ts < d.pending[j].ts })
	var out []Packet
	for _, b := range d.pending {
		if d.started && b.ts < d.last {
			continue
		}
		if !d.started {
			d.started, d.first = true, b.ts
		}
		d.last = b.ts
		ts := time.Duration(b.ts - d.first)
		for i, fr := range b.frames {
			out = append(out, Packet{TS: ts, Dur: b.durs[i], Data: fr})
			ts += b.durs[i]
		}
	}
	clear(d.pending)
	d.pending = d.pending[:0]
	if len(out) > 0 {
		d.publish(out)
	}
}

// children calls fn for each child of an in-memory master element.
func children(data []byte, fn func(id uint32, payload []byte) error) error {
	for len(data) > 0 {
		e, short, err := parseElement(data)
		if err != nil {
			return err
		}
		if short {
			return invalid("truncated element header")
		}
		if e.size == sizeUnknown || e.size > int64(len(data)-e.hdr) {
			return invalid("element %#x overflows its parent", e.id)
		}
		end := e.hdr + int(e.size)
		if err := fn(e.id, data[e.hdr:end:end]); err != nil {
			return err
		}
		data = data[end:]
	}
	return nil
}

func uintValue(b []byte) (uint64, error) {
	if len(b) > 8 {
		return 0, invalid("integer of %d bytes", len(b))
	}
	var v uint64
	for _, c := range b {
		v = v<<8 | uint64(c)
	}
	return v, nil
}

func floatValue(b []byte) (float64, error) {
	switch len(b) {
	case 0:
		return 0, nil
	case 4:
		return float64(math.Float32frombits(binary.BigEndian.Uint32(b))), nil
	case 8:
		return math.Float64frombits(binary.BigEndian.Uint64(b)), nil
	}
	return 0, invalid("float of %d bytes", len(b))
}

// str decodes an EBML string (null padding removed).
func str(b []byte) string { return string(bytes.TrimRight(b, "\x00")) }
