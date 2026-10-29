import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The process entry point only wires run() to stdout, stderr and the exit code; CI runs the
      // built command directly to cover it, because v8 coverage can't follow a spawned process.
      exclude: ['src/cli.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
});
