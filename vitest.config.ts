import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    testTimeout: 30000,
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Emit the coverage report even when tests fail — a red suite must not
      // silently swallow the coverage output (#509).
      reportOnFailure: true,
      reporter: ['text', 'json-summary', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'src/types/**',
      ],
      thresholds: {
        statements: 40,
        branches: 30,
        functions: 45,
        lines: 40,
      },
    },
  },
});
