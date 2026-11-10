// Table sounds. Card and chip sounds are recordings in sounds/ (name-1.mp3, name-2.mp3, ...; a random
// one plays each time so repeats do not sound robotic). Anything without a recording falls back to a
// small synthesized sound. Browsers only allow sound after a tap or key press, so the context wakes then.

const KEY = 'tc-sound';
let prefs = { on: true, volume: 0.6 };
try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(KEY)) }; } catch { /* defaults */ }

let ctx = null;
let master = null;
let noiseBuf = null;
// How many recordings each sound has in sounds/ (name-1.mp3 ... name-N.mp3). Empty = synthesized.
const SAMPLED = {};
const samples = {};

async function loadSamples() {
  for (const [name, count] of Object.entries(SAMPLED)) {
    samples[name] = [];
    for (let i = 1; i <= count; i += 1) {
      try {
        const res = await fetch(`sounds/${name}-${i}.mp3`);
        if (!res.ok) break;
        samples[name].push(await ctx.decodeAudioData(await res.arrayBuffer()));
      } catch { break; }
    }
  }
}

function wake() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = prefs.volume;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i += 1) d[i] = Math.random() * 2 - 1;
    loadSamples();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, wake, { capture: true });

export const soundPrefs = () => ({ ...prefs });

export function setSound(next) {
  prefs = { ...prefs, ...next };
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private window */ }
  if (master) master.gain.value = prefs.volume;
}

function noise(t, dur, freq, q, gain) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.3);
  src.stop(t + dur);
}

function tone(t, freq, dur, gain, type = 'sine') {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

const SOUNDS = {
  // A card sliding off the shoe.
  deal(t) { noise(t, 0.09, 2600, 0.8, 0.5); },
  // Paper bending as a card is peeled.
  peel(t) { noise(t, 0.35, 1400, 2.5, 0.12); },
  // The card snapping over.
  flip(t) { noise(t, 0.05, 3400, 1.2, 0.45); },
  chip(t) { tone(t, 2200, 0.05, 0.12, 'triangle'); tone(t + 0.045, 1900, 0.06, 0.1, 'triangle'); },
  win(t) { tone(t, 660, 0.18, 0.12); tone(t + 0.1, 880, 0.25, 0.12); },
  blackjack(t) { tone(t, 660, 0.15, 0.12); tone(t + 0.09, 880, 0.15, 0.12); tone(t + 0.18, 1320, 0.3, 0.1); },
  lose(t) { tone(t, 220, 0.25, 0.12, 'triangle'); tone(t + 0.12, 165, 0.3, 0.1, 'triangle'); },
  push(t) { tone(t, 520, 0.12, 0.08); },
  turn(t) { tone(t, 990, 0.12, 0.08); tone(t + 0.12, 1320, 0.16, 0.07); },
};

// Plays a sound `delayMs` from now. Silently does nothing until the page has been tapped once.
export function play(name, delayMs = 0) {
  if (!prefs.on) return;
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime + delayMs / 1000;
  const recs = samples[name];
  if (recs?.length) {
    const src = ctx.createBufferSource();
    src.buffer = recs[Math.floor(Math.random() * recs.length)];
    src.playbackRate.value = 0.96 + Math.random() * 0.08;
    src.connect(master);
    src.start(t);
    return;
  }
  SOUNDS[name]?.(t);
}
