import type { AddressInfo } from 'node:net';
import { readdir } from 'node:fs/promises';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { BuildAppOptions } from '../src/app';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiErrorResponse } from '@concord/shared';
import { ALICE, BOB, bearer, testApp, waitFor } from './helpers';
import { collectSse as collect, jamSetup, VIDEO_A, type JamSetup } from './jam-helpers';

let setup: JamSetup | undefined;
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  await setup?.cleanup();
  app = undefined;
  setup = undefined;
});

async function listen(
  logger: BuildAppOptions['logger'] = false,
): Promise<{ baseUrl: string; s: JamSetup }> {
  setup = await jamSetup();
  await setup.service.start();
  app = testApp({
    jam: setup.service,
    presence: setup.presence,
    heartbeatMs: 60_000,
    logger,
  }).app;
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, s: setup };
}

describe('GET /api/presence?jam=1', () => {
  it('streams the jam after the presence snapshot, interleaved with presence events', async () => {
    const { baseUrl, s } = await listen();
    const controller = new AbortController();
    try {
      const res = await fetch(`${baseUrl}/api/presence?jam=1`, {
        headers: bearer(ALICE),
        signal: controller.signal,
      });
      if (!res.body) throw new Error('missing body');
      const events = collect(res.body);
      await waitFor(() => events.length === 2);
      expect(events.map((event) => event.type)).toEqual(['snapshot', 'jam_snapshot']);
      expect(events[1]).toEqual({
        type: 'jam_snapshot',
        data: { available: true, rooms: {}, serverTime: s.clock.time },
      });

      const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
      s.presence.join('jogos', { id: 'bob', name: 'Bob', joinedAt: 1 });
      await waitFor(() => events.length === 4);
      expect(events[2]).toEqual({
        type: 'jam_updated',
        state: { room: 'geral', current: null, queue: [item], history: [] },
        serverTime: s.clock.time,
      });
      expect(events[3]?.type).toBe('participant_joined');
    } finally {
      controller.abort();
    }
  });

  it('logs the stream once, never each event it carries', async () => {
    const messages: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        messages.push((JSON.parse(chunk.toString()) as { msg: string }).msg);
        callback();
      },
    });
    const { baseUrl, s } = await listen({ level: 'info', stream });
    const controller = new AbortController();
    try {
      const res = await fetch(`${baseUrl}/api/presence?jam=1`, {
        headers: bearer(ALICE),
        signal: controller.signal,
      });
      if (!res.body) throw new Error('missing body');
      const events = collect(res.body);
      for (const videoId of [VIDEO_A, VIDEO_A, VIDEO_A]) {
        await s.service.enqueue('alice', 'geral', videoId);
      }
      s.presence.join('jogos', { id: 'bob', name: 'Bob', joinedAt: 1 });
      await waitFor(() => events.length === 6);
      // One line for the connection; nothing per event (the startup line aside).
      expect(messages.filter((msg) => !msg.startsWith('Server listening'))).toEqual([
        'incoming request',
      ]);
    } finally {
      controller.abort();
    }
  });

  it('sends old apps (no query) the presence events only', async () => {
    const { baseUrl, s } = await listen();
    const controller = new AbortController();
    try {
      const res = await fetch(`${baseUrl}/api/presence?jam=0`, {
        headers: bearer(ALICE),
        signal: controller.signal,
      });
      if (!res.body) throw new Error('missing body');
      const events = collect(res.body);
      await s.service.enqueue('alice', 'geral', VIDEO_A);
      s.presence.join('jogos', { id: 'bob', name: 'Bob', joinedAt: 1 });
      await waitFor(() => events.length === 2);
      expect(events.map((event) => event.type)).toEqual(['snapshot', 'participant_joined']);
    } finally {
      controller.abort();
    }
  });
});

describe('PUT /api/rooms/:room/jam/items/:itemId/audio over a real socket', () => {
  it('streams the body to the cache', async () => {
    const { baseUrl, s } = await listen();
    const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
    const res = await fetch(`${baseUrl}/api/rooms/geral/jam/items/${item.id}/audio`, {
      method: 'PUT',
      headers: { ...bearer(ALICE), 'content-type': 'audio/webm' },
      body: new Uint8Array(256 * 1024).fill(5),
    });
    expect(res.status).toBe(204);
    expect(await readdir(s.cacheDir)).toEqual([`${VIDEO_A}.json`, `${VIDEO_A}.webm`]);
    expect(s.service.snapshot().rooms.geral?.current?.item.id).toBe(item.id);
  });

  it('answers a rejected upload to a client still sending its body', async () => {
    const { baseUrl, s } = await listen();
    const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
    const send = (user: typeof ALICE) =>
      fetch(`${baseUrl}/api/rooms/geral/jam/items/${item.id}/audio`, {
        method: 'PUT',
        headers: { ...bearer(user), 'content-type': 'audio/webm' },
        body: new Uint8Array(900 * 1024),
      });
    const notYours = await send(BOB);
    expect(notYours.status).toBe(403);
    expect(((await notYours.json()) as ApiErrorResponse).error).toBe('not_requester');
    expect((await send(ALICE)).status).toBe(204);
    const again = await send(ALICE);
    expect(again.status).toBe(409);
    expect(((await again.json()) as ApiErrorResponse).error).toBe('already_uploaded');
  });
});
