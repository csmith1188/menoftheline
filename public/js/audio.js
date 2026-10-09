const SHOT_NOTES = {
  top: ["F#6", "E5", "C#6", "A5", "F#5"],
  bottom: ["G#4", "B4", "F#4"],
};

const NOTE_FREQ = {
  "C2": 65.41,
  "C#2": 69.30,
  "D2": 73.42,
  "D#2": 77.78,
  "E2": 82.41,
  "F2": 87.31,
  "F#2": 92.50,
  "G2": 98.00,
  "G#2": 103.83,
  "A2": 110.00,
  "A#2": 116.54,
  "B2": 123.47,
  "C3": 130.81,
  "C#3": 138.59,
  "D3": 146.83,
  "D#3": 155.56,
  "E3": 164.81,
  "F3": 174.61,
  "F#3": 185.00,
  "G3": 196.00,
  "G#3": 207.65,
  "A3": 220.00,
  "A#3": 233.08,
  "B3": 246.94,
  "C4": 261.63,
  "C#4": 277.18,
  "D4": 293.66,
  "D#4": 311.13,
  "E4": 329.63,
  "F4": 349.23,
  "F#4": 369.99,
  "G4": 392.00,
  "G#4": 415.30,
  "A4": 440.00,
  "A#4": 466.16,
  "B4": 493.88,
  "C5": 523.25,
  "C#5": 554.37,
  "D5": 587.33,
  "D#5": 622.25,
  "E5": 659.26,
  "F5": 698.46,
  "F#5": 739.99,
  "G5": 783.99,
  "G#5": 830.61,
  "A5": 880.00,
  "A#5": 932.33,
  "B5": 987.77,
  "C6": 1046.50,
  "C#6": 1108.73,
  "D6": 1174.66,
  "D#6": 1244.51,
  "E6": 1318.51,
  "F6": 1396.91,
  "F#6": 1479.98,
  "G6": 1567.98,
  "G#6": 1661.22,
  "A6": 1760.00,
  "A#6": 1864.66,
  "B6": 1975.53,
  "C7": 2093.00,
};

const VOLUME_KEY = "motl-sound-volume";
const BGM_VOLUME_KEY = "motl-bgm-volume";
const BGM_BASE = "/bgm/HTL";
/** Slider at 100% plays the file at this gain. */
const BGM_MAX_GAIN = 0.25;

function clampVolume(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

function readStoredVolume() {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw == null) return 1;
    return clampVolume(raw);
  } catch (err) {
    return 1;
  }
}

const BGM_DEFAULT_VOLUME = 0.5;
/** Short delay after match start before playing (blob must already be local). */
const BGM_START_DELAY_MS = 200;

function readStoredBgmVolume() {
  const rawDefault = typeof document !== "undefined" && document.body
    ? document.body.dataset.bgmVolumeDefault
    : null;
  if (rawDefault != null && rawDefault !== "") {
    const fromDb = Number(rawDefault);
    if (Number.isFinite(fromDb)) return clampVolume(fromDb / 100);
  }
  try {
    const raw = localStorage.getItem(BGM_VOLUME_KEY);
    if (raw == null) return BGM_DEFAULT_VOLUME;
    return clampVolume(raw);
  } catch (err) {
    return BGM_DEFAULT_VOLUME;
  }
}

function bgmSrc() {
  return `${BGM_BASE}.ogg`;
}

