'use strict';

//
// beatfinder.js
//
// Real-time rhythm and harmony event detection for frontend webapps.
// 

/*
Usage:

  import { createBeatFinder } from './beatfinder.js';

  const engine = await createBeatFinder({
    audioContext,             // an AudioContext
    source,                   // an AudioNode to analyze (mic, file, etc.)
    boost: 10,                // optional gain applied to the analysis
                              // chain only -- does not affect playback
    Meyda: window.Meyda,      // https://github.com/meyda/meyda, loaded by the caller
    createRealtimeBpmAnalyzer, // https://github.com/dlepaux/realtime-bpm-analyzer, imported by the caller
    // ...any other key from DEFAULT_CONFIG below can be set here too
  });

  engine.on('peak', () => {...});
  engine.on('predictedBeat', ({ tickIndex }) => {...});
  engine.on('downbeat', ({ tickIndex }) => {...});
  engine.on('loudnessSpike', ({ level }) => {...});
  engine.on('chordChange', ({ distance }) => {...});
  engine.on('bpmChange', ({ bpm }) => {...});
  engine.on('tempoLost', () => {...});
  engine.on('keyChange', ({ key }) => {...}); // e.g. "A minor"

  // Every tunable value can also be read or modified on the fly:
  engine.getConfig();               // -> { boost: 10, loudnessSpikeHigh: 0.85, ... }
  engine.setConfig({ boost: 5 });   // merges over the current config

  // Later, to release everything (closes the AudioContext):
  engine.stop();

This library is dependency-free at the module level: Meyda and realtime-bpm-analyzer
are passed in by the caller rather than bundled or imported internally, so it can
be dropped into a page with a plain <script> tag and no build step.

How it works:
  1. Builds one shared web audio graph for four detectors:
    a. createBeatTracker
    b. createLoudnessSpikeDetector
    c. createChordAnalyzer
    d. createKeyAnalyzer
  2. Feeds audio input and config to each detector.
  3. Emits events corresponding with changes in rhythm, loudness, and harmony

The defaults in the library are well tested on iPhones with live electronic
music (think club DJs, etc.) but can be tweaked as needed.
*/

//
// Tunable defaults
//
// Every value here can be overridden at construction time (as an extra
// property alongside audioContext/source/Meyda/etc.) or changed later via
// engine.setConfig(). All of them take effect immediately except
// chordChromaBufferSize and keyAnalysisBufferSize, which rebuild the
// affected Meyda analyzer (a brief, one-frame gap in that analyzer's
// output) since Meyda can't resize an existing analyzer's FFT window.

const DEFAULT_CONFIG = {
  // Gain applied to the internal analysis chain only -- never to anything
  // routed to speakers. Quiet mic input typically needs 10-20x; a file
  // being played back out loud usually needs less.
  boost: 1,

  // No detected peak for this long drops the tempo lock and emits tempoLost.
  silenceTimeoutMs: 8_000,

  // A candidate tempo needs to differ from the current lock by more than
  // this (as a fraction) to even be considered for a re-lock.
  relockDrift: 0.10,
  // Consecutive agreeing readings needed to accept a re-lock.
  relockConsensus: 3,
  // Consecutive agreeing readings needed instead, when the candidate is a
  // suspiciously simple ratio (half, double, three-against-two, etc.) of
  // the current lock -- a common tempo-detector confusion on syncopated or
  // breakbeat-heavy material, so it needs much stronger evidence.
  relockConsensusSuspicious: 15,
  suspiciousRatioTolerance: 0.04,
  // A new tempo lock is immune to re-lock consideration for this long,
  // regardless of relockConsensus -- real tempo changes don't happen every
  // few seconds, so this alone kills most rapid flip-flopping.
  minLockHoldMs: 8_000,

  // downbeat picks whichever of the 4 beat positions has the strongest
  // average kick-band energy. Per-position sample count needed before that
  // comparison is trusted:
  downbeatPhaseMinSamples: 8,
  // Weight given to each new energy sample in that position's running average.
  downbeatPhaseEmaWeight: 0.15,
  // A challenger position must be this many times stronger than the
  // current downbeat position to take over (avoids flicker between two
  // near-tied positions).
  downbeatPhaseSwitchMargin: 1.15,

  // loudnessSpike fires when the rolling loudness percentile rises above
  // loudnessSpikeHigh, and re-arms once it falls back below loudnessSpikeLow.
  loudnessSpikeHigh: 0.85,
  loudnessSpikeLow: 0.6,

  // FFT window for the chordChange analyzer, in samples. Smaller feels more
  // immediate; larger gives cleaner pitch-class resolution.
  chordChromaBufferSize: 2048,
  // How many recent frames' distances to keep for the rolling mean/stddev
  // that chordChange's threshold is based on.
  chordDistanceHistorySize: 20,
  // chordChange fires when a frame's chroma distance from the previous
  // frame exceeds (rolling mean + this many standard deviations). Lower is
  // more sensitive.
  chordDistanceThresholdMult: 2,
  // Minimum gap between chordChange events, so one transient can't
  // multi-fire while its energy decays.
  chordRefractoryMs: 150,

  // FFT window for the key analyzer, in samples. Larger gives better bass
  // resolution (helpful for chroma accuracy) at the cost of a slower
  // update rate.
  keyAnalysisBufferSize: 8_192,
  // Weight given to each new chroma frame when smoothing over time (higher
  // = faster but noisier).
  keyChromaSmoothing: 0.3,
  // Consecutive agreeing frames needed before keyChange actually fires.
  // Higher means slower to react but less flicker between ambiguous keys.
  keyConsensusFrames: 8,
};

