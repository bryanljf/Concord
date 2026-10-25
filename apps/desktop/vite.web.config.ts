/**
 * The web client: a second Vite build in this package, rooted at `src/web`, that bundles the
 * renderer as it is (`src/web/main.tsx` imports `../renderer/App`). Output goes to `out/web`
 * (served as static files by Caddy on the VM; never packed into the installer).
 */
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import pkg from './package.json';

/** `pnpm dev:api`; the proxy also carries the presence SSE (http-proxy streams responses). */
const API_DEV_TARGET = 'http://127.0.0.1:3000';

/**
 * The page's CSP is production-strict (`script-src 'self'`, `connect-src 'self' wss: https:`).
 * The dev server needs inline scripts (React Fast Refresh's preamble) and plain `ws:`/`http:`
 * (a local LiveKit), so it relaxes those two directives in `serve` mode only.
 */
function devCsp(): Plugin {
  return {
    name: 'concord-dev-csp',
    apply: 'serve',
    transformIndexHtml: (html) =>
      html
        .replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
        .replace("connect-src 'self' wss: https:;", "connect-src 'self' ws: wss: http: https:;"),
  };
}

const proxy = { '/api': { target: API_DEV_TARGET, changeOrigin: false } };

export default defineConfig({
  root: 'src/web',
  base: '/',
  // Copied verbatim to `out/web`: the manifest and its icons keep stable names.
  publicDir: 'public',
  plugins: [react(), devCsp()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: '../../out/web',
    emptyOutDir: true,
  },
  server: { proxy },
  preview: { proxy },
});