/** Tiny Web Audio bus for the per-sublane shot plucks. */
const ShotTone = {
  ctx: null,
  master: null,
  volume: readStoredVolume(),

  unlock() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    if (!this.ctx) this.ctx = new AudioCtor();
    if (!this.master) {
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  },

  setVolume(value) {
    this.volume = clampVolume(value);
    if (this.master) this.master.gain.value = this.volume;
    try {
      localStorage.setItem(VOLUME_KEY, String(this.volume));
    } catch (err) {
      // Storage can be blocked; the in-memory level still applies this session.
    }
  },

  play(lane, sublane, type, sideId) {
    if (this.volume <= 0) return;
    const ctx = this.unlock();
    if (!ctx) return;
    const names = SHOT_NOTES[lane];
    const name = names && names[sublane];
    let freq = name && NOTE_FREQ[name];
    if (!freq) return;
    let sustain = 0.14;
    let baseVolume = sideId === "enemy" ? 0.04 : 0.07;
    let decay = sustain; // Default: decay equals sustain
    if (type === "cannon") {
      freq /= 4; 
      sustain = 0.32; // Longer sustain for cannon shots
      baseVolume *= 2; // Louder cannon
      decay = 0.5; // Increased decay for cannon
    }
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = sideId === "enemy" ? "square" : "triangle";
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(baseVolume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + decay);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    osc.stop(now + Math.max(sustain, decay) + 0.02);
  },

  /** Short tone for one second of the match-start countdown. */
  playCountdown() {
    if (this.volume <= 0) return;
    const ctx = this.unlock();
    if (!ctx) return;
    const start = () => {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, now);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(now);
      osc.stop(now + 0.14);
    };
    if (ctx.state === "running") start();
    else ctx.resume().then(start).catch(() => {});
  },

  /** Cached white-noise buffers keyed by sampleRate:sampleCount. */
  noiseBuffers: null,

  noiseBuffer(ctx, life) {
    const samples = Math.max(1, Math.floor(ctx.sampleRate * life));
    const key = `${ctx.sampleRate}:${samples}`;
    if (!this.noiseBuffers) this.noiseBuffers = new Map();
    let buffer = this.noiseBuffers.get(key);
    if (buffer) return buffer;
    buffer = ctx.createBuffer(1, samples, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffers.set(key, buffer);
    return buffer;
  },

  /**
   * High-passed noise hit. `playbackRate` 2 = one octave up (tighter / brighter).
   */
  playNoiseHit({
    life = 0.04,
    decay = 0.03,
    highpass = 1800,
    volume = 0.14,
    playbackRate = 1,
  } = {}) {
    if (this.volume <= 0) return;
    const ctx = this.unlock();
    if (!ctx) return;
    const now = ctx.currentTime;
    const buffer = this.noiseBuffer(ctx, life);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.setValueAtTime(playbackRate, now);
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.setValueAtTime(highpass, now);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + decay);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start(now);
    src.stop(now + life / playbackRate + 0.02);
  },

  /** Longer snare-like noise for a melee hit. */
  playMelee() {
    this.playNoiseHit({
      life: 0.14,
      decay: 0.12,
      highpass: 1400,
      volume: 0.16,
      playbackRate: 1,
    });
  },

  /** Closed hi-hat: same melee noise, one octave up. */
  playRangedHit() {
    this.playNoiseHit({
      life: 0.05,
      decay: 0.035,
      highpass: 3600,
      volume: 0.11,
      playbackRate: 2,
    });
  },

  /** Bass kick for a Keep hit — sine with a quick pitch drop. */
  playKick() {
    if (this.volume <= 0) return;
    const ctx = this.unlock();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.exponentialRampToValueAtTime(38, now + 0.14);
    gain.gain.setValueAtTime(0.32, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    osc.stop(now + 0.24);
  },
};

/**
 * Looping match music from /public/bgm.
 * Multi-MB files must never stream during a match: they share the game host
 * with Socket.IO and starve state/command traffic on production bandwidth.
 * Prefetch into a blob during lobby/countdown; play only from that blob.
 */