//
// Event emitter
//

function createEmitter() {
  const listenersByEvent = new Map();
  return {
    on(event, handler) {
      if (!listenersByEvent.has(event)) listenersByEvent.set(event, new Set());
      listenersByEvent.get(event).add(handler);
      return () => listenersByEvent.get(event)?.delete(handler);
    },
    off(event, handler) {
      listenersByEvent.get(event)?.delete(handler);
    },
    emit(event, payload) {
      listenersByEvent.get(event)?.forEach(handler => handler(payload));
    },
  };
}

//
// Beat + tempo tracking
//
// Turns realtime-bpm-analyzer's raw peak/tempo events into three things:
//   - peak, fired directly on every raw kick/transient it detects.
//   - predictedBeat, from a phase-corrected beat grid: once tempo locks, a
//     setTimeout chain ticks on every beat, and each detected peak nudges
//     its phase back into alignment.
//   - downbeat, whichever of those 4 scheduled beats currently has the
//     strongest average kick-band energy (most music accents beat 1).
//   - bpmChange / tempoLost, from a deliberately conservative tempo lock:
//     see relockConsensus and friends in DEFAULT_CONFIG above for why.

function clampBpmToRange(bpm) {
  while (bpm > 160) bpm /= 2;
  while (bpm < 70)  bpm *= 2;
  return bpm;
}

const SUSPICIOUS_TEMPO_RATIOS = [0.5, 2, 1 / 3, 3, 2 / 3, 1.5, 0.25, 4];

function isSuspiciousTempoRatio(candidateBpm, lockedBpm, tolerance) {
  const ratio = candidateBpm / lockedBpm;
  return SUSPICIOUS_TEMPO_RATIOS.some(suspicious => Math.abs(ratio - suspicious) / suspicious < tolerance);
}

