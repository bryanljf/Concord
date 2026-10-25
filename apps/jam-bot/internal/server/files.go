package server

import (
	"context"
	"errors"
	"io/fs"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/bryanljf/Concord/apps/jam-bot/internal/webmopus"
)

const (
	// maxOpens bounds the files being opened at once. An open parses the header (the clusters
	// follow in the Source's goroutine), but waits up to 10 s for it when the file is still
	// being written: a few at once, so one slow upload does not hold up the other rooms.
	maxOpens = 4
	// maxFullParses bounds the full probes waiting for a whole file's packets: those packets
	// (up to MaxFileSize) are the memory peak. The api probes once per finished upload.
	maxFullParses = 1
)

// Files reads songs from the cache directory, and nowhere else.
type Files struct {
	dir    string           // absolute and clean; symlinks resolved at each use (it may not exist yet)
	growth *webmopus.Growth // files still being written (the process' only one)
	opens  chan struct{}    // files being opened at once
	full   chan struct{}    // full probes at once
	open   func(path string, growth *webmopus.Growth) (*webmopus.Source, error)
}

// NewFiles serves the files inside dir (relative to the working directory). growth tracks the
// files still being written (one per process, shared with every Source); nil makes a new one.
func NewFiles(dir string, growth *webmopus.Growth) (*Files, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	if growth == nil {
		growth = webmopus.NewGrowth()
	}
	return &Files{
		dir:    filepath.Clean(abs),
		growth: growth,
		opens:  make(chan struct{}, maxOpens),
		full:   make(chan struct{}, maxFullParses),
		open:   openSource,
	}, nil
}

// Dir is the cache directory, absolute.
func (f *Files) Dir() string { return f.dir }

func errInvalidFile(msg string) *apiError {
	return &apiError{http.StatusBadRequest, "invalid_file", msg}
}

func errInvalidAudio(msg string) *apiError {
	return &apiError{http.StatusUnprocessableEntity, "invalid_audio", msg}
}

var errOutside = errInvalidFile("the file is outside the cache directory")

