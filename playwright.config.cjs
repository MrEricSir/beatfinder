// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 120_000,       // generous per-test timeout for audio analysis
  use: {
    baseURL: 'http://localhost:8080',
    // Skip the autoplay gesture requirement so AudioContext starts immediately
    permissions: ['camera', 'microphone'],
    launchOptions: {
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
    },
  },
  // Don't spin up a web server; assume dev.sh start is already running
  webServer: {
    command: './dev.sh start',
    url: 'http://localhost:8080',
    reuseExistingServer: true,
  },
});
