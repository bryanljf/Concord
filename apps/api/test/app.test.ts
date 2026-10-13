import { describe, expect, it } from 'vitest';
import type { ApiErrorResponse } from '@concord/shared';
import { ALICE, bearer, testApp } from './helpers';

describe('app', () => {
  it('GET /api/health answers without auth', async () => {
    const { app } = testApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it('answers unknown routes with a JSON 404', async () => {
    const { app } = testApp();
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json<ApiErrorResponse>()).toEqual({
      error: 'not_found',
      message: expect.any(String),
    });
    await app.close();
  });

  it('maps unexpected errors to a JSON 500', async () => {
    const { app } = testApp();
    app.get('/boom', () => {
      throw new Error('boom');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json<ApiErrorResponse>()).toEqual({
      error: 'internal_error',
      message: expect.any(String),
    });
    await app.close();
  });

  it('maps malformed JSON to invalid_request', async () => {
    const { app } = testApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/token',
      headers: { ...bearer(ALICE), 'content-type': 'application/json' },
      payload: '{ nope',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiErrorResponse>().error).toBe('invalid_request');
    await app.close();
  });

  it('maps unsupported content types to a JSON 415', async () => {
    const { app } = testApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/token',
      headers: { ...bearer(ALICE), 'content-type': 'application/xml' },
      payload: '<room>geral</room>',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json<ApiErrorResponse>().error).toBe('unsupported_media_type');
    await app.close();
  });

  it('answers CORS preflights for any origin', async () => {
    const { app } = testApp();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/token',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toBe('GET, POST, PUT');
    expect(res.headers['access-control-allow-headers']).toBe('Authorization, Content-Type');
    await app.close();
  });
});
