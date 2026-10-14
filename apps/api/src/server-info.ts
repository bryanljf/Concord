import { hostname } from 'node:os';
import type { ServerInfoResponse } from '@concord/shared';

/** Oracle Cloud instance metadata (IMDSv2), reachable from the VM and its host-network containers. */
const OCI_METADATA_URL = 'http://169.254.169.254/opc/v2/instance/';
const METADATA_TIMEOUT_MS = 1500;

export interface ServerInfoOptions {
  /** `SERVER_NAME` / `SERVER_REGION`: override whatever is detected. */
  name?: string;
  region?: string;
  fetchImpl?: typeof fetch;
  hostName?: () => string;
}

interface OciInstance {
  displayName?: unknown;
  canonicalRegionName?: unknown;
}

async function readOciInstance(fetchImpl: typeof fetch): Promise<OciInstance | null> {
  try {
    const res = await fetchImpl(OCI_METADATA_URL, {
      headers: { Authorization: 'Bearer Oracle' },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null ? (body as OciInstance) : null;
  } catch {
    return null;
  }
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/**
 * Where this api runs: on an Oracle Cloud VM, the instance name and region from the metadata
 * service; anywhere else (a home PC), the host name and no region. `SERVER_NAME` and
 * `SERVER_REGION` win over both.
 */
export async function detectServerInfo(
  options: ServerInfoOptions = {},
): Promise<ServerInfoResponse> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const oci = await readOciInstance(fetchImpl);
  const ociName = text(oci?.displayName);
  const ociRegion = text(oci?.canonicalRegionName);
  return {
    name: text(options.name) ?? ociName ?? (options.hostName ?? hostname)(),
    region: text(options.region) ?? ociRegion,
    provider: ociRegion ? 'oracle' : null,
  };
}

/** Detects once, on first use; a failed detection is retried on the next call. */
export function cachedServerInfo(
  options: ServerInfoOptions = {},
): () => Promise<ServerInfoResponse> {
  let pending: Promise<ServerInfoResponse> | null = null;
  return () => {
    pending ??= detectServerInfo(options).catch((err: unknown) => {
      pending = null;
      throw err;
    });
    return pending;
  };
}
