// DAYBOOK — the clock. Every "what time is it" in the app comes from now() here,
// so a test (or Evrtek) can run the app at a pretend time with ?fakeNow=2026-11-19T08:59:50
// in the address bar. The pretend clock then keeps ticking forward in real time.
// Pure functions only below now(): no DOM, no storage. Tested in Node.

let offsetMs = 0;

/** Parses "YYYY-MM-DDTHH:MM[:SS]" as LOCAL time. Returns ms or NaN. */
export function parseLocal(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(text || '').trim());
  if (!m) return NaN;
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
  return new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
}

/** Starts the pretend clock at a local time (or clears it with null). */
export function setFakeNow(text) {
  if (text == null) { offsetMs = 0; return true; }
  const t = parseLocal(text);
  if (Number.isNaN(t)) return false;
  offsetMs = t - Date.now();
  return true;
}

export function isFake() { return offsetMs !== 0; }
export function nowMs() { return Date.now() + offsetMs; }
export function now() { return new Date(nowMs()); }

export const pad2 = n => String(n).padStart(2, '0');

/** "YYYY-MM-DD" for a Date (local). */
export function dayKey(d = now()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local midnight Date for "YYYY-MM-DD". */
export function dateFromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key, n) {
  const d = dateFromKey(key);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}

/** "HH:MM" -> minutes after midnight, or null for an empty / bad value. */
export function hmToMinutes(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

export function minutesToHm(min) {
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

/** Local Date for a day key at "HH:MM", or null. */
export function atTime(key, hm) {
  const min = hmToMinutes(hm);
  if (min == null) return null;
  const d = dateFromKey(key);
  d.setHours(Math.floor(min / 60), min % 60, 0, 0);
  return d;
}

export function minutesOfDay(d) { return d.getHours() * 60 + d.getMinutes(); }

/** morning / afternoon / evening / night from the configured start times. */
export function partOfDay(d, parts) {
  const p = parts || {};
  const m = minutesOfDay(d);
  const morning = hmToMinutes(p.morning) ?? 300;
  const afternoon = hmToMinutes(p.afternoon) ?? 720;
  const evening = hmToMinutes(p.evening) ?? 1020;
  const night = hmToMinutes(p.night);
  if (m < morning) return 'night';
  if (night != null && m >= night) return 'night';
  if (m >= evening) return 'evening';
  if (m >= afternoon) return 'afternoon';
  return 'morning';
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export function weekdayKey(d) { return WEEKDAYS[d.getDay()]; }

export function weekdayName(d, locale) {
  return d.toLocaleDateString(locale || 'en-CA', { weekday: 'long' });
}

/** "November 19, 2026" (en-CA). */
export function formatDate(d, locale, withYear = true) {
  const opts = withYear ? { month: 'long', day: 'numeric', year: 'numeric' } : { month: 'long', day: 'numeric' };
  return d.toLocaleDateString(locale || 'en-CA', opts);
}

/** "9:00 a.m." (12-hour) or "09:00" (24-hour), from "HH:MM" or a Date. */
export function formatTime(hmOrDate, clock12h = true) {
  const min = hmOrDate instanceof Date ? minutesOfDay(hmOrDate) : hmToMinutes(hmOrDate);
  if (min == null) return '';
  const h = Math.floor(min / 60), mi = min % 60;
  if (!clock12h) return `${pad2(h)}:${pad2(mi)}`;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad2(mi)} ${h < 12 ? 'a.m.' : 'p.m.'}`;
}

/** Rounds "HH:MM" to the nearest quarter hour; returns minutes (may wrap past midnight). */
export function roundToQuarter(hm) {
  const min = hmToMinutes(hm);
  if (min == null) return null;
  return (Math.round(min / 15) * 15) % 1440;
}

/** The time-bank part id for "HH:MM": "time.HH.MM" on a 12-hour dial, nearest quarter hour. */
export function timeBankId(hm) {
  const q = roundToQuarter(hm);
  if (q == null) return null;
  const h = Math.floor(q / 60), mi = q % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `time.${pad2(h12)}.${pad2(mi)}`;
}

/** Whole days since 1970-01-01 for a day key (for rotating thoughts and meals by date). */
export function daysSinceEpoch(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}