// within reports whether path is strictly inside dir (both clean and absolute).
func within(dir, path string) bool {
	rel, err := filepath.Rel(dir, path)
	if err != nil || rel == "." || filepath.IsAbs(rel) {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// clean makes a request's file absolute (a relative file is relative to the directory) and
// clean, and checks that it names something inside the directory.
func (f *Files) clean(file string) (string, error) {
	if file == "" || strings.ContainsRune(file, 0) {
		return "", errInvalidFile("file is required")
	}
	if !filepath.IsAbs(file) {
		file = filepath.Join(f.dir, file)
	}
	path := filepath.Clean(file)
	if !within(f.dir, path) {
		return "", errOutside
	}
	return path, nil
}

// Resolve returns the real path of a request's file: a regular file inside the cache directory
// after cleaning the path and resolving symlinks (a relative file is relative to the directory).
func (f *Files) Resolve(file string) (string, error) {
	path, err := f.clean(file)
	if err != nil {
		return "", err
	}
	realDir, err := filepath.EvalSymlinks(f.dir)
	if err != nil {
		return "", notFound(err)
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		if throughLink(f.dir, path) {
			return "", errLink
		}
		return "", notFound(err)
	}
	if !within(realDir, real) {
		return "", errOutside
	}
	if err := checkReal(realDir, real); err != nil {
		return "", err
	}
	return real, nil
}

// Since Go 1.23 EvalSymlinks no longer follows Windows junctions (mount points) and other
// reparse points that are not symlinks (it fails on a path through one), but opening the file
// does: one inside the cache could point anywhere. Lstat reports them as irregular files; files
// behind one are refused.
var errLink = errInvalidFile("the path goes through a junction or another link the bot does not follow")

// throughLink reports whether a path below dir goes through an irregular file (a junction),
// up to its first missing step.
func throughLink(dir, path string) bool {
	rel, err := filepath.Rel(dir, path)
	if err != nil {
		return false
	}
	p := dir
	for _, name := range strings.Split(rel, string(filepath.Separator)) {
		p = filepath.Join(p, name)
		info, err := os.Lstat(p)
		if err != nil {
			return false
		}
		if info.Mode()&fs.ModeIrregular != 0 {
			return true
		}
	}
	return false
}

// checkReal walks a resolved path below the real directory: every step must be a plain directory
// and the last one a regular file (no junction either, see errLink).
func checkReal(realDir, real string) error {
	rel, err := filepath.Rel(realDir, real)
	if err != nil {
		return err
	}
	names := strings.Split(rel, string(filepath.Separator))
	p := realDir
	for i, name := range names {
		p = filepath.Join(p, name)
		info, err := os.Lstat(p)
		if err != nil {
			return notFound(err)
		}
		mode := info.Mode()
		switch {
		case mode&(fs.ModeSymlink|fs.ModeIrregular) != 0:
			return errLink
		case i < len(names)-1 && !mode.IsDir():
			return errInvalidAudio("file not found") // a path through a file
		case i == len(names)-1 && !mode.IsRegular():
			return errInvalidFile("not a regular file")
		}
	}
	return nil
}

func notFound(err error) error {
	// ENOTDIR: a path through a file ("song.webm/x"), which EvalSymlinks reports bare on Unix;
	// still a file that is not there (else a 500, which the api would retry).
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
		return errInvalidAudio("file not found")
	}
	return err
}

// growthKey is the path Load opened a request's file under (its real path), for a file that may
// be gone by now: the api renames an upload once it is complete. The symlinks of its longest
// existing ancestor are resolved and the rest of the path appended.
func (f *Files) growthKey(file string) (string, error) {
	path, err := f.clean(file)
	if err != nil {
		return "", err
	}
	realDir, err := filepath.EvalSymlinks(f.dir)
	if err != nil {
		return path, nil // no cache directory: nothing is playing from it
	}
	if throughLink(f.dir, path) {
		return "", errLink
	}
	real := resolveExisting(path)
	if !within(realDir, real) {
		return "", errOutside
	}
	return real, nil
}

func resolveExisting(path string) string {
	rest := ""
	for p := path; ; {
		if real, err := filepath.EvalSymlinks(p); err == nil {
			return filepath.Join(real, rest)
		}
		parent := filepath.Dir(p)
		if parent == p {
			return path
		}
		rest = filepath.Join(filepath.Base(p), rest)
		p = parent
	}
}

// Complete tells the Sources reading a file still being written that it is whole now (also
// before any opens it, or between two opens). The file may be gone already.
func (f *Files) Complete(file string) error {
	key, err := f.growthKey(file)
	if err != nil {
		return err
	}
	f.growth.Complete(key)
	return nil
}

// Fail tells the Sources reading a file still being written that it will never be whole.
func (f *Files) Fail(file string) error {
	key, err := f.growthKey(file)
	if err != nil {
		return err
	}
	f.growth.Fail(key)
	return nil
}

func acquire(ctx context.Context, sem chan struct{}) error {
	select {
	case sem <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Load opens a resolved file: whole (growing false), or still being written, then read as it
// grows until Complete or Fail. The caller owns the Source (the player, once handed over).
func (f *Files) Load(ctx context.Context, path string, growing bool) (*webmopus.Source, error) {
	if err := acquire(ctx, f.opens); err != nil {
		return nil, err
	}
	defer func() { <-f.opens }()
	var growth *webmopus.Growth
	if growing {
		growth = f.growth
	}
	src, err := f.open(path, growth)
	if err != nil {
		return nil, sourceError(err)
	}
	return src, nil
}

// sourceError turns an error from a Source (opening or reading it) into the API's.
func sourceError(err error) error {
	var ae *apiError
	switch {
	case errors.As(err, &ae):
		return ae
	case errors.Is(err, webmopus.ErrInvalidAudio):
		return errInvalidAudio(err.Error())
	case errors.Is(err, webmopus.ErrFailed):
		return errInvalidAudio("the upload of this file failed")
	case errors.Is(err, webmopus.ErrStalled):
		return errInvalidAudio("the upload of this file stalled")
	}
	return notFound(err)
}

// Probe reads a resolved file's format. partial: the header only (the file may still be
// written; duration 0). Otherwise the whole file is parsed, for its duration.
func (f *Files) Probe(ctx context.Context, path string, partial bool) (channels int, duration time.Duration, err error) {
	if !partial {
		if err := acquire(ctx, f.full); err != nil {
			return 0, 0, err
		}
		defer func() { <-f.full }()
	}
	src, err := f.Load(ctx, path, partial)
	if err != nil {
		return 0, 0, err
	}
	defer src.Close()
	if partial {
		return src.Channels(), 0, nil
	}
	// Past the end of a complete file: answers once every packet is parsed.
	if _, err := src.IndexAt(ctx, time.Duration(math.MaxInt64)); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return 0, 0, ctxErr
		}
		return 0, 0, sourceError(err)
	}
	n, end, _ := src.Parsed()
	if n == 0 {
		return 0, 0, errInvalidAudio("no Opus packets")
	}
	return src.Channels(), end, nil
}

// openSource opens a file; a whole one larger than MaxFileSize is refused up front.
func openSource(path string, growth *webmopus.Growth) (*webmopus.Source, error) {
	if growth == nil {
		info, err := os.Stat(path)
		if err != nil {
			return nil, err
		}
		if info.Size() > webmopus.MaxFileSize {
			return nil, errInvalidAudio("file larger than 64 MB")
		}
	}
	return webmopus.Open(path, growth)
}
