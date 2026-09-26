const SHOT_NOTES = {
  top: ["F#6", "E5", "C#6", "A5", "F#5"],
  bottom: ["G#", "B4", "F#4"],

};

const NOTE_FREQ = {
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
    if (type === "cannon") freq /= 2;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = sideId === "enemy" ? "square" : "triangle";
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(sideId === "enemy" ? 0.04 : 0.07, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    osc.stop(now + 0.16);
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

  /** Quick high-passed noise tick for a melee hit. */
  playMelee() {
    if (this.volume <= 0) return;
    const ctx = this.unlock();
    if (!ctx) return;
    const now = ctx.currentTime;
    const life = 0.04;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * life), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.setValueAtTime(1800, now);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.14, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start(now);
    src.stop(now + life);
  },
};

export function unlockAudio() {
  ShotTone.unlock();
}

export function getSoundVolume() {
  return ShotTone.volume;
}

export function setSoundVolume(value) {
  ShotTone.setVolume(value);
}

export function playCountdownBeep() {
  ShotTone.playCountdown();
}

export function playSounds(events) {
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.type === "melee") ShotTone.playMelee();
    else ShotTone.play(event.lane, event.sublane, event.unitType, event.sideId);
  }
}
