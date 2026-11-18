// DAYBOOK 0.4.0 — the character on the today screen: Evrtek, from Portero's painted set
// ("the blue shirt style"), with a little life. The art is approved and stands; this file
// only shows the prepared frames (app/img/character/, made by tools/make-character.js).
//
//   at rest     the portrait itself: his warm smile, eyes on her; a slow breath and a
//               slight sway, and a natural blink every few seconds
//   speaking    the mouth follows the voice events (voice.js, mouth.js); open vowels on
//               warm lines (greetings, thanks, praise) use the smile-talk mouth
//   happy       after a thank-you or praise line: his open smile, held a few seconds
//   listening   while a card waits for her answer (medicine, meals, "How are you
//               feeling?", "Would you like a call?"): brows up, attentive; back to rest
//               when the card goes
//
// Calm by design: expressions fade (never snap), the mouth changes at most every 70 ms,
// breathing and sway stop when the device asks for less motion, and nothing ever frowns.
// One element, kept for the whole session and moved into the today screen's portrait
// slot after each redraw, so the motion never restarts.

import { onVoice, speaking } from './voice.js';
import { LipSync, WARM_LINES, mouthFrame } from './mouth.js';

const DIR = 'img/character/';
const MOUTH_TICK_MS = 50;
const SETTLE_MS = 380;            // a gap this short between lines keeps the mouth in "rest", not back to the smile
const BLINK_MS = 130;

/** Loads character.json. Returns null if the frames are not there (the app then shows the plain portrait). */
export async function loadCharacter() {
  try {
    const r = await fetch(`${DIR}character.json`, { cache: 'no-store' });
    if (!r.ok) return null;
    const doc = await r.json();
    if (!doc || !doc.base || !doc.regions || !doc.regions.mouth || !doc.regions.eyes) return null;
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
  const M = doc.regions.mouth, E = doc.regions.eyes;
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
  const mouthX = layer('ch-mouth-x', M, doc.base, version);      // the happy smile (fades)
  const mouth = layer('ch-mouth', M, doc.base, version);         // speech (instant)
  const blink = layer('ch-blink', E, doc.base, version);         // shut lids (instant)
  breathe.append(img, eyesX, mouthX, mouth, blink);

  const lip = new LipSync({ minHoldMs: 70 });
  const st = {
    expression: 'rest', speaking: false, warm: false, mouth: '', eyes: '', blinks: 0, mouthFrames: 0,
    posed: false, attached: false, lastLine: '',
  };
  let pending = null;          // { kind, holdMs, maxMs, while } to apply when the voice is quiet
  let pendingTimer = null, holdTimer = null, whileTimer = null, settleTimer = null, mouthTimer = null, blinkTimer = null;
  let anims = [];

  // --- expressions -----------------------------------------------------------------------

  function setExpression(kind) {
    st.expression = kind;
    show(eyesX, E, kind === 'listen' ? 'listen' : '');
    show(mouthX, M, kind === 'happy' && !st.speaking ? 'happy' : '');
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

  // --- the mouth, from the voice events ----------------------------------------------------

  function mouthTick() {
    const t = now();
    const shape = lip.frameAt(t);
    // the words are over (the engine's "end" can come a second later): his own smile again
    const frame = lip.finished(t) ? '' : mouthFrame(shape, { warm: st.warm, frames: M.frames, standIns: doc.standIns || {} });
    if (frame !== st.mouth) { st.mouth = frame; st.mouthFrames += 1; show(mouth, M, frame); }
  }

  function settle() {
    // the line is over and no other followed: back to the portrait's own mouth
    clearInterval(mouthTimer); mouthTimer = null;
    st.speaking = false;
    st.mouth = '';
    show(mouth, M, '');
    if (pending) { const p = pending; pending = null; clearTimeout(pendingTimer); apply(p); }
    else if (st.expression === 'happy') show(mouthX, M, 'happy');
  }

  const offVoice = onVoice(ev => {
    if (st.posed) return;
    const t = now();
    if (ev.type === 'start') {
      clearTimeout(settleTimer);
      st.speaking = true;
      st.lastLine = ev.lineId || '';
      st.warm = WARM_LINES.test(st.lastLine);
      show(mouthX, M, '');                       // the held smile gives way to speech
      lip.start(ev, t);
      if (!mouthTimer) mouthTimer = setInterval(mouthTick, MOUTH_TICK_MS);
      mouthTick();
    } else if (ev.type === 'boundary') {
      lip.boundary(ev, t);
    } else if (ev.type === 'end') {
      lip.end();
      mouthTick();                               // lips together
      clearTimeout(settleTimer);
      settleTimer = setTimeout(settle, SETTLE_MS);
    }
  });

  // --- blinking ------------------------------------------------------------------------------

  function blinkOnce(done) {
    st.blinks += 1;
    show(blink, E, st.expression === 'listen' ? 'listen-closed' : 'closed');
    st.eyes = blink.dataset.frame;
    setTimeout(() => { if (st.posed) return; show(blink, E, ''); st.eyes = ''; if (done) done(); }, BLINK_MS);
  }

  function scheduleBlink() {
    clearTimeout(blinkTimer);
    const wait = 2600 + Math.random() * 3900;      // about every 4.5 s, never on a beat
    blinkTimer = setTimeout(() => {
      if (st.attached && !st.posed && !document.hidden) {
        if (Math.random() < 0.16) blinkOnce(() => setTimeout(() => blinkOnce(), 150));
        else blinkOnce();
      }
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
        expression: st.expression, speaking: st.speaking || speaking(), warm: st.warm, mouth: st.mouth, eyes: st.eyes,
        blinks: st.blinks, mouthFrames: st.mouthFrames, attached: st.attached, posed: st.posed, lastLine: st.lastLine,
        moving: anims.some(a => a.playState === 'running'), loaded: img.complete && img.naturalWidth > 0,
      };
    },
    /** Holds one exact look for a screenshot: { expression, mouth, eyes }; pose(null) lets go. */
    pose(p) {
      if (!p) { st.posed = false; setExpression('rest'); show(mouth, M, ''); show(blink, E, ''); if (st.attached) startIdle(); return; }
      st.posed = true;
      clearTimeout(holdTimer); clearInterval(whileTimer); clearTimeout(pendingTimer); pending = null;
      st.speaking = false;
      setExpression(p.expression || 'rest');
      show(mouth, M, p.mouth || '');
      show(blink, E, p.eyes || '');
      for (const a of anims) a.pause();
    },
    destroy() {
      offVoice();
      for (const t of [pendingTimer, holdTimer, settleTimer, blinkTimer]) clearTimeout(t);
      clearInterval(whileTimer); clearInterval(mouthTimer);
      for (const a of anims) a.cancel();
      el.remove();
    },
  };
  return ctl;
}
