import { describe, expect, it } from 'vitest';
import { normalizeServerUrl } from './serverUrl';

describe('normalizeServerUrl', () => {
  it('keeps explicit schemes and strips paths and trailing slashes', () => {
    expect(normalizeServerUrl('http://127.0.0.1:3000/')).toEqual({
      ok: true,
      url: 'http://127.0.0.1:3000',
    });
    expect(normalizeServerUrl('https://concord.exemplo.org/api/health')).toEqual({
      ok: true,
      url: 'https://concord.exemplo.org',
    });
  });

  it('assumes http for IPs, localhost and explicit ports, https for domains', () => {
    expect(normalizeServerUrl('192.168.0.10:3000')).toEqual({
      ok: true,
      url: 'http://192.168.0.10:3000',
    });
    expect(normalizeServerUrl('localhost:3000')).toEqual({
      ok: true,
      url: 'http://localhost:3000',
    });
    expect(normalizeServerUrl('concord.duckdns.org')).toEqual({
      ok: true,
      url: 'https://concord.duckdns.org',
    });
    expect(normalizeServerUrl('  concord.exemplo.org:8443 ')).toEqual({
      ok: true,
      url: 'http://concord.exemplo.org:8443',
    });
  });

  it('rejects empty, malformed and non-http input', () => {
    expect(normalizeServerUrl('   ').ok).toBe(false);
    expect(normalizeServerUrl('http://').ok).toBe(false);
    expect(normalizeServerUrl('ftp://x.org').ok).toBe(false);
    expect(normalizeServerUrl('http://user:pw@x.org').ok).toBe(false);
  });
});
