// DAYBOOK 0.3.0 — start-up, the clock tick, and the reminders.
//
// The app opens on TODAY and speaks the start of the day. A tick every few
// seconds keeps the screen current and fires reminders: the medicine (with its
// own gentle rule), lunch, supper, the dishes, and each appointment (30 minutes
// before and at the start). A reminder = a soft chime, the spoken line, a big
// card, and a notification if allowed.
//
// 0.2.0, the family side: once his script is connected, the app checks in
// (start, a heartbeat every 15 minutes, the medicine, meals and dishes, the week,
// added appointments, "I'd like a call", how she is feeling), and picks up the
// family page's settings and message for today on each check-in. After the
// start-of-day words it may ask, once a day, "How are you feeling today?".
//
// 0.3.0, updating itself: on her PC the keeper (pc/keeper.js) runs the server and
// keeps Daybook up to date. Every 15 seconds the page tells it "I am running, version
// X" (that is how a new version proves it started); when the keeper serves another
// version, the page reloads itself quietly while she is not using it (local.js). The
// family page's "update" request arrives with a check-in and is passed on; the result
// of an update (or a rollback), and a fresh install, go back as check-ins.

import * as clock from './clock.js';
import * as store from './store.js';
import { loadConfig, saveConfig } from './config.js';
import { initVoice, speak, speakAll, chime, hush, unlockAudio, spokenLog, listLocalVoices } from './voice.js';
import { initCalendar, syncCalendar, allEvents, addAppointment, calendarStatus, usingSample } from './calendar.js';
import { introSequence, daySchedule, dueReminders, medicineDecision, pickByDay, MIN } from './day.js';
import { initCards, showCard, closeCard, expireCards, currentCard } from './screens/card.js';
import { renderToday, todaySignature } from './screens/today.js';
import { renderWeek } from './screens/week.js';
import { renderAdd, startAdd } from './screens/add.js';
import { renderSettings } from './screens/settings.js';
import * as local from './local.js';
import {
  VERSION, initCheckins, record, push, queue as checkinQueue, connected as checkinsConnected,
  checkinStatus, withRemote, todaysMessage, messageLine,
} from './checkins.js';

const TICK_MS = 5000;
const IDLE_BACK_TO_TODAY = 3 * MIN;    // the week and add screens return to today when left alone

const app = {
  cfg: null, baseCfg: null, lines: null, view: 'today', lastSig: '', lastKey: '',
  introDone: false, lastSync: 0, lastInput: 0, remoteSig: '', callSending: false, reloadWaiting: false,
};

const wait = ms => new Promise(r => setTimeout(r, ms));

// --- records on this device -------------------------------------------------------------

function medLog() { return store.get('medlog', {}); }
function saveMed(key, rec) {
  const log = medLog();
  log[key] = rec;
  store.set('medlog', store.pruneDays(log, 90));
}
function firedToday(key) { return store.get('fired', {})[key] || []; }
function markFired(key, ids) {
  const f = store.get('fired', {});
  f[key] = [...new Set([...(f[key] || []), ...ids])];
  store.set('fired', store.pruneDays(f, 3));
}

function snapshot() {
  const nowMs = clock.nowMs();
  const key = clock.dayKey(new Date(nowMs));
  const log = medLog();
  return {
    cfg: app.cfg, baseCfg: app.baseCfg, lines: app.lines, nowMs, key, events: allEvents(), medRec: log[key] || null, medLog: log,
    sample: usingSample(), message: todaysMessage(store.get('remote', null), key), canCall: checkinsConnected(),
  };
}

// --- check-ins (0.2.0) ----------------------------------------------------------------------

/** What the family page shows as the app's health. */
function appStatus() {
  const cal = calendarStatus();
  return {
    version: VERSION,
    queued: (cal.outbox || []).length + checkinQueue().length,
    lastSync: cal.lastOk || null,
    medicineTime: (app.cfg.medicine && app.cfg.medicine.time) || '',
    update: local.updateSummary(local.lastStatus()),
  };
}

/** Sends waiting check-ins (and the heartbeat when due); takes in the family page's settings. */
async function pushCheckins(force = false, beat = false) {
  const r = await push({ force, beat });
  if (r && r.ok) {
    applyRemote();
    passOnUpdateRequest(r.remote.updateRequest);
    if (r.more) setTimeout(() => { pushCheckins(true).catch(() => {}); }, 300);
  }
  return r;
}

function pushSoon() { pushCheckins(true).catch(() => {}); }

