// DAYBOOK — the TODAY screen. Same layout every day: the day, the date, a
// greeting, the thought of the day, today's list, and one button for the week.
// 0.2.0: on a day the family writes a message, it takes the thought's box (same
// place, same size: one thing at a time), and a calm "I'd like a call" button
// sits beside the date (always the same place) once his script is connected.
// 0.4.0: with the character on (settings), the portrait slot grows and main.js puts
// the character in it after each redraw (app/js/character.js); off, the plain sun.

import { esc, wire } from '../util.js';
import { partOfDay, weekdayName, formatDate, formatTime } from '../clock.js';
import { todayItems, pickByDay, thoughtIds } from '../day.js';

const GREETING = { morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening', night: 'Hello' };

/** A short fingerprint of what the screen shows, so the clock only redraws when something changed. */
export function todaySignature(s) {
  const items = todayItems(s.key, s.nowMs, s.cfg, s.events, s.medRec);
  return JSON.stringify([s.key, partOfDay(new Date(s.nowMs), s.cfg.partsOfDay), s.cfg.name, s.message || '', !!s.canCall, !!s.character,
    items.map(i => [i.id, i.time, i.title, i.status, !!i.now])]);
}

function itemHtml(it, cfg) {
  const time = it.allDay ? 'All day' : formatTime(it.time, cfg.clock12h !== false);
  const cls = ['item', `kind-${it.kind}`, `status-${it.status}`];
  if (it.now) cls.push('is-now');
  let note = '';
  let button = '';
  if (it.kind === 'medicine') {
    if (it.status === 'done') note = '<span class="note note-done">Done. Thank you!</span>';
    if (it.status === 'next') note = '<span class="note note-next">Next</span>';
    if (it.status === 'due') button = '<button class="btn btn-primary btn-took" data-action="took">I took it</button>';
  } else if (it.now) note = '<span class="note note-now">Now</span>';
  else if (it.status === 'next') note = '<span class="note note-next">Next</span>';
  else if (it.status === 'past') note = '<span class="note">Earlier today</span>';
  return `<li class="${cls.join(' ')}">
      <span class="time">${esc(time)}</span>
      <span class="what">${esc(it.title)}${note}</span>
      ${button}
    </li>`;
}

export function renderToday(root, s, actions) {
  const { cfg, key, nowMs, lines } = s;
  const d = new Date(nowMs);
  const part = partOfDay(d, cfg.partsOfDay);
  const name = String(cfg.name || '').trim();
  const thought = lines.text(pickByDay(thoughtIds(lines), key));
  const items = todayItems(key, nowMs, cfg, s.events, s.medRec);
  const hasEvents = items.some(i => i.kind === 'event');

  let list = items.map(it => itemHtml(it, cfg)).join('');
  if (!hasEvents) {
    list += `<li class="item item-empty"><span class="what">${items.length ? 'Nothing else on the calendar today.' : 'Nothing on the calendar today.'} <span class="note">A nice, easy day.</span></span></li>`;
  }

  root.innerHTML = `
  <section class="screen today${s.character ? ' with-character' : ''}" data-screen="today">
    <div class="hold-corner" data-hold="settings" aria-hidden="true"></div>
    <header class="today-head">
      <h1 class="dayline"><span class="weekday">${esc(weekdayName(d, cfg.locale))}</span> <span class="part">${esc(part)}</span></h1>
      <div class="date-row">
        <p class="date">${esc(formatDate(d, cfg.locale))}</p>
        ${s.canCall ? '<button class="btn btn-secondary btn-call call-in-head" data-action="call">I’d like a call</button>' : ''}
      </div>
    </header>
    <div class="today-left">
      <div class="hello">
        <div class="portrait-slot" data-slot="character" aria-hidden="true">
          ${s.character ? '' : '<img src="img/portrait-placeholder.svg" alt="">'}
        </div>
        <p class="greeting">${esc(GREETING[part])}${name ? `, ${esc(name)}` : ''}.</p>
        ${s.canCall ? '<button class="btn btn-secondary btn-call call-in-hello" data-action="call">I’d like<br>a call</button>' : ''}
      </div>
      ${s.message ? `<figure class="thought family-note" data-family-note>
        <figcaption>From your family</figcaption>
        <blockquote class="family-note-text">${esc(s.message)}</blockquote>
      </figure>` : `<figure class="thought">
        <figcaption>A thought for today</figcaption>
        <blockquote>${esc(thought)}</blockquote>
      </figure>`}
    </div>
    <div class="today-right">
      <h2 class="list-title">Today${s.sample ? ' <span class="sample-note">(sample appointments, for testing)</span>' : ''}</h2>
      <ul class="items">${list}</ul>
      <button class="btn btn-primary btn-week" data-action="week">See my week</button>
    </div>
  </section>`;
  wire(root, actions);
}
