import { describe, expect, it, vi } from 'vitest';
import type { ApiErrorResponse, ServerInfoResponse } from '@concord/shared';
import { cachedServerInfo, detectServerInfo } from '../src/server-info';
import { ALICE, bearer, testApp } from './helpers';

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('detectServerInfo', () => {
  it('reads the Oracle instance name and region from the metadata service', async () => {
    const fetchImpl = vi.fn(() =>
      json({ displayName: 'concord', canonicalRegionName: 'sa-saopaulo-1', region: 'gru' }),
    );
    await expect(detectServerInfo({ fetchImpl })).resolves.toEqual({
      name: 'concord',
      region: 'sa-saopaulo-1',
      provider: 'oracle',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://169.254.169.254/opc/v2/instance/',
      expect.objectContaining({ headers: { Authorization: 'Bearer Oracle' } }),
    );
  });

  it('falls back to the host name outside Oracle', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    await expect(detectServerInfo({ fetchImpl, hostName: () => 'MEU-PC' })).resolves.toEqual({
      name: 'MEU-PC',
      region: null,
      provider: null,
    });
  });

  it('lets SERVER_NAME / SERVER_REGION override what is detected', async () => {
    const fetchImpl = vi.fn(() =>
      json({ displayName: 'concord', canonicalRegionName: 'sa-saopaulo-1' }),
    );
    await expect(
      detectServerInfo({ fetchImpl, name: 'Principal', region: 'Casa' }),
    ).resolves.toEqual({ name: 'Principal', region: 'Casa', provider: 'oracle' });
  });

  it('detects only once', async () => {
    const fetchImpl = vi.fn(() => json({}, 404));
    const info = cachedServerInfo({ fetchImpl, hostName: () => 'pc' });
    await info();
    await info();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/server', () => {
  const info: ServerInfoResponse = { name: 'concord', region: 'sa-saopaulo-1', provider: 'oracle' };

  it('returns the server info to signed-in users', async () => {
    const { app } = testApp({ serverInfo: () => Promise.resolve(info) });
    const res = await app.inject({ method: 'GET', url: '/api/server', headers: bearer(ALICE) });
    expect(res.statusCode).toBe(200);
    expect(res.json<ServerInfoResponse>()).toEqual(info);
    await app.close();
  });

  it('requires a valid key', async () => {
    const { app } = testApp({ serverInfo: () => Promise.resolve(info) });
    const res = await app.inject({ method: 'GET', url: '/api/server' });
    expect(res.statusCode).toBe(401);
    expect(res.json<ApiErrorResponse>().error).toBe('unauthorized');
    await app.close();
  });
});
