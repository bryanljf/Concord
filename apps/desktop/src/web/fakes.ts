/**
 * Fakes for the web bridge's unit tests (Node, no DOM): a scripted `fetch`, an `EventSource`
 * the test drives, an in-memory `localStorage`, `location`/`history`/visibility stand-ins and
 * a whole `WebEnv` built from them. Only `*.test.ts` files import this module.
 */
import type { WebEnv, WebHistory, WebLocation } from './env';
import type { FullscreenHost } from './fullscreen';
import type { EventSourceLike, VisibilitySource } from './presence';
import type { StorageLike } from './settings';

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

export interface FetchCall {
  path: string;
  init: RequestInit | undefined;
  /** The JSON body sent, if any. */
  json: unknown;
}

export type FetchHandler = (
  path: string,
  init: RequestInit | undefined,
) => Response | Promise<Response>;

export interface ScriptedFetch {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
}

export function scriptedFetch(handler: FetchHandler): ScriptedFetch {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const json = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ path, init, json });
    return handler(path, init);
  };
  return { fetchImpl, calls };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

/** A fetch that answers every path with the same response. */
export function alwaysRespond(status: number, body?: unknown): ScriptedFetch {
  return scriptedFetch(() =>
    body === undefined ? emptyResponse(status) : jsonResponse(status, body),
  );
}

// ---------------------------------------------------------------------------
// EventSource and visibility
// ---------------------------------------------------------------------------

export class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {}

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  /** The server accepted the connection. */
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  /** One `data:` payload (objects are sent as JSON, strings as they are). */
  send(payload: unknown): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /** The connection dropped or was refused. */
  fail(): void {
    this.onerror?.(new Event('error'));
  }
}

export class FakeVisibility implements VisibilitySource {
  hidden = false;
  private readonly listeners = new Set<() => void>();

  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  set(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of this.listeners) listener();
  }
}

// ---------------------------------------------------------------------------
// Storage, location, history, fullscreen
// ---------------------------------------------------------------------------

export function memoryStorage(initial: Record<string, string> = {}): {
  storage: StorageLike;
  map: Map<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    map,
    storage: {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        map.set(key, value);
      },
      removeItem: (key) => {
        map.delete(key);
      },
    },
  };
}

export function fakeLocation(href = 'http://localhost/'): WebLocation & { assigned: string[] } {
  const url = new URL(href);
  const assigned: string[] = [];
  return {
    origin: url.origin,
    host: url.host,
    href,
    assigned,
    assign: (target) => {
      assigned.push(target);
    },
  };
}

export function fakeHistory(): WebHistory & { replaced: string[] } {
  const replaced: string[] = [];
  return {
    replaced,
    replaceState: (_data, _unused, url) => {
      replaced.push(String(url));
    },
  };
}

export function fakeFullscreen(
  behaviour: { reject?: boolean } = {},
): FullscreenHost & { active: boolean; requests: number } {
  const listeners = new Set<(active: boolean) => void>();
  const host = {
    active: false,
    requests: 0,
    async request() {
      host.requests += 1;
      if (behaviour.reject) throw new DOMException('not allowed', 'NotAllowedError');
      host.active = true;
      for (const listener of listeners) listener(true);
    },
    async exit() {
      host.active = false;
      for (const listener of listeners) listener(false);
    },
    isActive: () => host.active,
    subscribe(listener: (active: boolean) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return host;
}

// ---------------------------------------------------------------------------
// Whole environment
// ---------------------------------------------------------------------------

export interface FakeEnv extends WebEnv {
  calls: FetchCall[];
  sources: FakeEventSource[];
  opened: string[];
  visibility: FakeVisibility;
  fullscreen: ReturnType<typeof fakeFullscreen>;
  location: ReturnType<typeof fakeLocation>;
  history: ReturnType<typeof fakeHistory>;
  stored: Map<string, string>;
}

export function fakeEnv(handler: FetchHandler, href = 'http://localhost/'): FakeEnv {
  const { fetchImpl, calls } = scriptedFetch(handler);
  const { storage, map } = memoryStorage();
  const sources: FakeEventSource[] = [];
  const opened: string[] = [];
  return {
    fetchImpl,
    calls,
    location: fakeLocation(href),
    history: fakeHistory(),
    storage: () => storage,
    stored: map,
    createEventSource: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    sources,
    visibility: new FakeVisibility(),
    fullscreen: fakeFullscreen(),
    openWindow: (url) => {
      opened.push(url);
    },
    opened,
    platform: 'iPhone',
  };
}
