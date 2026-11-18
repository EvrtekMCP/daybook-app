// DAYBOOK — the WEEK view: today and the six days after it, simply.

import { esc, wire } from '../util.js';
import { addDays, dateFromKey, weekdayName, formatDate, formatTime, hmToMinutes } from '../clock.js';
import { eventsOn } from '../day.js';

export function renderWeek(root, s, actions) {
  const { cfg, key } = s;
  const clock12h = cfg.clock12h !== false;
  const rows = [];
  for (let i = 0; i < 7; i++) {
    const k = addDays(key, i);
    const d = dateFromKey(k);
    const name = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : weekdayName(d, cfg.locale);
    const sub = i <= 1 ? `${weekdayName(d, cfg.locale)}, ${formatDate(d, cfg.locale, false)}` : formatDate(d, cfg.locale, false);
    const evs = eventsOn(k, s.events).slice().sort((a, b) => {
      if (!!a.allDay !== !!b.allDay) return a.allDay ? -1 : 1;
      return (hmToMinutes(a.time) ?? 0) - (hmToMinutes(b.time) ?? 0);
    });
    const list = evs.length
      ? evs.map(e => `<li><span class="ev-time">${esc(e.allDay ? 'All day' : formatTime(e.time, clock12h))}</span><span class="ev-what">${esc(e.title)}</span></li>`).join('')
      : '<li class="nothing">Nothing planned</li>';
    rows.push(`<li class="day${i === 0 ? ' is-today' : ''}">
        <div class="day-label"><span class="day-name">${esc(name)}</span><span class="day-date">${esc(sub)}</span></div>
        <ul class="day-events">${list}</ul>
      </li>`);
  }
  root.innerHTML = `
  <section class="screen week" data-screen="week">
    <div class="week-top">
      <button class="btn btn-primary btn-back" data-action="today">Back to today</button>
      <h1 class="week-title">Your week</h1>
    </div>
    <ol class="days">${rows.join('')}</ol>
    <div class="week-bottom">
      ${s.sample ? '<span class="sample-note">(sample appointments, for testing)</span>' : '<span></span>'}
      <button class="btn btn-secondary btn-add" data-action="add">Add an appointment</button>
    </div>
  </section>`;
  wire(root, actions);
}
