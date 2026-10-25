package lk

import (
	"net/netip"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
)

// Errors and SDK logs may quote the LiveKit URL (the server address is private), the join token
// (in the signal URL's query) or IP addresses (ICE candidates, dial errors): all of them are
// scrubbed before anything is logged or answered.

var (
	jwtPattern = regexp.MustCompile(`eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`)
	tokenParam = regexp.MustCompile(`(?i)(access_token=)[^&\s"']+`)

	// Candidates only: each match is checked with netip before it is replaced, so times
	// ("21:42:05"), versions ("1.13.9") and MAC addresses stay as they are.
	ipv6Candidate = regexp.MustCompile(`\[?[0-9A-Fa-f.]*:[0-9A-Fa-f.]*:[0-9A-Fa-f.:]*(?:%[0-9A-Za-z_-]+)?\]?`)
	ipv4Candidate = regexp.MustCompile(`\d{1,3}(?:\.\d{1,3}){3}`)

	hostsMu sync.RWMutex
	hosts   []string // longest first, so "host:port" goes before "host"
)

// rememberHost marks the host of a LiveKit URL as something never to print.
func rememberHost(raw string) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return
	}
	hostsMu.Lock()
	defer hostsMu.Unlock()
	for _, h := range []string{u.Host, u.Hostname()} {
		if h != "" && !slices.Contains(hosts, h) && len(hosts) < 16 {
			hosts = append(hosts, h)
		}
	}
	slices.SortFunc(hosts, func(a, b string) int { return len(b) - len(a) })
}

// Redact removes tokens, LiveKit hosts and IP addresses (v4 and v6, a port after them is kept)
// from s.
func Redact(s string) string {
	s = tokenParam.ReplaceAllString(s, "${1}[redacted]")
	s = jwtPattern.ReplaceAllString(s, "[token]")
	hostsMu.RLock()
	for _, h := range hosts {
		s = strings.ReplaceAll(s, h, "[livekit]")
	}
	hostsMu.RUnlock()
	return redactIPs(s)
}

func redactIPs(s string) string {
	s = replaceAddrs(s, ipv6Candidate, isIPv6)
	return replaceAddrs(s, ipv4Candidate, isIPv4)
}

func isIPv6(c string) bool {
	c = strings.TrimSuffix(strings.TrimPrefix(c, "["), "]")
	if i := strings.IndexByte(c, '%'); i >= 0 {
		c = c[:i]
	}
	a, err := netip.ParseAddr(c)
	return err == nil && a.Is6()
}

func isIPv4(c string) bool {
	a, err := netip.ParseAddr(c)
	return err == nil && a.Is4()
}

// replaceAddrs replaces with "[ip]" every match of re that valid accepts (after dropping
// trailing punctuation) and that is not glued to a longer word or dotted number.
func replaceAddrs(s string, re *regexp.Regexp, valid func(string) bool) string {
	locs := re.FindAllStringIndex(s, -1)
	if locs == nil {
		return s
	}
	var b strings.Builder
	last := 0
	for _, l := range locs {
		start, end := l[0], l[1]
		for end > start && !valid(s[start:end]) && strings.ContainsRune(".:]", rune(s[end-1])) {
			end--
		}
		if end == start || !valid(s[start:end]) || glued(s, start, end) {
			continue
		}
		b.WriteString(s[last:start])
		b.WriteString("[ip]")
		last = end
	}
	if last == 0 {
		return s
	}
	b.WriteString(s[last:])
	return b.String()
}

// glued: s[start:end] is part of a longer token ("std::x", "v1.2.3.4", "1.2.3.4.5").
func glued(s string, start, end int) bool {
	if start > 0 {
		c := s[start-1]
		if isWordChar(c) || (c == '.' && start > 1 && isDigit(s[start-2])) {
			return true
		}
	}
	if end < len(s) {
		c := s[end]
		if isWordChar(c) || (c == '.' && end+1 < len(s) && isDigit(s[end+1])) {
			return true
		}
	}
	return false
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func isWordChar(c byte) bool {
	return isDigit(c) || c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

type redactedError struct{ msg string }

func (e *redactedError) Error() string { return e.msg }

func redactErr(prefix string, err error) error {
	return &redactedError{Redact(prefix + ": " + err.Error())}
}
