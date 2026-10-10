/**
 * Minimal, pure Server-Sent Events parser (https://html.spec.whatwg.org/#parsing-an-event-stream).
 * Feed it decoded text chunks of any size; it returns the `data` payload of every event that
 * the chunk completed. Comments (`: ping`), `event:`, `id:` and `retry:` lines are ignored,
 * multi-line `data:` fields are joined with `\n`, and `\r\n`, `\n` and `\r` all end a line.
 */
export interface SseParser {
  feed(chunk: string): string[];
}

export function createSseParser(): SseParser {
  let buffer = '';
  let dataLines: string[] = [];
  let hasData = false;

  function processLine(line: string, out: string[]): void {
    if (line === '') {
      if (hasData) out.push(dataLines.join('\n'));
      dataLines = [];
      hasData = false;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      dataLines.push(value);
      hasData = true;
    }
  }

  return {
    feed(chunk) {
      buffer += chunk;
      const out: string[] = [];
      let start = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const char = buffer[i];
        if (char !== '\n' && char !== '\r') continue;
        if (char === '\r' && i === buffer.length - 1) break; // may be half of a CRLF
        processLine(buffer.slice(start, i), out);
        if (char === '\r' && buffer[i + 1] === '\n') i += 1;
        start = i + 1;
      }
      buffer = buffer.slice(start);
      return out;
    },
  };
}
