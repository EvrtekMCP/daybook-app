// DAYBOOK — SETTINGS, for Evrtek. Reached only by holding the top-left corner of
// the today screen for a few seconds. Saves to config.local.json on this device.
// The form edits her own settings (s.cfg); times set on the family page win over
// them while they are set there, and the screen says which.

import { esc, wire } from '../util.js';
import { addDays, dateFromKey, formatDate, formatTime, isFake, now } from '../clock.js';
import { VERSION, remoteOverrides, leadText, LEAD_CHOICES } from '../checkins.js';
import { updateLine } from '../local.js';
import { getReadyMinutes } from '../day.js';

/** "Thursday 3:00 a.m." for the update lines (time only when timeOnly). */
function when(ms, cfg, timeOnly = false) {
  if (!ms) return 'not yet';
  const d = new Date(ms);
  const t = formatTime(d, cfg.clock12h !== false);
  return timeOnly ? t : `${d.toLocaleDateString(cfg.locale || 'en-CA', { weekday: 'long' })} ${t}`;
}

function get(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function put(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) { if (typeof o[k] !== 'object' || o[k] == null) o[k] = {}; o = o[k]; }
  o[keys[keys.length - 1]] = value;
}

function field(cfg, path, label, type, extra = '') {
  const v = get(cfg, path);
  if (type === 'checkbox') {
    return `<label class="set-row set-check"><input type="checkbox" data-path="${path}" data-type="bool" ${v ? 'checked' : ''} ${extra}> <span>${esc(label)}</span></label>`;
  }
  const dt = type === 'number' ? 'num' : 'text';
  return `<label class="set-row"><span>${esc(label)}</span><input type="${type}" data-path="${path}" data-type="${dt}" value="${esc(v == null ? '' : v)}" ${extra}></label>`;
}

/** A drop-down of numbers (saved as a number). options: [[value, label], ...] */
function choice(cfg, path, label, options, current) {
  const v = current === undefined ? get(cfg, path) : current;
  const opts = options.map(([val, text]) => `<option value="${val}" ${Number(val) === Number(v) ? 'selected' : ''}>${esc(text)}</option>`).join('');
  return `<label class="set-row"><span>${esc(label)}</span><select data-path="${path}" data-type="num">${opts}</select></label>`;
}

function medRecord(s) {
  const rows = [];
  for (let i = 0; i < 14; i++) {
    const k = addDays(s.key, -i);
    const r = s.medLog[k];
    let text = 'No record (the app was not open, or no reminder yet)';
    if (r && r.takenAt) text = `Tapped "I took it" at ${formatTime(new Date(r.takenAt), s.cfg.clock12h !== false)}`;
    else if (r && r.offers) text = i === 0 ? `Offered ${r.offers} time${r.offers > 1 ? 's' : ''}, not tapped yet` : `Offered ${r.offers} time${r.offers > 1 ? 's' : ''}, not tapped`;
    rows.push(`<tr><td>${esc(formatDate(dateFromKey(k), s.cfg.locale))}</td><td>${esc(text)}</td></tr>`);
  }
  return rows.join('');
}

