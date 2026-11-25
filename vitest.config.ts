import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'entrypoints/**/*.test.ts',
      'entrypoints/**/*.test.tsx',
      'tests/architecture.test.ts',
      'wxt.config.test.ts',
    ],
  },
});