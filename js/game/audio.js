// Tiny Web Audio synth: every sound is generated, so there are no files to load.
// Browsers only allow audio after a user gesture; call unlock() from one.

let ctx = null;
let master = null;
let noiseBuf = null;
let enabled = false;
let volume = 1;                       // per-play scale, set by play()
const lastPlayed = new Map();

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return ctx;
}

function env(gain, t, attack, decay, peak) {
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function tone(type, f0, f1, dur, vol = 0.2, delay = 0) {
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  env(g, t, 0.005, dur, Math.max(0.0002, vol * volume));
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.05);
  return o;
}

function noise(dur, vol, filterType, freq) {
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = filterType;
  f.frequency.value = freq;
  const g = ctx.createGain();
  env(g, t, 0.005, dur, Math.max(0.0002, vol * volume));
  src.connect(f).connect(g).connect(master);
  src.start(t);
  src.stop(t + dur + 0.05);
}

function wobble(osc, rate, depth) {
  const lfo = ctx.createOscillator();
  const g = ctx.createGain();
  lfo.frequency.value = rate;
  g.gain.value = depth;
  lfo.connect(g).connect(osc.frequency);
  lfo.start();
  lfo.stop(ctx.currentTime + 1);
}

const SOUNDS = {
  shot: () => tone('square', 880, 260, 0.07, 0.05),
  hit: () => tone('triangle', 320, 110, 0.12, 0.25),
  hurt: () => { tone('sawtooth', 200, 80, 0.18, 0.2); noise(0.1, 0.2, 'lowpass', 1200); },
  ko: () => { tone('sawtooth', 500, 60, 0.45, 0.2); noise(0.3, 0.25, 'lowpass', 900); },
  boom: () => { noise(0.5, 0.5, 'lowpass', 500); tone('sine', 120, 40, 0.4, 0.4); },
  dash: () => noise(0.15, 0.15, 'highpass', 2000),
  boing: () => { tone('sine', 180, 620, 0.12, 0.25); tone('sine', 620, 300, 0.2, 0.15, 0.12); },
  baa: () => wobble(tone('sawtooth', 340, 300, 0.5, 0.12), 22, 30),
  fart: () => { wobble(tone('sawtooth', 95, 70, 0.6, 0.25), 14, 25); noise(0.5, 0.1, 'lowpass', 300); },
  zap: () => { for (let i = 0; i < 4; i++) tone('square', 600 + Math.random() * 900, 200, 0.06, 0.08, i * 0.04); },
  pickup: () => { tone('sine', 660, 660, 0.08, 0.2); tone('sine', 990, 990, 0.12, 0.2, 0.08); },
  slip: () => tone('sine', 900, 180, 0.4, 0.2),
  swap: () => tone('sine', 300, 1100, 0.2, 0.2),
  cast: () => tone('triangle', 500, 900, 0.1, 0.12),
  block: () => tone('sine', 1300, 1300, 0.06, 0.15),
  spook: () => wobble(tone('sine', 520, 220, 0.5, 0.15), 8, 40),
  count: () => tone('sine', 660, 660, 0.12, 0.2),
  go: () => tone('sine', 990, 990, 0.35, 0.25),
  win: () => [523, 659, 784, 1046].forEach((f, i) => tone('triangle', f, f, 0.18, 0.2, i * 0.11)),
  emote: () => tone('sine', 700, 900, 0.08, 0.1),
  tshot: () => tone('square', 420, 160, 0.12, 0.08),
  reload: () => { noise(0.05, 0.12, 'highpass', 3000); tone('square', 300, 300, 0.04, 0.06, 0.12); },
  orb: () => tone('sine', 1200 + Math.random() * 300, 1600, 0.06, 0.08),
  levelup: () => [523, 784, 1046, 1568].forEach((f, i) => tone('triangle', f, f * 1.01, 0.14, 0.18, i * 0.07)),
};

export const audio = {
  get enabled() { return enabled; },

  unlock() {
    if (!ensure()) return;
    if (ctx.state === 'suspended') ctx.resume();
  },

  setEnabled(on) {
    enabled = on;
    if (on) this.unlock();
  },

  // minGap stops 8 players' machine-guns from becoming white noise.
  play(name, minGap = 0.03, vol = 1) {
    if (!enabled || !ctx || ctx.state !== 'running' || !SOUNDS[name] || vol <= 0.02) return;
    const now = ctx.currentTime;
    if (now - (lastPlayed.get(name) || 0) < minGap) return;
    lastPlayed.set(name, now);
    volume = vol;
    SOUNDS[name]();
    volume = 1;
  },
};
