import { defineConfig } from 'vitest/config';

// Main-process unit tests only; the renderer gets its own (jsdom) project when it needs one.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
