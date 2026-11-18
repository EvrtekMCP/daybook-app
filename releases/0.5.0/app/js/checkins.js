// DAYBOOK — check-ins: telling his script what happened, so the family can see
// that the system is working (0.2.0; 0.3.0 adds "update" and "install").
//
//   record(type, data)  keeps one check-in on this device: start, medicine, nudge,
//                       week, added, call, mood. It goes with the next push.
//   push({ force })     sends what is waiting, or a heartbeat when nothing else
//                       has gone for heartbeatMinutes (15). The answer brings the
//                       family page's settings and today's message.
//
// Kept like the appointments outbox: on the device until the script says it has
// them (each has an id, so a resend counts once). Heartbeats are never kept: an old
// heartbeat says nothing, and the next one goes on its own. Nothing is kept unless
// his script is connected (calendar provider "appsscript", with its URL and key).
// The words she tapped are never sent, only what kind of thing happened.

import * as store from './store.js';
import { nowMs, hmToMinutes } from './clock.js';
import { scriptCall, scriptConfigured } from './script.js';
import { deepMerge } from './config.js';

export const VERSION = '0.5.0';
export const CHECKIN_TYPES = ['start', 'heartbeat', 'medicine', 'nudge', 'week', 'added', 'call', 'mood', 'update', 'install'];
export const MAX_QUEUE = 300;
export const MAX_BATCH = 50;
const MIN = 60000;

// --- pure helpers (tested in Node) ------------------------------------------------------

export function newId() {
  try { return globalThis.crypto.randomUUID(); } catch { return `c${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`; }
}

export function makeCheckin(type, at, data = {}) {
  return Object.assign({ id: newId(), type, at }, data);
}

/** The queue with one more check-in, newest last, never longer than max (the oldest go first). */
export function enqueue(queue, c, max = MAX_QUEUE) {
  const q = (queue || []).concat([c]);
  return q.length > max ? q.slice(q.length - max) : q;
}

/** What to send now: up to max waiting check-ins, or a heartbeat when none wait and one is due. */
export function makeBatch(queue, at, heartbeatDue, max = MAX_BATCH) {
  const batch = (queue || []).slice(0, max);
  if (!batch.length && heartbeatDue) batch.push(makeCheckin('heartbeat', at));
  return batch;
}

/** The queue once the script has said which ids it has. */
export function afterAck(queue, accepted) {
  const done = new Set(accepted || []);
  return (queue || []).filter(c => !done.has(c.id));
}

const okTime = v => typeof v === 'string' && hmToMinutes(v) != null;

/** 0.5.0: the getting-ready lead times offered (minutes; 0 = off), here and on the family page. */
export const LEAD_CHOICES = [0, 60, 90, 120, 150, 180, 240];
const okLead = v => typeof v === 'number' && LEAD_CHOICES.includes(v);

/** "2 hours before", "1½ hours before", "Off". */
export function leadText(min) {
  const m = Number(min) || 0;
  if (!m) return 'Off';
  const h = m / 60;
  const whole = Math.floor(h), half = h - whole >= 0.5;
  if (h < 1) return `${m} minutes before`;
  return `${whole}${half ? '½' : ''} hour${whole === 1 && !half ? '' : 's'} before`;
}

/** Her settings with the family page's on top (only those set there, and valid). */
export function withRemote(base, remote) {
  const r = (remote && remote.settings) || {};
  const over = {};
  if (okTime(r.medicineTime)) over.medicine = { time: r.medicineTime };
  const nudges = {};
  for (const k of ['lunch', 'supper', 'dishes']) if (okTime(r[k])) nudges[k] = r[k];
  if (Object.keys(nudges).length) over.nudges = nudges;
  if (okLead(r.getReadyMinutes)) over.events = { getReadyMinutes: r.getReadyMinutes };
  return deepMerge(base, over);
}

