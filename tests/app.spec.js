// @ts-check
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- helpers ----

async function startApp(page) {
  await page.goto('/');
  await page.locator('#overlay').click();
  await expect(page.locator('#btn-show-controls')).toBeVisible({ timeout: 10_000 });
}

async function openControls(page) {
  await startApp(page);
  await page.locator('#btn-show-controls').click();
  await expect(page.locator('#controls')).toBeVisible();
}

// ---- splash screen ----

test('splash screen: overlay visible, FAB hidden', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#overlay')).toBeVisible();
  await expect(page.locator('#btn-show-controls')).toBeHidden();
});

test('splash screen: title text', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.overlay-content h1')).toHaveText('beatfinder');
});

// ---- init flow ----

test('clicking overlay starts app: overlay hides, FAB appears', async ({ page }) => {
  await page.goto('/');
  await page.locator('#overlay').click();
  await expect(page.locator('#overlay')).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('#btn-show-controls')).toBeVisible();
});

test('double-click on overlay does not break init', async ({ page }) => {
  await page.goto('/');
  await page.locator('#overlay').click();
  // A real double-click/double-tap fires both events before startApp()'s
  // own async work finishes, which is what the appHasStarted guard is for.
  // dispatchEvent (unlike .click()) fires immediately, bypassing the
  // actionability wait that would otherwise just block on the overlay
  // already being hidden if the first click's startup happened to finish
  // first -- exactly the race this test exists to cover either way.
  await page.locator('#overlay').dispatchEvent('click');
  await expect(page.locator('#btn-show-controls')).toBeVisible({ timeout: 10_000 });
});

test('six event quadrants are visible after init', async ({ page }) => {
  await startApp(page);
  await expect(page.locator('#quad-peak')).toBeVisible();
  await expect(page.locator('#quad-predicted')).toBeVisible();
  await expect(page.locator('#quad-chord')).toBeVisible();
  await expect(page.locator('#quad-downbeat')).toBeVisible();
  await expect(page.locator('#quad-loudness')).toBeVisible();
  await expect(page.locator('#quad-key')).toBeVisible();
});

test('key quadrant shows placeholder label before a key is detected', async ({ page }) => {
  await startApp(page);
  await expect(page.locator('#quad-key .quad-label')).toHaveText('Key');
});

test('BPM status bar shows "listening..." once mic starts', async ({ page }) => {
  await startApp(page);
  await expect(page.locator('#status-bar')).toBeVisible();
  await expect(page.locator('#status-bar')).toHaveText('listening...');
});

// ---- controls panel ----

test('FAB opens and closes controls panel', async ({ page }) => {
  await startApp(page);

  await expect(page.locator('#controls')).toBeHidden();

  await page.locator('#btn-show-controls').click();
  await expect(page.locator('#controls')).toBeVisible();

  await page.locator('#btn-show-controls').click();
  await expect(page.locator('#controls')).toBeHidden();
});

test('controls panel shows Mic and Open File buttons', async ({ page }) => {
  await openControls(page);
  await expect(page.locator('#btn-mic')).toBeVisible();
  await expect(page.locator('#btn-open-file')).toBeVisible();
});

// ---- Tuning panel ----

test('Tuning button opens a panel of sliders synced to the running engine', async ({ page }) => {
  await openControls(page);
  await expect(page.locator('#tuning-panel')).toBeHidden();

  await page.locator('#btn-tuning').click();
  await expect(page.locator('#tuning-panel')).toBeVisible();
  await expect(page.locator('.tuning-group-title').first()).toHaveText('General');

  // Mic mode boosts 10x (or 20x on a touch device) -- either way the panel
  // should reflect whatever the live engine actually locked in, not some
  // hardcoded placeholder.
  const boostRow = page.locator('.tuning-row', { hasText: 'Boost' }).first();
  await expect(boostRow.locator('.tuning-row-value')).not.toHaveText('1');
});

test('Moving a tuning slider updates the running engine live', async ({ page }) => {
  await openControls(page);
  await page.locator('#btn-tuning').click();

  const boostSlider = page.locator('#tuning-panel input[type="range"]').first();
  await boostSlider.fill('25');
  await boostSlider.dispatchEvent('input');

  await expect(page.locator('.tuning-row', { hasText: 'Boost' }).first().locator('.tuning-row-value'))
    .toHaveText('25');
  await expect.poll(() => page.evaluate(() => activeEngine.getConfig().boost)).toBe(25);
});

// ---- Mic mode ----

