package webmopus

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"sort"
	"sync"
	"time"
)

// ErrFailed: Growth.Fail was called for the file (its upload will never finish).
var ErrFailed = errors.New("the file's upload failed")

// ErrStalled: the file is still growing but no new bytes arrived for StallTimeout (or its header
// did not arrive within HeaderTimeout) and nobody said it was complete.
var ErrStalled = errors.New("the file stopped growing")

const (
	// StallTimeout is how long a growing file may go without new bytes before ErrStalled.
	StallTimeout = 30 * time.Second
	// HeaderTimeout is how long Open waits for a growing file to exist and hold its header.
	HeaderTimeout = 10 * time.Second
	// PollInterval is how often the end of a growing file is checked for new bytes.
	PollInterval = 50 * time.Millisecond
)

// options are the timings of a Source (tests shorten them).
type options struct {
	poll, stall, header time.Duration
	limit               int64
	bufSize             int // 0: readBuffer
	now                 func() time.Time
	onWait              func(read int64) // before each poll, with the bytes read so far
}

func defaultOptions() options {
	return options{poll: PollInterval, stall: StallTimeout, header: HeaderTimeout, limit: MaxFileSize, now: time.Now}
}

// Source is an Opus-in-WebM file parsed incrementally, possibly while it is still being
// written: a goroutine parses it to its end into memory while readers take the packets parsed
// so far, waiting for the next ones. Its methods are safe for concurrent use.
type Source struct {
	key      string // in Growth
	growth   *Growth
	opts     options
	f        *os.File
	channels int

	// Owned by Open, then by the parsing goroutine.
	r            *reader
	d            *demuxer
	headerDone   bool
	deadline     time.Time // for the header
	lastRead     int64
	lastProgress time.Time
	sawComplete  bool

	stop      chan struct{} // closed by Close
	done      chan struct{} // closed when the parsing goroutine returns
	fileOnce  sync.Once
	fileErr   error
	closeOnce sync.Once

	mu       sync.Mutex
	changed  chan struct{} // closed (and replaced) at every change below
	packets  []Packet
	finished bool  // parsing ended
	err      error // why, when not at the end of a whole file
	closed   bool
}

// Open opens a WebM/Opus file and validates its header (up to the tracks) before returning:
// content errors wrap ErrInvalidAudio, a missing file is an fs.ErrNotExist error. The clusters
// are then parsed in a goroutine.
//
// growth == nil: the file is whole (and at most MaxFileSize bytes). growth != nil: the file may
// still grow. Open waits up to HeaderTimeout for it to exist and hold its header (ErrStalled
// after that; ErrFailed when the writer failed it), and at the file's current end the parser
// polls for more bytes until growth says complete (then the real end is io.EOF) or failed
// (ErrFailed), or until StallTimeout passes without new bytes (ErrStalled). A Segment of known
// size ends the file without waiting for Complete.
//
// On Windows the file is opened so that the writer can still rename or delete it.
func Open(path string, growth *Growth) (*Source, error) {
	return open(path, growth, defaultOptions())
}

func open(path string, growth *Growth, o options) (*Source, error) {
	now := o.now()
	s := &Source{
		key: growthKey(path), growth: growth, opts: o,
		deadline: now.Add(o.header), lastProgress: now,
		stop: make(chan struct{}), done: make(chan struct{}), changed: make(chan struct{}),
	}
	f, err := s.openFile(path)
	if err != nil {
		return nil, err
	}
	s.f = f
	var wait func() error
	if growth != nil {
		wait = s.wait
	}
	s.r = newReader(f, o.limit, wait)
	if o.bufSize > 0 {
		s.r.buf = make([]byte, o.bufSize)
	}
	s.d = newDemuxer(s.r, s.publish)
	if err := s.d.header(); err != nil {
		_ = f.Close()
		return nil, err
	}
	s.channels = s.d.channels
	s.headerDone = true
	go s.run()
	return s, nil
}

// openFile opens the file, waiting for a growing one to exist.
func (s *Source) openFile(path string) (*os.File, error) {
	for {
		if s.growth.state(s.key) == failed {
			return nil, ErrFailed
		}
		f, err := openShared(path)
		if err == nil {
			info, err := f.Stat()
			switch {
			case err != nil:
			case !info.Mode().IsRegular():
				err = fmt.Errorf("%s: not a regular file", path)
			case info.Size() > s.opts.limit:
				err = errTooLarge(s.opts.limit)
			default:
				return f, nil
			}
			_ = f.Close()
			return nil, err
		}
		if s.growth == nil || !errors.Is(err, fs.ErrNotExist) || s.growth.state(s.key) == grown ||
			!s.opts.now().Before(s.deadline) {
			return nil, err
		}
		time.Sleep(s.opts.poll)
	}
}