function createBeatTracker({ bpmAnalyser, kickEnergyAnalyser, config, emit }) {
  const kickEnergyBuffer = new Float32Array(kickEnergyAnalyser.fftSize);

  function sampleKickEnergy() {
    kickEnergyAnalyser.getFloatTimeDomainData(kickEnergyBuffer);
    let sumOfSquares = 0;
    for (let i = 0; i < kickEnergyBuffer.length; i++) sumOfSquares += kickEnergyBuffer[i] ** 2;
    return Math.sqrt(sumOfSquares / kickEnergyBuffer.length);
  }

  let tempoIsLocked      = false;
  let lockedBpm          = 0;
  let beatGridGeneration = 0;
  let beatGridAnchor     = 0;
  let beatGridIntervalMs = 0;
  let lastPeakDetectedAt = performance.now();

  // Which of the 4 beats in a measure is the real downbeat isn't known in
  // advance -- most music accents it with a stronger kick, so we track
  // average kick-band energy per beat position (a slowly-updated EMA, one
  // slot refreshed per tick) and downbeat follows whichever position is
  // currently strongest. Reset on every (re-)lock since tick numbering
  // restarts from 1 then, and phase before that is meaningless.
  let phaseEnergyEma    = [null, null, null, null];
  let phaseSampleCounts = [0, 0, 0, 0];
  let downbeatPhase     = 0;

  // Folds one beat position's newest energy sample into its running
  // average, then re-checks whether a different position has pulled far
  // enough ahead to take over as the downbeat.
  function updateDownbeatPhase(phase, energy) {
    phaseEnergyEma[phase] = phaseEnergyEma[phase] === null
      ? energy
      : phaseEnergyEma[phase] * (1 - config.downbeatPhaseEmaWeight) + energy * config.downbeatPhaseEmaWeight;
    phaseSampleCounts[phase]++;

    if (Math.min(...phaseSampleCounts) < config.downbeatPhaseMinSamples) return;

    let strongest = 0;
    for (let i = 1; i < 4; i++) {
      if (phaseEnergyEma[i] > phaseEnergyEma[strongest]) strongest = i;
    }
    if (strongest !== downbeatPhase &&
        phaseEnergyEma[strongest] > phaseEnergyEma[downbeatPhase] * config.downbeatPhaseSwitchMargin) {
      downbeatPhase = strongest;
    }
  }

  function onBeatGridTick(tickIndex) {
    emit('predictedBeat', { tickIndex });

    const phase = tickIndex % 4;
    updateDownbeatPhase(phase, sampleKickEnergy());
    if (phase === downbeatPhase) emit('downbeat', { tickIndex });
  }

  function scheduleBeatGrid(intervalMs, anchor) {
    // Bumping beatGridGeneration invalidates any scheduleNext chain still
    // running from a previous lock -- its next setTimeout fires, sees a
    // stale gen, and quietly stops rescheduling itself instead of ticking
    // on top of the new grid.
    const gen = ++beatGridGeneration;
    tempoIsLocked      = true;
    beatGridAnchor      = anchor;
    beatGridIntervalMs  = intervalMs;
    phaseEnergyEma      = [null, null, null, null];
    phaseSampleCounts   = [0, 0, 0, 0];
    downbeatPhase       = 0;

    function scheduleNext(index) {
      const delay = beatGridAnchor + index * beatGridIntervalMs - performance.now();
      setTimeout(() => {
        if (gen !== beatGridGeneration) return;
        onBeatGridTick(index);
        scheduleNext(index + 1);
      }, Math.max(0, delay));
    }
    scheduleNext(1);
  }

  let lastLockAt = 0;

  function applyLock(bpm) {
    lockedBpm  = bpm;
    lastLockAt = performance.now();
    emit('bpmChange', { bpm });
    scheduleBeatGrid(60_000 / bpm, performance.now());
  }

  // Pending re-lock state: track consecutive readings that agree on a new tempo.
  let pendingBpm   = 0;
  let pendingCount = 0;

  function handleBpmReading(bpm) {
    if (lockedBpm > 0 && performance.now() - lastLockAt < config.minLockHoldMs) return;

    if (lockedBpm === 0) {
      applyLock(bpm);
      return;
    }

    const driftFromLock = Math.abs(bpm - lockedBpm) / lockedBpm;
    if (driftFromLock <= config.relockDrift) {
      pendingBpm   = 0;
      pendingCount = 0;
      return;
    }

    const driftFromPending = pendingBpm > 0 ? Math.abs(bpm - pendingBpm) / pendingBpm : 1;
    if (driftFromPending < 0.05) {
      pendingCount++;
    } else {
      pendingBpm   = bpm;
      pendingCount = 1;
    }

    const requiredConsensus = isSuspiciousTempoRatio(bpm, lockedBpm, config.suspiciousRatioTolerance)
      ? config.relockConsensusSuspicious
      : config.relockConsensus;
    if (pendingCount >= requiredConsensus) applyLock(bpm);
  }

  function pickTopCandidate(candidates) {
    if (!candidates?.length) return null;
    return candidates.reduce((best, c) => (c.count > (best?.count ?? -1) ? c : best), null);
  }

  bpmAnalyser.on('validPeak', () => {
    const now = performance.now();
    emit('peak');
    lastPeakDetectedAt = now;

    if (!tempoIsLocked || beatGridIntervalMs === 0) return;

    // Compute how far this peak sits from the nearest scheduled beat.
    // fractional is in [0, 1); normalize to [-0.5, 0.5) so the sign tells us
    // which direction the grid needs to shift.
    const beatsElapsed       = (now - beatGridAnchor) / beatGridIntervalMs;
    const fractional         = ((beatsElapsed % 1) + 1) % 1;
    const normalizedFraction = fractional > 0.5 ? fractional - 1 : fractional;
    const phaseErrorMs       = normalizedFraction * beatGridIntervalMs;

    // Only act when the peak is within 40% of a beat boundary -- peaks that
    // land in the middle of a beat interval are likely non-kick transients.
    if (Math.abs(phaseErrorMs) < beatGridIntervalMs * 0.4) {
      // Apply 25% of the error each peak (EMA) so corrections converge
      // smoothly over several beats rather than jumping all at once.
      beatGridAnchor += phaseErrorMs * 0.25;
    }
  });

  bpmAnalyser.on('bpm', ({ bpm: candidates }) => {
    const top = pickTopCandidate(candidates);
    if (!top || top.count < 10) return;
    handleBpmReading(clampBpmToRange(top.tempo));
  });

  bpmAnalyser.on('bpmStable', ({ bpm: candidates }) => {
    const top = pickTopCandidate(candidates);
    if (!top) return;
    handleBpmReading(clampBpmToRange(top.tempo));
  });

  const silenceCheckIntervalId = setInterval(() => {
    const msSinceLastPeak = performance.now() - lastPeakDetectedAt;
    if (msSinceLastPeak > config.silenceTimeoutMs && tempoIsLocked) {
      lockedBpm     = 0;
      tempoIsLocked = false;
      beatGridGeneration++;
      emit('tempoLost');
    }
  }, 2_000);

  return {
    stop() {
      beatGridGeneration++;
      clearInterval(silenceCheckIntervalId);
    },
  };
}

