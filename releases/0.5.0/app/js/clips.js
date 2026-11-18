// DAYBOOK 0.5.0 — the clip player: one recorded voice (ElevenLabs "Chris"), played from
// the bank in app/voice/<voice>/ (manifest.json + one WAV per clip id).
//
// File names: the clip id with # and @ as - (soon.psw-1.wav, time.10.30-mid.wav), the only
// characters her PC's updater accepts in a release.
//
// A line's play plan (lines.js) lists its pieces in order: whole lines are one clip; lines
// with a {time} are fixed pieces plus a part from the time bank. They are joined the way
// talking clocks and station announcements are (docs/VOICE.md, "Joining the clips"):
//
//   1. trim      each clip's silent head and tail (keeping about 10 ms)
//   2. loudness  every clip brought to the same level (gated RMS, about -21 dBFS, at most
//                8 dB up or down, never clipping), so no piece jumps out
//   3. joins     mid-sentence: a 20 ms equal-power crossfade, never a hard cut;
//                at a comma a natural 120 ms gap, at a full stop 300 ms (short fades both sides)
//   4. pace      natural, as generated (Evrtek, 11-18): no tempo or pitch change at all
//
// Pure helpers first (tested in Node), then the player (Web Audio, in the browser).

export const CROSSFADE_S = 0.02;
export const EDGE_FADE_S = 0.008;
export const COMMA_GAP_MS = 120;
export const STOP_GAP_MS = 300;
export const LINE_GAP_MS = 300;        // after a line, before the next one starts
export const TARGET_DB = -21;          // about the bank's median: most clips barely move
export const MAX_GAIN_DB = 8;
export const PEAK_CEILING = 0.95;
const CACHE_CLIPS = 48;                // decoded clips kept (the time bank is used most)

/** soon.psw#1 -> soon.psw-1.wav; time.10.30@mid -> time.10.30-mid.wav */
export function clipFile(clip) { return `${String(clip).replace('#', '-').replace('@', '-')}.wav`; }

/** The clip ids a plan needs, in order. */
export function planClips(plan) { return plan.segments.filter(s => s.clip).map(s => s.clip); }

/**
 * How to say a plan with this bank (has(clipId) -> bool):
 *   'clips'   every clip is there
 *   'skip'    only her name is missing (it is recorded on her PC only): say nothing, rather than
 *             "Hello," alone or a second voice; the greeting with her name is on the screen
 *   'speech'  anything else is missing: the whole line in the placeholder voice
 */
export function choose(plan, has) {
  const missing = planClips(plan).filter(c => !has(c));
  if (!missing.length) return { how: 'clips', missing };
  if (missing.every(c => /^name@/.test(c))) return { how: 'skip', missing };
  return { how: 'speech', missing };
}

/** How each clip meets the one before it: [{ clip, gapMs, crossfade }]. */
export function joins(plan) {
  const out = [];
  let prev = null;
  let between = '';
  for (const s of plan.segments) {
    if (!s.clip) { between += s.text || ''; continue; }
    if (!prev) out.push({ clip: s.clip, gapMs: 0, crossfade: false });
    else {
      const marks = (/[.,!?;:]+\s*$/.exec(prev.text || '') || [''])[0] + between + (/^\s*[.,!?;:]+/.exec(s.text || '') || [''])[0];
      const stop = /[.!?]/.test(marks), comma = /[,;:]/.test(marks);
      out.push({ clip: s.clip, gapMs: stop ? STOP_GAP_MS : comma ? COMMA_GAP_MS : 0, crossfade: !stop && !comma });
    }
    prev = s;
    between = '';
  }
  return out;
}

/**
 * A clip's edges and loudness, from its samples (Float32, -1..1). start/end are sample
 * indexes (end exclusive) with about 10 ms kept; db is the gated RMS of the speech in it.
 */
export function measure(samples, rate) {
  const n = samples.length, thr = 0.01, keep = Math.round(rate * 0.01);
  let a = 0, b = n - 1;
  while (a < n && Math.abs(samples[a]) < thr) a++;
  if (a >= n) return { start: 0, end: n, db: -Infinity, peak: 0 };
  while (b > a && Math.abs(samples[b]) < thr) b--;
  a = Math.max(0, a - keep);
  b = Math.min(n, b + 1 + keep);
  let peak = 0;
  for (let i = a; i < b; i++) { const v = Math.abs(samples[i]); if (v > peak) peak = v; }
  const W = Math.max(1, Math.round(rate * 0.02)), gate = Math.pow(10, -45 / 10);
  let p = 0, w = 0;
  for (let i = a; i + W <= b; i += W) {
    let e = 0;
    for (let k = i; k < i + W; k++) e += samples[k] * samples[k];
    e /= W;
    if (e > gate) { p += e; w += 1; }
  }
  return { start: a, end: b, db: w ? 10 * Math.log10(p / w) : -Infinity, peak };
}

/** The gain that brings a clip to the target level, within limits and never clipping. */
export function gainFor({ db, peak }) {
  if (!Number.isFinite(db)) return 1;
  const want = Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, TARGET_DB - db));
  let g = Math.pow(10, want / 20);
  if (peak > 0 && peak * g > PEAK_CEILING) g = PEAK_CEILING / peak;
  return g;
}

/**
 * The timeline (seconds from the line's start): items [{ clip, dur, gapMs, crossfade }] ->
 * { slots: [{ clip, at, dur, fadeIn, fadeOut }], total }.
 */
