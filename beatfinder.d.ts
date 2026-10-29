// Type declarations for beatfinder.js.
//
// This is a hand-written .d.ts for a plain JS module, not compiler output --
// TypeScript resolves it automatically for `import ... from './beatfinder.js'`
// as long as this file sits next to it with the same basename. If you publish
// this as an npm package, point package.json's "types" field at this file.

/** Every value here has a documented default in beatfinder.js's DEFAULT_CONFIG. */
export interface BeatFinderConfig {
  /** Gain applied to the internal analysis chain only -- never to audio routed to speakers. */
  boost: number;
  /** Minimum gap between "peak" events, so one transient can't multi-fire as it rings out. */
  peakRefractoryMs: number;
  /** Tempo candidates are weighted toward this value (a log-normal prior) when ranking which one to trust. */
  preferredBpm: number;
  /** Spread (in octaves) of that prior -- smaller pulls harder toward preferredBpm. */
  preferredBpmSpread: number;
  /** Spread (in octaves) of a second, tighter prior pulling toward whatever tempo is currently locked. */
  lockedBpmSpread: number;
  /** How strongly a candidate is weighed down when a slower candidate in the same reading looks like its fundamental. */
  subharmonicWeight: number;
  /** How often tempo-candidate history resets so genuine tempo changes can be tracked. Construction-time only. */
  tempoStabilizationMs: number;
  /** No detected peak for this long drops the tempo lock and emits "tempoLost". */
  silenceTimeoutMs: number;
  /** "loudnessSpike" fires when the rolling loudness percentile rises above this. */
  loudnessSpikeHigh: number;
  /** loudnessSpike re-arms once the rolling loudness percentile falls back below this. */
  loudnessSpikeLow: number;
  /** FFT window (must be a power of 2) for the chordChange analyzer, in samples. */
  chordChromaBufferSize: number;
  /** How many recent frames' chroma distances feed chordChange's rolling mean/stddev. */
  chordDistanceHistorySize: number;
  /** chordChange fires when a frame's chroma distance exceeds (rolling mean + this many standard deviations). */
  chordDistanceThresholdMult: number;
  /** Minimum gap between chordChange events. */
  chordRefractoryMs: number;
  /** FFT window (must be a power of 2) for the key analyzer, in samples. */
  keyAnalysisBufferSize: number;
  /** Weight given to each new chroma frame when smoothing over time. */
  keyChromaSmoothing: number;
  /** Consecutive agreeing frames needed before keyChange fires. */
  keyConsensusFrames: number;
  /** Fractional drift from the current tempo lock needed to even consider a re-lock. */
  relockDrift: number;
  /** Consecutive agreeing readings needed to accept a re-lock. */
  relockConsensus: number;
  /** Consecutive agreeing readings needed instead when the candidate is a suspicious simple ratio of the current lock. */
  relockConsensusSuspicious: number;
  /** How close a tempo ratio must be to a simple fraction (0.5, 2, 1.5, ...) to count as suspicious. */
  suspiciousRatioTolerance: number;
  /** A new tempo lock is immune to re-lock consideration for this long. */
  minLockHoldMs: number;
  /** Per-beat-position sample count needed before downbeat's energy comparison is trusted. */
  downbeatPhaseMinSamples: number;
  /** Weight given to each new energy sample in a beat position's running average. */
  downbeatPhaseEmaWeight: number;
  /** How many times stronger a challenger beat position must be to become the new downbeat. */
  downbeatPhaseSwitchMargin: number;
}

export interface BeatFinderEventMap {
  peak: undefined;
  predictedBeat: { tickIndex: number };
  downbeat: { tickIndex: number };
  loudnessSpike: { level: number };
  chordChange: { distance: number };
  bpmChange: { bpm: number };
  tempoLost: undefined;
  /** e.g. "A minor", "C major" */
  keyChange: { key: string };
}

type EventHandler<Payload> = Payload extends undefined ? () => void : (payload: Payload) => void;

export interface StopOptions {
  /**
   * Close the AudioContext this engine was given, in addition to tearing
   * down everything the engine created itself. Only pass true if this
   * engine owns a dedicated AudioContext created just for it -- never if
   * the context is shared with anything else, since closing it stops all
   * audio on it, not just this engine's.
   */
  closeContext?: boolean;
}

export interface BeatFinderEngine {
  on<K extends keyof BeatFinderEventMap>(event: K, handler: EventHandler<BeatFinderEventMap[K]>): () => void;
  off<K extends keyof BeatFinderEventMap>(event: K, handler: EventHandler<BeatFinderEventMap[K]>): void;
  getConfig(): BeatFinderConfig;
  /** Merges over the current config; keys not mentioned are left unchanged. */
  setConfig(partial: Partial<BeatFinderConfig>): void;
  stop(options?: StopOptions): void;
}

export interface CreateBeatFinderOptions extends Partial<BeatFinderConfig> {
  audioContext: AudioContext;
  /** The AudioNode to analyze -- a mic input, a file's MediaElementSource, etc. */
  source: AudioNode;
  /** The Meyda global/module, loaded by the caller (https://github.com/meyda/meyda). */
  Meyda: unknown;
  /** From realtime-bpm-analyzer, imported by the caller (https://github.com/dlepaux/realtime-bpm-analyzer). */
  createRealtimeBpmAnalyzer: (audioContext: AudioContext, options: Record<string, unknown>) => Promise<unknown>;
}

export function createBeatFinder(options: CreateBeatFinderOptions): Promise<BeatFinderEngine>;