/** The family page asked her app to update: pass it on to the keeper, once per request. */
function passOnUpdateRequest(id) {
  if (!id || store.get('updateRequestDone') === id) return;
  store.set('updateRequestDone', id);
  local.requestUpdate('family', String(id)).catch(() => {});
}

// --- the keeper on this PC (0.3.0) -------------------------------------------------------------

/** "I am running" to the keeper, and what its answer asks of the page. */
async function keeperTick(force = false) {
  const ck = checkinStatus();
  const st = await local.alive({ version: VERSION, booted: true, waiting: app.reloadWaiting, checkins: { lastOk: ck.lastOk || 0, queued: ck.queued, connected: ck.connected } }, { force });
  if (!st || !st.updater) return;
  const upd = st.updater;
  if (local.otherVersionServed(VERSION, st)) {
    app.reloadWaiting = true;
    const idleMs = clock.nowMs() - app.lastInput;
    if (local.readyToReload({ view: app.view, card: !!currentCard(), idleMs })) { local.quietReload(); return; }
  }
  if (!checkinsConnected()) return;              // nothing to tell the family yet: keep it for later
  const rep = local.updateReport(upd, store.get('updateReported'));
  if (rep) { record('update', rep.data); store.set('updateReported', rep.id); pushSoon(); }
  if (upd.install && upd.install.id && store.get('installSeen') !== upd.install.id) {
    record('install', { version: String(upd.install.version || VERSION) });
    store.set('installSeen', upd.install.id);
    local.ack({ install: upd.install.id });
    pushSoon();
  }
}

/** Waits (up to 10 s) for one check-in to reach the script: 'sent' or 'queued'. */
async function sendNow(id) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const r = await pushCheckins(true);
    if (r && r.ok && r.sent.includes(id)) return 'sent';
    if (r && !r.ok) return 'queued';
    if (!checkinQueue().some(c => c.id === id)) return 'sent';
    await wait(300);
  }
  return 'queued';
}

/** When the family page's settings or message changed: the settings in use change at once. */
function applyRemote() {
  const remote = store.get('remote', null);
  const sig = JSON.stringify(remote ? [remote.settings, remote.message] : null);
  if (sig === app.remoteSig) return;
  app.remoteSig = sig;
  applyConfig(app.baseCfg);
  if (app.view === 'today') render();
  if (app.introDone) maybeSpeakMessage();     // a new message during the day (before that, afterIntro says it)
}

// --- screens -------------------------------------------------------------------------------

function render() {
  const root = document.getElementById('view');
  const s = snapshot();
  if (app.view === 'today') {
    renderToday(root, s, todayActions);
    app.lastSig = todaySignature(s);
    bindHold(root);
  } else if (app.view === 'week') renderWeek(root, s, weekActions);
  else if (app.view === 'add') renderAdd(root, s, addCtl);
  else if (app.view === 'settings') renderSettings(root, { ...s, cfg: app.baseCfg, effectiveCfg: app.cfg }, settingsCtl);
  document.body.dataset.view = app.view;
}

function go(view) {
  app.view = view;
  app.lastInput = clock.nowMs();
  render();
  const root = document.getElementById('view');
  if (root) root.scrollTop = 0;
}

const todayActions = {
  week: () => { go('week'); speak('week.intro'); record('week'); pushSoon(); },
  took: () => takeMedicine(),
  call: () => askCall(),
};

const weekActions = {
  today: () => go('today'),
  add: () => { startAdd(); go('add'); speak('add.kind'); },
};

const addCtl = {
  redraw: () => render(),
  say: id => { if (id) { hush(); speak(id); } },
  leave: () => go('today'),
  save: async ev => {
    let result;
    try { result = await addAppointment(ev); }
    catch (e) { console.error('[daybook] add failed', e); result = 'queued'; }
    record('added', { kind: ev.type, date: ev.date, time: ev.time });
    pushSoon();
    return result;
  },
};

const settingsCtl = {
  leave: () => go('today'),
  redraw: () => render(),
  voices: () => listLocalVoices(),
  calendarStatus: () => calendarStatus(),
  checkinStatus: () => checkinStatus(),
  test: () => { chime(); speak('test.voice'); },
  askNotifications: async () => {
    try { if (typeof Notification !== 'undefined') await Notification.requestPermission(); } catch { /* none */ }
  },
  sync: async () => { await syncCalendar(); await pushCheckins(true, true); },
  updateStatus: () => local.lastStatus(),
  updateNow: async () => { const r = await local.requestUpdate('button'); await keeperTick(true); return r; },
  updateRefresh: () => keeperTick(true),
  save: async next => {
    const where = await saveConfig(next);
    applyConfig(next);
    await syncCalendar();
    pushSoon();
    return where;
  },
};

