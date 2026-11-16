'use strict';
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/browser',
  timeout: 240000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.BOMB_SQUAD_BASE_URL || 'http://127.0.0.1:3100',
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
    screenshot: 'only-on-failure',
    actionTimeout: 15000,
    navigationTimeout: 20000,
  },
  webServer: process.env.BOMB_SQUAD_BASE_URL ? undefined : {
    command: 'node server.js',
    url: 'http://127.0.0.1:3100/health',
    env: { PORT: '3100' },
    reuseExistingServer: false,
  },
});
