// DAYBOOK — the day's logic: today's list, what to say at the start of the day,
// which reminders are due, and when to offer the medicine.
// Pure functions: they take the time, the settings, the events and the records,
// and return answers. No DOM, no storage, no clock reads. Tested in Node.

import {
  atTime, hmToMinutes, timeBankId, partOfDay, weekdayKey, daysSinceEpoch, dateFromKey, dayKey,
} from './clock.js';

export const MIN = 60000;

/** Picks one id from a list by date, so it is the same all day and changes daily. */
export function pickByDay(ids, key, salt = 0) {
  if (!ids.length) return null;
  const n = daysSinceEpoch(key) + salt;
  return ids[((n % ids.length) + ids.length) % ids.length];
}

export function thoughtIds(lines) {
  return lines.ids('thought.').filter(id => /^thought\.\d+$/.test(id));
}

export function eventsOn(key, events) {
  return (events || []).filter(e => e.date === key);
}

function eventEndMs(key, e) {
  const start = atTime(key, e.time);
  if (!start) return null;
  const end = e.endTime ? atTime(key, e.endTime) : null;
  return end && end > start ? end.getTime() : start.getTime() + 60 * MIN;
}

/**
 * The medicine's state for a day:
 *   'done'     taken (tapped "I took it")
 *   'due'      time has come and it is still offered (until the last-offer time)
 *   'upcoming' not yet time
 *   'closed'   past the last-offer time without a tap (shown plainly, never as a failure)
 *   null       no medicine reminder set
 */
export function medicineState(key, nowMs, cfg, rec) {
  const med = cfg.medicine || {};
  const t = atTime(key, med.time);
  if (!t) return null;
  if (rec && rec.takenAt) return 'done';
  const last = atTime(key, med.lastOffer);
  const lastMs = last && last > t ? last.getTime() : dateFromKey(key).getTime() + 1440 * MIN;
  if (nowMs < t.getTime()) return 'upcoming';
  if (nowMs < lastMs) return 'due';
  return 'closed';
}

/**
 * Whether to offer the medicine card now, and with which line.
 *   first offer near the set time        -> 'med.due'
 *   first offer later (app opened late)  -> 'med.later'
 *   gentle repeats every repeatMinutes   -> 'med.again' (at most repeatTimes)
 * Returns null when nothing should happen.
 */
export function medicineDecision(key, nowMs, cfg, rec) {
  if (medicineState(key, nowMs, cfg, rec) !== 'due') return null;
  const med = cfg.medicine || {};
  const t = atTime(key, med.time).getTime();
  const offers = (rec && rec.offers) || 0;
  if (offers === 0) return nowMs - t <= 20 * MIN ? 'med.due' : 'med.later';
  const repeatMin = Number(med.repeatMinutes) || 0;
  const repeatTimes = Number(med.repeatTimes) || 0;
  if (repeatMin <= 0 || offers >= 1 + repeatTimes) return null;
  const lastOffer = (rec && rec.lastOfferAt) || 0;
  return nowMs - lastOffer >= repeatMin * MIN ? 'med.again' : null;
}

/**
 * Today's list: calendar events plus the medicine, all-day events first, then by time.
 * Each item gets a status: 'past' | 'next' | 'upcoming' | 'due' | 'done' | 'closed' | 'allday'.
 */
export function todayItems(key, nowMs, cfg, events, medRec) {
  const items = [];
  for (const e of eventsOn(key, events)) {
    items.push({
      kind: 'event', id: e.id, title: e.title, type: e.type, allDay: !!e.allDay,
      time: e.allDay ? null : e.time, endMs: e.allDay ? null : eventEndMs(key, e), pending: !!e.pending,
    });
  }
  const ms = medicineState(key, nowMs, cfg, medRec);
  if (ms) items.push({ kind: 'medicine', id: 'medicine', title: 'Your medicine', time: cfg.medicine.time, allDay: false, medState: ms });

  items.sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return (hmToMinutes(a.time) ?? 0) - (hmToMinutes(b.time) ?? 0);
  });

  let nextGiven = false;
  for (const it of items) {
    if (it.allDay) { it.status = 'allday'; continue; }
    if (it.kind === 'medicine') {
      it.status = it.medState;            // done / due / upcoming / closed
      if (it.status === 'upcoming' && !nextGiven) { it.status = 'next'; nextGiven = true; }
      continue;
    }
    const start = atTime(key, it.time).getTime();
    if (nowMs >= it.endMs) it.status = 'past';
    else if (!nextGiven) { it.status = 'next'; nextGiven = true; }
    else it.status = 'upcoming';
    if (nowMs >= start && nowMs < it.endMs) it.now = true;
  }
  return items;
}

/**
 * What to say at the start of the day, as a list of [lineId, parts] in order:
 * hello (if a name is set), the day line, the thought, then today's upcoming items.
 * note (0.2.0): the family's message for today, { lineId } — on those days it takes
 * the thought's place, on the screen and here: its recorded line is said instead
 * of the thought (lineId null: a message that is not a recorded line, so nothing).
 */
