/**
 * Ranged-shot pitches by row, in C minor. Top is C5–Eb5–G5–Ab5–C6
 * south to north; bottom is C6–Eb6–G6 on the outer, middle, and inner rings.
 */
const SHOT_NOTES = {
  top: ["C6", "Ab5", "G5", "Eb5", "C5"],
  bottom: ["C6", "Eb6", "G6"],
};

const NOTE_FREQ = {
  C5: 523.25,
  Eb5: 622.25,
  G5: 783.99,
  Ab5: 830.61,
  C6: 1046.5,
  Eb6: 1244.51,
  G6: 1567.98,
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

export function playSounds(events) {
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.type === "melee") ShotTone.playMelee();
    else ShotTone.play(event.lane, event.sublane, event.unitType, event.sideId);
  }
}
