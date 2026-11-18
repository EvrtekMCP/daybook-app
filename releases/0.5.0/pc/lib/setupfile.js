// DAYBOOK — "her setup file" (daybook-setup.json): what the family page's "Download her
// setup file" makes, and what the installer reads. It carries her name, her times, and
// her PC's calendar address and key, so the visit needs no typing on her PC.
//
//   {
//     "daybook": "setup", "format": 1, "made": "2026-11-15T20:00:00Z",
//     "name": "...",
//     "medicine": { "time": "09:00" },
//     "nudges": { "lunch": "12:00", "supper": "17:30", "dishes": "18:30" },
//     "calendar": { "provider": "appsscript", "url": "https://script.google.com/macros/s/.../exec", "key": "..." }
//   }
//
// An empty time turns that reminder off (as in config.local.json). The file holds the
// secret key: it is meant for the visit only (the installer says so when it is done).
// The same checks run in Family.gs (familySetupFile) when the file is made.

'use strict';

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'daybook-setup.json';
const SCRIPT_URL = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{10,200}\/exec$/;
const KEY = /^[A-Za-z0-9_-]{24,200}$/;
const TIME = /^(?:([01]\d|2[0-3]):[0-5]\d)?$/;            // "" = off

/** Checks a parsed setup file. Returns { ok: true, setup } or { ok: false, errors: [...] }. */
function validateSetup(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['The file is not a Daybook setup file.'] };
  if (obj.daybook !== 'setup' || obj.format !== 1) return { ok: false, errors: ['The file is not a Daybook setup file (it should come from "Download her setup file" on the family page).'] };
  const setup = { name: '', medicine: {}, nudges: {}, calendar: null };
  if (obj.name != null) {
    const n = String(obj.name).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (n.length > 40) errors.push('The name is longer than 40 letters.');
    setup.name = n.slice(0, 40);
  }
  const time = (v, label) => {
    if (v == null) return undefined;
    const s = String(v).trim();
    if (!TIME.test(s)) { errors.push(`${label}: not a time (use 24-hour HH:MM, or empty to turn it off).`); return undefined; }
    return s;
  };
  const med = obj.medicine && typeof obj.medicine === 'object' ? time(obj.medicine.time, 'Medicine') : undefined;
  if (med !== undefined) setup.medicine.time = med;
  const nud = obj.nudges && typeof obj.nudges === 'object' ? obj.nudges : {};
  for (const [k, label] of [['lunch', 'Lunch'], ['supper', 'Supper'], ['dishes', 'Dishes']]) {
    const t = time(nud[k], label);
    if (t !== undefined) setup.nudges[k] = t;
  }
  if (obj.calendar != null) {
    const c = obj.calendar;
    if (!c || typeof c !== 'object') errors.push('The calendar part is not readable.');
    else {
      const url = String(c.url || '').trim();
      const key = String(c.key || '').trim();
      if (!SCRIPT_URL.test(url)) errors.push("Her PC's address is not an Apps Script web app address (https://script.google.com/macros/s/.../exec).");
      if (!KEY.test(key)) errors.push('The secret key is missing or too short.');
      setup.calendar = { provider: 'appsscript', url, key };
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, setup };
}

function parseSetupText(text) {
  let obj;
  try { obj = JSON.parse(String(text).replace(/^﻿/, '')); } catch { return { ok: false, errors: ['The setup file is not readable (not JSON).'] }; }
  return validateSetup(obj);
}

/** Her config.local.json with the setup file's values on top (everything else she had is kept). */
function toLocalConfig(setup, existing = {}) {
  const cfg = JSON.parse(JSON.stringify(existing || {}));
  if (setup.name) cfg.name = setup.name;
  if (Object.keys(setup.medicine).length) cfg.medicine = Object.assign({}, cfg.medicine, setup.medicine);
  if (Object.keys(setup.nudges).length) cfg.nudges = Object.assign({}, cfg.nudges, setup.nudges);
  if (setup.calendar) cfg.calendar = Object.assign({}, cfg.calendar, setup.calendar);
  return cfg;
}

/**
 * Where to look for the setup file: beside the installer, the folder above it, and the
 * top of the drive it is on (the USB stick). First found wins.
 */
function setupCandidates(packageDir) {
  const dirs = [packageDir, path.dirname(packageDir), path.parse(path.resolve(packageDir)).root];
  return [...new Set(dirs.map(d => path.join(d, FILE_NAME)))];
}

function findSetupFile(packageDir) {
  return setupCandidates(packageDir).find(f => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
}

module.exports = { FILE_NAME, validateSetup, parseSetupText, toLocalConfig, setupCandidates, findSetupFile };
