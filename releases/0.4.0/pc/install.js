#!/usr/bin/env node
// DAYBOOK — the installer (0.3.0). "Install Daybook.cmd" runs this with the Node runtime
// that comes in the same folder, so nothing needs to be installed on her PC first.
//
// What it does, for her Windows account only (no administrator):
//   1. reads "her setup file" (daybook-setup.json) beside the installer or at the top
//      of the USB stick: her name, her times, her PC's calendar address and key
//   2. checks its own files (a bad copy from the stick is caught here, not later)
//   3. copies Daybook to %LOCALAPPDATA%\Daybook: the runtime, the app, the starter
//   4. writes her settings (config.local.json) from the setup file, keeping anything
//      already there; never the sample calendar
//   5. starts Daybook when she signs in (one entry under HKCU\...\Run), and lists it in
//      Settings > Apps so it can be uninstalled from there
//   6. asks (yes/no) to keep the PC awake while plugged in (the screen may still turn off)
//   7. starts Daybook, which opens on screen and sends a test check-in (a test alert to
//      the family); with no internet it waits on her PC and goes when the internet is back
//
// For the tests only:
//   --sandbox DIR    install into DIR\Daybook; the Windows commands are written to
//                    DIR\system-commands.jsonl instead of being run; Edge is never opened
//   --answers y,n    the answers to the questions, in order
//   --no-start       do not start Daybook at the end
// With DAYBOOK_NO_SYSTEM=1 (every test sets it) it refuses to run without --sandbox.

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const U = require('./lib/updater');
const W = require('./lib/winsys');
const S = require('./lib/setupfile');

const RELEASE = path.resolve(__dirname, '..');                  // ...\files\daybook
const PKG = path.resolve(RELEASE, '..', '..');                  // the installer folder
const NODE_DIR = path.join(RELEASE, '..', 'node');

function opt(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }
const SANDBOX = opt('--sandbox') ? path.resolve(opt('--sandbox')) : null;
const ANSWERS = (opt('--answers') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const NO_START = process.argv.includes('--no-start');
const PORT = Number(process.env.DAYBOOK_PORT || 8642);

const say = (s = '') => console.log(s);
const step = s => say(`\n== ${s}`);

let rl = null;
function ask(question) {
  if (ANSWERS.length) {
    const a = ANSWERS.shift();
    say(`${question} (Y/N) ${a.toUpperCase()}`);
    return Promise.resolve(a.startsWith('y'));
  }
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    const go = () => rl.question(`${question} (Y/N) `, a => {
      const t = String(a || '').trim().toLowerCase();
      if (t === 'y' || t === 'yes') return resolve(true);
      if (t === 'n' || t === 'no') return resolve(false);
      say('  Please type Y or N, then press Enter.');
      go();
    });
    go();
  });
}

function fail(msg) {
  say(`\nDaybook was NOT installed: ${msg}`);
  if (rl) rl.close();
  process.exit(1);
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function get(p, timeout = 3000) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, headers: { Host: `127.0.0.1:${PORT}` }, timeout }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function post(p, headers = {}) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', headers: Object.assign({ Host: `127.0.0.1:${PORT}`, 'Content-Type': 'application/json' }, headers), timeout: 3000 }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end('{}');
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Stops a Daybook that is already running from this install folder (a reinstall). */
async function stopRunning(root) {
  const token = (() => { try { return fs.readFileSync(path.join(root, 'run', 'token'), 'utf8').trim(); } catch { return ''; } })();
  const up = await get('/health');
  if (!up || up.body !== 'daybook') return false;
  if (token) await post('/api/keeper/stop', { 'X-Daybook-Token': token });
  for (let i = 0; i < 40; i++) {
    const h = await get('/health', 1000);
    if (!h) break;
    await sleep(250);
  }
  for (const f of ['boot.pid', 'keeper.pid']) {
    const pid = Number((() => { try { return fs.readFileSync(path.join(root, 'run', f), 'utf8'); } catch { return ''; } })());
    if (pid > 0) { try { process.kill(pid); } catch { /* already gone */ } }
  }
  await sleep(500);
  return true;
}

function copyDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

function dirSizeKb(dir) {
  let n = 0;
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else n += fs.statSync(f).size; } };
  try { walk(dir); } catch { /* fine */ }
  return Math.round(n / 1024);
}

const UNINSTALL_CMD = `@echo off
rem DAYBOOK - uninstall. Also reached from Settings > Apps > Daybook > Uninstall.
rem It runs from a copy in %TEMP%, so this folder can be removed while it runs.
rem The last line is read whole before it runs; "(goto) 2>nul" then lets go of this
rem file, so Windows does not look for it again once the folder is gone.
setlocal
title Remove Daybook
set "D=%~dp0"
set "T=%TEMP%\\daybook-uninstall-%RANDOM%%RANDOM%"
mkdir "%T%\\lib" >nul 2>&1
copy /y "%D%runtime\\node.exe" "%T%\\node.exe" >nul
copy /y "%D%uninstaller\\uninstall.js" "%T%\\uninstall.js" >nul
copy /y "%D%uninstaller\\lib\\*.js" "%T%\\lib\\" >nul
(goto) 2>nul & "%T%\\node.exe" "%T%\\uninstall.js" --root "%D:~0,-1%" %* & pause
`;

async function main() {
  say(`DAYBOOK installer ${readJson(path.join(RELEASE, 'manifest.json')) ? readJson(path.join(RELEASE, 'manifest.json')).version : ''} - REIMERTEK STUDIOS`);
  if (process.platform !== 'win32') fail('this installer is for Windows.');
  if (process.env.DAYBOOK_NO_SYSTEM === '1' && !SANDBOX) fail('DAYBOOK_NO_SYSTEM is set (a test run): use --sandbox.');
  const root = SANDBOX ? path.join(SANDBOX, 'Daybook') : path.join(process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'), 'Daybook');
  const run = SANDBOX ? W.recordRunner(path.join(SANDBOX, 'system-commands.jsonl'), { 'SUB_SLEEP STANDBYIDLE': { stdout: 'Current AC Power Setting Index: 0x00000708\nCurrent DC Power Setting Index: 0x00000384\n' }, 'SUB_SLEEP HIBERNATEIDLE': { stdout: 'Current AC Power Setting Index: 0x00002a30\nCurrent DC Power Setting Index: 0x00002a30\n' } }) : W.realRunner;
  if (SANDBOX) say(`(test run: installing into ${root}; Windows settings are written down, not changed)`);

  // 1. Her setup file ------------------------------------------------------------------------
  step('1. Her setup file');
  let setup = null;
  const found = S.findSetupFile(PKG);
  if (found) {
    const r = S.parseSetupText(fs.readFileSync(found, 'utf8'));
    if (r.ok) {
      setup = r.setup;
      say(`Found ${found}`);
      say(`  name: ${setup.name ? 'yes' : '(none)'}; medicine ${setup.medicine.time || 'off'}; lunch ${setup.nudges.lunch || 'off'}; supper ${setup.nudges.supper || 'off'}; dishes ${setup.nudges.dishes || 'off'}; calendar: ${setup.calendar ? 'yes' : 'no'}`);
    } else {
      say(`Found ${found}, but it cannot be used:`);
      for (const e of r.errors) say(`  - ${e}`);
      if (!(await ask('Install without it (her name, times and calendar can be set later in Daybook\'s hidden settings)?'))) fail('fix the setup file (download it again from the family page) and run this again.');
    }
  } else {
    say(`No setup file found (looked for ${S.FILE_NAME} beside this installer and at the top of the USB stick).`);
    if (!(await ask('Install without it (her name, times and calendar can be set later in Daybook\'s hidden settings)?'))) fail(`put ${S.FILE_NAME} (from "Download her setup file" on the family page) beside the installer and run it again.`);
  }

  // 2. Its own files ----------------------------------------------------------------------------
  step('2. Checking the installer\'s files');
  const manifest = readJson(path.join(RELEASE, 'manifest.json'));
  if (!manifest || !U.validateManifest(manifest).ok) fail('the installer\'s manifest.json is missing or damaged. Copy the installer folder to the stick again.');
  const problems = await U.verifyFolder(RELEASE, manifest);
  if (problems.length) fail(`a file did not copy right (${problems[0]}). Copy the installer folder to the stick again.`);
  if (!fs.existsSync(path.join(NODE_DIR, 'node.exe'))) fail('files\\node\\node.exe is missing. Copy the installer folder to the stick again.');
  say(`Daybook ${manifest.version}: all ${manifest.files.length} files are right.`);

  // 3. Copy it in ---------------------------------------------------------------------------------
  step(`3. Copying Daybook to ${root}`);
  fs.mkdirSync(root, { recursive: true });
  if (await stopRunning(root)) say('Stopped the Daybook that was running (it starts again at the end).');
  const v = manifest.version;
  const runtime = path.join(root, 'runtime');
  try {
    copyDir(NODE_DIR, runtime);
  } catch (e) {
    fail(`could not copy the runtime (${e.code || e.message}). Close Daybook (Alt+F4) and run this again.`);
  }
  const versions = path.join(root, 'versions');
  fs.mkdirSync(versions, { recursive: true });
  const part = path.join(versions, `${v}.part`);
  copyDir(RELEASE, part);
  fs.rmSync(path.join(versions, v), { recursive: true, force: true });
  fs.renameSync(part, path.join(versions, v));
  fs.copyFileSync(path.join(RELEASE, 'pc', 'boot.js'), path.join(root, 'boot.js'));
  const un = path.join(root, 'uninstaller');
  fs.rmSync(un, { recursive: true, force: true });
  fs.mkdirSync(path.join(un, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(RELEASE, 'pc', 'uninstall.js'), path.join(un, 'uninstall.js'));
  for (const f of ['edge.js', 'winsys.js']) fs.copyFileSync(path.join(RELEASE, 'pc', 'lib', f), path.join(un, 'lib', f));
  const uninstallCmd = path.join(root, 'Uninstall Daybook.cmd');
  fs.writeFileSync(uninstallCmd, UNINSTALL_CMD.replace(/\r?\n/g, '\r\n'));
  let st = U.readState(root);
  const previous = st.current && st.current !== v ? st.current : st.previous && st.previous !== v ? st.previous : null;
  st = Object.assign(st, { current: v, previous, trial: null, skip: null, install: { id: `i-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`, version: v, at: Date.now() } });
  U.writeState(root, st);
  U.prune(root, st);
  say(`Copied (Daybook ${v}${previous ? `; ${previous} kept as the fallback` : ''}).`);

  // 4. Her settings ------------------------------------------------------------------------------
  step('4. Her settings');
  const cfgFile = path.join(root, 'config.local.json');
  const had = readJson(cfgFile);
  let cfg = had || {};
  if (setup) cfg = S.toLocalConfig(setup, cfg);
  if (!cfg.calendar || !cfg.calendar.provider || cfg.calendar.provider === 'mock') {
    cfg.calendar = Object.assign({}, cfg.calendar, { provider: setup && setup.calendar ? 'appsscript' : 'none' });   // never the sample calendar
  }
  writeJsonAtomic(cfgFile, cfg);
  say(`${had ? 'Updated' : 'Wrote'} ${cfgFile}${setup ? ' from the setup file' : ''}${had ? ' (her other settings kept)' : ''}.`);
  if (!(cfg.calendar && cfg.calendar.provider === 'appsscript')) say('No calendar connected yet: Daybook shows no appointments and sends no check-ins until it is (hidden settings, or a setup file).');

  // 5. Start with Windows, and Settings > Apps ----------------------------------------------------------
  step('5. Starting with Windows');
  const nodeExe = path.join(runtime, 'node.exe');
  const bootJs = path.join(root, 'boot.js');
  const r1 = W.runAll(run, W.addStartup(nodeExe, bootJs));
  if (r1.some(x => x.code !== 0)) say(`Could not add the startup entry (${(r1.find(x => x.code !== 0) || {}).stderr || 'reg add failed'}). docs/INSTALL-PC.md says how to add it by hand.`);
  else say('Daybook starts by itself when she signs in to Windows.');
  const r2 = W.runAll(run, W.addUninstallEntry({ version: v, installDir: root, uninstallCmd, sizeKb: dirSizeKb(root) }));
  if (r2.some(x => x.code !== 0)) say('(Could not list Daybook in Settings > Apps; "Uninstall Daybook" in its folder still works.)');
  else say('Listed in Settings > Apps (to uninstall it later).');

  // 6. Never sleep while plugged in ----------------------------------------------------------------------
  step('6. Keeping the PC awake');
  const infoFile = path.join(root, 'install.json');
  const info = readJson(infoFile) || {};
  if (!info.power) {
    const [qs, qh] = W.runAll(run, W.queryPower());
    info.power = { standbySec: W.parsePowerQuery(qs.stdout), hibernateSec: W.parsePowerQuery(qh.stdout), changed: false };
  }
  say('Daybook can only remind her and check in while the PC is awake. A sleeping PC looks');
  say('like a broken one to the family page. The screen can still turn itself off.');
  if (await ask('Set this PC to never sleep while it is plugged in?')) {
    const r3 = W.runAll(run, W.neverSleepAc());
    if (r3.some(x => x.code !== 0)) say('Could not change it here. Set it by hand: Settings > System > Power > Screen and sleep > "When plugged in, put my device to sleep after": Never.');
    else { info.power.changed = true; say('Done: it never sleeps or hibernates while plugged in.'); }
  } else {
    say('Left as it is. (docs/INSTALL-PC.md step 12 shows how to set it by hand.)');
  }
  info.installed = new Date().toISOString();
  info.version = v;
  writeJsonAtomic(infoFile, info);

  // 7. Start it, and the test check-in --------------------------------------------------------------------
  step('7. Starting Daybook');
  if (NO_START) { say('Not started (--no-start).'); return finish(setup); }
  const env = Object.assign({}, process.env, SANDBOX ? { DAYBOOK_NO_WINDOW: '1' } : {});
  const child = spawn(nodeExe, [bootJs], { cwd: root, detached: true, windowsHide: true, stdio: 'ignore', env });
  child.unref();
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { const h = await get('/health', 1000); up = !!(h && h.body === 'daybook'); if (!up) await sleep(500); }
  if (!up) { say('Daybook did not answer within 30 seconds. Restart the PC; if it still does not open, see docs/INSTALL-PC.md "If something goes wrong".'); return finish(setup); }
  say(`Daybook is running${SANDBOX ? '' : ' and opening on screen'}.`);
  if (!(cfg.calendar && cfg.calendar.provider === 'appsscript')) { say('(No calendar connected, so there is no test check-in to send.)'); return finish(setup); }
  say('Waiting for its test check-in (up to a minute)...');
  let page = null;
  for (let i = 0; i < 60; i++) {
    const s = await get('/api/status');
    let j = null;
    try { j = s ? JSON.parse(s.body) : null; } catch { j = null; }
    page = j && j.updater && j.updater.page;
    const taken = j && j.updater && !j.updater.install;
    if (taken && page && page.lastCheckinOk >= Date.now() - 120000 && !page.queued) { say('Test check-in sent. Within a minute or two you should get the test email and a phone notification ("Daybook: installed on her PC (test)"), and the family page shows "installed on her PC" under Recent check-ins.'); return finish(setup); }
    await sleep(1000);
  }
  if (page && page.connected) say('The test check-in is saved on her PC and goes to the family page as soon as the internet is there (no internet right now, it seems).');
  else say('Daybook has not reported back yet. Look at the screen: if the TODAY screen shows, it is fine; the test check-in goes when the page has started and the internet is there.');
  return finish(setup);
}

function finish(setup) {
  say('\nDone. Daybook is installed.');
  if (setup && setup.calendar) say(`The setup file holds the secret key: delete ${S.FILE_NAME} from the USB stick now.`);
  say('To remove Daybook later: Settings > Apps > Installed apps > Daybook > Uninstall.');
  if (rl) rl.close();
}

main().catch(e => fail(e.stack || e.message));