/** base = her own settings (config files); the family page's times go on top. */
function applyConfig(base) {
  app.baseCfg = base;
  app.cfg = withRemote(base, store.get('remote', null));
  app.lines = initVoice(app.lines, app.cfg);
  initCalendar(app.cfg);
  initCheckins(app.cfg, { appStatus });
}

/** Hold the top-left corner of TODAY for a few seconds to open the settings. */
function bindHold(root) {
  const el = root.querySelector('[data-hold]');
  if (!el) return;
  let t = null;
  const start = ev => {
    ev.preventDefault();
    clearTimeout(t);
    t = setTimeout(() => { t = null; go('settings'); }, (Number(app.cfg.settingsHoldSeconds) || 3) * 1000);
  };
  const stop = () => { clearTimeout(t); t = null; };
  el.addEventListener('pointerdown', start);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(n => el.addEventListener(n, stop));
  el.addEventListener('contextmenu', e => e.preventDefault());
}

// --- reminders --------------------------------------------------------------------------------

function notify(title, body, tag) {
  if (!app.cfg.notifications) return;
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const opts = { body, tag, silent: true, icon: 'icons/icon-192.png' };
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then(reg => reg.showNotification(title, opts)).catch(() => {});
    } else {
      new Notification(title, opts);
    }
  } catch { /* fine: the card and the voice still happen */ }
}

function sayIntro(s) {
  store.set('introKey', s.key);
  store.set('introAt', s.nowMs);
  // On a day with a family message, it takes the thought's place (and is not said again after).
  const note = s.message ? { lineId: messageLine(s.message, app.lines) } : null;
  if (note) store.set('messageSaid', `${s.key}|${s.message}`);
  return speakAll(introSequence(s.key, s.nowMs, s.cfg, s.events, s.medRec, app.lines, note));
}

function offerMedicine(lineId, s) {
  const rec = Object.assign({ offers: 0 }, s.medRec || {});
  rec.time = s.cfg.medicine.time;
  rec.offers += 1;
  rec.lastOfferAt = s.nowMs;
  saveMed(s.key, rec);
  const later = lineId === 'med.later';
  showCard({
    id: 'medicine',
    tone: 'medicine',
    title: later ? 'Your medicine' : 'Time for your medicine',
    body: later ? 'Have you had it today? Tap the button when you have.' : 'Tap the button when you have taken it.',
    buttons: [
      { label: 'I took it', primary: true, onTap: () => takeMedicine() },
      { label: 'Back to my day', onTap: () => closeCard('medicine') },
    ],
  });
  chime();
  speak(lineId);
  notify(later ? 'Your medicine' : 'Time for your medicine', 'Tap "I took it" when you have.', 'medicine');
}

function takeMedicine() {
  const s = snapshot();
  const rec = Object.assign({ offers: 0 }, s.medRec || {});
  if (rec.takenAt) { closeCard('medicine'); return; }
  rec.time = s.cfg.medicine.time;
  rec.takenAt = s.nowMs;
  saveMed(s.key, rec);
  record('medicine', { takenAt: s.nowMs });
  pushSoon();
  hush();
  const thanks = pickByDay(app.lines.ids('med.thanks.'), s.key);
  showCard({
    id: 'medicine',
    tone: 'thanks',
    title: 'Thank you!',
    body: app.lines.text(thanks),
    until: s.nowMs + 12000,
    buttons: [{ label: 'OK', primary: true, onTap: () => closeCard('medicine') }],
  });
  speak(thanks);
  if (app.view === 'today') render();
}

const NUDGE_TITLE = { lunch: 'Lunchtime', supper: 'Suppertime', dishes: 'The dishes' };