/** The family page's settings in use now, for the settings screen: [['Medicine', '09:30', 'time'], ['Getting ready', 120, 'lead'], ...]. */
export function remoteOverrides(remote) {
  const r = (remote && remote.settings) || {};
  const names = { medicineTime: 'Medicine', lunch: 'Lunch', supper: 'Supper', dishes: 'Dishes' };
  const out = Object.keys(names).filter(k => okTime(r[k])).map(k => [names[k], r[k], 'time']);
  if (okLead(r.getReadyMinutes)) out.push(['Getting ready', r.getReadyMinutes, 'lead']);
  return out;
}

/** The family's message for today (day key "YYYY-MM-DD"), or null. */
export function todaysMessage(remote, key) {
  const m = remote && remote.message;
  if (!m || m.date !== key) return null;
  const t = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);     // the family page allows 80
  return t || null;
}

/** The line that speaks a family message: only when it is exactly one of the message.* lines. */
export function messageLine(text, lines) {
  const norm = s => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[.!?\s]+$/, '').replace(/\s+/g, ' ').trim();
  const n = norm(text);
  if (!n) return null;
  return lines.ids('message.').find(id => norm(lines.text(id)) === n) || null;
}

// --- on the device ----------------------------------------------------------------------

let cfg = null;
let statusFn = () => ({});
const st = { sending: false, lastOk: 0, lastTry: 0, fails: 0, lastError: null };

export function initCheckins(config, { appStatus } = {}) {
  cfg = config;
  if (appStatus) statusFn = appStatus;
}

/** True when his script is set up in the settings (otherwise nothing is recorded or sent). */
export function connected() { return scriptConfigured(cfg && cfg.calendar); }

export function queue() { return store.get('checkins', []); }

export function heartbeatMs() {
  return Math.max(5, Number(cfg && cfg.checkins && cfg.checkins.heartbeatMinutes) || 15) * MIN;
}

/** Keeps one check-in to send. Returns its id, or null when no script is connected. */
export function record(type, data = {}) {
  if (!connected() || !CHECKIN_TYPES.includes(type) || type === 'heartbeat') return null;
  const c = makeCheckin(type, nowMs(), data);
  store.set('checkins', enqueue(queue(), c));
  return c.id;
}

/**
 * Sends what is waiting (or a heartbeat when one is due).
 * Returns null when there was nothing to do (or a send is already under way),
 * { ok: true, sent, remote, more } or { ok: false, error }.
 * After a failure it waits 1, 2, 4 ... up to 15 minutes before trying again,
 * unless force (a tap she just made). beat: send a heartbeat now even if one is
 * not due ("Check the calendar now" in the settings: fetch the family page's news).
 */
export async function push({ force = false, beat = false } = {}) {
  if (!connected() || st.sending) return null;
  const now = nowMs();
  const q = queue();
  const beatDue = beat || now - st.lastOk >= heartbeatMs();
  if (!q.length && !beatDue) return null;
  const wait = st.fails ? Math.min(15 * MIN, MIN * 2 ** (st.fails - 1)) : 0;
  if (!force && now - st.lastTry < wait) return null;
  const batch = makeBatch(q, now, beatDue);
  st.sending = true;
  st.lastTry = now;
  try {
    const j = await scriptCall(cfg.calendar, { action: 'checkin', checkins: batch, app: statusFn() });
    store.set('checkins', afterAck(queue(), j.accepted));
    st.lastOk = now;
    st.fails = 0;
    st.lastError = null;
    const remote = { settings: j.settings || {}, message: j.message || null, day: j.day || null, at: now, updateRequest: typeof j.updateRequest === 'string' ? j.updateRequest : null };
    store.set('remote', remote);
    return { ok: true, sent: j.accepted || [], remote, more: queue().length > 0 };
  } catch (e) {
    st.fails += 1;
    st.lastError = String((e && e.message) || e);
    return { ok: false, error: st.lastError };
  } finally {
    st.sending = false;
  }
}

export function checkinStatus() {
  return { ...st, queued: queue().length, connected: connected(), remote: store.get('remote', null) };
}

/** For the tests: forget the timing (as a fresh page load would). */
export function resetCheckinTiming() { Object.assign(st, { sending: false, lastOk: 0, lastTry: 0, fails: 0, lastError: null }); }
