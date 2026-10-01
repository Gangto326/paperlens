import { defineConfig } from '@playwright/test';

// Electron 최소 시나리오(C5.5). `npm run e2e`. vitest의 include에 들어가지 않게 e2e/ 아래에 둔다.
export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.e2e\.ts/,
  timeout: 120_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
});
