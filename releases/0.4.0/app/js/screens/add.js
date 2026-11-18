// DAYBOOK — ADD AN APPOINTMENT. One question per screen:
//   what kind -> (its name, for "Something else") -> which day -> what hour
//   -> which quarter hour -> is this right? -> done
// There is no delete or edit anywhere: this flow only ever adds.

import { esc, wire } from '../util.js';
import { addDays, dateFromKey, weekdayName, formatDate, formatTime, pad2 } from '../clock.js';
import { EVENT_TYPES, typeInfo } from '../types.js';

const FIRST_HOUR = 7;
const LAST_HOUR = 20;
const MAX_PAGE = 8;            // the next nine weeks

let st = null;

const PROMPT = {
  kind: ['What kind of appointment is it?', 'add.kind'],
  what: ['What is it called?', 'add.what'],
  day: ['Which day is it?', 'add.day'],
  hour: ['What time does it start?', 'add.hour'],
  minute: ['Which of these times is it?', 'add.minute'],
  confirm: ['Is this right?', 'add.confirm'],
};

export function startAdd() { st = { step: 'kind', page: 0, history: [] }; }
export function addStep() { return st && st.step; }

function dayLabel(k, today, locale) {
  const d = dateFromKey(k);
  if (k === today) return ['Today', `${weekdayName(d, locale)}, ${formatDate(d, locale, false)}`];
  if (k === addDays(today, 1)) return ['Tomorrow', `${weekdayName(d, locale)}, ${formatDate(d, locale, false)}`];
  return [weekdayName(d, locale), formatDate(d, locale, false)];
}

export function renderAdd(root, s, ctl) {
  const { cfg, key } = s;
  const clock12h = cfg.clock12h !== false;
  const go = (step) => { st.history.push(st.step); st.step = step; ctl.redraw(); ctl.say(PROMPT[step] && PROMPT[step][1]); };
  const back = () => { st.step = st.history.pop() || 'kind'; ctl.redraw(); };
  let body = '';
  let nav = '';
  const handlers = { cancel: () => ctl.leave(), back };

  if (st.step === 'kind') {
    body = `<div class="choices choices-kind">${EVENT_TYPES.map(t => `<button class="btn btn-choice" data-action="kind" data-type="${t.id}">${esc(t.label)}</button>`).join('')}</div>`;
    handlers.kind = el => {
      st.type = el.dataset.type;
      st.title = st.type === 'other' ? (st.title || '') : '';
      go(st.type === 'other' ? 'what' : 'day');
    };
  }

  if (st.step === 'what') {
    body = `<div class="what-box">
        <input class="what-input" type="text" maxlength="60" autocomplete="off" placeholder="For example: Hair appointment" value="${esc(st.title || '')}">
        <button class="btn btn-primary btn-big" data-action="next">Next</button>
      </div>`;
    handlers.next = () => { st.title = root.querySelector('.what-input').value.trim(); go('day'); };
  }

  if (st.step === 'day') {
    const start = st.page * 7;
    const days = [];
    for (let i = start; i < start + 7; i++) days.push(addDays(key, i));
    body = `<div class="choices choices-day">${days.map(k => {
      const [a, b] = dayLabel(k, key, cfg.locale);
      return `<button class="btn btn-choice btn-day" data-action="day" data-key="${k}"><span class="big">${esc(a)}</span><span class="small">${esc(b)}</span></button>`;
    }).join('')}</div>
      <div class="pager">
        ${st.page > 0 ? '<button class="btn btn-secondary" data-action="earlier">Earlier dates</button>' : '<span></span>'}
        ${st.page < MAX_PAGE ? '<button class="btn btn-secondary" data-action="later">Later dates</button>' : '<span></span>'}
      </div>`;
    handlers.day = el => { st.dayKey = el.dataset.key; go('hour'); };
    handlers.earlier = () => { st.page = Math.max(0, st.page - 1); ctl.redraw(); };
    handlers.later = () => { st.page = Math.min(MAX_PAGE, st.page + 1); ctl.redraw(); };
  }

  if (st.step === 'hour') {
    const hours = [];
    for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) hours.push(h);
    body = `<div class="choices choices-hour">${hours.map(h => {
      const label = clock12h ? `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'a.m.' : 'p.m.'}` : `${pad2(h)}:00`;
      return `<button class="btn btn-choice" data-action="hour" data-hour="${h}">${esc(label)}</button>`;
    }).join('')}</div>`;
    handlers.hour = el => { st.hour = Number(el.dataset.hour); go('minute'); };
  }

  if (st.step === 'minute') {
    const times = [0, 15, 30, 45].map(m => `${pad2(st.hour)}:${pad2(m)}`);
    body = `<div class="choices choices-minute">${times.map(t => `<button class="btn btn-choice" data-action="minute" data-time="${t}">${esc(formatTime(t, clock12h))}</button>`).join('')}</div>`;
    handlers.minute = el => { st.time = el.dataset.time; go('confirm'); };
  }

  if (st.step === 'confirm') {
    const d = dateFromKey(st.dayKey);
    const what = st.type === 'other' ? (st.title || typeInfo('other').title) : typeInfo(st.type).label;
    body = `<div class="confirm-box">
        <p class="confirm-what">${esc(what)}</p>
        <p class="confirm-when">${esc(weekdayName(d, cfg.locale))}, ${esc(formatDate(d, cfg.locale, false))}</p>
        <p class="confirm-when">at ${esc(formatTime(st.time, clock12h))}</p>
      </div>
      <div class="confirm-buttons">
        <button class="btn btn-primary btn-big" data-action="yes">Yes, add it</button>
        <button class="btn btn-secondary" data-action="again">Start again</button>
      </div>`;
    handlers.yes = async el => {
      if (st.saving) return;
      st.saving = true;
      el.disabled = true;
      el.textContent = 'Adding it now';
      const result = await ctl.save({ type: st.type, title: st.type === 'other' ? st.title : '', date: st.dayKey, time: st.time });
      st.step = 'done';
      st.result = result;
      st.saving = false;
      ctl.redraw();
      ctl.say(result === 'added' ? 'add.done' : 'add.waiting');
    };
    handlers.again = () => { startAdd(); ctl.redraw(); ctl.say('add.kind'); };
  }

  if (st.step === 'done') {
    const said = st.result === 'added'
      ? 'Thank you. It’s on the calendar now.'
      : 'Thank you. It’s saved, and it will go on the calendar as soon as the internet is back.';
    root.innerHTML = `
    <section class="screen add add-done" data-screen="add" data-step="done">
      <h1 class="add-q">${esc(said)}</h1>
      <button class="btn btn-primary btn-big" data-action="cancel">Back to today</button>
    </section>`;
    wire(root, handlers);
    return;
  }

  if (st.step !== 'kind') nav += '<button class="btn btn-secondary" data-action="back">Back</button>';
  else nav += '<span></span>';
  nav += '<button class="btn btn-secondary" data-action="cancel">Cancel</button>';

  root.innerHTML = `
  <section class="screen add" data-screen="add" data-step="${st.step}">
    <p class="add-kicker">Add an appointment</p>
    <h1 class="add-q">${esc(PROMPT[st.step][0])}</h1>
    <div class="add-body">${body}</div>
    <div class="add-nav">${nav}</div>
  </section>`;
  wire(root, handlers);
  if (st.step === 'what') {
    const input = root.querySelector('.what-input');
    input.addEventListener('keydown', e => { if (e.key === 'Enter') handlers.next(); });
    setTimeout(() => input.focus(), 50);
  }
}
