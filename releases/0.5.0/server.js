#!/usr/bin/env node
/**
 * DAYBOOK — the tiny local server.
 *
 *   node server.js            -> http://127.0.0.1:8642  (on its own: for trying it out, and the tests)
 *   pc/keeper.js              -> on her PC, the keeper runs this same server, and adds the updater
 *
 * What it does, and nothing more:
 *   - serves the app from ./app (static files, a fixed list of file types)
 *   - serves /config.example.json and /config.local.json
 *   - accepts POST /api/config from the app's settings screen and writes
 *     config.local.json (the personal settings, git-ignored, this device only)
 *   - GET /health answers "daybook" so a starter can tell it is up
 *   - 0.3.0: GET /api/status (the version running, and the updater's news when the
 *     keeper hosts it); POST /api/alive (the page saying "I am running, version X"),
 *     /api/update ("Update now"), /api/ack, and /api/keeper/stop (with the keeper's
 *     own token). Without the keeper these answer "no updater here".
 *   - 0.5.0: POST /api/front (a medicine or appointment reminder while the window is
 *     minimized or hidden): brings the Daybook window forward, at most once a minute. The
 *     keeper does it on her PC; run on its own (start.cmd), the server does it for
 *     start.cmd's Edge profile. With DAYBOOK_NO_WINDOW=1 (the tests) no window is touched.
 *
 * Safety:
 *   - Binds 127.0.0.1 only. Never the LAN.
 *   - Every request must carry a Host header of 127.0.0.1:<port> or
 *     localhost:<port>; anything else is refused (blocks DNS-rebinding tricks
 *     from other web pages).
 *   - Every POST also refuses any Origin that is not this server.
 *   - Static paths are resolved and must stay inside ./app.
 *   - No network calls from here at all. (The keeper's updater fetches releases;
 *     the app itself talks only to the Apps Script URL in the config.)
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const MAX_BODY_BYTES = 64 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const JSON_TYPE = TYPES['.json'];
const TEXT_TYPE = TYPES['.txt'];

/** The version of the files beside this server: manifest.json (a release), else package.json, else "dev". */
function readVersion(root) {
  for (const name of ['manifest.json', 'package.json']) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')).version;
      if (typeof v === 'string' && v) return v;
    } catch { /* next */ }
  }
  return 'dev';
}

function send(res, code, type, body, extra) {
  res.writeHead(code, Object.assign({
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  }, extra || {}));
  res.end(body);
}

function sendJson(res, code, obj) { send(res, code, JSON_TYPE, JSON.stringify(obj)); }

function sendFile(res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, TEXT_TYPE, 'not found');
    send(res, 200, type, data);
  });
}

