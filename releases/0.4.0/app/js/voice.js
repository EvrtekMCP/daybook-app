// DAYBOOK — the voice and the chime.
//
// EVERY spoken line goes through speak(lineId, parts). Nothing else in the app
// calls speechSynthesis. That one door is what lets the placeholder voice be
// swapped for recorded clips later (Evrtek's own voice, or one ElevenLabs voice):
// speak() builds a play plan from app/lines/lines.json (see lines.js), and a
// backend plays the plan.
//
//   backend 'speech'  (0.1.0) reads plan.text with the computer's built-in voice
//   backend 'clips'   (later)  plays plan.segments from the recorded bank, joined
//                              with short crossfades (docs/VOICE.md). Until that
//                              exists, mode "clips" falls back to 'speech'.
//
// Only voices installed on this computer are used (voice.localService), never
// an online voice, so speaking sends nothing over the network.
//
// 0.4.0: VOICE EVENTS. Whatever backend plays a line tells onVoice() listeners when it
// starts, which word it has reached, and when it ends (app/js/mouth.js lists them). The
// character's mouth moves from these alone, so it works the same with the placeholder
// now and with a recorded voice later: a clip player sends start with the clip's real
// length (durationMs) and, if it plays through WebAudio, a level() meter; then end.

import { Lines } from './lines.js';
import { estimateMs } from './mouth.js';

let lines = null;
let cfg = null;
let audioCtx = null;
let chain = Promise.resolve();
let generation = 0;

/** Every plan spoken this session, newest last (for tests and the settings screen). */
export const spokenLog = [];

// --- voice events (0.4.0) ------------------------------------------------------------

const listeners = new Set();
let current = null;          // the line being played: { lineId, text }

/** Listens to the voice: fn({ type: 'start' | 'boundary' | 'end', ... }). Returns the "stop listening" function. */
export function onVoice(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function emit(ev) {
  for (const fn of [...listeners]) { try { fn(ev); } catch (e) { console.warn('[daybook] voice listener', e); } }
}

/** True while a line is being played. */
export function speaking() { return !!current; }

function lineStarted(plan, extra) {
  current = { lineId: plan.lineId, text: plan.text, plan };
  emit(Object.assign({ type: 'start', lineId: plan.lineId, text: plan.text }, extra));
}

/** The line is over. With a plan: only if that plan is still the one playing (a late "end" from a cancelled line is ignored). */
function lineEnded(plan) {
  if (!current || (plan && current.plan !== plan)) return;
  const { lineId } = current;
  current = null;
  emit({ type: 'end', lineId });
}

export function initVoice(linesDoc, config) {
  lines = linesDoc instanceof Lines ? linesDoc : new Lines(linesDoc);
  cfg = config;
  return lines;
}

export function getLines() { return lines; }

function voiceCfg() { return (cfg && cfg.voice) || {}; }

/**
 * Speaks one line. parts fills its {slots}: { time: "time.10.30" } or { name: "name" }.
 * Lines queue one after another. Returns a promise that settles when this line is done.
 */
export function speak(lineId, parts = {}) {
  let plan;
  try { plan = lines.plan(lineId, parts, { name: cfg && cfg.name }); }
  catch (e) { console.warn('[daybook] cannot speak', lineId, e.message); return Promise.resolve(); }
  spokenLog.push({ at: Date.now(), lineId, text: plan.text, clips: plan.segments.filter(s => s.clip).map(s => s.clip) });
  if (spokenLog.length > 200) spokenLog.splice(0, spokenLog.length - 200);
  if (!voiceCfg().enabled) return Promise.resolve();
  const gen = generation;
  chain = chain.then(() => (gen === generation ? backend().play(plan) : null)).catch(() => {});
  return chain;
}

/** Speaks a list of [lineId, parts] in order. */
export function speakAll(seq) {
  let last = Promise.resolve();
  for (const [id, parts] of seq) last = speak(id, parts);
  return last;
}

/** Stops whatever is speaking and drops the queue. */
export function hush() {
  generation += 1;
  chain = Promise.resolve();
  try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch { /* none */ }
  lineEnded();
}

function backend() {
  // 'clips' is the future recorded voice; until the bank exists it reads aloud like 'speech'.
  return speechBackend;
}

// --- the placeholder voice: the computer's built-in speech ---------------------------

function localVoices() {
  try { return (window.speechSynthesis.getVoices() || []).filter(v => v.localService); }
  catch { return []; }
}

export function listLocalVoices() { return localVoices().map(v => ({ name: v.name, lang: v.lang })); }

function chooseVoice() {
  const voices = localVoices();
  const want = voiceCfg().voiceName;
  if (want) { const v = voices.find(x => x.name === want); if (v) return v; }
  const lang = String((cfg && cfg.locale) || 'en-CA');
  return voices.find(v => v.lang === lang)
    || voices.find(v => v.lang && v.lang.startsWith('en-CA'))
    || voices.find(v => v.lang && v.lang.startsWith('en'))
    || voices[0] || null;
}

/** Voices load a moment after the page; wait up to 3 s for them, once per session. */
let voicesWaited = false;
function voicesReady() {
  if (voicesWaited || localVoices().length) return Promise.resolve();
  return new Promise(resolve => {
    let left = 30;
    const t = setInterval(() => {
      if (localVoices().length || --left <= 0) { clearInterval(t); voicesWaited = true; resolve(); }
    }, 100);
  });
}

const speechBackend = {
  async play(plan) {
    await voicesReady();
    return new Promise(resolve => {
      let synth;
      try { synth = window.speechSynthesis; } catch { synth = null; }
      if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return resolve();
      const v = voiceCfg();
      const u = new SpeechSynthesisUtterance(plan.text);
      const voice = chooseVoice();
      if (!voice) return resolve();          // no installed voice: stay silent rather than go online
      u.voice = voice;
      u.lang = voice.lang;
      u.rate = clamp(Number(v.rate) || 0.9, 0.5, 1.5);
      let begun = false;
      const begin = () => { if (!begun) { begun = true; lineStarted(plan, { backend: 'speech', estimateMs: estimateMs(plan.text, u.rate) }); } };
      u.onstart = begin;
      u.onboundary = ev => {
        begin();
        if (ev && (ev.name === 'word' || ev.name == null)) emit({ type: 'boundary', lineId: plan.lineId, charIndex: ev.charIndex || 0, charLength: ev.charLength || 0 });
      };
      u.pitch = clamp(Number(v.pitch) || 1, 0.5, 1.5);
      u.volume = clamp(v.volume == null ? 1 : Number(v.volume), 0, 1);
      // Some speech engines never fire 'end'; do not let one stuck line block the rest.
      const guard = setTimeout(done, 4000 + plan.text.length * 110);
      function done() { clearTimeout(guard); if (begun) lineEnded(plan); resolve(); }
      u.onend = done;
      u.onerror = done;
      synth.speak(u);
    });
  },
};

function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }

