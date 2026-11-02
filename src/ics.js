// The approved visit as a calendar invite (RFC 5545), so "booked" is a real entry in the owner's own
// calendar (Google, Apple, Outlook all open .ics) with no calendar account connected to the demo.
// Times are floating local times: a visit at 9 AM is 9 AM wherever the owner's calendar is.

const esc = (s) =>
  String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
// Lines longer than 75 octets are folded with CRLF + space, as the format requires.
const fold = (line) => {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let n = 75;
    while (Buffer.byteLength(rest.slice(0, n)) > 75) n -= 1;
    out.push(rest.slice(0, n));
    rest = ` ${rest.slice(n)}`;
  }
  out.push(rest);
  return out.join('\r\n');
};
const stamp = (d) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
const local = (date, hour) => `${date.replace(/-/g, '')}T${String(hour).padStart(2, '0')}0000`;

/** slot: { date: 'YYYY-MM-DD', startHour, endHour, label }; returns the .ics text, or null without a dated slot. */
export function bookingIcs({ uid, slot, title, details, now = new Date() }) {
  if (
    !slot ||
    !/^\d{4}-\d{2}-\d{2}$/.test(slot.date ?? '') ||
    !Number.isInteger(slot.startHour) ||
    !Number.isInteger(slot.endHour)
  )
    return null;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Show Me the Problem//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}@show-me-the-problem`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${local(slot.date, slot.startHour)}`,
    `DTEND:${local(slot.date, slot.endHour)}`,
    `SUMMARY:${esc(String(title ?? 'Service visit').slice(0, 120))}`,
    `DESCRIPTION:${esc(String(details ?? '').slice(0, 1500))}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
