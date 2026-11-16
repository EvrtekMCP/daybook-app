// DAYBOOK — the calendar. Two providers behind one face:
//   mock       sample events, for building and testing (the default until
//              Evrtek deploys the Apps Script; set calendar.provider in config).
//              Her screens label it "sample appointments" so it is never
//              mistaken for real ones.
//   none       no calendar yet: shows nothing
//   appsscript his Google Apps Script web app (apps-script/Code.gs): list + add only
//
// The app keeps the last copy it fetched, so it works offline. Appointments
// added while the calendar cannot be reached wait in an outbox on the device and
// are sent on the next sync; each carries a request id, so the script never
// adds the same one twice. There is no delete or edit here, or in the script.

import * as store from './store.js';
import { dayKey, addDays, now, dateFromKey, hmToMinutes, minutesToHm } from './clock.js';
import { inferType, typeInfo, TYPE_IDS } from './types.js';
import { scriptCall } from './script.js';

let cfg = null;
let status = { lastOk: null, lastError: null, syncing: false };

export function initCalendar(config) { cfg = config; }
export function calendarStatus() { return { ...status, cache: store.get('calendar', null), outbox: store.get('outbox', []) }; }

function provider() {
  const c = (cfg && cfg.calendar) || {};
  if (c.provider === 'appsscript') return c.url && c.key ? appsScript(c) : none;   // half set up: show nothing, never samples
  if (c.provider === 'none') return none;
  return mock;
}

/** True while the sample calendar is the one in use (her screens say so). */
export function usingSample() { return provider() === mock; }

const none = {
  name: 'none',
  async list() { return []; },
  async add() { throw new Error('no calendar connected yet'); },
};

/** A calendar event in the app's own shape. */
function normalize(e, extra) {
  const type = inferType(e.title, e.tag || e.type);
  return Object.assign({
    id: String(e.id),
    title: String(e.title || typeInfo(type).title).slice(0, 120),
    type,
    date: e.date,
    time: e.allDay || !e.time ? null : e.time,
    endTime: e.allDay || !e.time ? null : (e.endTime || null),
    allDay: !!e.allDay || !e.time,
    fromDaybook: !!e.fromDaybook,
  }, extra || {});
}

// --- the mock calendar -------------------------------------------------------------
// A sample week, the same every week (0 = Sunday ... 6 = Saturday). Saturday is
// left empty so a quiet day can be seen too.
const MOCK_WEEK = [
  [1, '10:00', '11:00', 'PSW visit', 'psw'],
  [2, '09:30', '10:30', 'Dentist appointment', 'dentist'],
  [3, null, null, 'Recycling day', 'other'],
  [3, '10:00', '11:00', 'PSW visit', 'psw'],
  [4, '10:00', '11:00', 'PSW visit', 'psw'],
  [4, '13:30', '14:30', 'Hair appointment', 'other'],
  [5, '14:30', '15:30', 'Doctor appointment', 'doctor'],
  [0, '15:00', '17:00', 'Family visit', 'family'],
];

const mock = {
  name: 'mock',
  async list(from, to) {
    const out = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const wd = dateFromKey(date).getDay();
      for (const [day, time, endTime, title, tag] of MOCK_WEEK) {
        if (day === wd) out.push({ id: `mock-${date}-${time || 'allday'}-${tag}`, title, date, time, endTime, allDay: !time, tag });
      }
    }
    for (const a of store.get('mockAdded', [])) if (a.date >= from && a.date <= to) out.push(a);
    return out;
  },
  async add(event, requestId) {
    const added = store.get('mockAdded', []);
    const existing = added.find(a => a.requestId === requestId);
    if (existing) return { id: existing.id };
    const id = `mock-added-${requestId}`;
    added.push({ id, requestId, title: event.title, date: event.date, time: event.time, endTime: event.endTime, allDay: false, tag: event.type, fromDaybook: true });
    store.set('mockAdded', added);
    return { id };
  },
};

// --- the Apps Script calendar --------------------------------------------------------
// Through scriptCall (script.js): POST, text/plain, the key in the body.
function appsScript(c) {
  const call = body => scriptCall(c, body);
  return {
    name: 'appsscript',
    async list(from, to) { return (await call({ action: 'list', from, to })).events || []; },
    async add(event, requestId) { const j = await call({ action: 'add', requestId, event }); return { id: j.event && j.event.id }; },
  };
}

// --- the shared face --------------------------------------------------------------------

function newRequestId() {
  try { return crypto.randomUUID(); } catch { return `r${Date.now()}${Math.random().toString(36).slice(2)}`; }
}

/** Every event the screens should show: the last fetched copy plus anything still in the outbox. */
export function allEvents() {
  const cache = store.get('calendar', null);
  // Only a copy from the calendar in use now: never yesterday's samples after switching to the real one.
  const list = cache && cache.provider === provider().name ? cache.events.map(e => normalize(e)) : [];
  for (const o of store.get('outbox', [])) {
    list.push(normalize({ id: `pending-${o.requestId}`, title: o.event.title, date: o.event.date, time: o.event.time, endTime: o.event.endTime, tag: o.event.type, fromDaybook: true }, { pending: true }));
  }
  return list;
}

async function flushOutbox(p) {
  const box = store.get('outbox', []);
  const left = [];
  for (const o of box) {
    try { await p.add(o.event, o.requestId); }
    catch (e) { left.push(o); status.lastError = String(e.message || e); }
  }
  store.set('outbox', left);
  return left.length === 0;
}

/** Sends waiting appointments, then fetches today .. today+daysAhead. */
export async function syncCalendar() {
  if (status.syncing) return { ok: false, error: 'busy' };
  status.syncing = true;
  const p = provider();
  try {
    await flushOutbox(p);
    const from = dayKey(now());
    const ahead = Math.max(7, Number(cfg && cfg.calendar && cfg.calendar.daysAhead) || 7);
    const to = addDays(from, ahead);
    const events = await p.list(from, to);
    store.set('calendar', { provider: p.name, fetchedAt: new Date().toISOString(), from, to, events });
    status.lastOk = new Date().toISOString();
    status.lastError = null;
    return { ok: true };
  } catch (e) {
    status.lastError = String(e.message || e);
    return { ok: false, error: status.lastError };
  } finally {
    status.syncing = false;
  }
}

/**
 * Adds one appointment. event: { type, title, date "YYYY-MM-DD", time "HH:MM" }.
 * Returns 'added' (it reached the calendar) or 'queued' (saved here, sent later).
 */
export async function addAppointment(event) {
  if (!TYPE_IDS.includes(event.type)) throw new Error('unknown type');
  const info = typeInfo(event.type);
  const clean = {
    type: event.type,
    title: String(event.title || '').trim().slice(0, 80) || info.title,
    date: event.date,
    time: event.time,
    minutes: info.minutes,
  };
  const start = hmToMinutes(clean.time);
  if (start == null || !/^\d{4}-\d{2}-\d{2}$/.test(String(clean.date))) throw new Error('bad date or time');
  clean.endTime = minutesToHm(Math.min(start + clean.minutes, 23 * 60 + 59));
  const requestId = newRequestId();
  const box = store.get('outbox', []);
  box.push({ requestId, event: clean, createdAt: new Date().toISOString() });
  store.set('outbox', box);
  const p = provider();
  const sent = await flushOutbox(p);
  if (sent) { await syncCalendar(); return 'added'; }
  return 'queued';
}
