// DAYBOOK — opening (and, for the uninstaller, closing) the Daybook window in Edge.
//
// Daybook's window is Edge with its OWN profile (<install>\EdgeProfile), so it never
// mixes with anyone's normal Edge windows, tabs or sign-in, and so it can be found
// and closed without touching any other Edge window: only processes whose command
// line names that profile folder are ever closed.
//
// The flags are start.cmd's (0.1.0): full-screen app window, or kiosk; the chime and
// the voice may play without a tap (--autoplay-policy=no-user-gesture-required).

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

/** msedge.exe: DAYBOOK_EDGE if set, else the usual places. null if not found. */
function findEdge(env = process.env) {
  const tries = [
    env.DAYBOOK_EDGE,
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  return tries.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

/** The command-line flags for the Daybook window. */
function edgeArgs({ url, profileDir, kiosk = false }) {
  const flags = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=Translate',
    '--overscroll-history-navigation=0', '--disable-pinch', '--hide-crash-restore-bubble',
  ];
  return kiosk
    ? ['--kiosk', url, '--edge-kiosk-type=fullscreen', ...flags]
    : [`--app=${url}`, '--start-fullscreen', ...flags];
}

/** Opens the Daybook window (does not wait for it). Returns the started process. */
function launchEdge({ edgePath, url, profileDir, kiosk }) {
  const child = spawn(edgePath, edgeArgs({ url, profileDir, kiosk }), { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return child;
}

/** Splits a Windows command line into arguments (spaces outside quotes; quotes removed). */
function splitCommandLine(s) {
  const out = [];
  let cur = '';
  let quoted = false;
  let any = false;
  for (const ch of String(s || '')) {
    if (ch === '"') { quoted = !quoted; any = true; continue; }
    if (!quoted && /\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

/** Does this command line belong to a process using exactly this profile folder? */
function usesProfile(commandLine, profileDir) {
  const norm = p => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
  const want = norm(profileDir);
  const arg = splitCommandLine(commandLine).find(a => a.toLowerCase().startsWith('--user-data-dir='));
  return !!arg && norm(arg.slice('--user-data-dir='.length)) === want;
}

/** The PowerShell command that lists Edge processes with their command lines (as JSON). */
const LIST_EDGE_PS = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";

/** Edge processes using the Daybook profile: [{ pid, parent, browser, commandLine }]. */
function listProfileProcesses(profileDir, { run = spawnSync } = {}) {
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LIST_EDGE_PS], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const text = String((r && r.stdout) || '').trim();
  if (!text) return [];
  let rows;
  try { rows = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(rows)) rows = [rows];
  return rows
    .filter(p => p && usesProfile(p.CommandLine, profileDir))
    .map(p => ({ pid: Number(p.ProcessId), parent: Number(p.ParentProcessId), browser: !/\s--type=/.test(String(p.CommandLine)), commandLine: String(p.CommandLine) }));
}

/** Closes the Daybook window: ends the Edge processes that use its profile, and only those. */
function closeProfileWindows(profileDir, { run = spawnSync } = {}) {
  const procs = listProfileProcesses(profileDir, { run });
  const browsers = procs.filter(p => p.browser);
  const ended = [];
  for (const p of browsers.length ? browsers : procs) {
    run('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    ended.push(p.pid);
  }
  return ended;
}

module.exports = { findEdge, edgeArgs, launchEdge, splitCommandLine, usesProfile, listProfileProcesses, closeProfileWindows, LIST_EDGE_PS };
