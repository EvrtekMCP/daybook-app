// DAYBOOK — settings. Three layers, later wins:
//   1. config.example.json   (committed defaults)
//   2. config.local.json     (her personal settings; git-ignored, this device only)
//   3. a copy in this browser (only used when the settings screen could not
//      write config.local.json, e.g. the app is served without the local server)

import * as store from './store.js';

export function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

export function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

async function fetchJson(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export async function loadConfig() {
  const example = (await fetchJson('config.example.json')) || {};
  const local = (await fetchJson('config.local.json')) || {};
  const browserCopy = store.get('configOverride', null) || {};
  const cfg = deepMerge(deepMerge(example, local), browserCopy);
  delete cfg._readme;
  return { cfg, hasLocal: Object.keys(local).length > 0, example };
}

/** Saves the whole settings object. Returns 'file' or 'browser'. */
export async function saveConfig(cfg) {
  const clean = { ...cfg };
  delete clean._readme;
  try {
    const r = await fetch('api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clean),
    });
    if (r.ok) { store.remove('configOverride'); return 'file'; }
  } catch { /* fall through to the browser copy */ }
  store.set('configOverride', clean);
  return 'browser';
}
