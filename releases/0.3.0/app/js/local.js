// DAYBOOK — talking to the keeper on this PC (0.3.0).
//
// On her PC the Daybook server is run by the keeper (pc/keeper.js), which also keeps
// Daybook up to date. The page tells it, every 15 seconds, "I am running, version X"
// (POST /api/alive): that is how a new version proves it started, and the answer
// brings the keeper's news: the version it serves, the last update check, the last
// update (or rollback), and a fresh install's test check-in.
//
// When the keeper serves a different version than this page runs (after an update, or
// a rollback), the page reloads itself, quietly (no start-of-day words), when she is
// not using it: on TODAY with no card up and a minute untouched, or after half an
// hour untouched whatever is on screen.
//
// Pure helpers first (tested in Node), then the calls.

export const ALIVE_MS = 15000;
export const QUIET_KEY = 'daybook.quiet';
const MIN = 60000;

/** True when the keeper serves another version than the page's own. */
export function otherVersionServed(pageVersion, status) {
  return !!(status && status.updater && status.version && status.version !== pageVersion);
}

/** May the page reload now? { view, card, idleMs } */
export function readyToReload({ view, card, idleMs }) {
  if (idleMs >= 30 * MIN) return true;
  return view === 'today' && !card && idleMs >= MIN;
}

/** The last update's result, to send once as a check-in: { id, data } or null. */
export function updateReport(updater, reportedId) {
  const u = updater && updater.update;
  if (!u || !u.id || u.id === reportedId) return null;
  if (u.result !== 'updated' && u.result !== 'rolledback') return null;
  const data = { result: u.result, from: String(u.from || ''), to: String(u.to || '') };
  if (u.result === 'rolledback' && u.why) data.why = String(u.why).slice(0, 120);
  return { id: u.id, data };
}

/** The updater's news, short, for the family page (the check-in's app block). */
export function updateSummary(status) {
  const u = status && status.updater;
  if (!u) return null;
  const out = { running: String(u.running || status.version || '') };
  if (u.check) out.check = { at: u.check.at || 0, result: String(u.check.result || ''), latest: u.check.latest || '', requestId: u.check.requestId || '' };
  if (u.update) out.last = { result: u.update.result, from: u.update.from || '', to: u.update.to || '', at: u.update.at || 0, requestId: u.update.requestId || '' };
  if (u.trial) out.trial = u.trial.version;
  return out;
}

const PHASE = {
  checking: 'Looking for a new version…',
  downloading: 'Downloading the new version…',
  installing: 'Putting the new version in place…',
  restarting: 'Starting the new version…',
};

/** One or two sentences for the settings screen. fmt(ms) -> "Thursday 3:00 a.m." */
export function updateLine(status, fmt) {
  const u = status && status.updater;
  if (!u) return 'This copy of Daybook was not installed with the Daybook installer, so it does not update itself.';
  if (PHASE[u.phase]) return PHASE[u.phase];
  if (u.trial) return `Trying the new version ${u.trial.version}…`;
  const parts = [`Daybook ${u.running}.`];
  parts.push(u.enabled === false ? 'Nightly updates are off.' : `Looks for updates every night at ${fmt(u.nextNight, true)}.`);
  const c = u.check;
  const words = {
    uptodate: 'up to date', offline: 'no internet then (it tries again the next night)', error: `a problem (${c && c.error})`,
    started: 'a new version was found', needsboot: `version ${c && c.latest} needs the installer (a visit)`, skipped: `skipped ${c && c.latest}, which did not start before`,
  };
  if (c && words[c.result]) parts.push(`Last looked ${fmt(c.at)}: ${words[c.result]}.`);
  const l = u.update;
  if (l && l.result === 'updated') parts.push(`Updated from ${l.from} to ${l.to}, ${fmt(l.at)}.`);
  if (l && l.result === 'rolledback') parts.push(`The update to ${l.to} did not start, so Daybook went back to ${l.from} (${fmt(l.at)}).`);
  return parts.join(' ').replace(/\.\./g, '.');          // '3:00 a.m.' at the end of a sentence
}

// --- the calls -----------------------------------------------------------------------------------

let last = null;
let lastTry = 0;

export function lastStatus() { return last; }

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), cache: 'no-store' });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error(`answered ${r.status}`);
  return j;
}

/** "I am running." At most every 15 seconds unless force. Resolves the keeper's status (or the last one). */
export async function alive(body, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastTry < ALIVE_MS) return last;
  lastTry = now;
  try {
    const j = await post('api/alive', body);
    if (j && j.app === 'daybook') last = j;
  } catch { /* the server is restarting, or not there: try again next time */ }
  return last;
}

/** "Update now" (her settings, reason 'button') or the family page's request (reason 'family', with its id). */
export async function requestUpdate(reason, id) {
  try {
    const j = await post('api/update', { reason, id: id || undefined });
    if (j && j.status && j.status.app === 'daybook') last = j.status;
    return j;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export async function ack(body) {
  try { const j = await post('api/ack', body); if (j && j.app === 'daybook') last = j; } catch { /* next time */ }
}

/** Reloads the page without the start-of-day words (main.js reads the flag at start-up). */
export function quietReload() {
  try { sessionStorage.setItem(QUIET_KEY, String(Date.now())); } catch { /* fine */ }
  location.reload();
}

/** True (once) if this start-up is a quiet reload from within the last half hour. */
export function takeQuiet() {
  try {
    const v = Number(sessionStorage.getItem(QUIET_KEY));
    sessionStorage.removeItem(QUIET_KEY);
    return v > 0 && Date.now() - v < 30 * MIN;
  } catch {
    return false;
  }
}
