// DAYBOOK — the updater's working parts (0.3.0), used by pc/keeper.js on her PC and by
// tools/release.js on Evrtek's. Plain Node, nothing to install.
//
// How an update goes, start to end:
//   1. check     fetch latest.json from the release site (GitHub Pages); is it newer?
//   2. stage     download every file it lists into staging/<version>-<random>/,
//                checking each one's size and SHA-256 against the manifest
//   3. swap      rename the staged folder to versions/<version> (one rename, all or
//                nothing), then write state.json: current = new, previous = old,
//                trial = { deadline }  (one atomic write)
//   4. restart   the keeper exits with code 75; boot.js starts the new version
//   5. trial     the new version must answer its own health check, and the page must
//                say "I am running, version X" before the deadline; then the trial
//                ends "updated". Otherwise: rollback (state.json back to the old
//                version, the result "rolledback"), and restart again.
// Her config.local.json, the logs and the Edge profile (her offline queue and records)
// are outside versions/ and staging/, and nothing here ever writes to them.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANIFEST_FORMAT = 1;
const STATE_FORMAT = 1;
const BOOT_PROTOCOL = 1;                        // what this release's boot.js speaks (manifest.minBoot)
const DEFAULT_RELEASES_URL = 'https://evrtekmcp.github.io/daybook-app/latest.json';
const MAX_FILES = 400;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const RESTART_CODE = 75;                        // keeper -> boot: "start current again" (after a swap or rollback)

// --- versions ------------------------------------------------------------------------------