// wait is called by the reader at the current end of a growing file.
func (s *Source) wait() error {
	s.d.flush() // hand out what is parsed before sleeping: a cluster can be long
	now := s.opts.now()
	if s.r.read != s.lastRead {
		s.lastRead, s.lastProgress = s.r.read, now
	}
	if s.sawComplete {
		return io.EOF
	}
	switch s.growth.state(s.key) {
	case failed:
		return ErrFailed
	case grown:
		// Read once more: everything written before Complete is there now.
		s.sawComplete = true
		return nil
	}
	if !s.headerDone {
		if !now.Before(s.deadline) {
			return fmt.Errorf("%w: no complete header after %v", ErrStalled, s.opts.header)
		}
	} else if now.Sub(s.lastProgress) >= s.opts.stall {
		return fmt.Errorf("%w: no new data for %v", ErrStalled, s.opts.stall)
	}
	if s.opts.onWait != nil {
		s.opts.onWait(s.r.read)
	}
	if s.opts.poll <= 0 { // tests whose hook writes the file
		select {
		case <-s.stop:
			return fs.ErrClosed
		default:
			return nil
		}
	}
	t := time.NewTimer(s.opts.poll)
	defer t.Stop()
	select {
	case <-s.stop:
		return fs.ErrClosed
	case <-t.C:
		return nil
	}
}

func (s *Source) run() {
	defer close(s.done)
	err := s.d.body()
	s.d.flush()
	_ = s.closeFile() // everything is in memory now
	s.mu.Lock()
	defer s.mu.Unlock()
	if err == nil && len(s.packets) == 0 {
		err = invalid("no Opus packets")
	}
	s.finished, s.err = true, err
	s.broadcastLocked()
}

func (s *Source) closeFile() error {
	s.fileOnce.Do(func() { s.fileErr = s.f.Close() })
	return s.fileErr
}

func (s *Source) publish(p []Packet) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed {
		s.packets = append(s.packets, p...)
		s.broadcastLocked()
	}
}

func (s *Source) broadcastLocked() {
	close(s.changed)
	s.changed = make(chan struct{})
}

// await calls ready under the lock until it returns true, waiting for a change in between.
func (s *Source) await(ctx context.Context, ready func() bool) error {
	for {
		s.mu.Lock()
		ok, ch := ready(), s.changed
		s.mu.Unlock()
		if ok {
			return nil
		}
		select {
		case <-ch:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// Channels is 1 or 2, from OpusHead.
func (s *Source) Channels() int { return s.channels }

// Packet returns packet i, waiting until it is parsed. Past the last packet it returns io.EOF
// when the file is whole, else why parsing stopped: ErrStalled, ErrInvalidAudio (corrupt data
// later in the file) or a read error. ErrFailed is returned for every i as soon as the writer
// fails the file (the song stops). ctx.Err() when ctx ends first; fs.ErrClosed after Close.
func (s *Source) Packet(ctx context.Context, i int) (Packet, error) {
	if i < 0 {
		return Packet{}, fmt.Errorf("webmopus: packet %d", i)
	}
	var p Packet
	var err error
	if werr := s.await(ctx, func() bool {
		switch {
		case s.closed:
			err = fs.ErrClosed
		case errors.Is(s.err, ErrFailed):
			err = s.err
		case i < len(s.packets):
			p = s.packets[i]
		case s.finished:
			err = s.err
			if err == nil {
				err = io.EOF
			}
		default:
			return false
		}
		return true
	}); werr != nil {
		return Packet{}, werr
	}
	return p, err
}

// IndexAt returns the index of the first packet starting at or after off, waiting while the
// file grows; past the end of a whole file it returns the number of packets. Errors as Packet.
func (s *Source) IndexAt(ctx context.Context, off time.Duration) (int, error) {
	var idx int
	var err error
	if werr := s.await(ctx, func() bool {
		n := len(s.packets)
		switch {
		case s.closed:
			err = fs.ErrClosed
		case errors.Is(s.err, ErrFailed):
			err = s.err
		case (n > 0 && s.packets[n-1].TS >= off) || (s.finished && s.err == nil):
			idx = sort.Search(n, func(i int) bool { return s.packets[i].TS >= off })
		case s.finished:
			err = s.err
		default:
			return false
		}
		return true
	}); werr != nil {
		return 0, werr
	}
	return idx, err
}

// Parsed returns how many packets are available now, the end of the last one, and whether the
// whole file has been parsed (its real end reached, without error).
func (s *Source) Parsed() (n int, end time.Duration, complete bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n = len(s.packets)
	if n > 0 {
		last := s.packets[n-1]
		end = last.TS + last.Dur
	}
	return n, end, s.finished && s.err == nil
}

// Close stops the parsing, releases the file and the packets, and wakes every waiting call
// (they return fs.ErrClosed). Calling it again does nothing.
func (s *Source) Close() error {
	var err error
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		s.packets = nil
		s.broadcastLocked()
		s.mu.Unlock()
		close(s.stop)
		<-s.done
		err = s.closeFile()
	})
	return err
}
