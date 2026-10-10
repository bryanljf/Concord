import { describe, expect, it } from 'vitest';
import type { ApiErrorResponse, RoomsResponse } from '@concord/shared';
import { ALICE, bearer, testApp } from './helpers';

describe('GET /api/rooms', () => {
  it('lists the configured rooms', async () => {
    const { app, config } = testApp();
    const res = await app.inject({ method: 'GET', url: '/api/rooms', headers: bearer(ALICE) });
    expect(res.statusCode).toBe(200);
    expect(res.json<RoomsResponse>()).toEqual({ rooms: config.rooms });
    await app.close();
  });

  it('requires a valid key', async () => {
    const { app } = testApp();
    const res = await app.inject({ method: 'GET', url: '/api/rooms' });
    expect(res.statusCode).toBe(401);
    expect(res.json<ApiErrorResponse>().error).toBe('unauthorized');
    await app.close();
  });
});
