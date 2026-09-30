import { defineConfig } from 'vitest/config';

const DOM_TESTS = ['tests/unit/infrastructure/overleaf-editor-adapter.test.ts'];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: DOM_TESTS,
          globalSetup: ['tests/integration/global-setup.ts'],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'dom',
          include: DOM_TESTS,
          environment: 'jsdom',
        },
      },
    ],
  },
});
