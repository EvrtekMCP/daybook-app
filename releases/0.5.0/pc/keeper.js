#!/usr/bin/env node
// DAYBOOK — the keeper (0.3.0). On her PC, boot.js runs this, from the version folder
// that state.json names (versions/<version>/pc/keeper.js). It:
//   - runs the Daybook server on 127.0.0.1 (server.js beside it), with her settings
//     from the install folder (config.local.json, never touched here)
//   - opens the Daybook window in Edge when she signs in (boot says so with --open): a
//     normal window, maximized, that she can minimize and resize (0.5.0); kiosk only if
//     window.kiosk is set; and brings it forward for a medicine or appointment reminder
//     while it is minimized (POST /api/front, at most once a minute)
//   - checks for a new release every night (03:00 by default), on "Update now" in her
//     hidden settings, and when the family page asks (her page passes that on)
//   - on a new release: downloads it to staging/, checks every file's fingerprint,
//     moves it into versions/, switches state.json to it with a trial, and exits 75 so
//     boot.js starts the new version
//   - as the new version: checks itself, then waits for the page to say "I am running,
//     version X"; if that does not come before the deadline, switches back (rollback)
//     and exits 75 again, so the old version is running, and says so on its next
//     check-in. Offline, or any error: nothing changes, and it tries again next night.
//
// Arguments: --root <install folder> [--open]
// For the tests: DAYBOOK_PORT, DAYBOOK_NO_WINDOW=1 (never opens Edge or touches a window; writes
// run/window.json, and run/front.json for each "bring it forward"),
// DAYBOOK_SCHED_MS (how often it looks at the clock).

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const U = require('./lib/updater');
const edge = require('./lib/edge');

const VERSION_DIR = path.resolve(__dirname, '..');
const { start, readVersion } = require(path.join(VERSION_DIR, 'server.js'));

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }
const ROOT = path.resolve(arg('--root') || process.env.DAYBOOK_ROOT || path.join(VERSION_DIR, '..', '..'));
const OPEN = process.argv.includes('--open');
const PORT = Number(process.env.DAYBOOK_PORT || 8642);
const SCHED_MS = Number(process.env.DAYBOOK_SCHED_MS || 30000);
const MAX_WAIT_MS = 6 * 3600000;            // the longest a trial waits for a busy page to reload
const L = {
  config: path.join(ROOT, 'config.local.json'),
  logs: path.join(ROOT, 'logs'),
  run: path.join(ROOT, 'run'),
  profile: path.join(ROOT, 'EdgeProfile'),
};

let MANIFEST = null;
try { MANIFEST = JSON.parse(fs.readFileSync(path.join(VERSION_DIR, 'manifest.json'), 'utf8')); } catch { MANIFEST = null; }
const VERSION = (MANIFEST && MANIFEST.version) || readVersion(VERSION_DIR);

// --- the log (logs/keeper.log, about 1 MB, one older copy) ------------------------------------

fs.mkdirSync(L.logs, { recursive: true });
fs.mkdirSync(L.run, { recursive: true });
const LOG = path.join(L.logs, 'keeper.log');
function log(...parts) {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1024 * 1024) fs.renameSync(LOG, path.join(L.logs, 'keeper.1.log'));
    fs.appendFileSync(LOG, `${new Date().toISOString()} [${VERSION}] ${parts.join(' ')}\n`);
  } catch { /* a full disk never stops Daybook */ }
}

// --- settings (the example beside this version, her config.local.json on top) -------------------

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function settings() {
  const ex = readJson(path.join(VERSION_DIR, 'config.example.json')) || {};
  const loc = readJson(L.config) || {};
  const u = Object.assign({ enabled: true, time: '03:00', url: U.DEFAULT_RELEASES_URL, trialMinutes: 10 }, ex.updates, loc.updates);
  const w = Object.assign({ kiosk: false }, ex.window, loc.window);
  u.trialMinutes = Math.min(120, Math.max(0.2, Number(u.trialMinutes) || 10));
  if (!U.allowedUrl(u.url)) u.url = U.DEFAULT_RELEASES_URL;
  return { updates: u, window: w };
}

// --- state ------------------------------------------------------------------------------------------

let state = U.readState(ROOT);
function save() { try { U.writeState(ROOT, state); } catch (e) { log('could not write state.json:', e.message); } }