export function renderSettings(root, s, ctl) {
  const cfg = s.cfg;
  const voices = ctl.voices();
  const cal = ctl.calendarStatus();
  const perm = typeof Notification === 'undefined' ? 'not available here' : Notification.permission;
  const voiceOptions = ['<option value="">Automatic (an installed English voice)</option>']
    .concat(voices.map(v => `<option value="${esc(v.name)}" ${v.name === get(cfg, 'voice.voiceName') ? 'selected' : ''}>${esc(v.name)} (${esc(v.lang)})</option>`)).join('');
  const prov = get(cfg, 'calendar.provider');
  const ck = ctl.checkinStatus();
  const overrides = remoteOverrides(ck.remote);
  const familyNote = overrides.length
    ? `<p class="set-warn">Set on the family page, and used instead of the settings below: ${esc(overrides.map(([n, t, kind]) => (kind === 'lead' ? `${n}: ${leadText(t)}` : `${n} ${formatTime(t, cfg.clock12h !== false)}`)).join(', '))}.</p>`
    : '';

  root.innerHTML = `
  <section class="screen settings" data-screen="settings">
    <div class="set-top">
      <h1>Daybook settings</h1>
      <div class="set-top-buttons">
        <button class="btn btn-primary" data-action="save">Save</button>
        <button class="btn btn-secondary" data-action="close">Close without saving</button>
      </div>
    </div>
    ${isFake() ? `<p class="set-warn">Pretend clock is on (?fakeNow in the address): the app thinks it is ${esc(formatDate(now(), cfg.locale))}, ${esc(formatTime(now(), cfg.clock12h !== false))}.</p>` : ''}
    <p class="set-note">These settings stay on this device only (config.local.json). Clear a time to turn that reminder off.</p>
    ${familyNote}

    <fieldset><legend>Her</legend>
      ${field(cfg, 'name', 'Name (shown and spoken in the greeting)', 'text', 'maxlength="40"')}
      ${field(cfg, 'clock12h', 'Show times as 12-hour (9:00 a.m.)', 'checkbox')}
      ${field(cfg, 'greetingTime', 'Morning greeting (says the day, if the app was already open)', 'time')}
      ${field(cfg, 'mood.ask', 'After the greeting, ask "How are you feeling today?" (once a day, never at night)', 'checkbox')}
    </fieldset>

    <fieldset><legend>Medicine</legend>
      ${field(cfg, 'medicine.time', 'Reminder time', 'time')}
      ${field(cfg, 'medicine.repeatMinutes', 'Gentle repeat every (minutes, 0 = never)', 'number', 'min="0" max="240"')}
      ${field(cfg, 'medicine.repeatTimes', 'Repeat at most (times)', 'number', 'min="0" max="10"')}
      ${field(cfg, 'medicine.lastOffer', 'Stop offering it after', 'time')}
    </fieldset>

    <fieldset><legend>Meals and dishes</legend>
      ${field(cfg, 'nudges.lunch', 'Lunch', 'time')}
      ${field(cfg, 'nudges.supper', 'Supper', 'time')}
      ${field(cfg, 'nudges.dishes', 'Dishes', 'time')}
      ${field(cfg, 'nudges.showMinutes', 'Card stays up for (minutes)', 'number', 'min="5" max="240"')}
    </fieldset>

    <fieldset><legend>Appointments</legend>
      ${choice(cfg, 'events.getReadyMinutes', 'Time to get ready: a reminder this long before each appointment (never in the night)', LEAD_CHOICES.map(m => [m, leadText(m)]), getReadyMinutes(cfg))}
      ${field(cfg, 'events.soonMinutes', 'Remind this many minutes before', 'number', 'min="5" max="180"')}
      ${field(cfg, 'events.showMinutes', 'Card stays up after the start for (minutes)', 'number', 'min="5" max="240"')}
    </fieldset>

    <fieldset><legend>Parts of the day (when each starts)</legend>
      ${field(cfg, 'partsOfDay.morning', 'Morning', 'time')}
      ${field(cfg, 'partsOfDay.afternoon', 'Afternoon', 'time')}
      ${field(cfg, 'partsOfDay.evening', 'Evening', 'time')}
      ${field(cfg, 'partsOfDay.night', 'Night (empty = no night)', 'time')}
    </fieldset>

    <fieldset><legend>Voice and chime</legend>
      ${field(cfg, 'voice.enabled', 'Speak the reminders', 'checkbox')}
      <label class="set-row"><span>Voice</span><select data-path="voice.mode" data-type="text">
        <option value="clips" ${get(cfg, 'voice.mode') !== 'speech' ? 'selected' : ''}>The recorded voice (Chris), at his natural pace</option>
        <option value="speech" ${get(cfg, 'voice.mode') === 'speech' ? 'selected' : ''}>The computer’s own voice</option>
      </select></label>
      <p class="set-note">A line the recorded voice does not have is said by the computer’s own voice. These two apply to the computer’s voice only:</p>
      <label class="set-row"><span>Computer voice (only voices installed on this computer)</span><select data-path="voice.voiceName" data-type="text">${voiceOptions}</select></label>
      ${field(cfg, 'voice.rate', 'Computer voice speed (0.5 slow to 1.5 fast)', 'number', 'min="0.5" max="1.5" step="0.05"')}
      ${field(cfg, 'voice.volume', 'Voice volume (0 to 1)', 'number', 'min="0" max="1" step="0.1"')}
      ${field(cfg, 'chime.enabled', 'Play the chime', 'checkbox')}
      ${field(cfg, 'chime.volume', 'Chime volume (0 to 1)', 'number', 'min="0" max="1" step="0.1"')}
      <div class="set-buttons"><button class="btn btn-secondary" data-action="test">Test the chime and voice</button></div>
      ${field(cfg, 'notifications', 'Also show a Windows / iPad notification', 'checkbox')}
      <div class="set-buttons"><button class="btn btn-secondary" data-action="perm">Allow notifications</button> <span class="set-note">Now: ${esc(perm)}</span></div>
    </fieldset>

    <fieldset><legend>The character</legend>
      ${field(cfg, 'character.enabled', 'Show the character on the today screen (Evrtek\u2019s portrait: breathes, blinks, smiles, and listens)', 'checkbox')}
      <p class="set-note">Off: the today screen goes back to the plain sun picture. Nothing else changes.</p>
    </fieldset>

    <fieldset><legend>Calendar</legend>
      <label class="set-row"><span>Calendar</span><select data-path="calendar.provider" data-type="text">
        <option value="none" ${prov === 'none' ? 'selected' : ''}>No calendar yet (shows nothing)</option>
        <option value="mock" ${prov !== 'appsscript' && prov !== 'none' ? 'selected' : ''}>Sample calendar (for testing: invented appointments)</option>
        <option value="appsscript" ${prov === 'appsscript' ? 'selected' : ''}>My Google Calendar (Apps Script)</option>
      </select></label>
      ${field(cfg, 'calendar.url', 'Apps Script web app URL (ends in /exec)', 'url', 'spellcheck="false"')}
      ${field(cfg, 'calendar.key', 'Secret key (the DAYBOOK_KEY you set in the script)', 'password', 'spellcheck="false" autocomplete="off"')}
      ${field(cfg, 'calendar.refreshMinutes', 'Check the calendar every (minutes)', 'number', 'min="5" max="240"')}
      <div class="set-buttons"><button class="btn btn-secondary" data-action="sync">Check the calendar now</button></div>
      <p class="set-note" data-cal-status>${esc(calendarLine(cal))}</p>
      <p class="set-note" data-checkin-status>${esc(checkinLine(ck))}</p>
    </fieldset>

    <fieldset><legend>Updates</legend>
      <p class="set-note" data-update-status>${esc(updateLine(ctl.updateStatus(), (ms, t) => when(ms, cfg, t)))}</p>
      <div class="set-buttons"><button class="btn btn-secondary" data-action="update">Update now</button></div>
    </fieldset>

    <fieldset><legend>Medicine record (this device)</legend>
      <table class="med-table">${medRecord(s)}</table>
    </fieldset>

    <p class="set-note">DAYBOOK ${VERSION} · REIMERTEK STUDIOS</p>
  </section>`;

  wire(root, {
    close: () => ctl.leave(),
    save: async () => {
      const next = JSON.parse(JSON.stringify(cfg));
      root.querySelectorAll('[data-path]').forEach(el => {
        let v;
        if (el.dataset.type === 'bool') v = el.checked;
        else if (el.dataset.type === 'num') v = el.value === '' ? 0 : Number(el.value);
        else v = el.value.trim();
        put(next, el.dataset.path, v);
      });
      const where = await ctl.save(next);
      ctl.leave(where === 'file' ? 'Saved.' : 'Saved in this browser (the settings file could not be written).');
    },
    test: () => ctl.test(),
    perm: async () => { await ctl.askNotifications(); ctl.redraw(); },
    update: async () => {
      const line = root.querySelector('[data-update-status]');
      line.textContent = 'Looking for a new version…';
      const r = await ctl.updateNow();
      if (r && r.ok === false && r.error) line.textContent = r.error === 'no updater here' ? updateLine(null) : `Could not ask: ${r.error}`;
      else if (r && r.busy) line.textContent = 'An update is already under way.';
      else {
        // Show how it goes for a minute (the new version restarts the screen by itself).
        for (let i = 0; i < 20 && root.isConnected; i++) {
          await new Promise(res => setTimeout(res, 3000));
          await ctl.updateRefresh();
          line.textContent = updateLine(ctl.updateStatus(), (ms, t) => when(ms, cfg, t));
          const st = ctl.updateStatus();
          if (st && st.updater && st.updater.phase === 'idle' && !st.updater.busy) break;
        }
      }
    },
    sync: async () => {
      const line = root.querySelector('[data-cal-status]');
      line.textContent = 'Checking...';
      await ctl.sync();
      line.textContent = calendarLine(ctl.calendarStatus());
      root.querySelector('[data-checkin-status]').textContent = checkinLine(ctl.checkinStatus());
    },
  });
}

function checkinLine(ck) {
  if (!ck.connected) return 'Check-ins to the family: off until the Google script is connected above.';
  const parts = ['Check-ins to the family: on.'];
  parts.push(ck.lastOk ? `Last sent ${new Date(ck.lastOk).toLocaleString()}.` : 'Nothing sent yet.');
  if (ck.queued) parts.push(`${ck.queued} waiting to be sent.`);
  if (ck.lastError) parts.push(`Last problem: ${ck.lastError}`);
  return parts.join(' ');
}

function calendarLine(cal) {
  const parts = [];
  if (cal.cache) parts.push(`Last copy: ${cal.cache.events.length} events from the ${cal.cache.provider === 'mock' ? 'sample' : 'Google'} calendar, fetched ${new Date(cal.cache.fetchedAt).toLocaleString()}.`);
  else parts.push('No calendar copy yet.');
  if (cal.outbox && cal.outbox.length) parts.push(`${cal.outbox.length} added appointment(s) waiting to be sent.`);
  if (cal.lastError) parts.push(`Last problem: ${cal.lastError}`);
  return parts.join(' ');
}
