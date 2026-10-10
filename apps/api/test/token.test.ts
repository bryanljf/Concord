import type { FastifyInstance } from 'fastify';
import { TokenVerifier } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';
import { TOKEN_TTL_SECONDS, type ApiErrorResponse, type TokenResponse } from '@concord/shared';
import { ALICE, API_KEY, API_SECRET, bearer, testApp, testConfig } from './helpers';

function requestToken(app: FastifyInstance, payload: object, remoteAddress?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/token',
    headers: bearer(ALICE),
    payload,
    remoteAddress,
  });
}

describe('POST /api/token', () => {
  it('issues a LiveKit join token restricted to screen sharing', async () => {
    const { app, config } = testApp();
    const before = Math.floor(Date.now() / 1000);
    const res = await requestToken(app, { room: 'jogos' });
    expect(res.statusCode).toBe(200);
    const body = res.json<TokenResponse>();
    expect(body.url).toBe(config.livekit.url);

    const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(body.token);
    expect(claims.iss).toBe(API_KEY);
    expect(claims.sub).toBe('alice');
    expect(claims.name).toBe('Alice');
    expect(claims.video).toEqual({
      roomJoin: true,
      room: 'jogos',
      canSubscribe: true,
      canPublish: true,
      canPublishSources: ['screen_share', 'screen_share_audio'],
      canPublishData: true,
    });
    const exp = claims.exp ?? 0;
    expect(exp).toBeGreaterThanOrEqual(before + TOKEN_TTL_SECONDS);
    expect(exp).toBeLessThanOrEqual(before + TOKEN_TTL_SECONDS + 5);
    expect(Math.abs(body.expiresAt - exp * 1000)).toBeLessThanOrEqual(1000);
    await app.close();
  });

  it('issues a hidden, subscribe-only token for the pop-out window', async () => {
    const { app } = testApp();
    const res = await requestToken(app, { room: 'jogos', purpose: 'popout' });
    expect(res.statusCode).toBe(200);
    const body = res.json<TokenResponse>();
    const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(body.token);
    expect(claims.sub).toBe('alice~popout');
    expect(claims.name).toBe('Alice');
    expect(claims.video).toEqual({
      roomJoin: true,
      room: 'jogos',
      canSubscribe: true,
      canPublish: false,
      canPublishData: false,
      hidden: true,
    });
    await app.close();
  });

  it('treats purpose "main" exactly like the default', async () => {
    const { app } = testApp();
    const res = await requestToken(app, { room: 'geral', purpose: 'main' });
    expect(res.statusCode).toBe(200);
    const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(
      res.json<TokenResponse>().token,
    );
    expect(claims.sub).toBe('alice');
    expect(claims.video).toEqual({
      roomJoin: true,
      room: 'geral',
      canSubscribe: true,
      canPublish: true,
      canPublishSources: ['screen_share', 'screen_share_audio'],
      canPublishData: true,
    });
    await app.close();
  });

  it('rejects rooms that are not configured', async () => {
    const { app } = testApp();
    const res = await requestToken(app, { room: 'secreta' });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiErrorResponse>()).toEqual({
      error: 'unknown_room',
      message: expect.stringContaining('secreta'),
    });
    await app.close();
  });

  it.each<[string, object]>([
    ['a missing room', {}],
    ['an object room', { room: { nested: true } }],
    ['an empty room', { room: '' }],
    ['an unknown purpose', { room: 'geral', purpose: 'spy' }],
    ['an object purpose', { room: 'geral', purpose: { nested: true } }],
  ])('rejects %s with invalid_request', async (_label, payload) => {
    const { app } = testApp();
    const res = await requestToken(app, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiErrorResponse>().error).toBe('invalid_request');
    await app.close();
  });

  it('requires a valid key', async () => {
    const { app } = testApp();
    const res = await app.inject({ method: 'POST', url: '/api/token', payload: { room: 'geral' } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  describe('LiveKit URL selection', () => {
    const localUrl = 'ws://127.0.0.1:7880';
    const publicUrl = 'wss://concord.example';

    it.each<[string, string]>([
      ['127.0.0.1', localUrl],
      ['::1', localUrl],
      ['::ffff:127.0.0.1', localUrl],
      ['203.0.113.9', publicUrl],
    ])('hands %s the URL %s when a local URL is configured', async (remoteAddress, expected) => {
      const config = testConfig();
      config.livekit = { ...config.livekit, url: publicUrl, localUrl };
      const { app } = testApp({ config });
      const res = await requestToken(app, { room: 'geral' }, remoteAddress);
      expect(res.statusCode).toBe(200);
      expect(res.json<TokenResponse>().url).toBe(expected);
      await app.close();
    });

    it('always hands out the public URL when no local URL is configured', async () => {
      const { app } = testApp();
      const res = await requestToken(app, { room: 'geral' }, '127.0.0.1');
      expect(res.json<TokenResponse>().url).toBe(publicUrl);
      await app.close();
    });
  });

  it('rate limits token requests to 30 per minute per IP', async () => {
    const { app } = testApp();
    for (let i = 0; i < 30; i += 1) {
      const res = await requestToken(app, { room: 'geral' }, '203.0.113.1');
      expect(res.statusCode, `request ${i + 1}`).toBe(200);
    }
    const limited = await requestToken(app, { room: 'geral' }, '203.0.113.1');
    expect(limited.statusCode).toBe(429);
    expect(limited.json<ApiErrorResponse>().error).toBe('rate_limited');
    expect(limited.headers['retry-after']).toBeDefined();

    const otherClient = await requestToken(app, { room: 'geral' }, '203.0.113.2');
    expect(otherClient.statusCode).toBe(200);
    await app.close();
  });
});
