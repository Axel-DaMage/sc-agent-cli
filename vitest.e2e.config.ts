import { defineConfig } from 'vitest/config';

// E2E smoke suite (#483): spawns the built bin/sc.js as a child process and
// runs it against a local mock OpenAI-compatible provider. Separate from the
// unit suite — requires `npm run build` first, run via `npm run test:e2e`.
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/e2e/**/*.test.ts'],
    // Each case spawns a real `node bin/sc.js` — keep timeouts generous.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
