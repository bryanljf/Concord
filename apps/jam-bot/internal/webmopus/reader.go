package webmopus

import (
	"io"
	"math/bits"
)

// reader is a forward-only buffered reader over a stream that may still be growing. It never
// hands out part of what was asked: a caller gets all n bytes or an error, so an element half
// written at the current end of a growing file is read again, whole, once the rest arrives.
type reader struct {
	src io.Reader
	// wait is called when src is at its end and more bytes are needed: nil to read again, io.EOF
	// when the stream is whole, any other error to give up. nil means the stream is whole.
	wait  func() error
	limit int64 // the stream may not be longer than this

	buf        []byte
	start, end int   // unread bytes: buf[start:end]
	pos        int64 // stream offset of buf[start]
	read       int64 // bytes read from src: pos + end - start
	err        error // sticky: io.EOF at the end of a whole stream, or why reading stopped
}

// readBuffer is the reader's buffer size (what is read from the file at once).
const readBuffer = 64 << 10

func newReader(src io.Reader, limit int64, wait func() error) *reader {
	return &reader{src: src, wait: wait, limit: limit, buf: make([]byte, readBuffer)}
}

func errTooLarge(limit int64) error {
	return invalid("file larger than %d MB", limit>>20)
}

// more reads at least one byte into dst, waiting while the stream grows.
func (r *reader) more(dst []byte) (int, error) {
	if r.err != nil {
		return 0, r.err
	}
	// Read one byte past the limit at most: an error only if the stream does go past it.
	if left := r.limit + 1 - r.read; int64(len(dst)) > left {
		dst = dst[:left]
	}
	for empty := 0; ; {
		n, err := r.src.Read(dst)
		if n > 0 {
			r.read += int64(n)
			if r.read > r.limit {
				r.err = errTooLarge(r.limit)
				return 0, r.err
			}
			if err != nil && err != io.EOF {
				r.err = err // returned by the next call
			}
			return n, nil
		}
		switch {
		case err == io.EOF:
			if r.wait == nil {
				r.err = io.EOF
				return 0, r.err
			}
			if werr := r.wait(); werr != nil {
				r.err = werr
				return 0, r.err
			}
		case err != nil:
			r.err = err
			return 0, r.err
		default:
			if empty++; empty > 100 {
				r.err = io.ErrNoProgress
				return 0, r.err
			}
		}
	}
}

// ensure buffers at least n bytes.
func (r *reader) ensure(n int) error {
	for r.end-r.start < n {
		if need := n - (r.end - r.start); len(r.buf)-r.end < need {
			if len(r.buf) < n {
				nb := make([]byte, max(n, 2*len(r.buf)))
				copy(nb, r.buf[r.start:r.end])
				r.buf = nb
			} else {
				copy(r.buf, r.buf[r.start:r.end])
			}
			r.end -= r.start
			r.start = 0
		}
		m, err := r.more(r.buf[r.end:])
		r.end += m
		if err != nil {
			return err
		}
	}
	return nil
}

// peek returns the next n bytes without consuming them; they are valid until the next call.
func (r *reader) peek(n int) ([]byte, error) {
	if err := r.ensure(n); err != nil {
		return nil, err
	}
	return r.buf[r.start : r.start+n], nil
}

// consume drops n bytes that peek returned.
func (r *reader) consume(n int) {
	r.start += n
	r.pos += int64(n)
}

// readFull returns the next n bytes in a new slice.
func (r *reader) readFull(n int64) ([]byte, error) {
	dst := make([]byte, n)
	c := copy(dst, r.buf[r.start:r.end])
	r.consume(c)
	for int64(c) < n {
		m, err := r.more(dst[c:])
		c += m
		r.pos += int64(m)
		if err != nil {
			return nil, err
		}
	}
	return dst, nil
}

// skip drops the next n bytes.
func (r *reader) skip(n int64) error {
	c := min(n, int64(r.end-r.start))
	r.consume(int(c))
	for n -= c; n > 0; {
		r.start, r.end = 0, 0
		room := r.buf
		if int64(len(room)) > n {
			room = room[:n]
		}
		m, err := r.more(room)
		r.pos += int64(m)
		n -= int64(m)
		if err != nil {
			return err
		}
	}
	return nil
}

// sizeUnknown is the size of an element whose end is found by what follows it.
const sizeUnknown = -1

// element is the header of an EBML element.
type element struct {
	id   uint32
	size int64 // sizeUnknown or the payload's length
	hdr  int   // header length (ID and size)
}

// vintLen is the length of a variable-size integer from its first byte (0 when invalid).
func vintLen(b byte) int { return bits.LeadingZeros8(b) + 1 }

// vint decodes a variable-size integer (marker bit removed). all is true when every value bit
// is set (an unknown size).
func vint(b []byte) (v uint64, n int, all bool, ok bool) {
	if len(b) == 0 || b[0] == 0 {
		return 0, 0, false, false
	}
	n = vintLen(b[0])
	if len(b) < n {
		return 0, 0, false, false
	}
	v = uint64(b[0] & (0xFF >> n))
	for _, c := range b[1:n] {
		v = v<<8 | uint64(c)
	}
	return v, n, v == 1<<(7*n)-1, true
}

// parseElement decodes an element header at the start of b. short is true when b ends before
// the header does.
func parseElement(b []byte) (e element, short bool, err error) {
	if len(b) == 0 {
		return e, true, nil
	}
	idLen := vintLen(b[0])
	if b[0] == 0 || idLen > 4 {
		return e, false, invalid("bad element ID % x", b[:1])
	}
	if len(b) <= idLen {
		return e, true, nil
	}
	sizeLen := vintLen(b[idLen])
	if b[idLen] == 0 {
		return e, false, invalid("bad element size")
	}
	if len(b) < idLen+sizeLen {
		return e, true, nil
	}
	for _, c := range b[:idLen] {
		e.id = e.id<<8 | uint32(c)
	}
	size, _, all, _ := vint(b[idLen : idLen+sizeLen])
	e.size = int64(size) // < 2^56
	if all {
		e.size = sizeUnknown
	}
	e.hdr = idLen + sizeLen
	return e, false, nil
}

// peekElement decodes the next element header without consuming it.
func (r *reader) peekElement() (element, error) {
	for n := 1; ; {
		b, err := r.peek(n)
		if err != nil {
			return element{}, err
		}
		e, short, err := parseElement(b)
		if err != nil || !short {
			return e, err
		}
		// The header is longer than what was peeked: its first bytes say by how much.
		next := vintLen(b[0])
		if len(b) > next {
			next += vintLen(b[next])
		} else {
			next++
		}
		n = next
	}
}
