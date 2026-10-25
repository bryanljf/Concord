import { defineConfig } from 'vitest/config';

// Main-process and web-bridge unit tests (both plain Node); the renderer gets its own (jsdom)
// project when it needs one.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/web/**/*.test.ts'],
    environment: 'node',
  },
});
