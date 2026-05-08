import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    root: '.',
    include: [
      'tests/**/*.test.ts',
      'electron/main/__tests__/**/*.test.ts',
      'src/lib/__tests__/**/*.test.ts',
      'src/__tests__/**/*.test.ts',
    ],
    globals: true,
    environment: 'node',
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
