'use strict';

// ---- DOM refs ----

const overlay           = document.getElementById('overlay');
const errorMessage      = document.getElementById('error-msg');
const controlsPanel     = document.getElementById('controls');
const controlsToggleBtn = document.getElementById('btn-show-controls');
const statusBar         = document.getElementById('status-bar');

const quadPeak      = document.getElementById('quad-peak');
const quadPredicted = document.getElementById('quad-predicted');
const quadChord     = document.getElementById('quad-chord');
const quadDownbeat  = document.getElementById('quad-downbeat');
const quadLoudness  = document.getElementById('quad-loudness');
const quadKey       = document.getElementById('quad-key');
const quadKeyLabel  = quadKey.querySelector('.quad-label');

const micBtn       = document.getElementById('btn-mic');
const openFileBtn  = document.getElementById('btn-open-file');
const tuningBtn    = document.getElementById('btn-tuning');
const tuningPanel  = document.getElementById('tuning-panel');
const recordBtn    = document.getElementById('btn-record');
const recordIndicator = document.getElementById('record-indicator');
const recordTimeEl    = document.getElementById('record-time');
const saveRecordingPanel = document.getElementById('save-recording-panel');
const saveAudioBtn    = document.getElementById('btn-save-audio');
const saveLogBtn      = document.getElementById('btn-save-log');
const fileInput    = document.getElementById('file-input');
const filePlayer   = document.getElementById('file-player');
const playPauseBtn = document.getElementById('btn-play-pause');
const trackNameLabel = document.getElementById('play-track-name');
const seekBar       = document.getElementById('seek-bar');
const timeCurrentEl = document.getElementById('time-current');
const timeTotalEl   = document.getElementById('time-total');

// ---- Shared helpers ----

function updateBpmDisplay(text) {
  statusBar.textContent = text;
  statusBar.classList.remove('hidden');
}