test('Mic mode auto-starts when app starts', async ({ page }) => {
  await openControls(page);
  await expect(page.locator('#btn-mic')).toHaveClass(/mode-btn-active/);
});

// ---- File mode ----

test('file player: hidden until a file is loaded', async ({ page }) => {
  await openControls(page);
  await expect(page.locator('#file-player')).toBeHidden();
});

test('file player: loading a file shows player controls and enables play/pause', async ({ page }) => {
  await openControls(page);

  const fixture = path.join(__dirname, '..', 'audio', 'basic-house-drums_130bpm.wav');
  await page.locator('#file-input').setInputFiles(fixture);

  await expect(page.locator('#file-player')).toBeVisible();
  await expect(page.locator('#play-track-name')).toHaveText('basic-house-drums_130bpm.wav');
  await expect(page.locator('#btn-play-pause')).toBeEnabled();
  await expect(page.locator('#btn-skip-back')).toBeVisible();
  await expect(page.locator('#btn-skip-forward')).toBeVisible();
});

test('file player: play/pause toggles label', async ({ page }) => {
  await openControls(page);

  const fixture = path.join(__dirname, '..', 'audio', 'basic-house-drums_130bpm.wav');
  await page.locator('#file-input').setInputFiles(fixture);
  await expect(page.locator('#btn-play-pause')).toBeEnabled();

  await page.locator('#btn-play-pause').click();
  await expect(page.locator('#btn-play-pause')).toContainText('Pause');

  await page.locator('#btn-play-pause').click();
  await expect(page.locator('#btn-play-pause')).toContainText('Play');
});

test('loading a file stops mic mode', async ({ page }) => {
  await openControls(page);
  await expect(page.locator('#btn-mic')).toHaveClass(/mode-btn-active/);

  const fixture = path.join(__dirname, '..', 'audio', 'basic-house-drums_130bpm.wav');
  await page.locator('#file-input').setInputFiles(fixture);

  await expect(page.locator('#btn-mic')).not.toHaveClass(/mode-btn-active/);
});

test('clicking Mic after a file is loaded switches back to mic mode', async ({ page }) => {
  await openControls(page);

  const fixture = path.join(__dirname, '..', 'audio', 'basic-house-drums_130bpm.wav');
  await page.locator('#file-input').setInputFiles(fixture);
  await expect(page.locator('#btn-mic')).not.toHaveClass(/mode-btn-active/);

  await page.locator('#btn-mic').click();
  await expect(page.locator('#btn-mic')).toHaveClass(/mode-btn-active/);
});

// ---- Recording ----

test('Record button toggles state, indicator, and disables mode switching', async ({ page }) => {
  await openControls(page);
  await expect(page.locator('#record-indicator')).toBeHidden();

  await page.locator('#btn-record').click();
  await expect(page.locator('#btn-record')).toHaveText('Stop');
  await expect(page.locator('#record-indicator')).toBeVisible();
  await expect(page.locator('#btn-mic')).toBeDisabled();
  await expect(page.locator('#btn-open-file')).toBeDisabled();

  await page.locator('#btn-record').click();
  await expect(page.locator('#btn-record')).toHaveText('Record');
  await expect(page.locator('#record-indicator')).toBeHidden();
  await expect(page.locator('#btn-mic')).toBeEnabled();
  await expect(page.locator('#btn-open-file')).toBeEnabled();
});

test('stopping a recording offers Save Audio and Save Log as two separate downloads', async ({ page }) => {
  await openControls(page);

  await page.locator('#btn-record').click();
  await page.waitForTimeout(500);
  await page.locator('#btn-record').click();

  await expect(page.locator('#save-recording-panel')).toBeVisible();

  const audioDownload = page.waitForEvent('download');
  await page.locator('#btn-save-audio').click();
  const audioFile = await audioDownload;
  expect(audioFile.suggestedFilename()).toMatch(/^beatfinder-.+\.(webm|m4a)$/);
  await expect(page.locator('#btn-save-audio')).toBeDisabled();

  const logDownload = page.waitForEvent('download');
  await page.locator('#btn-save-log').click();
  const logFile = await logDownload;
  expect(logFile.suggestedFilename()).toMatch(/^beatfinder-.+\.json$/);

  // Both files share the same timestamp stem, so they're recognizable as a pair.
  expect(logFile.suggestedFilename().replace(/\.json$/, ''))
    .toBe(audioFile.suggestedFilename().replace(/\.(webm|m4a)$/, ''));

  await expect(page.locator('#save-recording-panel')).toBeHidden();
});