/** "0.3.0" -> [0, 3, 0]; anything else -> null. Plain x.y.z only. */
function parseVersion(v) {
  const m = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.exec(String(v == null ? '' : v));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1, 0 or 1. Throws on a version that is not x.y.z (never guess which is newer). */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`not a version: ${pa ? b : a}`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

function isNewer(candidate, current) { return compareVersions(candidate, current) > 0; }

// --- paths ------------------------------------------------------------------------------------

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** A release file's path: relative, forward slashes, plain names, nothing that climbs out. */
function safeRelPath(p) {
  if (typeof p !== 'string' || !p || p.length > 200) return false;
  if (!/^[A-Za-z0-9._\-/]+$/.test(p)) return false;
  if (p.startsWith('/') || p.endsWith('/') || p.includes('//')) return false;
  return p.split('/').every(seg => seg && seg !== '.' && seg !== '..' && !seg.endsWith('.') && !WINDOWS_RESERVED.test(seg));
}

/** dir + a checked relative path, refusing anything that would land outside dir. */
function inside(dir, rel) {
  if (!safeRelPath(rel)) throw new Error(`unsafe path in release: ${rel}`);
  const base = path.resolve(dir);
  const full = path.resolve(base, ...rel.split('/'));
  if (!full.startsWith(base + path.sep)) throw new Error(`unsafe path in release: ${rel}`);
  return full;
}

// --- the manifest -------------------------------------------------------------------------------

/**
 * Checks a release manifest: { app: "daybook", format: 1, version, entry, minBoot,
 * files: [{ path, size, sha256 }] }. Returns { ok: true, manifest } or { ok: false, error }.
 */
function validateManifest(m) {
  const bad = error => ({ ok: false, error });
  if (!m || typeof m !== 'object' || Array.isArray(m)) return bad('the manifest is not an object');
  if (m.app !== 'daybook') return bad('not a Daybook manifest');
  if (m.format !== MANIFEST_FORMAT) return bad(`unknown manifest format ${m.format}`);
  if (!parseVersion(m.version)) return bad(`bad version ${m.version}`);
  if (!Number.isInteger(m.minBoot) || m.minBoot < 1) return bad('bad minBoot');
  if (!Array.isArray(m.files) || !m.files.length || m.files.length > MAX_FILES) return bad('bad file list');
  const seen = new Set();
  let total = 0;
  for (const f of m.files) {
    if (!f || typeof f !== 'object') return bad('bad file entry');
    if (!safeRelPath(f.path)) return bad(`unsafe path ${f.path}`);
    const lower = f.path.toLowerCase();                   // Windows: names differ only in case = the same file
    if (seen.has(lower)) return bad(`listed twice: ${f.path}`);
    seen.add(lower);
    if (!Number.isInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) return bad(`bad size for ${f.path}`);
    if (!/^[0-9a-f]{64}$/.test(String(f.sha256))) return bad(`bad sha256 for ${f.path}`);
    total += f.size;
  }
  if (total > MAX_TOTAL_BYTES) return bad('release too large');
  if (lower(m.entry) == null || !seen.has(lower(m.entry))) return bad('the entry file is not in the list');
  if (seen.has('manifest.json')) return bad('manifest.json may not list itself');
  for (const need of ['server.js', 'app/index.html']) if (!seen.has(need)) return bad(`missing ${need}`);
  return { ok: true, manifest: m };
}
function lower(s) { return typeof s === 'string' && safeRelPath(s) ? s.toLowerCase() : null; }

/** SHA-256 of a file, hex. */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}
function sha256Text(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/** Builds the manifest for a folder of release files (tools/release.js). */
async function manifestFor(dir, relPaths, { version, entry = 'pc/keeper.js', minBoot = BOOT_PROTOCOL, released = new Date().toISOString() }) {
  const files = [];
  for (const rel of relPaths.slice().sort()) {
    const full = inside(dir, rel);
    files.push({ path: rel, size: fs.statSync(full).size, sha256: await sha256File(full) });
  }
  return { app: 'daybook', format: MANIFEST_FORMAT, version, released, entry, minBoot, files };
}

/** Re-checks a folder against a manifest. Resolves [] when every file matches, else the problems. */
async function verifyFolder(dir, manifest) {
  const problems = [];
  for (const f of manifest.files) {
    const full = inside(dir, f.path);
    let st;
    try { st = fs.statSync(full); } catch { problems.push(`${f.path}: missing`); continue; }
    if (st.size !== f.size) { problems.push(`${f.path}: size ${st.size}, expected ${f.size}`); continue; }
    if ((await sha256File(full)) !== f.sha256) problems.push(`${f.path}: fingerprint does not match`);
  }
  return problems;
}

// --- state.json (in the install folder) ---------------------------------------------------------

function statePath(root) { return path.join(root, 'state.json'); }

function emptyState() {
  return { format: STATE_FORMAT, current: null, previous: null, trial: null, update: null, check: null, nightSlot: null, lastRequestId: null, install: null };
}

/** Reads state.json; a missing or broken one reads as empty (boot then refuses to guess). */
function readState(root) {
  try {
    const st = JSON.parse(fs.readFileSync(statePath(root), 'utf8'));
    if (!st || typeof st !== 'object') return emptyState();
    return Object.assign(emptyState(), st);
  } catch {
    return emptyState();
  }
}

/** Writes state.json in one step: a temp file, flushed, then renamed over the old one. */
function writeState(root, st) {
  const file = statePath(root);
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(st, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return st;
}

function newId(prefix) { return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`; }

/** After a swap: the new version is current, on trial until the deadline. */
function beginTrial(st, { version, now, trialMs, pageWasAlive, reason, requestId }) {
  return Object.assign({}, st, {
    previous: st.current,
    current: version,
    trial: { id: newId('u'), version, from: st.current, startedAt: now, deadline: now + trialMs, pageWasAlive: !!pageWasAlive, reason: reason || 'night', requestId: requestId || null },
  });
}

/** The trial passed. */
function endTrialOk(st, { now, note }) {
  const t = st.trial;
  if (!t) return st;
  return Object.assign({}, st, {
    trial: null,
    update: { id: t.id, result: 'updated', from: t.from, to: t.version, at: now, reason: t.reason, requestId: t.requestId, note: note || null },
  });
}

/** The trial failed (or the new version crashed): back to the version before it. */
function rollback(st, { now, why }) {
  const t = st.trial;
  const from = t ? t.from : st.previous;
  if (!from) return st;                              // nothing to go back to
  const to = t ? t.version : st.current;
  return Object.assign({}, st, {
    current: from,
    previous: null,
    trial: null,
    update: { id: t ? t.id : newId('u'), result: 'rolledback', from, to, at: now, reason: t ? t.reason : 'crash', requestId: t ? t.requestId : null, why: String(why || 'the new version did not start').slice(0, 160) },
  });
}

// --- fetching -------------------------------------------------------------------------------------

/** Only https, or http to this computer (the tests' stand-in release site). */
function allowedUrl(u) {
  let url;
  try { url = new URL(u); } catch { return false; }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
}

class OfflineError extends Error {
  constructor(msg) { super(msg); this.offline = true; }
}

async function fetchBytes(url, { timeoutMs = 30000, maxBytes = MAX_FILE_BYTES, fetchImpl = globalThis.fetch } = {}) {
  if (!allowedUrl(url)) throw new Error(`refusing to fetch ${url}`);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { signal: ac.signal, redirect: 'follow', cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
  } catch (e) {
    clearTimeout(t);
    throw new OfflineError(`could not reach the release site (${(e && (e.cause && e.cause.code)) || (e && e.name) || 'network'})`);
  }
  try {
    if (!res.ok) throw new Error(`the release site answered ${res.status}`);
    if (res.redirected && !allowedUrl(res.url)) throw new Error('redirected somewhere not allowed');
    const declared = Number(res.headers.get('content-length'));
    if (declared > maxBytes) throw new Error('file too large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('file too large');
    return buf;
  } catch (e) {
    if (e.name === 'AbortError') throw new OfflineError('the release site took too long');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Looks at the release site. Resolves { status, latest, manifest, base, error }:
 *   'uptodate'  nothing newer      'available'  newer, manifest checked
 *   'offline'   could not reach    'error'      reached, but something was wrong
 *   'needsboot' newer, but it needs a newer boot.js than this PC has (a visit with the installer)
 */
async function checkForUpdate({ url = DEFAULT_RELEASES_URL, current, bootProtocol = BOOT_PROTOCOL, fetchImpl } = {}) {
  let buf;
  try {
    const sep = url.includes('?') ? '&' : '?';
    buf = await fetchBytes(`${url}${sep}t=${Date.now()}`, { maxBytes: 512 * 1024, fetchImpl });   // past the Pages cache
  } catch (e) {
    return { status: e.offline ? 'offline' : 'error', error: e.message };
  }
  let m;
  try { m = JSON.parse(buf.toString('utf8')); } catch { return { status: 'error', error: 'latest.json is not JSON' }; }
  const v = validateManifest(m);
  if (!v.ok) return { status: 'error', error: v.error };
  const base = new URL(typeof m.path === 'string' && safeRelPath(m.path.replace(/\/$/, '')) ? m.path.replace(/\/?$/, '/') : `releases/${m.version}/`, url).toString();
  if (!isNewer(m.version, current)) return { status: 'uptodate', latest: m.version };
  if (m.minBoot > bootProtocol) return { status: 'needsboot', latest: m.version, error: `needs boot ${m.minBoot}` };
  return { status: 'available', latest: m.version, manifest: m, base };
}

/**
 * Downloads every file of a release into a new staging folder, checking each one.
 * Resolves the staging folder; on any problem removes it and throws.
 */
async function stageRelease({ root, manifest, base, fetchImpl, onProgress }) {
  const stagingRoot = path.join(root, 'staging');
  fs.mkdirSync(stagingRoot, { recursive: true });
  const dir = path.join(stagingRoot, `${manifest.version}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir);
  try {
    let n = 0;
    for (const f of manifest.files) {
      const dest = inside(dir, f.path);
      const buf = await fetchBytes(new URL(f.path, base).toString(), { maxBytes: Math.max(f.size, 1), fetchImpl });
      if (buf.length !== f.size) throw new Error(`${f.path}: size ${buf.length}, expected ${f.size}`);
      if (sha256Text(buf) !== f.sha256) throw new Error(`${f.path}: fingerprint does not match`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      n += 1;
      if (onProgress) onProgress(n, manifest.files.length);
    }
    const { path: _p, ...clean } = manifest;                         // written from the checked copy
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(clean, null, 2) + '\n');
    const problems = await verifyFolder(dir, clean);                 // once more, from the disk
    if (problems.length) throw new Error(problems[0]);
    return dir;
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Moves a checked staging folder to versions/<version>. Resolves the version folder. */
async function installStaged({ root, stagedDir, version }) {
  const versions = path.join(root, 'versions');
  fs.mkdirSync(versions, { recursive: true });
  const dest = path.join(versions, version);
  if (fs.existsSync(dest)) {
    // The same version is already here (an earlier try, or the one rolled back from):
    // set it aside rather than trust it, and use the freshly checked copy.
    fs.renameSync(dest, path.join(root, 'staging', `${version}-old-${crypto.randomBytes(3).toString('hex')}`));
  }
  fs.renameSync(stagedDir, dest);
  return dest;
}

/** Keeps versions/current and versions/previous; removes the rest, and old staging folders. */
function prune(root, st) {
  const keep = new Set([st.current, st.previous, st.trial && st.trial.version].filter(Boolean));
  const removed = [];
  const versions = path.join(root, 'versions');
  for (const name of safeList(versions)) {
    if (keep.has(name)) continue;
    fs.rmSync(path.join(versions, name), { recursive: true, force: true });
    removed.push(name);
  }
  const staging = path.join(root, 'staging');
  for (const name of safeList(staging)) fs.rmSync(path.join(staging, name), { recursive: true, force: true });
  return removed;
}

function safeList(dir) { try { return fs.readdirSync(dir); } catch { return []; } }

/** The manifest of an installed version (versions/<v>/manifest.json), or null. */
function installedManifest(root, version) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, 'versions', version, 'manifest.json'), 'utf8'));
    return validateManifest(m).ok ? m : null;
  } catch {
    return null;
  }
}

