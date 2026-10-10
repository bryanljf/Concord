import { describe, expect, it } from 'vitest';
import { createSseParser } from './sse-parser';

describe('createSseParser', () => {
  it('yields the data of each complete event', () => {
    const parser = createSseParser();
    expect(parser.feed('data: {"a":1}\n\ndata: {"b":2}\n\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('holds incomplete events across chunk boundaries', () => {
    const parser = createSseParser();
    expect(parser.feed('da')).toEqual([]);
    expect(parser.feed('ta: hel')).toEqual([]);
    expect(parser.feed('lo\n')).toEqual([]);
    expect(parser.feed('\n')).toEqual(['hello']);
  });

  it('accepts CRLF line endings, including a CRLF split across chunks', () => {
    const parser = createSseParser();
    expect(parser.feed('data: one\r\n\r\n')).toEqual(['one']);
    expect(parser.feed('data: two\r')).toEqual([]);
    expect(parser.feed('\n\r\n')).toEqual(['two']);
  });

  it('accepts bare CR line endings, deferring a trailing CR until the next chunk', () => {
    const parser = createSseParser();
    // The final "\r" could be the first half of a CRLF, so it is held back.
    expect(parser.feed('data: x\r\rdata: y\r\r')).toEqual(['x']);
    expect(parser.feed('data: z\r\r')).toEqual(['y']);
    expect(parser.feed('\n')).toEqual(['z']);
  });

  it('ignores comments, event, id and retry lines', () => {
    const parser = createSseParser();
    const chunk = ': ping\n\nevent: presence\nid: 7\nretry: 1000\ndata: payload\n\n: ping\n\n';
    expect(parser.feed(chunk)).toEqual(['payload']);
  });

  it('joins multi-line data with newlines', () => {
    const parser = createSseParser();
    expect(parser.feed('data: line 1\ndata:line 2\ndata: \n\n')).toEqual(['line 1\nline 2\n']);
  });

  it('does not dispatch when no data field was seen', () => {
    const parser = createSseParser();
    expect(parser.feed('event: ping\n\n\n\n')).toEqual([]);
  });

  it('treats a field without a colon as an empty value', () => {
    const parser = createSseParser();
    expect(parser.feed('data\n\n')).toEqual(['']);
  });
});
