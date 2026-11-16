// DAYBOOK — event types. Spoken lines come from the TYPE plus the time; the title
// (free text) is shown on screen, never spoken.
// Keep this list in step with TYPES in apps-script/Code.gs (a test checks it).

export const EVENT_TYPES = [
  { id: 'psw', label: 'PSW visit', title: 'PSW visit', minutes: 60 },
  { id: 'doctor', label: 'Doctor', title: 'Doctor appointment', minutes: 60 },
  { id: 'dentist', label: 'Dentist', title: 'Dentist appointment', minutes: 60 },
  { id: 'family', label: 'Family visit', title: 'Family visit', minutes: 120 },
  { id: 'other', label: 'Something else', title: 'Appointment', minutes: 60 },
];

export const TYPE_IDS = EVENT_TYPES.map(t => t.id);

export function typeInfo(id) {
  return EVENT_TYPES.find(t => t.id === id) || EVENT_TYPES[EVENT_TYPES.length - 1];
}

/**
 * The type of an event Evrtek typed into Google Calendar himself.
 * A tag wins (the script reads "#psw", "#doctor", "#dentist", "#family" or
 * "#other" from the event description); otherwise the title is read for
 * keywords; otherwise "other".
 */
export function inferType(title, tag) {
  if (tag && TYPE_IDS.includes(tag)) return tag;
  const t = String(title || '').toLowerCase();
  if (/\bpsw\b|personal support|support worker|care ?giver|home ?care/.test(t)) return 'psw';
  if (/dentist|dental|hygienist/.test(t)) return 'dentist';
  if (/doctor|\bdr\b\.?|clinic|physician|\bgp\b|check-?up/.test(t)) return 'doctor';
  if (/family|visit/.test(t)) return 'family';
  return 'other';
}
