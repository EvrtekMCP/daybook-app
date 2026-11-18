// DAYBOOK 0.4.0, 0.5.0 — the character on the today screen: Evrtek, from Portero's painted set
// ("the blue shirt style"), with a little life. The art is approved and stands; this file
// only shows the prepared frames (app/img/character/, made by tools/make-character.js).
//
//   at rest     the portrait itself: his warm smile, eyes on her; a slow breath and a
//               slight sway, and a single blink at random, every 2.5 to 6.5 seconds
//   speaking    nothing moves on the face (0.5.0, Evrtek: "my face shouldn't have animations
//               for speaking"): the portrait keeps its own smile while the voice plays
//   happy       after a thank-you or praise line: his open smile, held a few seconds
//   listening   while a card waits for her answer (medicine, meals, "How are you
//               feeling?", "Would you like a call?"): brows up, attentive; back to rest
//               when the card goes
//
// Calm by design: expressions fade (never snap), one blink at a time (0.5.0: "the double
// blink is too much"), breathing and sway stop when the device asks for less motion, and
// nothing ever frowns. One element, kept for the whole session and moved into the today
// screen's portrait slot after each redraw, so the motion never restarts.
//
// The voice events (voice.js) still matter: the happy and listening faces wait for the
// line being said to end, so he is seen saying it first.

import { onVoice, speaking } from './voice.js';

const DIR = 'img/character/';
const SETTLE_MS = 380;            // a gap this short between lines counts as one go of speaking
const BLINK_MS = 130;
export const BLINK_MIN_MS = 2500;
export const BLINK_MAX_MS = 6500;

/** The wait before the next blink: anywhere from 2.5 to 6.5 s, never on a beat. r: 0..1. */
export function blinkWait(r = Math.random()) { return BLINK_MIN_MS + r * (BLINK_MAX_MS - BLINK_MIN_MS); }

/** Loads character.json. Returns null if the frames are not there (the app then shows the plain portrait). */
export async function loadCharacter() {
  try {
    const r = await fetch(`${DIR}character.json`, { cache: 'no-store' });
    if (!r.ok) return null;
    const doc = await r.json();
    if (!doc || !doc.base || !doc.regions || !doc.regions.happy || !doc.regions.eyes) return null;
    return doc;
  } catch { return null; }
}

function layer(cls, region, base, version) {
  const el = document.createElement('div');
  el.className = `ch-layer ${cls}`;
  const { w, h } = base;
  // CSSOM only (the page's Content-Security-Policy allows no inline style attributes)
  el.style.left = `${(region.x / w) * 100}%`;
  el.style.top = `${(region.y / h) * 100}%`;
  el.style.width = `${(region.w / w) * 100}%`;
  el.style.height = `${(region.h / h) * 100}%`;
  el.style.backgroundImage = `url("${DIR}${region.file}?v=${version}")`;
  el.style.backgroundSize = `100% ${region.frames.length * 100}%`;
  el.dataset.frame = '';
  return el;
}

function show(el, region, frame) {
  if (!frame) { el.dataset.frame = ''; el.classList.remove('on'); return; }
  const i = region.frames.indexOf(frame);
  if (i < 0) return;
  const n = region.frames.length;
  el.style.backgroundPosition = `0 ${n > 1 ? (i / (n - 1)) * 100 : 0}%`;
  el.dataset.frame = frame;
  el.classList.add('on');
}

/**
 * Makes the character. opts: { version, reducedMotion (bool), voiceOn () -> bool }.
 * Returns the controller: attach(slot), detach(), expect(kind, opts), rest(), state(), pose(p), destroy().
 */
