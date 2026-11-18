// DAYBOOK — tiny DOM helpers.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text for HTML. Every calendar title and setting goes through this. */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);
}

/** Wires every [data-action] button under root to handlers[action](el, event). */
export function wire(root, handlers) {
  root.querySelectorAll('[data-action]').forEach(el => {
    const fn = handlers[el.dataset.action];
    if (fn) el.addEventListener('click', ev => { ev.preventDefault(); fn(el, ev); });
  });
}
