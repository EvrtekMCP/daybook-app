// DAYBOOK — small, safe wrapper over localStorage. Everything the app remembers on
// this device goes through here under the "daybook." prefix. A blocked or full
// storage never breaks the screen: reads fall back, writes report false.

const PREFIX = 'daybook.';

function ls() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function get(key, fallback = null) {
  try {
    const s = ls();
    const v = s ? s.getItem(PREFIX + key) : null;
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}

export function set(key, value) {
  try { const s = ls(); if (!s) return false; s.setItem(PREFIX + key, JSON.stringify(value)); return true; }
  catch { return false; }
}

export function remove(key) {
  try { const s = ls(); if (s) s.removeItem(PREFIX + key); } catch { /* nothing to do */ }
}

/** Keeps only the newest `keep` day keys of a { "YYYY-MM-DD": ... } record. */
export function pruneDays(obj, keep) {
  const keys = Object.keys(obj || {}).sort();
  const out = {};
  for (const k of keys.slice(-keep)) out[k] = obj[k];
  return out;
}
