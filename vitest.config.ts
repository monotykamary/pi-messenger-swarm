import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
    // The extension graph transitively loads @earendil-works/pi-coding-agent
    // (~21 MB dist) on the first test of a file; under parallel CI load that
    // first load can exceed vitest's 5s default and cascade into later tests.
    testTimeout: 20_000,
  },
});