function formatDuration(seconds) {
  if (!isFinite(seconds) || isNaN(seconds)) return '--:--';
  const minutes = Math.floor(seconds / 60);
  const secs    = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${secs}`;
}

function flashQuadrant(el, durationMs = 450) {
  // Cancel any in-flight animation.
  el.getAnimations().forEach(anim => anim.cancel());
  // Launch new animation.
  el.animate(
    [{ backgroundColor: 'var(--quad-color)' }, { backgroundColor: 'transparent' }],
    { duration: durationMs, easing: 'ease-out' }
  );
}

function displayError(msg) {
  if (msg) {
    errorMessage.textContent = msg;
    errorMessage.classList.remove('hidden');
  } else {
    errorMessage.classList.add('hidden');
  }
}

// Safari workaround.
function createAudioContext() {
  return new (window.AudioContext || window.webkitAudioContext)();
}

// Splash screen (oscilloscope waveform.)

const SCOPE_SAMPLE_SPACING_PX       = 16;
const SCOPE_SCROLL_SPEED_PX_PER_SEC = 2000;
const SCOPE_MAX_STEP                = 0.5;

function startScopeAnimation(canvas) {
  const ctx = canvas.getContext('2d');
  let dpr = window.devicePixelRatio || 1;
  let samples      = [];
  let scrollOffset = 0;
  let lastFrameAt  = null;
  let animationFrameId = null;

  function nextSample(previous) {
    const jump = (Math.random() - 0.5) * SCOPE_MAX_STEP;
    return Math.max(-1, Math.min(1, previous + jump));
  }

  function fillSamples() {
    const spacing   = SCOPE_SAMPLE_SPACING_PX * dpr;
    const needed    = Math.ceil(canvas.width / spacing) + 2;
    samples = new Array(needed).fill(0);
    for (let i = 1; i < needed; i++) samples[i] = nextSample(samples[i - 1]);
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width  = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    fillSamples();
  }
  resize();
  window.addEventListener('resize', resize);

  function draw(now) {
    animationFrameId = requestAnimationFrame(draw);

    const dtSeconds = lastFrameAt === null ? 0 : (now - lastFrameAt) / 1000;
    lastFrameAt = now;

    const spacing = SCOPE_SAMPLE_SPACING_PX * dpr;
    scrollOffset += SCOPE_SCROLL_SPEED_PX_PER_SEC * dpr * dtSeconds;
    while (scrollOffset >= spacing) {
      scrollOffset -= spacing;
      samples.shift();
      samples.push(nextSample(samples[samples.length - 1]));
    }

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const xs = samples.map((_, i) => i * spacing - scrollOffset);
    const ys = samples.map(v => h / 2 + v * h * 0.32);

    ctx.strokeStyle = '#39ff14';
    ctx.lineWidth   = 2 * dpr;
    ctx.shadowColor = '#39ff14';
    ctx.shadowBlur  = 10;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';

    // Quadratic-through-midpoints smoothing so the trace curves rather
    // than kinks at each sample.
    ctx.beginPath();
    ctx.moveTo(xs[0], ys[0]);
    for (let i = 1; i < samples.length - 1; i++) {
      const midX = (xs[i] + xs[i + 1]) / 2;
      const midY = (ys[i] + ys[i + 1]) / 2;
      ctx.quadraticCurveTo(xs[i], ys[i], midX, midY);
    }
    ctx.lineTo(xs[samples.length - 1], ys[samples.length - 1]);
    ctx.stroke();
  }
  animationFrameId = requestAnimationFrame(draw);

  return {
    stop() {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', resize);
    },
  };
}

const scopeAnimation = startScopeAnimation(document.getElementById('scope-canvas'));

// ---- External dependencies ----
//
// beatfinder.js needs Meyda and realtime-bpm-analyzer handed to it already
// loaded (see beatfinder.js's own header comment for why). Both are
// gathered here, in one place, as soon as the page loads, rather than
// wherever happens to need them first:
//
//   - Meyda's browser build is a plain global script, not an ES module --
//     its only real ESM build has a bare `import "fftjs"` that only
//     resolves inside a bundler, not from a plain URL in a browser -- so
//     it's loaded via the <script> tag in index.html and read off
//     `window` here.
//   - realtime-bpm-analyzer does ship a working browser ESM build, so it's
//     loaded with an ordinary dynamic import alongside beatfinder.js
//     itself.

const REALTIME_BPM_ANALYZER_URL =
  'https://cdn.jsdelivr.net/npm/realtime-bpm-analyzer@5.0.15/dist/index.esm.js';

const Meyda = window.Meyda;

const dependenciesPromise = Promise.all([
  import('./beatfinder.js'),
  import(REALTIME_BPM_ANALYZER_URL),
]);

// ---- Audio event engine ----
//
// The actual rhythm/chord/key detection lives in beatfinder.js as a
// standalone library; this just wires its events to the quadrant flashes.
// Only one engine runs at a time; starting a new one always tears down the
// previous one first.

let activeEngine        = null;
let activeAudioContext  = null;
let activeSourceNode    = null;

async function startAudioEngine(audioContext, source, { boost, audible }) {
  if (audible) source.connect(audioContext.destination);

  const [{ createBeatFinder }, { createRealtimeBpmAnalyzer }] = await dependenciesPromise;

  const engine = await createBeatFinder({
    audioContext,
    source,
    boost,
    Meyda,
    createRealtimeBpmAnalyzer,
  });

  engine.on('peak', () => { flashQuadrant(quadPeak); logRecordedEvent('peak', {}); });
  engine.on('predictedBeat', (payload) => { flashQuadrant(quadPredicted); logRecordedEvent('predictedBeat', payload); });
  engine.on('downbeat', (payload) => { flashQuadrant(quadDownbeat); logRecordedEvent('downbeat', payload); });
  engine.on('loudnessSpike', (payload) => { flashQuadrant(quadLoudness); logRecordedEvent('loudnessSpike', payload); });
  engine.on('chordChange', (payload) => { flashQuadrant(quadChord); logRecordedEvent('chordChange', payload); });
  engine.on('bpmChange', (payload) => { updateBpmDisplay(`${Math.round(payload.bpm)} BPM`); logRecordedEvent('bpmChange', payload); });
  engine.on('tempoLost', () => { updateBpmDisplay('listening...'); logRecordedEvent('tempoLost', {}); });
  engine.on('keyChange', (payload) => {
    quadKeyLabel.textContent = payload.key;
    flashQuadrant(quadKey);
    logRecordedEvent('keyChange', payload);
  });

  updateBpmDisplay('listening...');
  quadKeyLabel.textContent = 'Key';
  syncTuningPanelFromEngine(engine);

  return engine;
}

function tearDownActiveEngine() {
  // Stop. Save any recording in progress here.
  if (isRecording) {
    stopRecording();
  }

  if (activeEngine) {
    // Safe here specifically because this app always builds a fresh
    // AudioContext per mic/file session (see startMicMode/loadAudioFile)
    // and never shares one across engines.
    activeEngine.stop({ closeContext: true });
    activeEngine = null;
  }
  activeAudioContext = null;
  activeSourceNode    = null;
  statusBar.classList.add('hidden');
}

// ---- Recording ----

// Capture the original audio before we analyze it here for later debugging.

const mediaRecorderSupported = typeof MediaRecorder !== 'undefined';

const RECORDER_MIME_CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];

function pickRecorderMimeType() {
  for (const candidate of RECORDER_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return '';
}

function extensionForMimeType(mimeType) {
  if (mimeType.includes('mp4'))  return 'm4a';
  if (mimeType.includes('webm')) return 'webm';
  return 'audio';
}

let isRecording          = false;
let mediaRecorder         = null;
let recordedChunks        = [];
let recordedEvents        = [];
let recordingStartPerf    = null;
let recordingDestination  = null;
let recordingSourceNode   = null;
let recordingTimerId      = null;

function logRecordedEvent(name, payload) {
  if (!isRecording) {
    return;
  }

  recordedEvents.push({ t: Math.round(performance.now() - recordingStartPerf), event: name, ...payload });
}

function updateRecordButton() {
  recordBtn.textContent = isRecording ? 'Stop' : 'Record';
  recordBtn.classList.toggle('record-btn-active', isRecording);
  micBtn.disabled      = isRecording;
  openFileBtn.disabled = isRecording;
}

function updateRecordTimeDisplay() {
  const elapsedSeconds = (performance.now() - recordingStartPerf) / 1000;
  recordTimeEl.textContent = formatDuration(elapsedSeconds);
}

function startRecording() {
  if (isRecording || !activeAudioContext || !activeSourceNode) {
    return;
  }

  recordingDestination = activeAudioContext.createMediaStreamDestination();
  recordingSourceNode  = activeSourceNode;
  recordingSourceNode.connect(recordingDestination);

  const mimeType = pickRecorderMimeType();
  mediaRecorder = mimeType
    ? new MediaRecorder(recordingDestination.stream, { mimeType })
    : new MediaRecorder(recordingDestination.stream);

  recordedChunks     = [];
  recordedEvents     = [];
  recordingStartPerf = performance.now();

  mediaRecorder.addEventListener('dataavailable', (e) => {
    if (e.data.size > 0) {
      recordedChunks.push(e.data);
    }
  });

  mediaRecorder.start();
  isRecording = true;
  updateRecordButton();
  updateRecordTimeDisplay();
  recordIndicator.classList.remove('hidden');
  recordingTimerId = setInterval(updateRecordTimeDisplay, 500);
}

async function stopRecording() {
  if (!isRecording) {
    return;
  }

  isRecording = false;
  clearInterval(recordingTimerId);
  recordingTimerId = null;
  recordIndicator.classList.add('hidden');
  updateRecordButton();

  const finishedMimeType = mediaRecorder.mimeType || 'audio/webm';
  const stopped = new Promise(resolve => mediaRecorder.addEventListener('stop', resolve, { once: true }));
  mediaRecorder.stop();
  await stopped;

  try {
    recordingSourceNode.disconnect(recordingDestination);
  } catch {
    // Ignore -- the AudioContext may already be closing on its own.
  }
  recordingSourceNode  = null;
  recordingDestination = null;

  const audioBlob = new Blob(recordedChunks, { type: finishedMimeType });
  const logBlob    = new Blob([JSON.stringify(recordedEvents, null, 2)], { type: 'application/json' });
  recordedChunks = [];
  recordedEvents = [];

  await saveRecording(audioBlob, logBlob, finishedMimeType);
  mediaRecorder = null;
}

async function saveRecording(audioBlob, logBlob, mimeType) {
  const stamp     = new Date().toISOString().replace(/[:.]/g, '-');
  const extension = extensionForMimeType(mimeType);
  const audioFile = new File([audioBlob], `beatfinder-${stamp}.${extension}`, { type: mimeType });
  const logFile    = new File([logBlob], `beatfinder-${stamp}.json`, { type: 'application/json' });

  if (navigator.canShare && navigator.canShare({ files: [audioFile, logFile] })) {
    try {
      await navigator.share({ files: [audioFile, logFile] });
      return;
    } catch (err) {
      // Log errors but allow user-initiated cancellation.
      if (err?.name === 'AbortError') {
        return;
      }

      console.error('[record]', err);
    }
  }

  // Offer individual files so they dont get blocked.
  showSaveRecordingPanel(audioFile, logFile);
}

function showSaveRecordingPanel(audioFile, logFile) {
  saveRecordingPanel.classList.remove('hidden');

  saveAudioBtn.disabled = false;
  saveAudioBtn.textContent = 'Save Audio';
  saveAudioBtn.onclick = () => {
    downloadFile(audioFile);
    saveAudioBtn.disabled = true;
    saveAudioBtn.textContent = 'Audio Saved';
    hideSaveRecordingPanelIfDone();
  };

  saveLogBtn.disabled = false;
  saveLogBtn.textContent = 'Save Log';
  saveLogBtn.onclick = () => {
    downloadFile(logFile);
    saveLogBtn.disabled = true;
    saveLogBtn.textContent = 'Log Saved';
    hideSaveRecordingPanelIfDone();
  };
}

function hideSaveRecordingPanelIfDone() {
  if (saveAudioBtn.disabled && saveLogBtn.disabled) {
    saveRecordingPanel.classList.add('hidden');
  }
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a short delay to let the download manager catch up, if needed.
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

if (mediaRecorderSupported) {
  recordBtn.addEventListener('click', () => {
    if (isRecording) {
      stopRecording();
    } else if (!activeAudioContext || !activeSourceNode) {
      displayError('Start the mic or open a file before recording.');
    } else {
      startRecording();
    }
  });
} else {
  recordBtn.classList.add('hidden');
}

// ---- Tuning panel ----
//
// Exposes every beatfinder.js config value as a slider (or a <select> for
// the two Meyda buffer sizes, since those must be powers of 2), built from
// a schema instead of hand-written HTML so adding or removing a tunable
// value later only means editing this list.

const TUNING_GROUPS = [
  {
    title: 'General',
    params: [
      { key: 'boost', label: 'Boost', min: 1, max: 30, step: 1, default: 1 },
      { key: 'silenceTimeoutMs', label: 'Silence Timeout (ms)', min: 1000, max: 20000, step: 500, default: 8000 },
    ],
  },
  {
    title: 'Loudness Spike',
    params: [
      { key: 'loudnessSpikeHigh', label: 'Spike High', min: 0.5, max: 0.99, step: 0.01, default: 0.85 },
      { key: 'loudnessSpikeLow', label: 'Spike Low', min: 0.1, max: 0.9, step: 0.01, default: 0.6 },
    ],
  },
  {
    title: 'Chord Change',
    params: [
      { key: 'chordChromaBufferSize', label: 'Buffer Size', options: [512, 1024, 2048, 4096, 8192], default: 2048 },
      { key: 'chordDistanceHistorySize', label: 'History Size (frames)', min: 5, max: 60, step: 1, default: 20 },
      { key: 'chordDistanceThresholdMult', label: 'Threshold (std devs)', min: 0.5, max: 5, step: 0.1, default: 2 },
      { key: 'chordRefractoryMs', label: 'Refractory (ms)', min: 0, max: 1000, step: 10, default: 150 },
    ],
  },
  {
    title: 'Key',
    params: [
      { key: 'keyAnalysisBufferSize', label: 'Buffer Size', options: [2048, 4096, 8192, 16384], default: 8192 },
      { key: 'keyChromaSmoothing', label: 'Chroma Smoothing', min: 0.05, max: 1, step: 0.05, default: 0.3 },
      { key: 'keyConsensusFrames', label: 'Consensus Frames', min: 1, max: 30, step: 1, default: 8 },
    ],
  },
  {
    title: 'Tempo Lock',
    params: [
      { key: 'relockDrift', label: 'Relock Drift', min: 0.02, max: 0.5, step: 0.01, default: 0.10 },
      { key: 'relockConsensus', label: 'Relock Consensus', min: 1, max: 20, step: 1, default: 3 },
      { key: 'relockConsensusSuspicious', label: 'Relock Consensus (suspicious ratio)', min: 1, max: 40, step: 1, default: 15 },
      { key: 'suspiciousRatioTolerance', label: 'Suspicious Ratio Tolerance', min: 0.01, max: 0.2, step: 0.01, default: 0.04 },
      { key: 'minLockHoldMs', label: 'Min Lock Hold (ms)', min: 0, max: 20000, step: 500, default: 8000 },
    ],
  },
  {
    title: 'Downbeat',
    params: [
      { key: 'downbeatPhaseMinSamples', label: 'Min Samples', min: 1, max: 40, step: 1, default: 8 },
      { key: 'downbeatPhaseEmaWeight', label: 'EMA Weight', min: 0.01, max: 1, step: 0.01, default: 0.15 },
      { key: 'downbeatPhaseSwitchMargin', label: 'Switch Margin', min: 1.0, max: 2.0, step: 0.01, default: 1.15 },
    ],
  },
];

const tuningInputs   = {}; // config key -> <input> or <select>
const tuningValueEls = {}; // config key -> value readout <span>

function buildTuningPanel() {
  TUNING_GROUPS.forEach(group => {
    const groupEl = document.createElement('div');
    groupEl.className = 'tuning-group';

    const titleEl = document.createElement('div');
    titleEl.className = 'tuning-group-title';
    titleEl.textContent = group.title;
    groupEl.appendChild(titleEl);

    group.params.forEach(param => {
      const row = document.createElement('div');
      row.className = 'tuning-row';

      const labelRow  = document.createElement('div');
      labelRow.className = 'tuning-row-label';
      const labelText = document.createElement('span');
      labelText.textContent = param.label;
      const valueText = document.createElement('span');
      valueText.className   = 'tuning-row-value';
      valueText.textContent = param.default;
      labelRow.appendChild(labelText);
      labelRow.appendChild(valueText);
      row.appendChild(labelRow);

      const applyValue = (rawValue) => {
        valueText.textContent = rawValue;
        activeEngine?.setConfig({ [param.key]: Number(rawValue) });
      };

      let input;
      if (param.options) {
        input = document.createElement('select');
        param.options.forEach(opt => {
          const optionEl = document.createElement('option');
          optionEl.value = opt;
          optionEl.textContent = opt;
          if (opt === param.default) optionEl.selected = true;
          input.appendChild(optionEl);
        });
        input.addEventListener('change', () => applyValue(input.value));
      } else {
        input = document.createElement('input');
        input.type  = 'range';
        input.min   = param.min;
        input.max   = param.max;
        input.step  = param.step;
        input.value = param.default;
        input.addEventListener('input', () => applyValue(input.value));
      }

      row.appendChild(input);
      groupEl.appendChild(row);

      tuningInputs[param.key]   = input;
      tuningValueEls[param.key] = valueText;
    });

    tuningPanel.appendChild(groupEl);
  });
}

function syncTuningPanelFromEngine(engine) {
  const config = engine.getConfig();
  TUNING_GROUPS.forEach(group => {
    group.params.forEach(param => {
      const value = config[param.key];
      if (value === undefined) return;
      tuningInputs[param.key].value   = value;
      tuningValueEls[param.key].textContent = value;
    });
  });
}

buildTuningPanel();

tuningBtn.addEventListener('click', () => {
  tuningPanel.classList.toggle('hidden');
});

// ---- App init ----

// Hold AudioContext for re-use as a workaround on Mobile Safari.
let gestureUnlockedAudioContext = null;

let appHasStarted = false;

async function startApp() {
  if (appHasStarted) return;
  appHasStarted = true;
  displayError('');

  try {
    await startMicMode();
    overlay.classList.add('hidden');
    scopeAnimation.stop();
    controlsToggleBtn.classList.remove('hidden');
  } catch (err) {
    console.error('[mic]', err);
    appHasStarted = false;
    transitionTo(STATES.IDLE);
    displayError(micErrorMessage(err));
  }
}

function micErrorMessage(err) {
  const msg = err?.message ?? String(err);
  return msg.includes('Permission') || msg.includes('NotAllowed')
    ? 'Microphone access was denied. Please allow microphone access and try again.'
    : `Could not start microphone: ${msg}`;
}

overlay.addEventListener('click', () => {
  if (!gestureUnlockedAudioContext) {
    gestureUnlockedAudioContext = createAudioContext();
    gestureUnlockedAudioContext.resume().catch(() => {});
  }
  startApp();
});

//
// Control panel
//

let panelIsOpen = false;

function openControlsPanel() {
  panelIsOpen = true;
  controlsPanel.classList.remove('hidden');
  controlsToggleBtn.innerHTML = '&#9660;';
}

function closeControlsPanel() {
  panelIsOpen = false;
  controlsPanel.classList.add('hidden');
  controlsToggleBtn.innerHTML = '&#9650;';
}

controlsToggleBtn.addEventListener('click', () => {
  if (panelIsOpen) {
    closeControlsPanel();
  } else {
    openControlsPanel();
  }
});

//
// Mode state machine
//
// IDLE    : no audio source selected
// LIVE    : microphone is listening
// PLAYING : an audio file is playing

const STATES = { IDLE: 'idle', LIVE: 'live', PLAYING: 'playing' };
let appState = STATES.IDLE;

function transitionTo(newState) {
  if (appState === newState) return;
  appState = newState;

  micBtn.classList.remove('mode-btn-active');
  playPauseBtn.classList.remove('mode-btn-active');

  if (newState === STATES.LIVE) micBtn.classList.add('mode-btn-active');
}

//
// Mic mode
//

let micStream = null;

async function startMicMode() {
  displayError('');
  tearDownActiveEngine();
  if (audioPlayer) tearDownFileMode();

  const isMobile = navigator.maxTouchPoints > 0;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: isMobile },
    video: false,
  });

  const audioContext = gestureUnlockedAudioContext ?? createAudioContext();
  gestureUnlockedAudioContext = null;
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});

  const source = audioContext.createMediaStreamSource(micStream);
  // 10x boost (20x total on mobile, plus hardware AGC) to bring quiet
  // ambient audio up to a detectable level.
  activeEngine = await startAudioEngine(audioContext, source, { boost: isMobile ? 20 : 10, audible: false });
  activeAudioContext = audioContext;
  activeSourceNode    = source;

  transitionTo(STATES.LIVE);
}

function stopMicMode() {
  tearDownActiveEngine();
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
  }
  transitionTo(STATES.IDLE);
}

micBtn.addEventListener('click', () => {
  if (appState === STATES.LIVE) return; // already live, no-op
  startMicMode().catch(err => {
    console.error('[mic]', err);
    displayError(micErrorMessage(err));
    transitionTo(STATES.IDLE);
  });
});

//
// File playback mode
//

let audioPlayer    = null;
let currentFileUrl = null;

async function loadAudioFile(file) {
  stopMicMode();
  tearDownFileMode();

  currentFileUrl = URL.createObjectURL(file);
  trackNameLabel.textContent = file.name;
  filePlayer.classList.remove('hidden');
  playPauseBtn.disabled = false;

  audioPlayer      = new Audio(currentFileUrl);
  audioPlayer.loop = false;
  seekBar.value    = 0;
  seekBar.disabled = true;
  timeCurrentEl.textContent = '--:--';
  timeTotalEl.textContent   = '--:--';
  attachAudioSeekListeners();

  // Built once per loaded file -- an HTMLMediaElement can only ever be
  // connected to a single MediaElementSourceNode, so play/pause below must
  // reuse this engine rather than rebuilding it.
  const audioContext = createAudioContext();
  const source = audioContext.createMediaElementSource(audioPlayer);
  // boost only affects the analysis chain, not what's heard (audible: true
  // routes the unboosted signal straight to the speakers) -- but it's still
  // needed here: realtime-bpm-analyzer's peak detector has a fixed minimum
  // amplitude threshold that a normally-mastered file rarely reaches on its
  // own, so without a boost it silently finds zero tempo candidates.
  activeEngine = await startAudioEngine(audioContext, source, { boost: 10, audible: true });
  activeAudioContext = audioContext;
  activeSourceNode    = source;
}

function handlePlayPauseToggle() {
  if (!audioPlayer) return;
  if (audioPlayer.paused) {
    audioPlayer.play();
    playPauseBtn.innerHTML = '&#x2016; Pause';
    transitionTo(STATES.PLAYING);
  } else {
    audioPlayer.pause();
    playPauseBtn.innerHTML = '&#x25BA; Play';
    transitionTo(STATES.IDLE);
  }
}

function tearDownFileMode() {
  tearDownActiveEngine();
  if (currentFileUrl) { URL.revokeObjectURL(currentFileUrl); currentFileUrl = null; }
  if (audioPlayer)    { audioPlayer.pause(); audioPlayer.src = ''; audioPlayer = null; }

  playPauseBtn.innerHTML = '&#x25BA; Play';
  playPauseBtn.disabled  = true;
  filePlayer.classList.add('hidden');
  trackNameLabel.textContent = 'No file selected';
  seekBar.value              = 0;
  seekBar.disabled           = true;
  timeCurrentEl.textContent  = '--:--';
  timeTotalEl.textContent    = '--:--';
}

openFileBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadAudioFile(file);
  e.target.value = '';
});
playPauseBtn.addEventListener('click', handlePlayPauseToggle);

// Seek bar

let userIsSeeking = false;
seekBar.addEventListener('mousedown',  () => { userIsSeeking = true; });
seekBar.addEventListener('touchstart', () => { userIsSeeking = true; }, { passive: true });
window.addEventListener('mouseup',  () => { userIsSeeking = false; });
window.addEventListener('touchend', () => { userIsSeeking = false; });

seekBar.addEventListener('input', () => {
  if (!audioPlayer || isNaN(audioPlayer.duration)) return;
  const seekTime            = (seekBar.value / +seekBar.max) * audioPlayer.duration;
  timeCurrentEl.textContent = formatDuration(seekTime);
  audioPlayer.currentTime   = seekTime;
});

function attachAudioSeekListeners() {
  audioPlayer.addEventListener('loadedmetadata', () => {
    seekBar.max             = 1000;
    seekBar.disabled        = false;
    timeTotalEl.textContent = formatDuration(audioPlayer.duration);
  });
  audioPlayer.addEventListener('timeupdate', () => {
    if (userIsSeeking || !audioPlayer || isNaN(audioPlayer.duration)) return;
    seekBar.value             = (audioPlayer.currentTime / audioPlayer.duration) * +seekBar.max;
    timeCurrentEl.textContent = formatDuration(audioPlayer.currentTime);
  });
  audioPlayer.addEventListener('ended', () => {
    tearDownActiveEngine();
    playPauseBtn.innerHTML = '&#x25BA; Play';
    transitionTo(STATES.IDLE);
  });
}

document.getElementById('btn-skip-back').addEventListener('click', () => {
  if (audioPlayer) audioPlayer.currentTime = Math.max(0, audioPlayer.currentTime - 15);
});
document.getElementById('btn-skip-forward').addEventListener('click', () => {
  if (audioPlayer && isFinite(audioPlayer.duration))
    audioPlayer.currentTime = Math.min(audioPlayer.duration, audioPlayer.currentTime + 15);
});