// --- the chime ---------------------------------------------------------------------
// A soft two-note bell, made with Web Audio. A placeholder like the voice: the real
// chime can be a recorded file later, played from this same function.

function ctx() {
  if (audioCtx) return audioCtx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = AC ? new AC() : null;
  } catch { audioCtx = null; }
  return audioCtx;
}

/** Browsers start sound only after a tap; call this on the first tap (start.cmd's Edge flag lifts it on the PC). */
export function unlockAudio() {
  const c = ctx();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
  try {
    if (window.speechSynthesis && !unlockAudio.done) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      window.speechSynthesis.speak(u);
      unlockAudio.done = true;
    }
  } catch { /* none */ }
}

function bell(c, t0, freq, gain) {
  const out = c.createGain();
  out.gain.setValueAtTime(0.0001, t0);
  out.gain.exponentialRampToValueAtTime(gain, t0 + 0.03);
  out.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.4);
  out.connect(c.destination);
  [[1, 1], [2.0, 0.22], [3.0, 0.06]].forEach(([mul, g]) => {
    const o = c.createOscillator();
    const og = c.createGain();
    o.type = 'sine';
    o.frequency.value = freq * mul;
    og.gain.value = g;
    o.connect(og).connect(out);
    o.start(t0);
    o.stop(t0 + 2.5);
  });
}

/**
 * Queues the soft chime in the same line as the voice, so a chime never lands
 * on top of a sentence. Resolves when the voice may start (the bell tail keeps
 * ringing softly under it).
 */
export function chime() {
  const ch = (cfg && cfg.chime) || {};
  spokenLog.push({ at: Date.now(), lineId: '(chime)', text: '', clips: [] });
  if (ch.enabled === false) return Promise.resolve();
  const gen = generation;
  chain = chain.then(() => (gen === generation ? ring(ch) : null)).catch(() => {});
  return chain;
}

function ring(ch) {
  const c = ctx();
  if (!c) return Promise.resolve();
  if (c.state === 'suspended') c.resume().catch(() => {});
  const vol = clamp(ch.volume == null ? 0.5 : Number(ch.volume), 0, 1) * 0.35 + 0.0002;
  const t0 = c.currentTime + 0.05;
  bell(c, t0, 523.25, vol);          // C5
  bell(c, t0 + 0.5, 659.25, vol);    // E5, rising: a friendly "ding-ding", not an alarm
  return new Promise(r => setTimeout(r, 1500));
}