export function createCharacter(doc, { version = '', reducedMotion = false, voiceOn = () => true } = {}) {
  const H = doc.regions.happy, E = doc.regions.eyes;
  const now = () => performance.now();

  const el = document.createElement('div');
  el.className = 'character';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="ch-sway"><div class="ch-breathe"></div></div>';
  const breathe = el.querySelector('.ch-breathe');
  const sway = el.querySelector('.ch-sway');
  const img = document.createElement('img');
  img.className = 'ch-base';
  img.alt = '';
  img.decoding = 'async';
  img.src = `${DIR}${doc.base.file}?v=${version}`;
  const eyesX = layer('ch-eyes-x', E, doc.base, version);        // the listening look (fades)
  const smile = layer('ch-smile', H, doc.base, version);         // the happy smile (fades)
  const blink = layer('ch-blink', E, doc.base, version);         // shut lids (instant)
  breathe.append(img, eyesX, smile, blink);

  const st = {
    expression: 'rest', speaking: false, eyes: '', blinks: 0, doubleBlinks: 0, lastBlinkAt: 0, blinkWaits: [],
    posed: false, attached: false, lastLine: '',
  };
  let pending = null;          // { kind, holdMs, maxMs, while } to apply when the voice is quiet
  let pendingTimer = null, holdTimer = null, whileTimer = null, settleTimer = null, blinkTimer = null;
  let anims = [];

  // --- expressions -----------------------------------------------------------------------

  function setExpression(kind) {
    st.expression = kind;
    show(eyesX, E, kind === 'listen' ? 'listen' : '');
    show(smile, H, kind === 'happy' && !st.speaking ? 'happy' : '');
    el.dataset.expression = kind;
  }

  function apply(p) {
    clearTimeout(holdTimer); clearInterval(whileTimer);
    setExpression(p.kind);
    if (p.kind === 'rest') return;
    const limit = p.kind === 'happy' ? (p.holdMs || 3500) : (p.maxMs || 45000);
    holdTimer = setTimeout(() => rest(), limit);
    if (typeof p.while === 'function') {
      whileTimer = setInterval(() => { let ok = false; try { ok = !!p.while(); } catch { ok = false; } if (!ok) rest(); }, 700);
    }
  }

  /**
   * Asks for an expression once the line now being said (or about to be said) is over.
   * kind: 'happy' | 'listen' | 'rest'. opts: { holdMs, maxMs, while: () => bool }.
   */
  function expect(kind, opts = {}) {
    if (st.posed) return;
    clearTimeout(pendingTimer);
    // she has answered: the listening look ends now, whatever comes next
    if (st.expression === 'listen' && kind !== 'listen') { clearTimeout(holdTimer); clearInterval(whileTimer); setExpression('rest'); }
    pending = Object.assign({ kind }, opts);
    if (kind === 'rest') { const p = pending; pending = null; apply(p); return; }
    // The line usually starts a moment later (after the chime). If no line comes (voice off), go now.
    pendingTimer = setTimeout(() => { if (pending && !st.speaking) { const p = pending; pending = null; apply(p); } }, voiceOn() ? 9000 : 0);
  }

  function rest() {
    if (st.posed) return;
    pending = null;
    clearTimeout(pendingTimer); clearTimeout(holdTimer); clearInterval(whileTimer);
    setExpression('rest');
  }

  // --- the voice: no mouth; only when a line starts and ends ------------------------------------

  function settle() {
    // the line is over and no other followed: the face may change now
    st.speaking = false;
    if (pending) { const p = pending; pending = null; clearTimeout(pendingTimer); apply(p); }
    else if (st.expression === 'happy') show(smile, H, 'happy');
  }

  const offVoice = onVoice(ev => {
    if (st.posed) return;
    if (ev.type === 'start') {
      clearTimeout(settleTimer);
      st.speaking = true;
      st.lastLine = ev.lineId || '';
      show(smile, H, '');                        // the portrait's own smile while the voice plays
    } else if (ev.type === 'end') {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(settle, SETTLE_MS);
    }
  });

  // --- blinking: one at a time ------------------------------------------------------------------

  function blinkOnce() {
    const t = now();
    if (st.lastBlinkAt && t - st.lastBlinkAt < BLINK_MIN_MS - 50) st.doubleBlinks += 1;   // for the tests: stays 0
    st.lastBlinkAt = t;
    st.blinks += 1;
    show(blink, E, st.expression === 'listen' ? 'listen-closed' : 'closed');
    st.eyes = blink.dataset.frame;
    setTimeout(() => { if (st.posed) return; show(blink, E, ''); st.eyes = ''; }, BLINK_MS);
  }

  function scheduleBlink() {
    clearTimeout(blinkTimer);
    const wait = blinkWait();
    st.blinkWaits.push(Math.round(wait));
    if (st.blinkWaits.length > 20) st.blinkWaits.shift();
    blinkTimer = setTimeout(() => {
      if (st.attached && !st.posed && !document.hidden) blinkOnce();
      scheduleBlink();
    }, wait);
  }

  // --- breathing and sway (Web Animations, timed from one clock so a redraw never restarts them) ---

  function startIdle() {
    for (const a of anims) a.cancel();
    anims = [];
    if (reducedMotion || typeof breathe.animate !== 'function') return;
    const t = now();
    const breath = breathe.animate(
      [{ transform: 'translateY(0) scale(1, 1)' }, { transform: 'translateY(-0.35%) scale(1.003, 1.006)' }],
      { duration: 2900, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' });
    const lean = sway.animate(
      [{ transform: 'rotate(-0.3deg)' }, { transform: 'rotate(0.3deg)' }],
      { duration: 5300, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' });
    breath.currentTime = t % (2 * 2900);
    lean.currentTime = (t + 1700) % (2 * 5300);
    anims = [breath, lean];
  }

  // --- the controller --------------------------------------------------------------------------

  const ctl = {
    el,
    /** Puts the character into the today screen's portrait slot (after every redraw). */
    attach(slot) {
      if (!slot) return;
      if (el.parentNode !== slot) slot.appendChild(el);
      st.attached = true;
      startIdle();
      if (!blinkTimer) scheduleBlink();
    },
    detach() { st.attached = false; el.remove(); },
    expect,
    rest,
    /** For tests and the screenshots: what is showing now. */
    state() {
      return {
        expression: st.expression, speaking: st.speaking || speaking(), eyes: st.eyes, smile: smile.dataset.frame,
        blinks: st.blinks, doubleBlinks: st.doubleBlinks, blinkWaits: st.blinkWaits.slice(),
        layers: [...el.querySelectorAll('.ch-layer')].map(l => [...l.classList].find(c => c !== 'ch-layer' && c !== 'on')),
        attached: st.attached, posed: st.posed, lastLine: st.lastLine,
        moving: anims.some(a => a.playState === 'running'), loaded: img.complete && img.naturalWidth > 0,
      };
    },
    /** Holds one exact look for a screenshot: { expression, eyes }; pose(null) lets go. */
    pose(p) {
      if (!p) { st.posed = false; setExpression('rest'); show(blink, E, ''); if (st.attached) startIdle(); return; }
      st.posed = true;
      clearTimeout(holdTimer); clearInterval(whileTimer); clearTimeout(pendingTimer); pending = null;
      st.speaking = false;
      setExpression(p.expression || 'rest');
      show(blink, E, p.eyes || '');
      for (const a of anims) a.pause();
    },
    destroy() {
      offVoice();
      for (const t of [pendingTimer, holdTimer, settleTimer, blinkTimer]) clearTimeout(t);
      clearInterval(whileTimer);
      for (const a of anims) a.cancel();
      el.remove();
    },
  };
  return ctl;
}
