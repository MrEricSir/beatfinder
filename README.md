# beatfinder

**beatfinder.js** is a tiny Javascript library built to respond to music
by emitting events. Specifically, it allows applications to get realtime
events for beat detection, chord/harmony changes, and loudness spikes.

All processing is performed on the frontend; there is no backend. Works
with any `AudioNode` including the system mic or audio files.

The defaults in the library are well tested on iPhones with live electronic
music (think club DJs, etc.) but can be tweaked as needed.

[Try the demo webapp!](https://mrericsir.github.io/beatfinder/)

## Using the library

`beatfinder.js` is a Javascript module with no bundled dependencies. It needs
two libraries handed to it by the caller, already loaded:
[Meyda](https://github.com/meyda/meyda) (a global, loaded via a `<script>`
tag) and [realtime-bpm-analyzer](https://github.com/dlepaux/realtime-bpm-analyzer)
(an ES module, loaded via `import`). This keeps the library itself
buildless and framework-agnostic.

TypeScript types are in `beatfinder.d.ts`, sitting next to the `.js` file with
the same basename:
```js
import { createBeatFinder } from './beatfinder.js'
```
picks them up automatically with no extra config.

Example:

```js
import { createBeatFinder } from './beatfinder.js';
import { createRealtimeBpmAnalyzer } from 'https://cdn.jsdelivr.net/npm/realtime-bpm-analyzer@5.0.15/dist/index.esm.js';

const audioContext = new AudioContext();
const stream       = await navigator.mediaDevices.getUserMedia({ audio: true });
const source       = audioContext.createMediaStreamSource(stream);

const engine = await createBeatFinder({
  audioContext,
  source,
  boost: 10, // (Optional)
  Meyda: window.Meyda,
  createRealtimeBpmAnalyzer,
});

engine.on('peak', () => console.log('Beat detected'));
engine.on('bpmChange', ({ bpm }) => console.log('Tempo locked at', bpm));
engine.on('keyChange', ({ key }) => console.log('Key changed to', key));

// ...
// To stop BeatFinder:
engine.stop();
```

### Events

| Event | Payload | Fires when |
| --- | --- | --- |
| `peak` | -- | A raw beat detected in the audio |
| `predictedBeat` | `{ tickIndex }` | A scheduled tick from the phase-corrected beat grid, once tempo has been locked on |
| `downbeat` | `{ tickIndex }` | The predicted beat that's intended to be beat 1 of the measure |
| `loudnessSpike` | `{ level }` | The rolling loudness level crosses a high threshold |
| `chordChange` | `{ distance }` | The mix of pitch classes present shifts sharply from one frame to the next |
| `bpmChange` | `{ bpm }` | Tempo locks or re-locks |
| `tempoLost` | -- | No peaks for 8 seconds -- tempo lock is dropped |
| `keyChange` | `{ key }` | The detected musical key changes (e.g. `"A minor"`) |

`engine.on(event, handler)` returns an unsubscribe function. `engine.off(event, handler)`
also works.

`engine.stop()` tears down what it created itself (analyzers, nodes,
timers). `audioContext`/`source` are caller-owned, left alone unless
`{ closeContext: true }` is set, which will tear down the audioContext.

Note: without `closeContext`, Meyda's `chordChange`/`keyChange` nodes
keep processing silence until the context is closed.

### Live configuration changes

Every threshold, buffer size, and consensus count the detectors use is a
config value with a documented default (see `DEFAULT_CONFIG` at the top of
`beatfinder.js`), and every one of them can be read or changed after the
engine is already running:

```js
engine.getConfig();                        // -> { boost: 10, loudnessSpikeHigh: 0.85, ... }
engine.setConfig({ chordDistanceThresholdMult: 1.2 });  // more sensitive chordChange
```

`setConfig` merges over the current config. Values not included are left
alone. Takes effect on next frame, except `chordChromaBufferSize` and
`keyAnalysisBufferSize`: Meyda can't resize an FFT window, so these
rebuild just that one analyzer.

## The demo app

Run [the online version here](https://mrericsir.github.io/beatfinder/)
or read on for how to set this up locally.

Each audio event corresponds with one big colored rectangle:

- **Detected Beat**, **Predicted Beat**, **Downbeat**, **Loudness Spike**,
  **Chord Change** each flash briefly when their event fires.
- **Key** doesn't flash on its own event cadence -- it's a live readout of
  the current key, and flashes only when `keyChange` actually fires.

A **Tuning** button in the controls panel opens a live editor for every
value in `DEFAULT_CONFIG`, generated from a small schema in `app.js` (see
`TUNING_GROUPS`) rather than hand-written per field. It's a demonstration
of `getConfig`/`setConfig`, not a separate feature of the library itself.

A **Record** button captures the active (pre-boost) audio plus a
timestamped JSON log of every event, so a real session can be checked for
accuracy afterward. Works in both Mic and Open File mode; mode-switching
is disabled while recording (same `AudioContext` for both).

Saving uses the Web Share API where available (iOS: share sheet -> Save
to Files -> iCloud Drive). Otherwise, two separate buttons -- browsers
silently block a second automatic download, so one "save both" button
wouldn't reliably work.

## Development

Note: This has only been tested on macOS.

Configure and install requirements with `dev.sh`:
```bash
./dev.sh setup
```

Start, restart, and stop the server with the following commands:
```bash
./dev.sh start
./dev.sh restart
./dev.sh stop
```

Run the test suite:
```bash
./dev.sh test
```

`tests/app.spec.js` covers the demo app's UI. `tests/beatfinder.spec.js`
tests the library itself: the pure math helpers directly (correlation,
cosine distance, tempo-ratio suspicion, key-profile matching) via
beatfinder.js's `_internal` export, plus one integration test that runs a
synthetic click track at a precisely known BPM through the real
`createBeatFinder` and asserts it locks onto that exact tempo -- a
stronger, fully repeatable check than trusting a real music file's labeled
BPM.

## How beatfinder.js works

Audio is routed through a kick-filtered
[realtime-bpm-analyzer](https://github.com/dlepaux/realtime-bpm-analyzer) to
detect peaks and lock onto a tempo, and through a separate analyser node to
track rolling loudness. Once a tempo locks, a phase-corrected beat grid
schedules `predictedBeat` events; detected peaks nudge the grid's phase
back into alignment on every kick. Which of the 4 beats in a measure is
`downbeat` is decided by comparing average kick-band energy across the 4
beat positions and following whichever is consistently strongest.

The `peak` event is from realtime-bpm-analyzer, but filtered to only fire
once for a given period rather than per sample.

Tempo locking is deliberately conservative: a candidate tempo needs to hold
for 8 seconds. A candidate that's a ratio (half, double, etc.) of the
currently locked tempo needs to hold longer, to resist false positives from
pattern changes (beat shifts, drum fills, etc.)

Two more analyzers run off Meyda's `chroma` feature (energy per pitch
class, independent of octave), at different buffer sizes since they're
solving different problems:
- **`chordChange`**: moderate buffer (2048 samples, ~46ms), cosine
  distance between consecutive chroma vectors. Fires on a sharp shift
  above the rolling average -- not a generic loudness trigger, since a
  repeating drum pattern keeps roughly the same chroma shape hit after
  hit. Still imperfect (percussion has some tonal content).
- **`keyChange`**: large buffer (8192 samples), chroma smoothed over
  time and correlated against the 24 Krumhansl-Schmuckler key profiles. A
  candidate must win several consecutive readings, so changes land over a
  couple seconds rather than flickering.

All audio is amplified by a `boost` value which is determined at runtime;
this is intended to normalize the volume in live environments where it can
vary between songs or while moving closer to or away from the speakers.

## Dependencies

### Library
- [realtime-bpm-analyzer](https://github.com/dlepaux/realtime-bpm-analyzer)
- [Meyda](https://github.com/meyda/meyda) 

### Demo app and tests
- [tuicss](https://github.com/vinorodrigues/tuicss)
- [Playwright](https://github.com/microsoft/playwright)