//
// Loudness "spike" detection
//
// beginLoudnessTracking maintains a rolling 30-second window of RMS values
// and reports the percentile rank of the current RMS in that window
// (0 = quietest, 1 = loudest), smoothed with an EMA so it responds
// gradually over a few beats rather than jumping on transients.
// createLoudnessSpikeDetector layers the loudnessSpike event on top: it
// fires once when that percentile crosses loudnessSpikeHigh, then re-arms
// once the level drops back below loudnessSpikeLow.

const LOUDNESS_HISTORY_SIZE = 300; // 300 samples x 100 ms = 30 s

function beginLoudnessTracking(analyserNode, onLevel) {
  const sampleBuffer     = new Float32Array(analyserNode.fftSize);
  const rmsHistory       = [];
  let smoothedPercentile = 0.5;

  return setInterval(() => {
    analyserNode.getFloatTimeDomainData(sampleBuffer);

    let sumOfSquares = 0;
    for (let i = 0; i < sampleBuffer.length; i++) sumOfSquares += sampleBuffer[i] ** 2;
    const rms = Math.sqrt(sumOfSquares / sampleBuffer.length);

    rmsHistory.push(rms);
    if (rmsHistory.length > LOUDNESS_HISTORY_SIZE) rmsHistory.shift();
    if (rmsHistory.length < 10) return;

    const samplesAtOrBelow = rmsHistory.filter(v => v <= rms).length;
    const percentile       = samplesAtOrBelow / rmsHistory.length;

    smoothedPercentile = smoothedPercentile * 0.92 + percentile * 0.08;
    onLevel(smoothedPercentile);
  }, 100);
}

function createLoudnessSpikeDetector(analyserNode, config, emit) {
  let armed = true;

  const timerId = beginLoudnessTracking(analyserNode, (level) => {
    if (level > config.loudnessSpikeHigh && armed) {
      emit('loudnessSpike', { level });
      armed = false;
    } else if (level < config.loudnessSpikeLow) {
      armed = true;
    }
  });

  return {
    stop() {
      clearInterval(timerId);
    },
  };
}

//
// Chord change + key detection (Meyda)
//
// Chord Change tracks Meyda's chroma feature (energy per pitch class,
// independent of octave) and fires when the pitch-class *distribution*
// shifts sharply from one frame to the next. This is deliberately not a
// generic loudness/energy onset detector: a repeating drum pattern is
// mostly noise-like and keeps roughly the same chroma shape hit after hit,
// so it doesn't trigger this nearly as often as an actual new chord or note
// does. It's still not a perfect chord detector -- percussion has some
// tonal content too -- but it's far more specific than reacting to any loud
// transient.
//
// Key is a slower background analyzer: chroma is smoothed over time and
// correlated against the 24 Krumhansl-Schmuckler major/minor key profiles.
// A candidate key must win several consecutive readings in a row before
// it's reported, so the display updates over a couple of seconds rather
// than flickering.

function cosineDistance(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : 1 - dot / denom;
}

const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// Krumhansl-Schmuckler key profiles: relative fit of each pitch class to a
// major/minor key whose tonic is pitch class 0.
const MAJOR_KEY_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_KEY_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlate(a, b) {
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let numerator = 0;
  let denomA = 0;
  let denomB = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    numerator += da * db;
    denomA += da * da;
    denomB += db * db;
  }
  const denom = Math.sqrt(denomA * denomB);
  return denom === 0 ? 0 : numerator / denom;
}

