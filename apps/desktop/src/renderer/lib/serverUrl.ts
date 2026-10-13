export type ServerUrlResult = { ok: true; url: string } | { ok: false; message: string };

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function looksLocal(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.local') || IPV4.test(hostname);
}

/**
 * Normalizes what the user typed into a base URL for concord-api: adds a scheme when missing
 * (http for IPs/localhost/explicit ports, https otherwise), drops trailing slashes and paths.
 */
export function normalizeServerUrl(input: string): ServerUrlResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, message: 'Informe o endereço do servidor.' };

  let candidate = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    const hostPort = candidate.split('/')[0] ?? candidate;
    const hostname = hostPort.replace(/:\d+$/, '');
    const hasPort = /:\d+$/.test(hostPort);
    candidate = `${looksLocal(hostname) || hasPort ? 'http' : 'https'}://${candidate}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, message: 'Endereço inválido. Ex.: http://192.168.0.10:3000' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: 'Use um endereço http:// ou https://.' };
  }
  if (url.username || url.password) {
    return { ok: false, message: 'O endereço não deve conter usuário ou senha.' };
  }
  preferHttps(url);
  return { ok: true, url: url.origin };
}

/**
 * Public domains are served over HTTPS (Caddy redirects plain HTTP), so a stored or typed
 * `http://domain` without an explicit port is upgraded. IPs, localhost, *.local and explicit
 * ports (self-hosting on a PC, e.g. http://1.2.3.4:3000) keep plain HTTP.
 */
export function preferHttps(url: URL): void {
  if (url.protocol !== 'http:' || url.port !== '') return;
  const host = url.hostname;
  const local =
    host === 'localhost' || host.endsWith('.local') || IPV4.test(host) || host.startsWith('[');
  if (!local) url.protocol = 'https:';
}
