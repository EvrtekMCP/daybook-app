#!/usr/bin/env node
// DAYBOOK — the starter (boot.js). The installer puts it in the install folder
// (%LOCALAPPDATA%\Daybook\boot.js), and Windows runs it when she signs in:
//   "<install>\runtime\node.exe" "<install>\boot.js"
//
// It is deliberately small, and the nightly updates never replace it (only the
// installer does), because it is what stands guard over them:
//   - starts the keeper of the version state.json names (versions/<v>/pc/keeper.js)
//   - exit 75 from the keeper = "start current again" (after an update or a rollback)
//   - exit 0 = stop (the installer or uninstaller asked)
//   - a crash: if that version is on trial (just updated), go back to the version before
//     it at once; otherwise start it again after a short wait (2 s, 10 s, 30 s, 2 min, 5 min)
//   - a keeper that hangs on trial past its deadline (+3 minutes) is ended and rolled back
// Only one starter runs at a time (run/boot.pid). It hides its own window: the first
// copy starts a second, windowless one and leaves.
//
// Self-contained on purpose: it uses nothing from the version folders.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BOOT_PROTOCOL = 1;
const RESTART_CODE = 75;
const ROOT = path.resolve(argValue('--root') || __dirname);
const RUN = path.join(ROOT, 'run');
const LOGS = path.join(ROOT, 'logs');
const STATE = path.join(ROOT, 'state.json');
const HANG_GRACE_MS = Number(process.env.DAYBOOK_HANG_GRACE_MS || 3 * 60000);
const BACKOFF_S = [2, 10, 30, 120, 300];

function argValue(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }

// --- 1. hide the window: start a windowless copy and leave --------------------------------------

if (!process.argv.includes('--child')) {
  const args = [__filename, '--child', '--root', ROOT];
  if (!process.argv.includes('--no-open')) args.push('--open');
  const child = spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: 'ignore', cwd: ROOT });
  child.unref();
  process.exit(0);
}

fs.mkdirSync(RUN, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });
const LOG = path.join(LOGS, 'boot.log');
function log(...parts) {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 512 * 1024) fs.renameSync(LOG, path.join(LOGS, 'boot.1.log'));
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${parts.join(' ')}\n`);
  } catch { /* never stop for a log */ }
}

// --- 2. one starter at a time ---------------------------------------------------------------------

const PID_FILE = path.join(RUN, 'boot.pid');
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
try {
  const other = Number(fs.readFileSync(PID_FILE, 'utf8'));
  if (other && other !== process.pid && alive(other)) { log(`already running (pid ${other}); leaving`); process.exit(0); }
} catch { /* no pid file */ }
fs.writeFileSync(PID_FILE, String(process.pid));

// --- 3. state.json --------------------------------------------------------------------------------

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) || {}; } catch { return {}; }
}
function writeState(st) {
  const tmp = `${STATE}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(st, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, STATE);
}
/** Back to the version before the one on trial; the result is kept for her next check-in. */
function rollback(st, why) {
  const t = st.trial;
  const from = (t && t.from) || st.previous;
  if (!from) return false;
  const to = (t && t.version) || st.current;
  st.update = { id: (t && t.id) || `u-${Date.now().toString(36)}`, result: 'rolledback', from, to, at: Date.now(), reason: (t && t.reason) || 'crash', requestId: (t && t.requestId) || null, why, page: !!(t && t.pageWasAlive) };
  st.current = from;
  st.previous = null;
  st.trial = null;
  st.skip = to;
  writeState(st);
  log(`ROLLBACK ${to} -> ${from}: ${why}`);
  return true;
}

function entryFor(version) {
  const dir = path.join(ROOT, 'versions', String(version));
  let entry = 'pc/keeper.js';
  let minBoot = 1;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (typeof m.entry === 'string' && /^[A-Za-z0-9._\-/]+$/.test(m.entry) && !m.entry.includes('..')) entry = m.entry;
    if (Number.isInteger(m.minBoot)) minBoot = m.minBoot;
  } catch { /* the defaults */ }
  const file = path.join(dir, ...entry.split('/'));
  return { dir, file, ok: fs.existsSync(file) && minBoot <= BOOT_PROTOCOL };
}

// --- 4. run the keeper, again and again ---------------------------------------------------------------

let openWindow = process.argv.includes('--open');
let crashes = 0;
let child = null;
let stopping = false;

function launch() {
  const st = readState();
  if (!st.current) { log('state.json names no version; waiting 5 minutes'); return setTimeout(launch, 300000); }
  const e = entryFor(st.current);
  if (!e.ok) {
    log(`version ${st.current} cannot start here (missing, or needs a newer starter)`);
    if (rollback(st, 'the new version could not start')) return setImmediate(launch);
    return setTimeout(launch, 300000);
  }
  const args = [e.file, '--root', ROOT];
  if (openWindow) args.push('--open');
  openWindow = false;                                   // only the first start opens the window
  const out = fs.openSync(path.join(LOGS, 'keeper-console.log'), 'a');
  const began = Date.now();
  const version = st.current;
  let ended = false;                                    // ended by the hang guard (already rolled back)
  child = spawn(process.execPath, args, {
    cwd: e.dir, windowsHide: true, stdio: ['ignore', out, out],
    env: Object.assign({}, process.env, { DAYBOOK_BOOT: '1', DAYBOOK_BOOT_PROTOCOL: String(BOOT_PROTOCOL) }),
  });
  fs.closeSync(out);
  log(`started ${version} (pid ${child.pid})`);
  const guard = setInterval(() => {
    const now = readState();
    if (now.trial && now.trial.version === version && Date.now() > Number(now.trial.deadline) + HANG_GRACE_MS) {
      log(`${version} on trial has not answered past its deadline: ending it`);
      clearInterval(guard);
      rollback(now, 'the new version stopped answering');
      ended = true;
      try { child.kill(); } catch { /* gone */ }
    }
  }, Number(process.env.DAYBOOK_GUARD_MS || 15000));
  child.on('exit', (code, signal) => {
    clearInterval(guard);
    child = null;
    if (stopping) return process.exit(0);
    if (code === 0) { log(`${version} stopped on purpose`); cleanup(); return process.exit(0); }
    if (code === RESTART_CODE || ended) { crashes = 0; log(`${version} ${ended ? 'ended for the rollback' : 'asked for a restart'}`); return setImmediate(launch); }
    const now = readState();
    if (now.trial && now.trial.version === version) {
      rollback(now, `the new version stopped (${signal || `exit ${code}`})`);
      return setImmediate(launch);
    }
    if (Date.now() - began > 10 * 60000) crashes = 0;
    const wait = BACKOFF_S[Math.min(crashes, BACKOFF_S.length - 1)];
    crashes += 1;
    log(`${version} stopped (${signal || `exit ${code}`}); starting it again in ${wait} s`);
    setTimeout(launch, wait * 1000);
  });
}

function cleanup() { try { if (Number(fs.readFileSync(PID_FILE, 'utf8')) === process.pid) fs.rmSync(PID_FILE, { force: true }); } catch { /* fine */ } }
function stop() { stopping = true; cleanup(); if (child) { try { child.kill(); } catch { /* gone */ } } else process.exit(0); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', cleanup);

log(`starter running (pid ${process.pid}), install folder ${ROOT}`);
launch();
