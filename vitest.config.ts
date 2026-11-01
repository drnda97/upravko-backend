import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { DB_NAME: 'upravko_test', NODE_ENV: 'test', DEMO_NOW: '2026-10-30T11:00:00+01:00', STORAGE_DIR: './storage-test' },
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 120000,
  },
});
