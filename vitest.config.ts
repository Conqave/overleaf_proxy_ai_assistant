import { defineConfig } from 'vitest/config';

const DOM_TESTS = ['tests/unit/infrastructure/overleaf-editor-adapter.test.ts'];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          exclude: DOM_TESTS,
        },
      },
      {
        test: {
          name: 'dom',
          include: DOM_TESTS,
          environment: 'jsdom',
        },
      },
      {
        test: {
          name: 'architecture',
          include: ['tests/architecture/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/support/fake-overleaf-setup.ts'],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'deploy',
          include: ['tests/deploy/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'contract',
          include: ['tests/contract/**/*.test.ts'],
        },
      },
    ],
  },
});