export function schedule(items) {
  const slots = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const prev = slots[i - 1];
    let at = 0;
    let fadeIn = EDGE_FADE_S;
    if (prev) {
      const x = Math.min(CROSSFADE_S, prev.dur / 2, it.dur / 2);
      if (it.crossfade) { at = prev.at + prev.dur - x; fadeIn = x; prev.fadeOut = x; }
      else at = prev.at + prev.dur + it.gapMs / 1000;
    }
    slots.push({ clip: it.clip, at, dur: it.dur, fadeIn: Math.min(fadeIn, it.dur / 2), fadeOut: Math.min(EDGE_FADE_S, it.dur / 2) });
  }
  const last = slots[slots.length - 1];
  return { slots, total: last ? last.at + last.dur : 0 };
}

/** An equal-power fade as a curve: 'in' rises as sin, 'out' falls as cos, scaled by k. */
export function fadeCurve(dir, k = 1, points = 32) {
  const c = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    c[i] = k * (dir === 'in' ? Math.sin(t * Math.PI / 2) : Math.cos(t * Math.PI / 2));
  }
  return c;
}

// --- the player (browser) -----------------------------------------------------------------

/**
 * The bank at `base` (e.g. "voice/chris/"), played through the AudioContext getContext() gives.
 * load() -> manifest or null; has(clip); play(plan, { volume, onStart({ durationMs }) }); stop().
 */
export function createClipPlayer({ base, getContext }) {
  let manifest = null;
  let loading = null;
  const cache = new Map();             // clip -> Promise<{ buffer, start, end, gain }>
  let current = null;                  // { sources, master, finish }

  function load() {
    if (manifest) return Promise.resolve(manifest);
    if (!loading) {
      loading = fetch(`${base}manifest.json`, { cache: 'no-cache' })
        .then(r => (r.ok ? r.json() : null))
        .then(j => { manifest = j && j.clips && typeof j.clips === 'object' ? j : null; return manifest; })
        .catch(() => null)
        .then(m => { if (!m) loading = null; return m; });     // not there now: look again next time
    }
    return loading;
  }

  const has = clip => !!(manifest && manifest.clips[clip]);

  function buffer(clip) {
    if (cache.has(clip)) { const p = cache.get(clip); cache.delete(clip); cache.set(clip, p); return p; }
    const entry = manifest.clips[clip];
    const p = (async () => {
      const r = await fetch(`${base}${entry.file || clipFile(clip)}`);
      if (!r.ok) throw new Error(`${clip}: ${r.status}`);
      const data = await r.arrayBuffer();
      const ctx = getContext();
      const buf = await new Promise((resolve, reject) => {
        const q = ctx.decodeAudioData(data, resolve, reject);
        if (q && typeof q.then === 'function') q.then(resolve, reject);
      });
      const m = measure(buf.getChannelData(0), buf.sampleRate);
      return { buffer: buf, start: m.start, end: m.end, gain: gainFor(m) };
    })();
    p.catch(() => cache.delete(clip));
    cache.set(clip, p);
    while (cache.size > CACHE_CLIPS) cache.delete(cache.keys().next().value);
    return p;
  }

  async function play(plan, { volume = 1, onStart, still = () => true } = {}) {
    const ctx = getContext();
    if (!ctx) throw new Error('no Web Audio here');
    if (ctx.state === 'suspended') {
      try { await Promise.race([ctx.resume(), new Promise(r => setTimeout(r, 1500))]); } catch { /* checked below */ }
      if (ctx.state !== 'running') throw new Error('sound is locked until the first tap');
    }
    const js = joins(plan);
    const decoded = await Promise.all(js.map(j => buffer(j.clip)));
    if (!still()) return { played: false, durationMs: 0 };              // hushed while its clips were loading
    const { slots, total } = schedule(js.map((j, i) => ({ ...j, dur: (decoded[i].end - decoded[i].start) / decoded[i].buffer.sampleRate })));
    stop();
    const master = ctx.createGain();
    master.gain.value = Math.min(1, Math.max(0, Number(volume)));
    master.connect(ctx.destination);
    const t0 = ctx.currentTime + 0.05;
    const sources = slots.map((s, i) => {
      const d = decoded[i];
      const src = ctx.createBufferSource();
      src.buffer = d.buffer;
      const g = ctx.createGain();
      g.gain.value = 0;
      g.gain.setValueCurveAtTime(fadeCurve('in', d.gain), t0 + s.at, s.fadeIn);
      g.gain.setValueAtTime(d.gain, t0 + s.at + s.fadeIn);
      g.gain.setValueCurveAtTime(fadeCurve('out', d.gain), t0 + s.at + s.dur - s.fadeOut, s.fadeOut);
      src.connect(g).connect(master);
      src.start(t0 + s.at, d.start / d.buffer.sampleRate, s.dur);
      return src;
    });
    return new Promise(resolve => {
      let guard = null;
      const finish = () => {
        if (!current || current.finish !== finish) return;
        clearTimeout(guard);
        current = null;
        setTimeout(() => { try { master.disconnect(); } catch { /* gone */ } }, 120);
        resolve({ played: true, durationMs: Math.round(total * 1000) });
      };
      current = { sources, master, finish };
      sources[sources.length - 1].onended = finish;
      guard = setTimeout(finish, (total + 1.5) * 1000);           // never let one line block the rest
      if (onStart) onStart({ durationMs: Math.round(total * 1000) });
    });
  }

  /** Stops the line playing now (a short fade, no click). */
  function stop() {
    const c = current;
    if (!c) return;
    const ctx = getContext();
    try { c.master.gain.setTargetAtTime(0, ctx.currentTime, 0.01); } catch { /* fine */ }
    for (const s of c.sources) { try { s.stop(ctx.currentTime + 0.06); } catch { /* not started or done */ } }
    c.finish();
  }

  return { load, has, play, stop, get manifest() { return manifest; } };
}
