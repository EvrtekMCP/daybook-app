// DAYBOOK 0.4.0 — the mouth's timing: which mouth shape, when, while a line is spoken.
//
// The mouth never listens to the sound itself. It follows the VOICE EVENTS that voice.js
// sends for every line, whatever plays it:
//
//   start     { text, estimateMs }      the line began (the placeholder voice), or
//             { text, durationMs, level }  a recorded clip began: its real length, and
//                                       optionally level() -> 0..1 from a WebAudio meter
//   boundary  { charIndex }             the voice reached a word (the placeholder's engine
//                                       reports these): the timeline catches up to it
//   end                                 the line is over (or hushed)
//
// So the same mouth works with the computer's built-in voice now, and with a recorded or
// ElevenLabs voice later: a clip player only has to send start (with the clip's length,
// and a level meter if it has one) and end. Pure code: no DOM. Tested in Node.
//
// The shapes are the painted set's names: rest, ai, e, o, u, mbp, fv, l. (smile-talk is
// chosen by the character for warm lines; the stand-ins for fv and l live in
// app/img/character/character.json, because those two drawings are not right yet.)

/** Relative length of each kind of sound (one unit is about 70 ms at the usual pace). */
const W = { vowel: 1, consonant: 0.7, space: 0.35, comma: 3, stop: 4.5 };

/** Mouth shape for a letter group, longest groups first. */
const GROUPS = [
  ['tion', 'e'], ['ough', 'o'],
  ['ee', 'e'], ['ea', 'e'], ['ie', 'e'], ['ey', 'e'], ['ay', 'ai'], ['ai', 'ai'], ['igh', 'ai'],
  ['oo', 'u'], ['ou', 'u'], ['ow', 'o'], ['oa', 'o'], ['oi', 'o'], ['oy', 'o'], ['au', 'o'], ['aw', 'o'],
  ['wh', 'u'], ['qu', 'u'], ['th', 'e'], ['sh', 'e'], ['ch', 'e'], ['ph', 'fv'], ['ck', 'e'], ['ng', 'e'],
];
const LETTER = {
  a: 'ai', e: 'e', i: 'e', o: 'o', u: 'ai', y: 'e',
  m: 'mbp', b: 'mbp', p: 'mbp', f: 'fv', v: 'fv', l: 'l', w: 'u', r: 'u',
  c: 'e', d: 'e', g: 'e', j: 'e', k: 'e', n: 'e', q: 'e', s: 'e', t: 'e', x: 'e', z: 'e',
};
const VOWELS = new Set(['ai', 'e', 'o', 'u']);

/**
 * The line as mouth tokens: [{ v, w, ci }], v = shape, w = relative length, ci = the
 * index in text where the token starts. Silent final "e" and "h" take no shape of their own.
 */
export function visemes(text) {
  const s = String(text || '');
  const low = s.toLowerCase();
  const out = [];
  let i = 0;
  while (i < low.length) {
    const ch = low[i];
    if (/[a-z]/.test(ch)) {
      const g = GROUPS.find(([k]) => low.startsWith(k, i));
      if (g) { out.push({ v: g[1], w: VOWELS.has(g[1]) ? W.vowel : W.consonant, ci: i }); i += g[0].length; continue; }
      const next = low[i + 1] || '';
      // "time", "home": the vowel before consonant + final e is long; the e itself is silent
      if (ch === 'e' && !/[a-z]/.test(next) && i > 0 && /[a-z]/.test(low[i - 1]) && i > 1 && /[a-z]/.test(low[i - 2])) { i += 1; continue; }
      if (ch === 'i' && /[a-z]/.test(next) && low[i + 2] === 'e' && !/[a-z]/.test(low[i + 3] || '')) { out.push({ v: 'ai', w: W.vowel, ci: i }); i += 1; continue; }
      if (ch === 'h') { i += 1; continue; }
      const v = LETTER[ch] || 'e';
      out.push({ v, w: VOWELS.has(v) ? W.vowel : W.consonant, ci: i });
      i += 1;
    } else if (ch === ',' || ch === ';' || ch === ':') { out.push({ v: 'rest', w: W.comma, ci: i }); i += 1; }
    else if (ch === '.' || ch === '!' || ch === '?') { out.push({ v: 'rest', w: W.stop, ci: i }); i += 1; }
    else if (/\s/.test(ch)) {
      // between words the lips do not close; only a short beat
      if (out.length && out[out.length - 1].v !== 'rest') out.push({ v: null, w: W.space, ci: i });
      i += 1;
    } else i += 1;     // digits, quotes and the rest take no time of their own
  }
  // a word-gap token keeps the shape before it
  for (let k = 0; k < out.length; k++) if (out[k].v === null) out[k].v = k > 0 ? out[k - 1].v : 'rest';
  // a trailing pause does not hold the mouth: the end event closes it
  while (out.length && out[out.length - 1].v === 'rest') out.pop();
  return out;
}