// --- the nightly time ------------------------------------------------------------------------------

/** "03:00" -> minutes, or null. */
function hm(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * The nightly slot due now, if any: { key, at } for today's (or yesterday's) set time,
 * when now is within windowMin minutes after it. A PC that was off at 3 a.m. waits for
 * the next night (never an update in the middle of her morning).
 */
function nightSlotDue(nowMs, time, windowMin = 120) {
  const m = hm(time);
  if (m == null) return null;
  const d = new Date(nowMs);
  for (const back of [0, 1]) {
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back, Math.floor(m / 60), m % 60).getTime();
    if (nowMs >= at && nowMs < at + windowMin * 60000) {
      const k = new Date(at);
      return { key: `${k.getFullYear()}-${String(k.getMonth() + 1).padStart(2, '0')}-${String(k.getDate()).padStart(2, '0')}`, at };
    }
  }
  return null;
}

/** The next nightly time after now (ms), for the settings screen. */
function nextNight(nowMs, time) {
  const m = hm(time);
  if (m == null) return null;
  const d = new Date(nowMs);
  let at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(m / 60), m % 60).getTime();
  if (at <= nowMs) at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, Math.floor(m / 60), m % 60).getTime();
  return at;
}

module.exports = {
  MANIFEST_FORMAT, STATE_FORMAT, BOOT_PROTOCOL, DEFAULT_RELEASES_URL, RESTART_CODE,
  parseVersion, compareVersions, isNewer, safeRelPath, inside,
  validateManifest, sha256File, sha256Text, manifestFor, verifyFolder,
  statePath, emptyState, readState, writeState, newId, beginTrial, endTrialOk, rollback,
  allowedUrl, OfflineError, fetchBytes, checkForUpdate, stageRelease, installStaged, prune, installedManifest,
  hm, nightSlotDue, nextNight, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES,
};
