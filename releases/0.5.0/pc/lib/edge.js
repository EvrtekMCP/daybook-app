// DAYBOOK — opening (and, for the uninstaller, closing) the Daybook window in Edge; and
// (0.5.0) bringing it back to the front for a medicine or appointment reminder.
//
// Daybook's window is Edge with its OWN profile (<install>\EdgeProfile), so it never
// mixes with anyone's normal Edge windows, tabs or sign-in, and so it can be found
// and closed without touching any other Edge window: only processes whose command
// line names that profile folder are ever closed.
//
// The flags are start.cmd's: an app window (0.5.0: a NORMAL window, opened maximized, with
// its title bar, so it can be minimized, restored and resized; Evrtek: full screen left the
// computer "useless once the app is running"), or kiosk only when window.kiosk is set (off
// by default); the chime and the voice may play without a tap
// (--autoplay-policy=no-user-gesture-required).

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFile } = require('child_process');

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
    : [`--app=${url}`, '--start-maximized', ...flags];
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

/** The Edge processes in LIST_EDGE_PS's output that use the Daybook profile. */
function parseProcessList(text, profileDir) {
  const s = String(text || '').trim();
  if (!s) return [];
  let rows;
  try { rows = JSON.parse(s); } catch { return []; }
  if (!Array.isArray(rows)) rows = [rows];
  return rows
    .filter(p => p && usesProfile(p.CommandLine, profileDir))
    .map(p => ({ pid: Number(p.ProcessId), parent: Number(p.ParentProcessId), browser: !/\s--type=/.test(String(p.CommandLine)), commandLine: String(p.CommandLine) }));
}

/** Edge processes using the Daybook profile: [{ pid, parent, browser, commandLine }]. */
function listProfileProcesses(profileDir, { run = spawnSync } = {}) {
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LIST_EDGE_PS], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return parseProcessList(r && r.stdout, profileDir);
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

// --- bringing the window forward (0.5.0) ------------------------------------------------------

/**
 * The PowerShell that, for each process id, takes its main window: if minimized, restores it
 * the way it was (maximized: SW_RESTORE), then asks Windows to put it in front. Windows says
 * no when someone is busy in another program (it flashes the taskbar button instead), so
 * this never takes the keyboard from her. Prints "pid|wasMinimized|inFront" per window.
 */
function frontPs(pids) {
  const ids = pids.map(Number).filter(n => Number.isInteger(n) && n > 0);
  return "Add-Type -Namespace DaybookWin -Name U -MemberDefinition '" +
    '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); ' +
    '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c); ' +
    '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);' + "'; " +
    `foreach ($id in @(${ids.join(',')})) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; ` +
    'if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) { $h = $p.MainWindowHandle; $m = [DaybookWin.U]::IsIconic($h); ' +
    'if ($m) { [void][DaybookWin.U]::ShowWindowAsync($h, 9) }; $f = [DaybookWin.U]::SetForegroundWindow($h); "$id|$m|$f" } }';
}

/** Runs one PowerShell command without blocking; resolves its output ('' on any failure). */
function execPs(command) {
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 20000 }, (err, stdout) => resolve(String(stdout || '')));
  });
}

/** Brings the Daybook window (this profile's, and only its) forward. Resolves { found, windows: [{ pid, minimized, front }] }. */
async function bringForward(profileDir, { exec = execPs } = {}) {
  const pids = parseProcessList(await exec(LIST_EDGE_PS), profileDir).filter(p => p.browser).map(p => p.pid);
  if (!pids.length) return { found: 0, windows: [] };
  const windows = String(await exec(frontPs(pids))).split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const [pid, m, f] = l.split('|');
    return { pid: Number(pid), minimized: m === 'True', front: f === 'True' };
  }).filter(w => Number.isInteger(w.pid) && w.pid > 0);
  return { found: pids.length, windows };
}

/**
 * The server's "bring Daybook forward" (POST /api/front): at most once a minute, whatever the
 * page asks, so a reminder can never keep pulling the window up. noWindow (the tests): writes
 * down what it would do, touches no window. Returns (body) -> { asked, ... }.
 */
function frontHook(profileDir, { minGapMs = 60000, exec = execPs, noWindow = false, log = () => {}, now = Date.now } = {}) {
  let last = -Infinity;
  const asks = [];
  const hook = body => {
    const t = now();
    const reason = String((body && body.reason) || '').slice(0, 40);
    if (t - last < minGapMs) return { asked: false, why: 'asked less than a minute ago' };
    last = t;
    asks.push({ at: t, reason });
    if (noWindow) return { asked: true, stub: true };
    bringForward(profileDir, { exec })
      .then(r => log(`window forward (${reason}): ${r.found ? (r.windows.map(w => `${w.minimized ? 'restored, ' : ''}${w.front ? 'in front' : 'Windows flashed it'}`).join('; ') || 'no window handle') : 'not open'}`))
      .catch(e => log(`window forward: ${e.message}`));
    return { asked: true };
  };
  hook.asks = asks;
  return hook;
}

module.exports = { findEdge, edgeArgs, launchEdge, splitCommandLine, usesProfile, parseProcessList, listProfileProcesses, closeProfileWindows, frontPs, bringForward, frontHook, LIST_EDGE_PS };
