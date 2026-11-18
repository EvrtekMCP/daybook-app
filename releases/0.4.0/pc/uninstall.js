#!/usr/bin/env node
// DAYBOOK — uninstall (0.3.0). "Uninstall Daybook.cmd" in the install folder runs this
// (Settings > Apps > Daybook > Uninstall runs that file), from a copy in %TEMP%, so the
// install folder can be removed while it runs.
//
//   1. asks first
//   2. stops Daybook and closes its window (only the Edge window with Daybook's own profile)
//   3. removes the startup entry and the Settings > Apps entry
//   4. asks whether to put the sleep setting back as it was before Daybook
//   5. asks whether to delete her settings and records too; if not, they stay, and a
//      reinstall picks them up
//
// For the tests: --sandbox DIR (the install is DIR\Daybook; Windows commands are written to
// DIR\system-commands.jsonl, not run), --answers y,n,..., --close-window (close the window
// even in a sandbox). With DAYBOOK_NO_SYSTEM=1 it refuses to run without --sandbox.

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { spawn } = require('child_process');
const W = require('./lib/winsys');
const edge = require('./lib/edge');

function opt(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }
const SANDBOX = opt('--sandbox') ? path.resolve(opt('--sandbox')) : null;
const ROOT = path.resolve(opt('--root') || (SANDBOX ? path.join(SANDBOX, 'Daybook') : path.join(process.env.LOCALAPPDATA || '', 'Daybook')));
const ANSWERS = (opt('--answers') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const PORT = Number(process.env.DAYBOOK_PORT || 8642);
const say = (s = '') => console.log(s);

let rl = null;
function ask(q) {
  if (ANSWERS.length) { const a = ANSWERS.shift(); say(`${q} (Y/N) ${a.toUpperCase()}`); return Promise.resolve(a.startsWith('y')); }
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    const go = () => rl.question(`${q} (Y/N) `, a => {
      const t = String(a || '').trim().toLowerCase();
      if (t === 'y' || t === 'yes') return resolve(true);
      if (t === 'n' || t === 'no') return resolve(false);
      say('  Please type Y or N, then press Enter.');
      go();
    });
    go();
  });
}
function done(code) { if (rl) rl.close(); cleanTemp(); process.exitCode = code; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function readText(f) { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } }

function request(method, p, headers = {}) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: Object.assign({ Host: `127.0.0.1:${PORT}` }, headers), timeout: 2000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

async function stopRunning() {
  const token = readText(path.join(ROOT, 'run', 'token'));
  const up = await request('GET', '/health');
  if (up && up.body === 'daybook' && token) {
    await request('POST', '/api/keeper/stop', { 'X-Daybook-Token': token, 'Content-Type': 'application/json' });
    for (let i = 0; i < 40; i++) { if (!(await request('GET', '/health'))) break; await sleep(250); }
  }
  for (const f of ['boot.pid', 'keeper.pid']) {
    const pid = Number(readText(path.join(ROOT, 'run', f)));
    if (pid > 0) { try { process.kill(pid); } catch { /* gone */ } }
  }
  await sleep(300);
}

function rm(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); return true; } catch (e) { say(`  could not remove ${p} (${e.code || e.message})`); return false; }
}

/** When run from %TEMP%\daybook-uninstall-*, remove that copy a few seconds after this ends. */
function cleanTemp() {
  const here = path.resolve(__dirname);
  if (!/[\\/]daybook-uninstall-[0-9]+$/i.test(here)) return;
  try {
    spawn('cmd.exe', ['/d', '/c', `ping -n 6 127.0.0.1 >nul & rmdir /s /q "${here}"`], { detached: true, windowsHide: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
  } catch { /* %TEMP% is cleaned by Windows anyway */ }
}

async function main() {
  say('DAYBOOK - remove it from this PC');
  if (process.env.DAYBOOK_NO_SYSTEM === '1' && !SANDBOX) { say('DAYBOOK_NO_SYSTEM is set (a test run): use --sandbox.'); return done(1); }
  if (!fs.existsSync(path.join(ROOT, 'boot.js')) && !fs.existsSync(path.join(ROOT, 'state.json'))) { say(`Daybook is not installed in ${ROOT}.`); return done(1); }
  const run = SANDBOX ? W.recordRunner(path.join(SANDBOX, 'system-commands.jsonl')) : W.realRunner;
  if (!(await ask(`Remove Daybook from this PC (${ROOT})?`))) { say('Nothing was changed.'); return done(0); }

  say('Stopping Daybook...');
  await stopRunning();
  if (!SANDBOX || process.argv.includes('--close-window')) {
    const ended = edge.closeProfileWindows(path.join(ROOT, 'EdgeProfile'));
    if (ended.length) say('Closed the Daybook window.');
  }

  say('Removing the startup entry and the Settings > Apps entry...');
  W.runAll(run, W.removeStartup());
  W.runAll(run, W.removeUninstallEntry());

  let info = null;
  try { info = JSON.parse(fs.readFileSync(path.join(ROOT, 'install.json'), 'utf8')); } catch { info = null; }
  const p = info && info.power;
  if (p && p.changed && Number.isFinite(p.standbySec)) {
    const mins = Math.round(p.standbySec / 60);
    if (await ask(`Put the sleep setting back to how it was before Daybook (plugged in: ${mins ? `sleep after ${mins} minutes` : 'never sleep'})?`)) {
      const r = W.runAll(run, W.restorePowerAc(p));
      say(r.some(x => x.code !== 0) ? '  Could not change it here; Settings > System > Power has it.' : '  Done.');
    }
  }

  const herToo = await ask('Also delete her settings and records on this PC (her name and times, the medicine record, appointments waiting to be sent)?');
  for (const name of ['runtime', 'versions', 'staging', 'run', 'boot.js', 'state.json', 'uninstaller', 'Uninstall Daybook.cmd']) rm(path.join(ROOT, name));
  if (herToo) {
    for (const name of ['config.local.json', 'EdgeProfile', 'logs', 'install.json']) rm(path.join(ROOT, name));
    try { fs.rmdirSync(ROOT); } catch { /* something else is in it: leave it */ }
    say('Daybook and her records are removed.');
  } else {
    say(`Daybook is removed. Her settings and records are kept in ${ROOT} (a reinstall uses them).`);
  }
  return done(0);
}

main().catch(e => { say(`Something went wrong: ${e.message}`); done(1); });
