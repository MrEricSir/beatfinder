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

`engine.stop()` tears down everything the engine created itself (analyzers,
internal gain/filter nodes, timers) but -- since it didn't create the
`audioContext` or `source` you handed it -- leaves both of those alone by
default. If this engine owns a dedicated `AudioContext` created just for it,
pass `engine.stop({ closeContext: true })` to close it. 

Note: Meyda's analyzers have no API to release its internal processing node
short of closing the `AudioContext`, so leaving `closeContext` false means
`chordChange`/`keyChange`'s nodes keep lightly processing silence until the
context is eventually closed.

### Live configuration changes

Every threshold, buffer size, and consensus count the detectors use is a
config value with a documented default (see `DEFAULT_CONFIG` at the top of
`beatfinder.js`), and every one of them can be read or changed after the
engine is already running:

```js
engine.getConfig();                        // -> { boost: 10, loudnessSpikeHigh: 0.85, ... }
engine.setConfig({ chordDistanceThresholdMult: 1.2 });  // more sensitive chordChange
```

Values not mentioned in `setConfig`'s argument are left unchanged -- it
merges over the current config rather than replacing it. Changes take
effect on the very next audio frame, except `chordChromaBufferSize` and
`keyAnalysisBufferSize`: Meyda can't resize an existing analyzer's FFT
window, so changing either of those tears down and recreates just that one
analyzer (a brief gap in that analyzer's output only -- everything else
keeps running).

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

Tempo locking is deliberately conservative: a candidate tempo needs to hold
for 8 seconds before it's even considered, and a candidate that's a simple
ratio (half, double, three-against-two, etc.) of the current lock needs far
more sustained agreement than an unrelated tempo would, since that's a
common tempo-detector confusion on syncopated or breakbeat-heavy material.

Two more analyzers run off Meyda's `chroma` feature (energy per pitch
class, independent of octave), at different buffer sizes since they're
solving different problems:
- **`chordChange`** uses a moderate buffer (2048 samples, ~46 ms) and
  compares each frame's chroma vector to the previous one (cosine
  distance). A sharp shift in pitch-class balance above the recent rolling
  average fires the event. This is deliberately not a generic loudness
  trigger -- a repeating drum pattern is mostly noise-like and keeps
  roughly the same chroma shape hit after hit, so it doesn't fire nearly
  as often as an actual chord change does. It's still not a perfect chord
  detector -- percussion has some tonal content too.
- **`keyChange`** uses a large buffer (8192 samples) and smooths chroma
  over time, correlating it against the 24 Krumhansl-Schmuckler major/minor
  key profiles. A candidate key has to win several consecutive readings
  before it's reported, so detecting an actual key change takes a couple
  of seconds rather than flickering.

## Dependencies

### Library
- [realtime-bpm-analyzer](https://github.com/dlepaux/realtime-bpm-analyzer)
- [Meyda](https://github.com/meyda/meyda) 

### Demo app and tests
- [tuicss](https://github.com/vinorodrigues/tuicss)
- [Playwright](https://github.com/microsoft/playwright)