/** About how long the placeholder voice takes to say a text at a speaking rate (1 = normal). */
export function estimateMs(text, rate = 1) {
  const units = visemes(text).reduce((a, t) => a + t.w, 0);
  return Math.round((units * 70) / Math.max(0.5, Math.min(1.5, rate || 1)));
}

/**
 * The mouth timeline for one line at a time. Feed it the voice events; ask it frameAt(now).
 * `now` is any millisecond clock (performance.now() in the app, a number in the tests).
 */
export class LipSync {
  constructor({ minHoldMs = 70, silence = 0.04 } = {}) {
    this.minHoldMs = minHoldMs;
    this.silence = silence;
    this.reset();
  }

  reset() {
    this.tokens = []; this.cum = [0]; this.total = 0;
    this.speaking = false; this.level = null;
    this.anchorPos = 0; this.anchorAt = 0; this.rate = 0;
    this.shown = 'rest'; this.shownAt = -Infinity;
    this.lastBoundary = null;
  }

  start({ text, estimateMs: est, durationMs, level }, now) {
    this.reset();
    this.tokens = visemes(text);
    for (const t of this.tokens) this.cum.push(this.cum[this.cum.length - 1] + t.w);
    this.total = this.cum[this.cum.length - 1];
    const ms = Math.max(200, durationMs || est || estimateMs(text));
    this.rate = this.total / ms;            // units per millisecond
    this.anchorPos = 0; this.anchorAt = now;
    this.level = typeof level === 'function' ? level : null;
    this.speaking = this.tokens.length > 0;
  }

  /** The voice reached the word starting at charIndex: catch the timeline up (or back) to it. */
  boundary({ charIndex }, now) {
    if (!this.speaking) return;
    let k = this.tokens.findIndex(t => t.ci >= charIndex);
    if (k < 0) k = this.tokens.length;
    const pos = this.cum[k];
    // learn the voice's real pace from the words it reports (smoothed, kept sensible)
    if (this.lastBoundary && now > this.lastBoundary.at + 60 && pos > this.lastBoundary.pos) {
      const seen = (pos - this.lastBoundary.pos) / (now - this.lastBoundary.at);
      const r = Math.min(this.rate * 2, Math.max(this.rate / 2, seen));
      this.rate = this.rate * 0.5 + r * 0.5;
    }
    this.lastBoundary = { pos, at: now };
    this.anchorPos = pos; this.anchorAt = now;
  }

  end() { this.speaking = false; }

  /** The words are said (a short beat past the last one): the mouth may rest in its own smile. */
  finished(now) { return !this.speaking || this.position(now) >= this.total + 6; }

  /** Where in the line the voice is now, in length units. */
  position(now) { return this.anchorPos + Math.max(0, now - this.anchorAt) * this.rate; }

  /** The raw shape for this moment (before holding). */
  shapeAt(now) {
    if (!this.speaking) return 'rest';
    if (this.level) {
      let lv = 0;
      try { lv = Number(this.level()) || 0; } catch { lv = 0; }
      if (lv < this.silence) return 'rest';          // a recorded voice is quiet here: lips together
    }
    const pos = this.position(now);
    if (pos >= this.total) return 'rest';            // the voice is slower than we thought: wait, mouth closed
    let lo = 0, hi = this.tokens.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.cum[mid] <= pos) lo = mid; else hi = mid - 1; }
    return this.tokens[lo].v;
  }

  /** The shape to show now: changes no faster than minHoldMs, so the mouth never flickers. */
  frameAt(now) {
    const want = this.shapeAt(now);
    if (want !== this.shown && now - this.shownAt >= this.minHoldMs) { this.shown = want; this.shownAt = now; }
    else if (!this.speaking) { this.shown = 'rest'; }
    return this.shown;
  }
}

/** Lines said with a smile: an open vowel shows the smile-talk mouth on these. */
export const WARM_LINES = /^(hello\.|day\.|praise\.|med\.thanks\.|mood\.reply\.good|call\.sent|thought\.)/;

/**
 * The painted frame for a mouth shape. frames: the mouth frames that exist (character.json);
 * standIns: { fv: 'e', l: 'e' } for shapes whose drawing is not usable yet. A corrected
 * drawing only has to be added to the frames: it is then used instead of its stand-in.
 */
export function mouthFrame(shape, { warm = false, frames = [], standIns = {} } = {}) {
  if (shape === 'ai' && warm && frames.includes('smile')) return 'smile';
  if (frames.includes(shape)) return shape;
  if (standIns[shape] && frames.includes(standIns[shape])) return standIns[shape];
  return frames.includes('rest') ? 'rest' : frames[0];
}
