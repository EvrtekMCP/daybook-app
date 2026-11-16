// DAYBOOK — the few Windows settings the installer touches, all for this Windows user
// only (no administrator):
//   - starting Daybook when she signs in: one value under HKCU\...\Run
//   - Daybook in Settings > Apps (so it can be uninstalled from there): HKCU\...\Uninstall\Daybook
//   - never sleep while plugged in (the screen may still turn off): powercfg, with her yes
//
// Every command is built here as [program, args] and run by a runner. The tests use
// recordRunner(), which only writes the commands down; the real runner refuses to run
// at all when DAYBOOK_NO_SYSTEM=1 (set by every test), so a test can never change the
// startup or power settings of the PC it runs on.

'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Daybook';
const RUN_VALUE = 'Daybook';

/** The startup command: the bundled node.exe running boot.js (which hides itself). */
function startupCommand(nodeExe, bootJs) { return `"${nodeExe}" "${bootJs}"`; }

function addStartup(nodeExe, bootJs) {
  return [['reg.exe', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', startupCommand(nodeExe, bootJs), '/f']]];
}
function removeStartup() { return [['reg.exe', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']]]; }
function queryStartup() { return ['reg.exe', ['query', RUN_KEY, '/v', RUN_VALUE]]; }

function addUninstallEntry({ version, installDir, uninstallCmd, sizeKb }) {
  const v = (name, type, data) => ['reg.exe', ['add', UNINSTALL_KEY, '/v', name, '/t', type, '/d', String(data), '/f']];
  return [
    v('DisplayName', 'REG_SZ', 'Daybook'),
    v('DisplayVersion', 'REG_SZ', version),
    v('Publisher', 'REG_SZ', 'REIMERTEK STUDIOS'),
    v('InstallLocation', 'REG_SZ', installDir),
    v('UninstallString', 'REG_SZ', `"${uninstallCmd}"`),
    v('NoModify', 'REG_DWORD', 1),
    v('NoRepair', 'REG_DWORD', 1),
    v('EstimatedSize', 'REG_DWORD', Math.max(1, Math.round(sizeKb || 1))),
  ];
}
function removeUninstallEntry() { return [['reg.exe', ['delete', UNINSTALL_KEY, '/f']]]; }

/** Reading the current sleep and hibernate timeouts (plugged in), in seconds. */
function queryPower() {
  return [
    ['powercfg.exe', ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'STANDBYIDLE']],
    ['powercfg.exe', ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'HIBERNATEIDLE']],
  ];
}

/**
 * The AC (plugged in) value from `powercfg /query` output, in seconds, or null.
 * The words are in Windows's language, so this reads the numbers: the last two
 * 0x... values are the plugged-in and the battery settings, in that order.
 */
function parsePowerQuery(text) {
  const hex = String(text || '').match(/0x[0-9a-fA-F]{8}/g) || [];
  if (hex.length < 2) return null;
  return parseInt(hex[hex.length - 2], 16);
}

/** Never sleep and never hibernate while plugged in. The screen setting is left alone. */
function neverSleepAc() {
  return [
    ['powercfg.exe', ['/change', 'standby-timeout-ac', '0']],
    ['powercfg.exe', ['/change', 'hibernate-timeout-ac', '0']],
  ];
}

/** Puts back what was there before (seconds, from parsePowerQuery). */
function restorePowerAc({ standbySec, hibernateSec }) {
  const out = [];
  if (Number.isFinite(standbySec)) out.push(['powercfg.exe', ['/change', 'standby-timeout-ac', String(Math.round(standbySec / 60))]]);
  if (Number.isFinite(hibernateSec)) out.push(['powercfg.exe', ['/change', 'hibernate-timeout-ac', String(Math.round(hibernateSec / 60))]]);
  return out;
}

// --- runners ------------------------------------------------------------------------------------

/** Runs a command for real. Refuses when DAYBOOK_NO_SYSTEM=1 (the tests). */
function realRunner(prog, args) {
  if (process.env.DAYBOOK_NO_SYSTEM === '1') throw new Error(`DAYBOOK_NO_SYSTEM is set: refusing to run ${prog}`);
  const r = spawnSync(prog, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { code: r.status == null ? -1 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}

/** Writes each command to a JSON-lines file instead of running it; answers like a quiet success. */
function recordRunner(file, answers = {}) {
  return (prog, args) => {
    fs.appendFileSync(file, JSON.stringify({ prog, args }) + '\n');
    const key = `${prog} ${args.join(' ')}`;
    for (const [pattern, ans] of Object.entries(answers)) if (key.includes(pattern)) return Object.assign({ code: 0, stdout: '', stderr: '' }, ans);
    return { code: 0, stdout: '', stderr: '' };
  };
}

/** Runs a list of commands; resolves [{ prog, args, code, stdout, stderr }]. Stops at none: each is reported. */
function runAll(runner, cmds) { return cmds.map(([prog, args]) => Object.assign({ prog, args }, runner(prog, args))); }

module.exports = {
  RUN_KEY, UNINSTALL_KEY, RUN_VALUE,
  startupCommand, addStartup, removeStartup, queryStartup, addUninstallEntry, removeUninstallEntry,
  queryPower, parsePowerQuery, neverSleepAc, restorePowerAc,
  realRunner, recordRunner, runAll,
};
