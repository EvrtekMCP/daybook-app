// DAYBOOK — the one way the app talks to his Google Apps Script.
//
// Simple requests only (POST with a text/plain body, no custom headers), so the
// browser sends no CORS preflight; Apps Script answers with a redirect to
// script.googleusercontent.com, which fetch follows. The key travels in the
// body, never in the address. No cookies, no Google sign-in: the script sees an
// anonymous caller with the right key, and nothing more.

/** True when the calendar settings point at his script (URL and key both set). */
export function scriptConfigured(calendarCfg) {
  const c = calendarCfg || {};
  return c.provider === 'appsscript' && !!c.url && !!c.key;
}

/** One call to the script. Resolves with its JSON answer ({ ok: true, ... }); throws otherwise. */
export async function scriptCall(calendarCfg, body) {
  const c = calendarCfg || {};
  const r = await fetch(c.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ key: c.key }, body)),
    redirect: 'follow',
    cache: 'no-store',
    credentials: 'omit',
  });
  if (!r.ok) throw new Error(`calendar answered ${r.status}`);
  const j = await r.json();
  if (!j || !j.ok) throw new Error((j && j.error) || 'calendar refused');
  return j;
}
