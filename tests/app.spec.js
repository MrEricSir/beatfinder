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

test('recording started after tempo already locked backfills the missed bpmChange', async ({ page }) => {
  await openControls(page);

  // Simulate tempo having locked before Record was pressed, rather than
  // waiting out a real lock -- lastKnownBpm is exactly what a real
  // bpmChange handler would have set.
  await page.evaluate(() => { lastKnownBpm = 128; });

  await page.locator('#btn-record').click();
  const firstEvent = await page.evaluate(() => recordedEvents[0]);
  expect(firstEvent).toEqual({ t: 0, event: 'bpmChange', bpm: 128, initial: true });

  await page.locator('#btn-record').click();
});

test('recording started before any tempo lock does not backfill a bpmChange', async ({ page }) => {
  await openControls(page);

  await page.evaluate(() => { lastKnownBpm = null; });

  await page.locator('#btn-record').click();
  const hasBpmChange = await page.evaluate(() => recordedEvents.some(e => e.event === 'bpmChange'));
  expect(hasBpmChange).toBe(false);

  await page.locator('#btn-record').click();
});

// ---- Mic boost auto-throttle ----

test('a recent stored boost is used as the starting point; a stale one is ignored', async ({ page }) => {
  await page.goto('/');

  await page.evaluate(() => {
    localStorage.setItem('beatfinder.micBoost', JSON.stringify({ boost: 3, ts: Date.now() }));
  });
  await expect.poll(() => page.evaluate(() => loadStoredBoost(BOOST_STORAGE_KEY_MIC))).toBe(3);

  await page.evaluate(() => {
    const thirteenHoursAgo = Date.now() - 13 * 60 * 60 * 1000;
    localStorage.setItem('beatfinder.micBoost', JSON.stringify({ boost: 3, ts: thirteenHoursAgo }));
  });
  await expect.poll(() => page.evaluate(() => loadStoredBoost(BOOST_STORAGE_KEY_MIC))).toBe(null);
});

test('a recent stored boost for file mode is kept separate from mic mode', async ({ page }) => {
  await page.goto('/');

  await page.evaluate(() => {
    localStorage.setItem('beatfinder.micBoost', JSON.stringify({ boost: 5, ts: Date.now() }));
    localStorage.setItem('beatfinder.fileBoost', JSON.stringify({ boost: 2, ts: Date.now() }));
  });
  await expect.poll(() => page.evaluate(() => loadStoredBoost(BOOST_STORAGE_KEY_MIC))).toBe(5);
  await expect.poll(() => page.evaluate(() => loadStoredBoost(BOOST_STORAGE_KEY_FILE))).toBe(2);
});

test('nextBoostState throttles down immediately on overload', async ({ page }) => {
  await page.goto('/');

  const result = await page.evaluate(() => nextBoostState({
    peak: 0.5, currentBoost: 20, defaultBoost: 20, quietStreak: 0,
  }));
  // target 0.75 / peak 0.5 => ideal boost 1.5, well below currentBoost 20.
  expect(result.boost).toBe(1.5);
  expect(result.quietStreak).toBe(0);
});

test('nextBoostState only recovers boost after sustained headroom, and caps at the default', async ({ page }) => {
  await page.goto('/');

  const results = await page.evaluate(() => {
    // peak 0.03 at boost 2 => actual level 0.06, well under the 0.75
    // target -- consistent, sustained headroom every tick.
    let state = { boost: 2, quietStreak: 0 };
    const history = [];
    for (let i = 0; i < 9; i++) {
      const next = nextBoostState({
        peak: 0.03, currentBoost: state.boost, defaultBoost: 20, quietStreak: state.quietStreak,
      });
      state = { boost: next.boost ?? state.boost, quietStreak: next.quietStreak };
      history.push({ appliedBoost: next.boost, quietStreak: next.quietStreak });
    }
    return history;
  });

  // Headroom persists for 7 ticks without crossing the consensus threshold...
  for (const tick of results.slice(0, 7)) {
    expect(tick.appliedBoost).toBe(null);
    expect(tick.quietStreak).toBeGreaterThan(0);
  }
  // ...then on the 8th tick of sustained headroom, boost recovers upward
  // (target 0.75 / peak 0.03 = 25, capped at the 20x default) and the
  // streak resets.
  expect(results[7].appliedBoost).toBe(20);
  expect(results[7].quietStreak).toBe(0);
});

test('nextBoostState leaves boost alone when already close to the target', async ({ page }) => {
  await page.goto('/');

  // target 0.75 / peak 0.075 = ideal boost 10, equal to currentBoost -- no change.
  const result = await page.evaluate(() => nextBoostState({
    peak: 0.075, currentBoost: 10, defaultBoost: 20, quietStreak: 3,
  }));
  expect(result.boost).toBe(null);
  expect(result.quietStreak).toBe(0);
});

test('mic mode starts at a recently stored throttled-down boost instead of the default', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('beatfinder.micBoost', JSON.stringify({ boost: 2, ts: Date.now() }));
  });

  await page.locator('#overlay').click();
  await expect.poll(() => page.evaluate(() => activeEngine?.getConfig().boost)).toBe(2);
});

test('file mode starts at a recently stored throttled-down boost instead of the default', async ({ page }) => {
  await openControls(page);
  await page.evaluate(() => {
    localStorage.setItem('beatfinder.fileBoost', JSON.stringify({ boost: 1.5, ts: Date.now() }));
  });

  const fixture = path.join(__dirname, '..', 'audio', 'basic-house-drums_130bpm.wav');
  await page.locator('#file-input').setInputFiles(fixture);
  await expect.poll(() => page.evaluate(() => activeEngine?.getConfig().boost)).toBe(1.5);
});
