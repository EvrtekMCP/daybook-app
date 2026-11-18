// DAYBOOK — the spoken-line book (app/lines/lines.json) and the play plan.
//
// speak(lineId, parts) turns a line into a PLAN: the list of pieces a voice
// would play, in order. Today the placeholder voice just reads plan.text.
// Later the clip voice plays plan.segments, one recorded clip per piece:
//
//   "Soon, at {time}, your PSW is coming."  with parts { time: "time.10.30" }
//   -> fixed  "soon.psw#1"     "Soon, at"
//      part   "time.10.30@mid" "half past ten"      (mid-sentence tone)
//      fixed  "soon.psw#2"     ", your PSW is coming."
//
// A line with no {slots} is one clip named by its id. A slot followed only by
// punctuation takes the end-of-sentence tone; otherwise the mid tone.
// Pure code: no DOM, no fetch. Tested in Node.

const SLOT_BANK = { time: 'time', name: 'name' };

export class Lines {
  constructor(doc) {
    this.doc = doc;
    this.byId = new Map();
    for (const l of doc.lines || []) this.byId.set(l.id, l);
    this.parts = new Map();
    for (const [bank, b] of Object.entries(doc.banks || {})) {
      for (const p of b.parts || []) this.parts.set(p.id, { bank, text: p.text });
    }
  }

  has(id) { return this.byId.has(id); }
  text(id) { return this.byId.get(id)?.text ?? ''; }

  /** Every line id starting with a prefix, in file order (e.g. "thought."). */
  ids(prefix) {
    return [...this.byId.keys()].filter(id => id.startsWith(prefix));
  }

  /** The slot names a line expects, e.g. ["time"]. */
  slots(id) {
    return [...this.text(id).matchAll(/\{(\w+)\}/g)].map(m => m[1]);
  }

  /**
   * Builds the play plan for a line.
   * parts: { slotName: partId }, e.g. { time: "time.10.30" } or { name: "name" }.
   * ctx.name: her name, for the placeholder voice (the recorded voice uses the "name" clip).
   * Throws if the line or a part is unknown, so a missing line is caught in tests, not by her.
   */
  plan(lineId, parts = {}, ctx = {}) {
    const line = this.byId.get(lineId);
    if (!line) throw new Error(`unknown line: ${lineId}`);
    const text = line.text;
    const re = /\{(\w+)\}/g;
    const segments = [];
    let last = 0, fixedNo = 0, m;
    const hasSlots = /\{\w+\}/.test(text);
    const pushFixed = (s) => {
      if (!/[A-Za-z]/.test(s)) {            // pure punctuation: no clip, keep for the text
        if (s.trim()) segments.push({ kind: 'punct', text: s.trim() });
        return;
      }
      fixedNo += 1;
      segments.push({ kind: 'fixed', clip: hasSlots ? `${lineId}#${fixedNo}` : lineId, text: s.trim() });
    };
    while ((m = re.exec(text))) {
      if (m.index > last) pushFixed(text.slice(last, m.index));
      const slot = m[1];
      const bank = SLOT_BANK[slot];
      if (!bank) throw new Error(`unknown slot {${slot}} in ${lineId}`);
      const partId = parts[slot];
      if (!partId) throw new Error(`missing part {${slot}} for ${lineId}`);
      const part = this.parts.get(partId);
      if (!part || part.bank !== bank) throw new Error(`unknown ${bank} part: ${partId}`);
      const rest = text.slice(re.lastIndex);
      const tone = /^[\s.,!?;:]*$/.test(rest) ? 'end' : 'mid';
      const spokenText = slot === 'name' ? String(ctx.name || '').trim() : part.text;
      segments.push({ kind: 'part', bank, clip: `${partId}@${tone}`, partId, tone, text: spokenText });
      last = re.lastIndex;
    }
    if (last < text.length) pushFixed(text.slice(last));
    return { lineId, text: joinText(segments), segments };
  }
}

/** Joins segment texts into a readable sentence ("Hello," + "Rosie" + "." -> "Hello, Rosie."). */
function joinText(segments) {
  let out = '';
  for (const s of segments) {
    if (!s.text) continue;
    if (!out || /^[.,!?;:]/.test(s.text)) out += s.text;
    else out += ' ' + s.text;
  }
  return out.replace(/\s+/g, ' ').trim();
}
