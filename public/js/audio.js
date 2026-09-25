/**
 * Ranged-shot pitches by row, in F# minor, low to high:
 * bottom outer F#4, 3rd, 5th, then top-lane south-to-north 7th, 2nd, 4th, 6th, F#6.
 * Arrays are indexed by sublane, so top[0] is the northern row.
 */
const SHOT_NOTES = {
  top: ["F#6", "D6", "B5", "G#5", "E5"],
  bottom: ["F#4", "A4", "C#5"],
};

const NOTE_FREQ = {
  "F#4": 369.99,
  A4: 440.0,
  "C#5": 554.37,
  E5: 659.25,
  "G#5": 830.61,
  B5: 987.77,
  D6: 1174.66,
  "F#6": 1479.98,
};

/** Tiny Web Audio bus for the per-sublane shot plucks. */
const ShotTone = {
  ctx: null,

  unlock() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    if (!this.ctx) this.ctx = new AudioCtor();
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  },

  play(lane, sublane, type, sideId) {
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
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.16);
  },

  /** Short tone for one second of the match-start countdown. */
  playCountdown() {
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
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.14);
    };
    if (ctx.state === "running") start();
    else ctx.resume().then(start).catch(() => {});
  },

  /** Quick high-passed noise tick for a melee hit. */
  playMelee() {
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
    gain.connect(ctx.destination);
    src.start(now);
    src.stop(now + life);
  },
};

export function unlockAudio() {
  ShotTone.unlock();
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