export function introSequence(key, nowMs, cfg, events, medRec, lines, note = null) {
  const seq = [];
  const nowDate = new Date(nowMs);
  if (String(cfg.name || '').trim()) seq.push(['hello.name', { name: 'name' }]);
  seq.push([`day.${weekdayKey(nowDate)}.${partOfDay(nowDate, cfg.partsOfDay)}`, {}]);
  const thought = pickByDay(thoughtIds(lines), key);
  if (note) { if (note.lineId) seq.push([note.lineId, {}]); }
  else if (thought) seq.push(['thought.intro', {}], [thought, {}]);

  const items = todayItems(key, nowMs, cfg, events, medRec);
  const ahead = items.filter(i => !i.allDay && ['next', 'upcoming', 'due'].includes(i.status));
  const allDay = items.some(i => i.allDay);
  const medDone = items.some(i => i.kind === 'medicine' && i.status === 'done');

  const events_ = items.filter(i => i.kind === 'event');

  if (!ahead.length) {
    if (!events_.length) seq.push(['list.none', {}]);
    else {
      if (allDay) seq.push(['list.allday', {}]);
      if (events_.some(i => !i.allDay)) seq.push(['list.nomore', {}]);
    }
  } else {
    seq.push(['list.intro', {}]);
    for (const it of ahead.slice(0, 4)) {
      const time = timeBankId(it.time);
      if (it.kind === 'medicine') seq.push(['list.medicine', { time }]);
      else seq.push([`list.item.${it.type}`, { time }]);
    }
    if (ahead.length > 4) seq.push(['list.more', {}]);
    if (allDay) seq.push(['list.allday', {}]);
  }
  if (medDone) seq.push(['list.medicine.done', {}]);
  return seq;
}

export const READY_DEFAULT_MINUTES = 120;
export const READY_GAP_MINUTES = 15;

/** The getting-ready lead in minutes: events.getReadyMinutes (2 hours by default; 0 = off). */
export function getReadyMinutes(cfg) {
  const v = cfg && cfg.events ? cfg.events.getReadyMinutes : undefined;
  if (v === undefined || v === null || v === '') return READY_DEFAULT_MINUTES;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 12 * 60) : 0;
}

/**
 * The getting-ready reminder for an event starting at s (ms) on day key, or null (0.5.0):
 * the set lead time before it, and it may come until 15 minutes before the "soon" reminder
 * (soonAt), so the two never land close together. Never in the night: an early appointment
 * whose getting-ready time falls before the morning starts (partsOfDay.morning, 5 a.m. by
 * default) gets it at the start of the morning instead, if that is still in time; a late one
 * whose time falls after the night starts gets none. The 30-minute and at-start reminders
 * are unchanged either way. Returns { at, until } in ms.
 */
export function getReadyWindow(key, s, soonAt, cfg) {
  const lead = getReadyMinutes(cfg);
  if (!lead) return null;
  const p = cfg.partsOfDay || {};
  let until = soonAt - READY_GAP_MINUTES * MIN;
  let at = s - lead * MIN;
  if (at >= until) return null;                         // a lead this short: the 30-minute reminder is enough
  const d = new Date(at);
  if (dayKey(d) !== key) return null;                   // the evening before: that is the night
  if (partOfDay(d, p) === 'night') {
    const morning = atTime(key, hmToMinutes(p.morning) == null ? '05:00' : p.morning);
    if (!morning || at >= morning.getTime()) return null;   // after the night starts: none
    at = morning.getTime();                               // before the morning starts: at its start
  }
  const night = atTime(key, p.night);                     // and it may not come once the night has begun
  if (night && night.getTime() > at) until = Math.min(until, night.getTime());
  return at < until ? { at, until } : null;
}

/**
 * The day's timed reminders (not the medicine, which has its own rule):
 *   greeting  at greetingTime (the start-of-day words, if not already said today)
 *   nudge     lunch / supper / dishes, shown for nudges.showMinutes
 *   ready     (0.5.0) getReadyMinutes before an event: time to start getting ready
 *             (getReadyWindow); its card stays until the "soon" reminder
 *   soon      soonMinutes before an event, until it starts
 *   now       when an event starts, for events.showMinutes
 * Each: { id, kind, at, until, showUntil?, ... } with at/until in ms: it fires once, inside
 * [at, until); its card stays until showUntil (or until).
 */
export function daySchedule(key, cfg, events) {
  const out = [];
  const g = atTime(key, cfg.greetingTime);
  if (g) out.push({ id: 'greeting', kind: 'greeting', at: g.getTime(), until: g.getTime() + 120 * MIN });

  const n = cfg.nudges || {};
  const show = (Number(n.showMinutes) || 45) * MIN;
  for (const which of ['lunch', 'supper', 'dishes']) {
    const t = atTime(key, n[which]);
    if (t) out.push({ id: `nudge:${which}`, kind: 'nudge', nudge: which, at: t.getTime(), until: t.getTime() + show });
  }

  const ev = cfg.events || {};
  const soon = (Number(ev.soonMinutes) || 30) * MIN;
  const evShow = (Number(ev.showMinutes) || 30) * MIN;
  for (const e of eventsOn(key, events)) {
    if (e.allDay) continue;
    const start = atTime(key, e.time);
    if (!start) continue;
    const s = start.getTime();
    // Keyed by when and what, not by the calendar's id: an appointment added
    // offline changes id once it reaches the calendar, and must not ring twice.
    const base = `ev:${e.date}T${e.time}:${e.type}`;
    const ready = getReadyWindow(key, s, s - soon, cfg);
    if (ready) out.push({ id: `${base}:ready`, kind: 'ready', event: e, at: ready.at, until: ready.until, showUntil: s - soon });
    out.push({ id: `${base}:soon`, kind: 'soon', event: e, at: s - soon, until: s });
    out.push({ id: `${base}:now`, kind: 'now', event: e, at: s, until: s + evShow });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Which reminders to fire now. An entry fires once (its id goes in `fired`),
 * only inside its window, so a reminder missed while the app was closed is
 * skipped rather than shown late. An event's "soon" window ends where its
 * "now" window begins, so the two never fire together.
 * Returns { fire: [...entries], mark: [...ids] }.
 */
export function dueReminders(nowMs, entries, fired) {
  const done = new Set(fired || []);
  const fire = entries.filter(e => !done.has(e.id) && nowMs >= e.at && nowMs < e.until);
  return { fire, mark: fire.map(e => e.id) };
}
