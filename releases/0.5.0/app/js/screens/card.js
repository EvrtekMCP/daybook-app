// DAYBOOK — the big reminder card. One card at a time over whatever is on screen;
// any others wait their turn. Nothing flashes: a card fades in slowly and stays
// until it is answered or its time has passed.

import { esc, wire } from '../util.js';
import { nowMs } from '../clock.js';

const queue = [];      // waiting cards
let current = null;    // the card on screen
let overlay = null;

export function initCards(el) { overlay = el; }
export function currentCard() { return current; }
export function cardsWaiting() { return queue.map(c => c.id); }

/**
 * Shows a card, or queues it behind the one on screen.
 * spec: { id, tone, kicker, title, body, time, choices: [{ label, onTap }], buttons: [{ label, primary, onTap }], until }
 * (choices: a row of large, equal answers, such as the "How are you feeling?" three)
 * A card with the id of the one on screen replaces it in place.
 */
export function showCard(spec) {
  if (current && current.id === spec.id) { current = spec; draw(); return; }
  const i = queue.findIndex(c => c.id === spec.id);
  if (i >= 0) queue.splice(i, 1);
  if (current) {
    // medicine goes to the front of the line, everything else waits in order
    if (spec.tone === 'medicine') queue.unshift(spec); else queue.push(spec);
    return;
  }
  current = spec;
  draw();
}

export function closeCard(id) {
  if (id && (!current || current.id !== id)) {
    const i = queue.findIndex(c => c.id === id);
    if (i >= 0) queue.splice(i, 1);
    return;
  }
  current = null;
  const next = queue.shift();
  if (next) { current = next; draw(); }
  else { overlay.hidden = true; overlay.innerHTML = ''; }
}

/** Closes cards whose time has passed (called from the clock tick). */
export function expireCards() {
  const t = nowMs();
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].until && t >= queue[i].until) queue.splice(i, 1);
  if (current && current.until && t >= current.until) closeCard(current.id);
}

function draw() {
  const c = current;
  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="card tone-${esc(c.tone || 'plain')}" role="dialog" aria-modal="true" aria-labelledby="card-title">
      ${c.kicker ? `<p class="card-kicker">${esc(c.kicker)}</p>` : ''}
      <h2 class="card-title" id="card-title">${esc(c.title)}</h2>
      ${c.time ? `<p class="card-time">${esc(c.time)}</p>` : ''}
      ${c.body ? `<p class="card-body">${esc(c.body)}</p>` : ''}
      ${c.choices ? `<div class="card-choices">${c.choices.map((b, i) => `<button class="btn btn-choice btn-feel" data-action="c${i}">${esc(b.label)}</button>`).join('')}</div>` : ''}
      <div class="card-buttons">
        ${(c.buttons || []).map((b, i) => `<button class="btn ${b.primary ? 'btn-primary btn-big' : 'btn-secondary'}" data-action="b${i}">${esc(b.label)}</button>`).join('')}
      </div>
    </div>`;
  const handlers = {};
  (c.buttons || []).forEach((b, i) => { handlers[`b${i}`] = () => b.onTap && b.onTap(); });
  (c.choices || []).forEach((b, i) => { handlers[`c${i}`] = () => b.onTap && b.onTap(); });
  wire(overlay, handlers);
}
