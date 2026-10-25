import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJamBotClient, JamBotError, readSse, type BotEvent } from '../src/jam/bot-client';
import { fakeLogger, waitFor } from './helpers';

interface Recorded {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

type Handler = (request: Recorded, res: ServerResponse) => void;

const servers: Server[] = [];

async function fakeBot(handler: Handler) {
  const requests: Recorded[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      const recorded: Recorded = {
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body,
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, requests, baseUrl: `http://127.0.0.1:${port}` };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const STATUS = {
  room: 'geral',
  itemId: 'item-1',
  state: 'playing',
  positionMs: 1500,
  durationMs: 200_000,
};

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('createJamBotClient', () => {
  it('speaks the bot API with the Bearer token', async () => {
    const bot = await fakeBot((request, res) => {
      if (request.method === 'DELETE') {
        res.writeHead(204).end();
      } else if (request.url === '/v1/probe') {
        json(res, 200, { durationMs: 199_000, channels: 2, sampleRate: 48_000, codec: 'opus' });
      } else if (request.url === '/v1/rooms') {
        json(res, 200, { rooms: [STATUS] });
      } else if (request.url.endsWith('/pause')) {
        json(res, 200, { ...STATUS, state: 'paused' });
      } else {
        json(res, 200, STATUS);
      }
    });
    const client = createJamBotClient({
      baseUrl: bot.baseUrl,
      token: 'bot-secret',
      log: fakeLogger(),
    });
    const play = {
      livekitUrl: 'ws://127.0.0.1:7880',
      token: 'jwt',
      itemId: 'item-1',
      file: '/var/lib/concord-jam/aaaaaaaaaaa.webm',
      offsetMs: 0,
      paused: false,
    };

    expect(await client.play('geral', play)).toEqual(STATUS);
    expect(await client.pause('geral')).toEqual({ ...STATUS, state: 'paused' });
    expect(await client.resume('geral')).toEqual(STATUS);
    expect(await client.rooms()).toEqual([STATUS]);
    expect(await client.probe('/var/lib/concord-jam/.tmp-1.webm')).toEqual({
      durationMs: 199_000,
      channels: 2,
      sampleRate: 48_000,
      codec: 'opus',
    });
    await client.leave('geral');

    expect(bot.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'PUT /v1/rooms/geral',
      'POST /v1/rooms/geral/pause',
      'POST /v1/rooms/geral/resume',
      'GET /v1/rooms',
      'POST /v1/probe',
      'DELETE /v1/rooms/geral',
    ]);
    expect(bot.requests.every((request) => request.authorization === 'Bearer bot-secret')).toBe(
      true,
    );
    expect(bot.requests[0]?.contentType).toBe('application/json');
    expect(JSON.parse(bot.requests[0]?.body ?? '')).toEqual(play);
    expect(JSON.parse(bot.requests[4]?.body ?? '')).toEqual({
      file: '/var/lib/concord-jam/.tmp-1.webm',
    });
  });

  it('joins rooms ahead, plays growing files and reports how their upload ended', async () => {
    const IDLE = { room: 'geral', itemId: '', state: 'idle', positionMs: 0, durationMs: 0 };
    const bot = await fakeBot((request, res) => {
      if (request.url.startsWith('/v1/files/')) res.writeHead(204).end();
      else if (request.url === '/v1/probe') {
        json(res, 200, { durationMs: 0, channels: 2, sampleRate: 48_000, codec: 'opus' });
      } else if (request.method === 'PUT') json(res, 200, { ...STATUS, durationMs: 8_000 });
      else json(res, 200, IDLE);
    });
    const client = createJamBotClient({
      baseUrl: bot.baseUrl,
      token: 'bot-secret',
      log: fakeLogger(),
    });
    const temp = '/var/lib/concord-jam/.tmp-1.webm';
    const play = {
      livekitUrl: 'ws://127.0.0.1:7880',
      token: 'jwt',
      itemId: 'item-1',
      file: temp,
      offsetMs: 0,
      paused: false,
      growing: true,
    };

    expect(
      await client.connect('geral', { livekitUrl: 'ws://127.0.0.1:7880', token: 'jwt' }),
    ).toEqual(IDLE);
    expect(await client.probe(temp, { partial: true })).toMatchObject({ durationMs: 0 });
    expect(await client.play('geral', play)).toEqual({ ...STATUS, durationMs: 8_000 });
    await client.completeFile(temp);
    await client.failFile('/var/lib/concord-jam/.tmp-2.webm');

    expect(bot.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'POST /v1/rooms/geral/connect',
      'POST /v1/probe',
      'PUT /v1/rooms/geral',
      'POST /v1/files/complete',
      'POST /v1/files/failed',
    ]);
    expect(bot.requests.every((request) => request.authorization === 'Bearer bot-secret')).toBe(
      true,
    );
    expect(bot.requests.map((request) => JSON.parse(request.body) as unknown)).toEqual([
      { livekitUrl: 'ws://127.0.0.1:7880', token: 'jwt' },
      { file: temp, partial: true },
      play,
      { file: temp },
      { file: '/var/lib/concord-jam/.tmp-2.webm' },
    ]);
  });

  it('never puts the tokens it sends in its errors', async () => {
    const bot = await fakeBot((request, res) => {
      if (request.url.startsWith('/v1/files/')) json(res, 503, { error: 'busy', message: 'later' });
      else json(res, 502, { error: 'livekit_error', message: 'could not join' });
    });
    const log = fakeLogger();
    const client = createJamBotClient({ baseUrl: bot.baseUrl, token: 'bot-secret', log });
    const errors = [
      await client
        .connect('geral', { livekitUrl: 'ws://x', token: 'jwt-secret' })
        .catch((err: unknown) => err),
      await client.completeFile('/f').catch((err: unknown) => err),
      await client.failFile('/f').catch((err: unknown) => err),
    ];
    expect(errors[0]).toMatchObject({ status: 502, code: 'livekit_error', retryable: true });
    expect(errors[1]).toMatchObject({ status: 503, code: 'busy', retryable: true });
    for (const err of errors) {
      expect(err).toBeInstanceOf(JamBotError);
      expect(JSON.stringify({ ...(err as object), message: (err as Error).message })).not.toMatch(
        /jwt-secret|bot-secret/,
      );
    }
  });

  it('sends no Authorization header without a token', async () => {
    const bot = await fakeBot((_request, res) => json(res, 200, { rooms: [] }));
    await createJamBotClient({ baseUrl: bot.baseUrl, log: fakeLogger() }).rooms();
    expect(bot.requests[0]?.authorization).toBeUndefined();
  });

  it('reports what the bot rejected, and when it cannot be reached', async () => {
    const bot = await fakeBot((request, res) => {
      if (request.url === '/v1/probe')
        json(res, 422, { error: 'invalid_audio', message: 'no opus' });
      else if (request.method === 'PUT')
        json(res, 502, { error: 'livekit_error', message: 'down' });
      else json(res, 200, { rooms: [{ room: 'geral' }] });
    });
    const client = createJamBotClient({ baseUrl: bot.baseUrl, log: fakeLogger() });

    const rejected = await client.probe('/x.webm').catch((err: unknown) => err);
    expect(rejected).toBeInstanceOf(JamBotError);
    expect(rejected).toMatchObject({ status: 422, code: 'invalid_audio', retryable: false });

    const failing = await client.pause('geral').catch((err: unknown) => err);
    expect(failing).toMatchObject({ status: 502, code: 'invalid_response' });

    const down = await client
      .play('geral', {
        livekitUrl: 'ws://x',
        token: 'jwt-secret',
        itemId: 'i',
        file: '/f',
        offsetMs: 0,
        paused: false,
      })
      .catch((err: unknown) => err);
    expect(down).toMatchObject({ status: 502, code: 'livekit_error', retryable: true });
    expect((down as Error).message).not.toContain('jwt-secret');

    bot.server.closeAllConnections();
    await new Promise((resolve) => bot.server.close(resolve));
    servers.splice(servers.indexOf(bot.server), 1);
    const unreachable = await client.rooms().catch((err: unknown) => err);
    expect(unreachable).toMatchObject({ status: 0, code: 'unreachable', retryable: true });
  });

  it('follows the event stream, reconciling on every (re)connection', async () => {
    const streams: ServerResponse[] = [];
    const bot = await fakeBot((request, res) => {
      if (request.url !== '/v1/events') return json(res, 404, { error: 'not_found' });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': ping\n\n');
      streams.push(res);
    });
    const events: BotEvent[] = [];
    const onConnect = vi.fn(async () => undefined);
    const log = fakeLogger();
    const stream = createJamBotClient({
      baseUrl: bot.baseUrl,
      token: 'bot-secret',
      log,
      retryDelay: () => 10,
    }).events({ onConnect, onEvent: (event) => events.push(event) });
    try {
      await waitFor(() => streams.length === 1 && onConnect.mock.calls.length === 1);
      expect(bot.requests[0]?.authorization).toBe('Bearer bot-secret');
      streams[0]?.write('data: {"type":"ended","room":"geral","itemId":"item-1"}\n\n');
      streams[0]?.write('data: {"type":"error","room":"jogos",');
      streams[0]?.write('"itemId":"item-2","message":"boom"}\r\n\r\n');
      streams[0]?.write('data: {"type":"nonsense"}\n\n');
      await waitFor(() => events.length === 2);
      expect(events).toEqual([
        { type: 'ended', room: 'geral', itemId: 'item-1' },
        { type: 'error', room: 'jogos', itemId: 'item-2', message: 'boom' },
      ]);
      await waitFor(() => log.warn.mock.calls.length === 1);

      // The bot restarts: the api reconnects and reconciles again.
      streams[0]?.end();
      await waitFor(() => streams.length === 2 && onConnect.mock.calls.length === 2);
    } finally {
      stream.stop();
    }
  });

  it('drops a stream that went silent and one whose reconcile failed', async () => {
    let connections = 0;
    const bot = await fakeBot((_request, res) => {
      connections += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': ping\n\n');
    });
    const onConnect = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('GET /v1/rooms failed'))
      .mockResolvedValue(undefined);
    const stream = createJamBotClient({
      baseUrl: bot.baseUrl,
      log: fakeLogger(),
      idleTimeoutMs: 100,
      retryDelay: () => 10,
    }).events({ onConnect, onEvent: () => undefined });
    try {
      // 1st: reconcile fails; 2nd: goes silent; 3rd: and so on.
      await waitFor(() => connections >= 3 && onConnect.mock.calls.length >= 3);
      expect(onConnect.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      stream.stop();
    }
  });
});

describe('readSse', () => {
  it('splits frames across chunks and skips comments', async () => {
    const encoder = new TextEncoder();
    const chunks = [': ping\n\ndata: {"a"', ':1}\n\ndata: line1\ndata: line2\n\n'];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const data: string[] = [];
    await readSse(body, (frame) => data.push(frame));
    expect(data).toEqual(['{"a":1}', 'line1\nline2']);
  });
});
