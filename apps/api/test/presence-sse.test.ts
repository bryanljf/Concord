import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { ApiErrorResponse, PresenceEvent } from '@concord/shared';
import { ALICE, bearer, testApp, waitFor } from './helpers';

/** Splits an SSE body into frames (the text between blank lines). */
async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf('\n\n');
    while (end !== -1) {
      yield buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf('\n\n');
    }
  }
}

/** Reads frames until one matches; heartbeats may interleave with events. */
async function readUntil(
  frames: AsyncGenerator<string>,
  predicate: (frame: string) => boolean,
): Promise<string> {
  for (;;) {
    const { value, done } = await frames.next();
    if (done) throw new Error('SSE stream ended early');
    if (predicate(value)) return value;
  }
}

const isEvent = (frame: string): boolean => frame.startsWith('data: ');
const isHeartbeat = (frame: string): boolean => frame === ': ping';

function parseEvent(frame: string): PresenceEvent {
  return JSON.parse(frame.slice('data: '.length)) as PresenceEvent;
}

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe('GET /api/presence (SSE)', () => {
  it('streams the snapshot, then events, then heartbeats, and cleans up on disconnect', async () => {
    const { app, presence } = testApp({ heartbeatMs: 50 });
    const baseUrl = await listen(app);
    const controller = new AbortController();
    try {
      const res = await fetch(`${baseUrl}/api/presence`, {
        headers: bearer(ALICE),
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      if (!res.body) throw new Error('missing response body');
      const frames = sseFrames(res.body);

      expect(parseEvent(await readUntil(frames, isEvent))).toEqual({
        type: 'snapshot',
        data: { rooms: { geral: [], jogos: [] } },
      });
      expect(presence.listenerCount).toBe(1);

      presence.join('jogos', { id: 'bob', name: 'Bob', joinedAt: 2_000 });
      expect(parseEvent(await readUntil(frames, isEvent))).toEqual({
        type: 'participant_joined',
        room: 'jogos',
        participant: { id: 'bob', name: 'Bob', streaming: false, joinedAt: 2_000 },
      });

      expect(await readUntil(frames, isHeartbeat)).toBe(': ping');

      controller.abort();
      await waitFor(() => presence.listenerCount === 0);
    } finally {
      controller.abort();
      await app.close();
    }
  });

  it('rejects requests without a valid key before streaming', async () => {
    const { app } = testApp();
    const baseUrl = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/api/presence`);
      expect(res.status).toBe(401);
      expect(((await res.json()) as ApiErrorResponse).error).toBe('unauthorized');
    } finally {
      await app.close();
    }
  });
});
