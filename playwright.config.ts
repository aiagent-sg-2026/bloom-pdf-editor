import { defineConfig, devices } from '@playwright/test';

const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/^\/+|\/+$/g, '');
const baseURL = (process.env.E2E_BASE_URL ?? `http://127.0.0.1:4173/${basePath}`).replace(/\/*$/, '/');
const url = new URL(baseURL);
const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

export default defineConfig({
  testDir: './e2e/stories',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    headless: true,
    acceptDownloads: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{
    name: 'chromium',
    use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1100 } },
  }],
  webServer: local ? {
    command: 'npm run test:e2e:serve',
    url: baseURL,
    env: { E2E_BASE_URL: baseURL },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  } : undefined,
});