/** Reads a request body up to a limit. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonObject(req) {
  const body = await readBody(req, MAX_BODY_BYTES);
  const obj = body.trim() ? JSON.parse(body) : {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not an object');
  return obj;
}

/** Writes a file atomically (temp file, then rename). */
function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Starts the server. Options (all optional; the defaults are the folder this file is in):
 *   root, appDir, exampleConfig, localConfig, host, port, version, quiet,
 *   hooks: { status(), alive(body), update(body), ack(body), stop(token), front(body) }   (the keeper's)
 *   front(body): bring the window forward, when there is no keeper (start.cmd)
 * Resolves with { server, port, version, localConfig, close() } once listening;
 * rejects on EADDRINUSE and the like.
 */
function start(opts = {}) {
  const root = opts.root || __dirname;
  const appDir = path.resolve(opts.appDir || path.join(root, 'app'));
  const exampleConfig = opts.exampleConfig || path.join(root, 'config.example.json');
  const localConfig = path.resolve(opts.localConfig || path.join(root, 'config.local.json'));
  const host = opts.host || '127.0.0.1';
  const port = opts.port == null ? 8642 : Number(opts.port);
  const version = opts.version || readVersion(root);
  const hooks = opts.hooks || null;
  const log = opts.quiet ? () => {} : (...a) => console.log(new Date().toISOString(), ...a);

  let allowedHosts = new Set();
  let allowedOrigins = new Set();

  function status() {
    return { ok: true, app: 'daybook', version, updater: hooks ? hooks.status() : null };
  }

  const server = http.createServer(async (req, res) => {
    if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) {
      return send(res, 403, TEXT_TYPE, 'refused');
    }

    let url;
    try { url = decodeURIComponent((req.url || '/').split('?')[0]); }
    catch { return send(res, 400, TEXT_TYPE, 'bad request'); }

    if (url === '/health') return send(res, 200, TEXT_TYPE, 'daybook');

    if (url.startsWith('/api/')) {
      if (url === '/api/status') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, TEXT_TYPE, 'GET only');
        return sendJson(res, 200, status());
      }
      if (req.method !== 'POST') return send(res, 405, TEXT_TYPE, 'POST only');
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) return send(res, 403, TEXT_TYPE, 'refused');
      let body;
      try { body = await readJsonObject(req); }
      catch (e) { return sendJson(res, 400, { ok: false, error: String(e.message || e) }); }
      try {
        if (url === '/api/config') {
          writeAtomic(localConfig, JSON.stringify(body, null, 2) + '\n');
          log('settings saved');
          return sendJson(res, 200, { ok: true });
        }
        if (url === '/api/front') {
          const front = (hooks && hooks.front) || opts.front;
          if (!front) return sendJson(res, 501, { ok: false, error: 'no window here' });
          return sendJson(res, 200, Object.assign({ ok: true }, front(body) || {}));
        }
        if (!['/api/alive', '/api/update', '/api/ack', '/api/keeper/stop'].includes(url)) return send(res, 404, TEXT_TYPE, 'not found');
        if (!hooks) {
          // On its own (no keeper): the page may still say it is alive; there is nothing to update.
          if (url === '/api/alive' || url === '/api/ack') return sendJson(res, 200, status());
          return sendJson(res, 501, { ok: false, error: 'no updater here', status: status() });
        }
        if (url === '/api/alive') { hooks.alive(body); return sendJson(res, 200, status()); }
        if (url === '/api/update') return sendJson(res, 200, Object.assign({ ok: true }, hooks.update(body) || {}, { status: status() }));
        if (url === '/api/ack') { hooks.ack(body); return sendJson(res, 200, status()); }
        const ok = hooks.stop(String(req.headers['x-daybook-token'] || ''));      // /api/keeper/stop
        return sendJson(res, ok ? 200 : 403, { ok: !!ok });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e.message || e) });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, TEXT_TYPE, 'GET only');
    }

    if (url === '/config.example.json') return sendFile(res, exampleConfig, JSON_TYPE);
    if (url === '/config.local.json') return sendFile(res, localConfig, JSON_TYPE);

    // Static files from ./app, confined to that folder.
    const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
    const file = path.resolve(appDir, rel);
    if (file !== appDir && !file.startsWith(appDir + path.sep)) {
      return send(res, 404, TEXT_TYPE, 'not found');
    }
    const type = TYPES[path.extname(file).toLowerCase()];
    if (!type) return send(res, 404, TEXT_TYPE, 'not found');
    return sendFile(res, file, type);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const p = server.address().port;
      allowedHosts = new Set([`${host}:${p}`, `localhost:${p}`]);
      allowedOrigins = new Set([`http://${host}:${p}`, `http://localhost:${p}`]);
      resolve({
        server, port: p, version, localConfig,
        close: () => new Promise(r => {
          server.close(() => r());
          if (server.closeAllConnections) server.closeAllConnections();
        }),
      });
    });
  });
}

module.exports = { start, readVersion, TYPES };

if (require.main === module) {
  const port = Number(process.env.DAYBOOK_PORT || 8642);
  const localConfig = process.env.DAYBOOK_LOCAL_CONFIG ? path.resolve(process.env.DAYBOOK_LOCAL_CONFIG) : undefined;
  // start.cmd's window: Edge with its own profile, here (pc/lib/edge.js brings it forward).
  const edge = require('./pc/lib/edge');
  const profile = process.env.DAYBOOK_EDGE_PROFILE || path.join(process.env.LOCALAPPDATA || __dirname, 'Daybook', 'EdgeProfile');
  const front = edge.frontHook(profile, { noWindow: process.env.DAYBOOK_NO_WINDOW === '1', log: m => console.log(new Date().toISOString(), m) });
  start({ port, localConfig, front }).then(s => {
    console.log(`DAYBOOK ${s.version} on http://127.0.0.1:${s.port}  (this computer only)`);
    console.log(`Personal settings file: ${s.localConfig}${fs.existsSync(s.localConfig) ? '' : '  (not created yet; using config.example.json)'}`);
  }).catch(err => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Daybook is already running on http://127.0.0.1:${port}`);
      process.exit(0);
    }
    console.error(err);
    process.exit(1);
  });
}
