import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  // Every test launches its own headless browser and profile, so tests share no state.
  fullyParallel: true,
  workers: 4,
  reporter: 'list',
});