function fireNudge(e, s) {
  const lineId = pickByDay(app.lines.ids(`${e.nudge}.`), s.key);
  const title = NUDGE_TITLE[e.nudge];
  // The card's title already says "Lunchtime", so its text starts at the idea.
  const body = app.lines.text(lineId).replace(/^It's (lunch|supper)time\.\s*/, '');
  showCard({
    id: e.id,
    tone: 'nudge',
    title,
    body,
    until: e.until,
    buttons: [
      { label: 'Done', primary: true, onTap: () => praise(e) },
      { label: 'Later', onTap: () => closeCard(e.id) },
    ],
  });
  chime();
  speak(lineId);
  notify(title, body, e.id);
}

function praise(e) {
  const s = snapshot();
  const lineId = pickByDay(app.lines.ids(e.nudge === 'dishes' ? 'praise.dishes.' : 'praise.meal.'), s.key);
  showCard({
    id: e.id,
    tone: 'thanks',
    title: 'Well done!',
    body: app.lines.text(lineId),
    until: s.nowMs + 10000,
    buttons: [{ label: 'OK', primary: true, onTap: () => closeCard(e.id) }],
  });
  hush();
  speak(lineId);
  record('nudge', { nudge: e.nudge });
  pushSoon();
}

function fireEvent(e) {
  const ev = e.event;
  const clock12h = app.cfg.clock12h !== false;
  const soon = e.kind === 'soon';
  const kicker = soon ? 'Coming up soon' : 'It’s time';
  const time = clock.formatTime(ev.time, clock12h);
  showCard({
    id: e.id,
    tone: 'event',
    kicker,
    title: ev.title,
    time,
    until: e.until,
    buttons: [{ label: 'OK', primary: true, onTap: () => closeCard(e.id) }],
  });
  chime();
  speak(`${e.kind}.${ev.type}`, soon ? { time: clock.timeBankId(ev.time) } : {});
  notify(`${kicker}: ${ev.title}`, time, e.id);
}

function checkReminders(s) {
  const dec = medicineDecision(s.key, s.nowMs, s.cfg, s.medRec);
  if (dec) offerMedicine(dec, s);
  const { fire, mark } = dueReminders(s.nowMs, daySchedule(s.key, s.cfg, s.events), firedToday(s.key));
  if (mark.length) markFired(s.key, mark);
  for (const e of fire) {
    if (e.kind === 'greeting') { if (store.get('introKey') !== s.key) sayIntro(s).then(afterIntro); }
    else if (e.kind === 'nudge') fireNudge(e, s);
    else fireEvent(e);
  }
}

// --- after the start of the day: the family's message, then "How are you feeling?" -------------

/** Speaks today's family message once, if it is one of the recorded message lines. */
function maybeSpeakMessage() {
  const s = snapshot();
  if (!s.message) return null;
  const said = `${s.key}|${s.message}`;
  if (store.get('messageSaid') === said) return null;
  store.set('messageSaid', said);
  const id = messageLine(s.message, app.lines);
  return id ? speak(id) : null;          // any other message is shown, not spoken
}

async function afterIntro() {
  const said = maybeSpeakMessage();
  if (said) await Promise.race([said, wait(15000)]);
  askMood();
}

const MOODS = [
  { v: 'good', label: 'Good', title: 'Lovely!' },
  { v: 'okay', label: 'Okay', title: 'Thank you' },
  { v: 'notgood', label: 'Not so good', title: 'Thank you for telling me' },
];

/** Once a day, never at night, never forced: three big answers and "Not now". */
function askMood() {
  const s = snapshot();
  if (s.cfg.mood && s.cfg.mood.ask === false) return;
  if (clock.partOfDay(new Date(s.nowMs), s.cfg.partsOfDay) === 'night') return;
  if (store.get('moodAsked') === s.key) return;
  store.set('moodAsked', s.key);
  showCard({
    id: 'mood',
    tone: 'plain',
    title: 'How are you feeling today?',
    choices: MOODS.map(m => ({ label: m.label, onTap: () => answerMood(m) })),
    buttons: [{ label: 'Not now', onTap: () => closeCard('mood') }],
    until: s.nowMs + 15 * MIN,
  });
  speak('mood.ask');
}

function answerMood(m) {
  const s = snapshot();
  record('mood', { mood: m.v });
  pushSoon();
  const lineId = `mood.reply.${m.v}`;
  showCard({
    id: 'mood',
    tone: m.v === 'notgood' ? 'plain' : 'thanks',
    title: m.title,
    body: app.lines.text(lineId),
    until: s.nowMs + 15000,
    buttons: [{ label: 'OK', primary: true, onTap: () => closeCard('mood') }],
  });
  hush();
  speak(lineId);
}

// --- "I'd like a call" -------------------------------------------------------------------------

function askCall() {
  if (!checkinsConnected()) return;
  showCard({
    id: 'call',
    tone: 'plain',
    title: 'Would you like a call?',
    body: 'Tap “Yes, please” and your family will get a message.',
    buttons: [
      { label: 'Yes, please', primary: true, onTap: () => sendCall() },
      { label: 'No, thank you', onTap: () => closeCard('call') },
    ],
    until: clock.nowMs() + 3 * MIN,
  });
  hush();
  speak('call.ask');
}

async function sendCall() {
  if (app.callSending) return;
  app.callSending = true;
  showCard({ id: 'call', tone: 'plain', title: 'Sending your message…', buttons: [] });
  const id = record('call');
  const result = id ? await sendNow(id) : 'queued';
  app.callSending = false;
  const sent = result === 'sent';
  showCard({
    id: 'call',
    tone: 'thanks',
    title: 'Thank you',
    body: sent ? 'Your family knows you’d like a call.' : 'Your message is saved. It will go to your family as soon as the internet is back.',
    until: clock.nowMs() + 15000,
    buttons: [{ label: 'OK', primary: true, onTap: () => closeCard('call') }],
  });
  hush();
  speak(sent ? 'call.sent' : 'call.waiting');
}

// --- the tick -------------------------------------------------------------------------------

async function refreshCalendar() {
  app.lastSync = clock.nowMs();
  const r = await syncCalendar();
  if (r.ok && (app.view === 'today' || app.view === 'week')) {
    if (app.view === 'week') render();
    else if (todaySignature(snapshot()) !== app.lastSig) render();
  }
}

function tick() {
  const s = snapshot();
  expireCards();
  if (s.key !== app.lastKey) {
    app.lastKey = s.key;
    if (app.view !== 'settings') go('today');
    refreshCalendar();
  }
  if ((app.view === 'week' || app.view === 'add') && !currentCard() && s.nowMs - app.lastInput > IDLE_BACK_TO_TODAY) go('today');
  if (app.view === 'today' && todaySignature(s) !== app.lastSig) render();
  if (app.introDone) checkReminders(snapshot());
  const every = (Number(app.cfg.calendar && app.cfg.calendar.refreshMinutes) || 15) * MIN;
  if (s.nowMs - app.lastSync >= every) refreshCalendar();
  pushCheckins(false).catch(() => {});          // the heartbeat, and anything still waiting
  keeperTick().catch(() => {});                  // "I am running" (every 15 s), and the keeper's news
}

// --- start-up ---------------------------------------------------------------------------------

async function boot() {
  const q = new URLSearchParams(location.search);
  if (q.get('fakeNow')) clock.setFakeNow(q.get('fakeNow'));

  const quiet = local.takeQuiet();               // a reload after an update: no start-of-day words
  const { cfg } = await loadConfig();
  const r = await fetch('lines/lines.json', { cache: 'no-store' });
  if (!r.ok) throw new Error('lines.json missing');
  app.lines = initVoice(await r.json(), cfg);
  const remote = store.get('remote', null);
  app.remoteSig = JSON.stringify(remote ? [remote.settings, remote.message] : null);
  applyConfig(cfg);
  initCards(document.getElementById('overlay'));

  document.addEventListener('pointerdown', () => { unlockAudio(); app.lastInput = clock.nowMs(); }, { capture: true });
  app.lastKey = clock.dayKey();
  app.lastInput = clock.nowMs();
  render();
  window.daybookBooted = true;                   // watch.js: the app started

  if (!quiet) record('start');
  keeperTick(true).catch(() => {});
  await Promise.race([Promise.all([syncCalendar(), pushCheckins(true)]), wait(6000)]);
  app.lastSync = clock.nowMs();
  render();

  if ('serviceWorker' in navigator && window.isSecureContext && q.get('nosw') !== '1') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  setInterval(tick, TICK_MS);
  window.daybook = { app, spokenLog, snapshot, tick, clock, store, go, checkinStatus, pushCheckins, local, keeperTick, quiet };   // for tests and a curious Evrtek

  // The start of the day: the day, a thought, and today's list. Not again within half an hour.
  const s = snapshot();
  const recent = store.get('introKey') === s.key && s.nowMs - (store.get('introAt') || 0) < 30 * MIN;
  if (!recent && !quiet) await Promise.race([sayIntro(s), wait(90000)]);
  app.introDone = true;
  tick();
  afterIntro();
}

boot().catch(err => {
  console.error('[daybook] start-up failed', err);
  const root = document.getElementById('view');
  if (root) root.innerHTML = '<section class="screen starting"><p>Just a moment…</p></section>';
  setTimeout(() => location.reload(), 15000);
});
