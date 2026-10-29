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

Dependency-free at module level: Meyda and realtime-bpm-analyzer are passed
in by the caller, not bundled -- drop-in via <script>, no build step.

How it works:
  1. One shared web audio graph, four detectors:
    a. createBeatTracker
    b. createLoudnessSpikeDetector
    c. createChordAnalyzer
    d. createKeyAnalyzer
  2. Audio + config feed each detector.
  3. Events fire for rhythm, loudness, and harmony changes.

Defaults are tuned for iPhones + live electronic music (club DJs); tweak as needed.
*/

//
// Tunable defaults
//
// Overridable at construction or via engine.setConfig(). All apply
// immediately except: chordChromaBufferSize/keyAnalysisBufferSize (Meyda
// can't resize an FFT window -- rebuilds that analyzer, one-frame gap)
// and tempoStabilizationMs (construction-time only).

const DEFAULT_CONFIG = {
  // Analysis-chain gain only, never audible. Mic: 10-20x; loud file: less.
  boost: 1,

  // Min gap between 'peak' events. validPeak fires per scanned chunk --
  // too frequent; over-fires on sustained drums/cymbals.
  peakRefractoryMs: 225,

  // Tempo prior center. 120 is a reasonably common default.
  preferredBpm: 120,
  // Prior spread, in octaves. Smaller pulls harder.
  preferredBpmSpread: 0.3,

  // Spread for a tighter prior toward the current lock (see pickTopCandidate).
  lockedBpmSpread: 0.2,

  // Penalty when a slower candidate looks like this one's fundamental
  // (see pickTopCandidate). 0 = off; 1 = full weight.
  subharmonicWeight: 0.5,

  // How often tempo-candidate history resets (continuousAnalysis below)
  // Adapts to real tempo changes.
  tempoStabilizationMs: 10_000,

  // No peak for this long -> drop lock, emit tempoLost.
  silenceTimeoutMs: 8_000,

  // Min fractional drift from lock to even consider a re-lock.
  relockDrift: 0.10,
  // Consecutive agreeing readings needed to accept a re-lock.
  relockConsensus: 3,
  // Same, but for a suspiciously simple ratio of the lock (half, double,
  // 3:2, etc.) -- a common confusion on breakbeat material, so it needs
  // stronger evidence.
  relockConsensusSuspicious: 15,
  suspiciousRatioTolerance: 0.04,
  // New lock is immune to re-lock for this long, should kill 
  // detected tempo flip-flips.
  minLockHoldMs: 8_000,

  // downbeat = strongest avg kick-band energy of the 4 positions.
  // Samples needed per position before trusting that comparison:
  downbeatPhaseMinSamples: 8,
  // Weight per new energy sample in a position's running average.
  downbeatPhaseEmaWeight: 0.15,
  // Challenger must be this many times stronger to take over (avoids
  // flicker between near-tied positions).
  downbeatPhaseSwitchMargin: 1.15,

  // Fires above loudnessSpikeHigh; re-arms below loudnessSpikeLow.
  loudnessSpikeHigh: 0.85,
  loudnessSpikeLow: 0.6,

  // FFT window (samples). Smaller = more immediate; larger = cleaner
  // pitch-class resolution.
  chordChromaBufferSize: 2048,
  // Frames kept for chordChange's rolling mean/stddev threshold. Wider
  // avoids a repeating pattern (kick/snare) looking like baseline.
  chordDistanceHistorySize: 40,
  // Fires above (rolling mean + N stddev) chroma distance. Lower = more
  // sensitive. A crossing is just a candidate now (see
  // createChordAnalyzer) -- doesn't need to reject transients alone.
  chordDistanceThresholdMult: 2,
  // Min gap between chordChange events -- stops one transient multi-firing.
  chordRefractoryMs: 150,

  // FFT window (samples). Larger = better bass resolution, slower updates.
  keyAnalysisBufferSize: 8_192,
  // Per-frame smoothing weight -- higher = faster, noisier.
  keyChromaSmoothing: 0.3,
  // Consecutive agreeing frames before keyChange fires. Higher = slower,
  // less flicker.
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
// Turns realtime-bpm-analyzer's raw peak/tempo events into:
//   - peak: every raw kick/transient.
//   - predictedBeat: phase-corrected beat grid -- setTimeout chain ticks
//     each beat; peaks nudge phase back into alignment.
//   - downbeat: whichever of the 4 ticks has the strongest avg kick-band
//     energy (most music accents beat 1).
//   - bpmChange / tempoLost: see relockConsensus etc. in DEFAULT_CONFIG.

function clampBpmToRange(bpm) {
  while (bpm > 160) bpm /= 2;
  while (bpm < 70)  bpm *= 2;
  return bpm;
}

// Ratios commonly confused with the real tempo (breakbeats, fills, swells).
const SUSPICIOUS_TEMPO_RATIOS = [0.5, 2, 1 / 3, 3, 2 / 3, 1.5, 0.25, 4, 1.2, 5 / 6];

function isSuspiciousTempoRatio(candidateBpm, lockedBpm, tolerance) {
  const ratio = candidateBpm / lockedBpm;
  return SUSPICIOUS_TEMPO_RATIOS.some(suspicious => Math.abs(ratio - suspicious) / suspicious < tolerance);
}

// A Gaussian centered on logCenter, in log2-BPM space so octave
// relationships are symmetric.
function logNormalLogPrior(logBpm, logCenter, spread) {
  return -0.5 * ((logBpm - logCenter) / spread) ** 2;
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

  // Real downbeat isn't known in advance -- track avg kick-band energy
  // per beat position (slow EMA) and follow whichever is strongest.
  // Reset on every (re-)lock: tick numbering restarts, old phase is stale.
  let phaseEnergyEma    = [null, null, null, null];
  let phaseSampleCounts = [0, 0, 0, 0];
  let downbeatPhase     = 0;

  // Folds in one position's newest energy sample, then checks whether
  // another position has pulled ahead enough to take over as downbeat.
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
    // running from a previous lock -- it sees a stale gen and stops
    // rescheduling instead of ticking on top of the new grid.
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

  // Tracks consecutive readings that agree on a tempo, for both the first
  // lock and any re-lock after it.
  let pendingBpm   = 0;
  let pendingCount = 0;

  function handleBpmReading(bpm) {
    if (lockedBpm > 0 && performance.now() - lastLockAt < config.minLockHoldMs) return;

    if (lockedBpm > 0) {
      const driftFromLock = Math.abs(bpm - lockedBpm) / lockedBpm;
      if (driftFromLock <= config.relockDrift) {
        pendingBpm   = 0;
        pendingCount = 0;
        return;
      }
    }

    const driftFromPending = pendingBpm > 0 ? Math.abs(bpm - pendingBpm) / pendingBpm : 1;
    if (driftFromPending < 0.05) {
      pendingCount++;
    } else {
      pendingBpm   = bpm;
      pendingCount = 1;
    }

    // Without this the first lock gets no corroboration -- a single
    // stray reading would lock in unchallenged. isSuspiciousTempoRatio(bpm,
    // 0, ...) is always false, so this falls back to plain relockConsensus pre-lock.
    const requiredConsensus = isSuspiciousTempoRatio(bpm, lockedBpm, config.suspiciousRatioTolerance)
      ? config.relockConsensusSuspicious
      : config.relockConsensus;
    if (pendingCount >= requiredConsensus) applyLock(bpm);
  }

  // Re-ranks raw-count candidates: prior toward preferredBpm (as
  // librosa does); tighter prior toward the current lock; penalty for
  // looking like a harmonic of a slower candidate (subharmonic below).
  function pickTopCandidate(candidates) {
    if (!candidates?.length) return null;
    const logPreferred = Math.log2(config.preferredBpm);
    const logLocked = lockedBpm > 0 ? Math.log2(lockedBpm) : null;
    return candidates.reduce((best, c) => {
      const logBpm = Math.log2(c.tempo);
      let logPrior = logNormalLogPrior(logBpm, logPreferred, config.preferredBpmSpread);
      if (logLocked !== null) {
        logPrior += logNormalLogPrior(logBpm, logLocked, config.lockedBpmSpread);
      }

      // Weight by the subharmonic's own count -- a weak one shouldn't
      // drag down a dominant candidate.
      const subharmonic = candidates
        .filter(o => o.tempo < c.tempo && isSuspiciousTempoRatio(c.tempo, o.tempo, config.suspiciousRatioTolerance))
        .reduce((strongest, o) => (o.count > (strongest?.count ?? -1) ? o : strongest), null);
      if (subharmonic) logPrior -= config.subharmonicWeight * Math.log1p(subharmonic.count);

      const score = Math.log1p(c.count) + logPrior;
      return score > (best?.score ?? -Infinity) ? { ...c, score } : best;
    }, null);
  }

  bpmAnalyser.on('validPeak', () => {
    const now = performance.now();
    if (now - lastPeakDetectedAt < config.peakRefractoryMs) return;

    emit('peak');
    lastPeakDetectedAt = now;

    if (!tempoIsLocked || beatGridIntervalMs === 0) return;

    // Distance from the nearest scheduled beat; normalize to [-0.5, 0.5)
    // so the sign gives the shift direction.
    const beatsElapsed       = (now - beatGridAnchor) / beatGridIntervalMs;
    const fractional         = ((beatsElapsed % 1) + 1) % 1;
    const normalizedFraction = fractional > 0.5 ? fractional - 1 : fractional;
    const phaseErrorMs       = normalizedFraction * beatGridIntervalMs;

    // Within 40% of a beat boundary only -- further off is likely a
    // non-kick transient, not the beat.
    if (Math.abs(phaseErrorMs) < beatGridIntervalMs * 0.4) {
      // 25% correction per peak (EMA) -- converges smoothly, no jumps.
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
// beginLoudnessTracking: rolling 30s RMS window -> percentile rank
// (0 = quietest, 1 = loudest), EMA-smoothed against transients.
// createLoudnessSpikeDetector: fires once above loudnessSpikeHigh,
// re-arms below loudnessSpikeLow.

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
// chordChange: Meyda chroma (per-pitch-class energy, octave-independent)
// fires on a sharp pitch-class *distribution* shift -- not a generic
// loudness detector, since a repeating drum pattern keeps roughly the
// same chroma shape hit after hit. Still imperfect (percussion has some
// tonal content), but far more specific than reacting to any loud transient.
//
// keyChange: slower background analyzer -- chroma smoothed over time,
// correlated against the 24 Krumhansl-Schmuckler key profiles. A
// candidate must win several consecutive readings before it's reported,
// so it updates over a couple seconds rather than flickering.

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
    // Profiles are written for tonic C (pitch class 0) -- rotate to align
    // with this tonic for direct comparison against the chroma vector.
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

// config is read live each callback, so setConfig takes effect next
// frame -- except bufferSize, fixed at analyzer creation (see setConfig
// in createBeatFinder).

function createChordAnalyzer(Meyda, audioContext, source, config, emit) {
  let previousChroma  = null;
  let distanceHistory = [];
  let lastChordFireAt = 0;
  // A frame that crossed the threshold, pending the next frame's
  // confirmation that it stuck.
  let candidate = null;

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

      // Real change holds -- next frame stays close. A transient reverts
      // instead, so this catches it before firing.
      if (candidate) {
        const stayedPut = cosineDistance(chroma, candidate.chroma) < candidate.typicalDistance;
        const now = performance.now();
        if (stayedPut && now - lastChordFireAt > config.chordRefractoryMs) {
          lastChordFireAt = now;
          emit('chordChange', { distance: candidate.distance });
        }
        candidate = null;
      }

      distanceHistory.push(distance);
      if (distanceHistory.length > config.chordDistanceHistorySize) distanceHistory.shift();
      if (distanceHistory.length < 10) return;

      const { mean, stdDev } = meanAndStdDev(distanceHistory);
      const threshold = mean + stdDev * config.chordDistanceThresholdMult;

      if (distance > threshold) {
        candidate = { chroma: chroma.slice(), distance, typicalDistance: mean };
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
// One shared Web Audio graph, handed to the four detector factories
// above. No detection logic here -- just the graph and plumbing.

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
    stabilizationTime:  config.tempoStabilizationMs,
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
    // audioContext/source are caller-owned -- stop() only tears down what
    // this engine created. closeContext: true only if this engine owns a
    // dedicated context (never if shared -- closes all audio on it).
    // Caveat: without closeContext, Meyda's analyzers keep lightly
    // processing silence until the context is eventually closed (no API
    // to release their internal node otherwise).
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