function bestKeyForChroma(chroma) {
  let bestName = null;
  let bestScore = -Infinity;
  for (let tonic = 0; tonic < 12; tonic++) {
    // MAJOR_KEY_PROFILE/MINOR_KEY_PROFILE are written for a tonic of C
    // (pitch class 0). Rotate each so its own index 0 lines up with this
    // tonic, so it can be compared directly against the chroma vector.
    const majorProfile = MAJOR_KEY_PROFILE.map((_, i) => MAJOR_KEY_PROFILE[(i - tonic + 12) % 12]);
    const minorProfile = MINOR_KEY_PROFILE.map((_, i) => MINOR_KEY_PROFILE[(i - tonic + 12) % 12]);
    const majorScore = correlate(chroma, majorProfile);
    const minorScore = correlate(chroma, minorProfile);
    if (majorScore > bestScore) { bestScore = majorScore; bestName = `${PITCH_CLASS_NAMES[tonic]} major`; }
    if (minorScore > bestScore) { bestScore = minorScore; bestName = `${PITCH_CLASS_NAMES[tonic]} minor`; }
  }
  return bestName;
}

function meanAndStdDev(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

// config is read live on every callback (not captured), so changes via
// setConfig take effect on the very next audio frame -- except bufferSize,
// which is fixed at analyzer-creation time and requires the caller to tear
// down and recreate the analyzer (see setConfig in createBeatFinder).

function createChordAnalyzer(Meyda, audioContext, source, config, emit) {
  let previousChroma  = null;
  let distanceHistory = [];
  let lastChordFireAt = 0;

  const analyzer = Meyda.createMeydaAnalyzer({
    audioContext,
    source,
    bufferSize: config.chordChromaBufferSize,
    featureExtractors: ['chroma'],
    callback: (features) => {
      const chroma = features.chroma;
      if (!chroma || chroma.length !== 12) return;

      if (!previousChroma) {
        previousChroma = chroma.slice();
        return;
      }

      const distance = cosineDistance(chroma, previousChroma);
      previousChroma = chroma.slice();

      distanceHistory.push(distance);
      if (distanceHistory.length > config.chordDistanceHistorySize) distanceHistory.shift();
      if (distanceHistory.length < 10) return;

      const { mean, stdDev } = meanAndStdDev(distanceHistory);
      const threshold = mean + stdDev * config.chordDistanceThresholdMult;

      const now = performance.now();
      if (distance > threshold && now - lastChordFireAt > config.chordRefractoryMs) {
        lastChordFireAt = now;
        emit('chordChange', { distance });
      }
    },
  });
  analyzer.start();
  return analyzer;
}

function createKeyAnalyzer(Meyda, audioContext, source, config, emit) {
  let smoothedChroma  = null;
  let pendingKey      = null;
  let pendingKeyCount = 0;
  let committedKey    = null;

  const analyzer = Meyda.createMeydaAnalyzer({
    audioContext,
    source,
    bufferSize: config.keyAnalysisBufferSize,
    featureExtractors: ['chroma'],
    callback: (features) => {
      const chroma = features.chroma;
      if (!chroma || chroma.length !== 12) return;

      if (!smoothedChroma) {
        smoothedChroma = chroma.slice();
      } else {
        for (let i = 0; i < 12; i++) {
          smoothedChroma[i] += (chroma[i] - smoothedChroma[i]) * config.keyChromaSmoothing;
        }
      }

      const candidate = bestKeyForChroma(smoothedChroma);
      if (candidate === pendingKey) {
        pendingKeyCount++;
      } else {
        pendingKey = candidate;
        pendingKeyCount = 1;
      }

      if (pendingKeyCount >= config.keyConsensusFrames && candidate !== committedKey) {
        committedKey = candidate;
        emit('keyChange', { key: committedKey });
      }
    },
  });
  analyzer.start();
  return analyzer;
}

//
// Main library engine
//
// Builds one shared Web Audio graph, then hands pieces of it to the four
// detector factories above. createBeatFinder itself owns no detection
// logic -- just the graph and the plumbing to construct/reconfigure/tear
// down those four detectors together.

export async function createBeatFinder({ audioContext, source, Meyda, createRealtimeBpmAnalyzer, ...configOverrides }) {
  const config  = { ...DEFAULT_CONFIG, ...configOverrides };
  const emitter = createEmitter();

  const boostGain  = audioContext.createGain();
  const bpmBoost   = audioContext.createGain();
  const kickHiPass = audioContext.createBiquadFilter();
  const kickLoPass = audioContext.createBiquadFilter();
  const silentSink = audioContext.createGain();

  boostGain.gain.value       = config.boost;
  bpmBoost.gain.value        = 1;
  kickHiPass.type            = 'highpass';
  kickHiPass.frequency.value = 60;
  kickHiPass.Q.value         = 0.7;
  kickLoPass.type            = 'lowpass';
  // Attempt to capture kick drum attack at around 600 Hz.
  kickLoPass.frequency.value = 600;
  kickLoPass.Q.value         = 0.7;
  silentSink.gain.value      = 0;

  const loudnessAnalyser   = audioContext.createAnalyser();
  loudnessAnalyser.fftSize = 1024;

  // Used only by createBeatTracker, to figure out which of the 4 beats in
  // a measure is the real downbeat.
  const kickEnergyAnalyser   = audioContext.createAnalyser();
  kickEnergyAnalyser.fftSize = 1024;

  const bpmAnalyser = await createRealtimeBpmAnalyzer(audioContext, {
    continuousAnalysis: true,
    stabilizationTime:  10_000,
    debug:              true,
  });

  source.connect(boostGain);
  boostGain.connect(loudnessAnalyser);
  boostGain.connect(kickHiPass);
  kickHiPass.connect(kickLoPass);
  kickLoPass.connect(kickEnergyAnalyser);
  kickLoPass.connect(bpmBoost);
  bpmBoost.connect(bpmAnalyser.node);
  bpmBoost.connect(silentSink);
  silentSink.connect(audioContext.destination);

  const emit = emitter.emit;
  const beatTracker           = createBeatTracker({ bpmAnalyser, kickEnergyAnalyser, config, emit });
  const loudnessSpikeDetector = createLoudnessSpikeDetector(loudnessAnalyser, config, emit);
  let chordAnalyzer = createChordAnalyzer(Meyda, audioContext, boostGain, config, emit);
  let keyAnalyzer   = createKeyAnalyzer(Meyda, audioContext, boostGain, config, emit);

  function setConfig(partial) {
    const chordBufferChanged = partial.chordChromaBufferSize !== undefined &&
      partial.chordChromaBufferSize !== config.chordChromaBufferSize;
    const keyBufferChanged = partial.keyAnalysisBufferSize !== undefined &&
      partial.keyAnalysisBufferSize !== config.keyAnalysisBufferSize;

    Object.assign(config, partial);

    if (partial.boost !== undefined) boostGain.gain.value = partial.boost;

    if (chordBufferChanged) {
      chordAnalyzer.stop();
      chordAnalyzer = createChordAnalyzer(Meyda, audioContext, boostGain, config, emit);
    }
    if (keyBufferChanged) {
      keyAnalyzer.stop();
      keyAnalyzer = createKeyAnalyzer(Meyda, audioContext, boostGain, config, emit);
    }
  }

  return {
    on: emitter.on,
    off: emitter.off,
    getConfig: () => ({ ...config }),
    setConfig,
    // audioContext and source were both handed to us by the caller, not
    // created by us -- stop() only tears down what this engine created
    // itself (analyzers, internal nodes, timers), and leaves the caller's
    // own nodes and context alone by default. Pass { closeContext: true }
    // only if this engine owns a dedicated AudioContext created just for
    // it (as the demo app does); never do this if the context is shared
    // with anything else, since closing it breaks all audio on it.
    //
    // Caveat: Meyda's analyzers have no public API to fully release their
    // internal ScriptProcessorNode short of closing the AudioContext, so
    // with closeContext left false, chordChange/keyChange's nodes keep
    // lightly processing silence until the caller eventually closes the
    // context themselves.
    stop({ closeContext = false } = {}) {
      beatTracker.stop();
      loudnessSpikeDetector.stop();
      bpmAnalyser.stop();
      bpmAnalyser.disconnect();
      chordAnalyzer.stop();
      keyAnalyzer.stop();
      boostGain.disconnect();
      source.disconnect(boostGain);
      if (closeContext) audioContext.close();
    },
  };
}

// Used in testing; not part of the library API.
export const _internal = {
  clampBpmToRange,
  isSuspiciousTempoRatio,
  cosineDistance,
  correlate,
  bestKeyForChroma,
};