let phase = 'idle';
let busy = false;
let lastAlive = null;              // { at, version, booted, waiting } from the page
let trialTimer = null;
let trialReady = false;            // the new version passed its own check; now the page decides
let server = null;
const startedAt = Date.now();
const token = crypto.randomBytes(24).toString('hex');

function sameText(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** What the page and the settings screen are told (GET /api/status, POST /api/alive). */
function status() {
  const s = settings();
  const t = state.trial;
  return {
    running: VERSION,
    phase,
    busy,
    enabled: s.updates.enabled !== false,
    time: s.updates.time,
    nextNight: U.nextNight(Date.now(), s.updates.time),
    check: state.check,
    update: state.update,
    trial: t ? { version: t.version, from: t.from, deadline: t.deadline } : null,
    install: state.install || null,
    page: lastAlive ? { at: lastAlive.at, version: lastAlive.version, lastCheckinOk: lastAlive.lastCheckinOk, queued: lastAlive.queued, connected: lastAlive.connected } : null,
  };
}

const NO_WINDOW = process.env.DAYBOOK_NO_WINDOW === '1';
const frontHook = edge.frontHook(L.profile, { noWindow: NO_WINDOW, log: m => log(m) });

const hooks = {
  status,
  front(body) {
    const r = frontHook(body);
    if (NO_WINDOW && r.asked) { try { fs.writeFileSync(path.join(L.run, 'front.json'), JSON.stringify({ asks: frontHook.asks }, null, 2)); } catch { /* tests only */ } }
    return r;
  },
  alive(body) {
    const ck = body.checkins && typeof body.checkins === 'object' ? body.checkins : {};
    lastAlive = { at: Date.now(), version: String(body.version || '').slice(0, 20), booted: !!body.booted, waiting: !!body.waiting, lastCheckinOk: Number(ck.lastOk) || 0, queued: Number(ck.queued) || 0, connected: !!ck.connected };
    if (trialReady && pageOnNewVersion()) passTrial('the page is running the new version');
  },
  update(body) { return requestUpdate(body); },
  ack(body) {
    if (body.install && state.install && body.install === state.install.id) { state.install = null; save(); log('install check-in handed to the page'); }
  },
  stop(t) {
    if (!sameText(t, token)) return false;
    log('asked to stop (installer or uninstaller)');
    setTimeout(() => shutdown(0), 50);
    return true;
  },
};

// --- start-up ----------------------------------------------------------------------------------

async function main() {
  log(`starting from ${VERSION_DIR}${OPEN ? ' (opening the window)' : ''}`);
  fs.writeFileSync(path.join(L.run, 'token'), token);
  fs.writeFileSync(path.join(L.run, 'keeper.pid'), String(process.pid));

  // A trial for some other version than this one is stale (boot went back already).
  if (state.trial && state.trial.version !== VERSION) {
    log(`stale trial for ${state.trial.version}; this is ${VERSION}`);
    if (state.current === VERSION) { state.trial = null; save(); }
  }

  try {
    server = await start({ root: VERSION_DIR, localConfig: L.config, port: PORT, version: VERSION, hooks, quiet: true });
  } catch (e) {
    log('server did not start:', e.code || e.message);
    if (state.trial && state.trial.version === VERSION) return rollbackAndRestart(`the server did not start (${e.code || e.message})`);
    process.exit(e.code === 'EADDRINUSE' ? 3 : 1);
  }
  log(`server on http://127.0.0.1:${server.port}`);

  if (!state.trial) {
    try { const removed = U.prune(ROOT, state); if (removed.length) log(`removed old versions: ${removed.join(', ')}`); } catch (e) { log('prune:', e.message); }
  }
  if (state.trial && state.trial.version === VERSION) await runTrial();
  else if (state.update && state.update.result === 'rolledback' && state.update.page && !state.update.windowChecked && Date.now() - state.update.at < 10 * 60000) {
    watchWindowAfterRollback();
  }

  if (OPEN) openWindow();
  setTimeout(scheduler, Math.min(60000, SCHED_MS));
  setInterval(scheduler, SCHED_MS);
}

function openWindow() {
  const s = settings();
  const url = `http://127.0.0.1:${server.port}/`;
  if (process.env.DAYBOOK_NO_WINDOW === '1') {
    fs.writeFileSync(path.join(L.run, 'window.json'), JSON.stringify({ args: edge.edgeArgs({ url, profileDir: L.profile, kiosk: !!s.window.kiosk }) }, null, 2));
    log('window: not opened (DAYBOOK_NO_WINDOW)');
    return;
  }
  const edgePath = edge.findEdge();
  if (!edgePath) { log('window: Microsoft Edge not found'); return; }
  if (edge.listProfileProcesses(L.profile).length) { log('window: already open'); return; }
  edge.launchEdge({ edgePath, url, profileDir: L.profile, kiosk: !!s.window.kiosk });
  log('window: opened');
}

/** After a rollback: if the page does not come back within 3 minutes, open its window again. */
function watchWindowAfterRollback() {
  setTimeout(() => {
    state.update.windowChecked = true;
    save();
    if (lastAlive && lastAlive.at >= startedAt) return;
    log('the page did not come back after the rollback: reopening the Daybook window');
    if (process.env.DAYBOOK_NO_WINDOW === '1') { fs.writeFileSync(path.join(L.run, 'window-reopened.json'), '{}'); return; }
    try { edge.closeProfileWindows(L.profile); } catch (e) { log('closing the window:', e.message); }
    setTimeout(openWindow, 3000);
  }, Number(process.env.DAYBOOK_WINDOW_WAIT_MS || 3 * 60000));
}

// --- the trial (a new version proving itself) ---------------------------------------------------------

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: server.port, path: p, headers: { Host: `127.0.0.1:${server.port}` }, timeout: 10000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** The new version's own check: its files match, and the server serves the app. '' = fine. */
async function healthCheck() {
  if (MANIFEST) {
    const problems = await U.verifyFolder(VERSION_DIR, MANIFEST);
    if (problems.length) return `a file is not right: ${problems[0]}`;
  }
  const h = await get('/health');
  if (h.body !== 'daybook') return 'the server did not answer';
  const st = JSON.parse((await get('/api/status')).body);
  if (st.version !== VERSION) return `the server says ${st.version}`;
  for (const p of ['/', '/js/main.js', '/js/watch.js', '/css/daybook.css', '/config.example.json', '/lines/lines.json']) {
    const r = await get(p);
    if (r.status !== 200) return `${p} answered ${r.status}`;
    if (p.endsWith('.json')) JSON.parse(r.body);
  }
  return '';
}

async function runTrial() {
  const t = state.trial;
  log(`trial: ${t.from} -> ${VERSION} (${t.reason})`);
  let problem;
  try { problem = await healthCheck(); } catch (e) { problem = `health check: ${e.message}`; }
  if (problem) return rollbackAndRestart(problem);
  if (!t.pageWasAlive) return passTrial('Daybook was not open on screen; the server checks passed');
  trialReady = true;
  if (pageOnNewVersion()) return passTrial('the page is running the new version');
  trialTimer = setInterval(() => {
    const now = Date.now();
    const tt = state.trial;
    if (!tt) { clearInterval(trialTimer); return; }
    if (now < tt.deadline) return;
    // The page is there but busy (she is using it): give it more time, up to 6 hours.
    const pageBusy = lastAlive && now - lastAlive.at < 90000 && lastAlive.version !== VERSION && lastAlive.waiting;
    if (pageBusy && now - tt.startedAt < MAX_WAIT_MS) {
      tt.deadline = now + settings().updates.trialMinutes * 60000;
      save();
      log('trial: the page is busy; waiting longer');
      return;
    }
    rollbackAndRestart(lastAlive && lastAlive.at >= tt.startedAt ? 'the page did not start on the new version' : 'no word from the page on the new version');
  }, 5000);
}

function pageOnNewVersion() {
  return !!(lastAlive && lastAlive.version === VERSION && lastAlive.booted && state.trial && lastAlive.at >= state.trial.startedAt);
}

function passTrial(note) {
  if (!state.trial || state.trial.version !== VERSION) return;
  const page = state.trial.pageWasAlive;
  state = U.endTrialOk(state, { now: Date.now(), note });
  state.update.page = page;
  state.skip = null;
  save();
  if (trialTimer) clearInterval(trialTimer);
  const removed = U.prune(ROOT, state);
  log(`trial passed: ${note}${removed.length ? `; removed ${removed.join(', ')}` : ''}`);
}

function rollbackAndRestart(why) {
  const page = state.trial ? state.trial.pageWasAlive : false;
  const bad = state.trial ? state.trial.version : VERSION;
  state = U.rollback(state, { now: Date.now(), why });
  if (state.update) state.update.page = page;
  state.skip = bad;                         // nights skip it; "Update now" may still try it
  save();
  log(`ROLLBACK to ${state.current}: ${why}`);
  restart();
}

// --- updates ---------------------------------------------------------------------------------------

function requestUpdate(body) {
  const reason = body.reason === 'family' ? 'family' : 'button';
  const id = typeof body.id === 'string' && /^[A-Za-z0-9:._-]{1,64}$/.test(body.id) ? body.id : null;
  if (reason === 'family' && id && id === state.lastRequestId) return { started: false, already: true };
  if (busy || state.trial) return { started: false, busy: true };
  if (id) { state.lastRequestId = id; save(); }
  runUpdate(reason, id).catch(e => log('update:', e.message));
  return { started: true };
}

function scheduler() {
  const s = settings();
  if (s.updates.enabled === false || busy || state.trial) return;
  const slot = U.nightSlotDue(Date.now(), s.updates.time);
  if (!slot || state.nightSlot === slot.key) return;
  state.nightSlot = slot.key;
  save();
  runUpdate('night').catch(e => log('update:', e.message));
}

function bootAlive() {
  if (process.env.DAYBOOK_BOOT !== '1') return false;
  try { process.kill(process.ppid, 0); return true; } catch { return false; }
}

async function runUpdate(reason, requestId = null) {
  if (busy) return;
  busy = true;
  phase = 'checking';
  const s = settings();
  const done = (fields, level = 'info') => {
    state.check = Object.assign({ at: Date.now(), reason, requestId, latest: null, error: null }, fields);
    save();
    phase = 'idle';
    busy = false;
    log(`update check (${reason}): ${state.check.result}${state.check.latest ? ` ${state.check.latest}` : ''}${state.check.error ? ` - ${state.check.error}` : ''}`, level === 'warn' ? '(!)' : '');
  };
  try {
    if (!bootAlive()) return done({ result: 'error', error: 'Daybook was not started by its starter (boot.js), so it cannot restart itself' });
    const res = await U.checkForUpdate({ url: s.updates.url, current: VERSION });
    if (res.status !== 'available') return done({ result: res.status, latest: res.latest || null, error: res.error || null });
    if (reason === 'night' && state.skip && state.skip === res.latest) return done({ result: 'skipped', latest: res.latest, error: 'this version was rolled back before' });
    phase = 'downloading';
    log(`downloading ${res.latest} from ${res.base}`);
    const staged = await U.stageRelease({ root: ROOT, manifest: res.manifest, base: res.base });
    phase = 'installing';
    const pageWasAlive = !!(lastAlive && Date.now() - lastAlive.at < 3 * 60000);
    await U.installStaged({ root: ROOT, stagedDir: staged, version: res.latest });
    state = U.beginTrial(state, { version: res.latest, now: Date.now(), trialMs: s.updates.trialMinutes * 60000, pageWasAlive, reason, requestId });
    state.check = { at: Date.now(), result: 'started', latest: res.latest, error: null, reason, requestId };
    save();
    log(`switching to ${res.latest}${pageWasAlive ? ' (the page is open: it reloads by itself)' : ''}`);
    phase = 'restarting';
    restart();
  } catch (e) {
    done({ result: e.offline ? 'offline' : 'error', error: String(e.message || e).slice(0, 200) }, 'warn');
  }
}

// --- stopping ----------------------------------------------------------------------------------------

let stopping = false;
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  try { if (server) await Promise.race([server.close(), new Promise(r => setTimeout(r, 3000))]); } catch { /* closing */ }
  try { fs.rmSync(path.join(L.run, 'keeper.pid'), { force: true }); } catch { /* fine */ }
  log(`stopped (${code})`);
  process.exit(code);
}

function restart() { shutdown(U.RESTART_CODE); }

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', e => { log('crash:', e.stack || e.message); process.exit(1); });

main().catch(e => { log('start-up failed:', e.stack || e.message); process.exit(1); });