const MatchBgm = {
  el: null,
  blobUrl: null,
  volume: readStoredBgmVolume(),
  wanted: false,
  startTimer: null,
  /** False while a match is playing so we never open a BGM download then. */
  allowNetwork: true,
  prefetchCtrl: null,
  prefetchPromise: null,

  applyGain() {
    if (this.el) this.el.volume = this.volume * BGM_MAX_GAIN;
  },

  clearStartTimer() {
    if (this.startTimer == null) return;
    clearTimeout(this.startTimer);
    this.startTimer = null;
  },

  isReady() {
    return Boolean(this.blobUrl);
  },

  abortPrefetch() {
    if (this.prefetchCtrl) {
      this.prefetchCtrl.abort();
      this.prefetchCtrl = null;
    }
    this.prefetchPromise = null;
  },

  /**
   * Fully download BGM into a blob URL (HTTP cache friendly).
   * Safe during lobby/countdown; no-ops while a match is playing.
   */
  prefetch() {
    if (this.blobUrl) return Promise.resolve(true);
    if (!this.allowNetwork) return Promise.resolve(false);
    if (this.prefetchPromise) return this.prefetchPromise;
    if (typeof fetch !== "function") return Promise.resolve(false);

    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    this.prefetchCtrl = ctrl;
    this.prefetchPromise = (async () => {
      try {
        const res = await fetch(bgmSrc(), {
          signal: ctrl ? ctrl.signal : undefined,
          cache: "force-cache",
        });
        if (!res.ok) return false;
        const blob = await res.blob();
        if (ctrl && ctrl.signal.aborted) return false;
        if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
        this.blobUrl = URL.createObjectURL(blob);
        if (this.el) this.el.src = this.blobUrl;
        if (this.wanted) this.schedulePlay();
        return true;
      } catch (err) {
        if (err && err.name === "AbortError") return false;
        return false;
      } finally {
        if (this.prefetchCtrl === ctrl) this.prefetchCtrl = null;
        this.prefetchPromise = null;
      }
    })();
    return this.prefetchPromise;
  },

  ensure() {
    if (this.el) return this.el;
    const el = new Audio();
    el.loop = true;
    // Never point at /bgm/* directly — that streams over the game host mid-match.
    el.preload = "none";
    if (this.blobUrl) el.src = this.blobUrl;
    this.el = el;
    this.applyGain();
    return el;
  },

  setVolume(value) {
    this.volume = clampVolume(value);
    this.applyGain();
    try {
      localStorage.setItem(BGM_VOLUME_KEY, String(this.volume));
    } catch (err) {
      // Storage can be blocked; the in-memory level still applies this session.
    }
    if (this.wanted && this.volume > 0) this.playNow();
    else if (this.wanted && this.volume <= 0 && this.el) this.el.pause();
  },

  playNow() {
    if (!this.blobUrl) return;
    const el = this.ensure();
    if (!el.src) el.src = this.blobUrl;
    this.applyGain();
    if (this.volume <= 0) {
      el.pause();
      return;
    }
    if (!el.paused) return;
    const play = el.play();
    if (play && typeof play.catch === "function") play.catch(() => {});
  },

  schedulePlay() {
    this.clearStartTimer();
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (!this.wanted) return;
      this.playNow();
    }, BGM_START_DELAY_MS);
  },

  /**
   * Arm playback for an active match. Aborts any in-flight download so BGM
   * cannot compete with Socket.IO; plays only if the blob is already local.
   */
  start() {
    this.wanted = true;
    this.allowNetwork = false;
    this.abortPrefetch();
    if (!this.blobUrl) return;
    if (this.el && !this.el.paused) return;
    this.schedulePlay();
  },

  stop() {
    this.clearStartTimer();
    this.wanted = false;
    this.allowNetwork = true;
    if (!this.el) return;
    this.el.pause();
    this.el.currentTime = 0;
  },

  unlock() {
    if (!this.wanted || this.volume <= 0 || !this.blobUrl) return;
    if (this.startTimer != null) return;
    this.playNow();
  },
};

export function unlockAudio() {
  ShotTone.unlock();
  MatchBgm.unlock();
}

export function getSoundVolume() {
  return ShotTone.volume;
}

export function setSoundVolume(value) {
  ShotTone.setVolume(value);
}

export function getBgmVolume() {
  return MatchBgm.volume;
}

export function setBgmVolume(value) {
  MatchBgm.setVolume(value);
}

/** Download match BGM fully before play; call from lobby/landing, never mid-match. */
export function prefetchMatchBgm() {
  return MatchBgm.prefetch();
}

export function startMatchBgm() {
  MatchBgm.start();
}

export function stopMatchBgm() {
  MatchBgm.stop();
}

export function playCountdownBeep() {
  ShotTone.playCountdown();
}

export function playSounds(events) {
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.type === "melee") ShotTone.playMelee();
    else if (event.type === "hit") ShotTone.playRangedHit();
    else if (event.type === "keep") ShotTone.playKick();
    else ShotTone.play(event.lane, event.sublane, event.unitType, event.sideId);
  }
}
