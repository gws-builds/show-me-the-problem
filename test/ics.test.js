import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingIcs } from '../src/ics.js';

const slot = { date: '2026-11-03', startHour: 9, endHour: 11, label: 'Tuesday, Nov 3, 9-11 AM' };

test('an approved visit becomes a calendar invite at the booked time', () => {
  const ics = bookingIcs({
    uid: 'abc',
    slot,
    title: 'Faucet cartridge replacement',
    details: 'Kitchen tap drips; cartridge, seen on camera',
    now: new Date('2026-11-01T12:00:00Z'),
  });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20261103T090000\r\n/);
  assert.match(ics, /DTEND:20261103T110000\r\n/);
  assert.match(ics, /DESCRIPTION:Kitchen tap drips\\; cartridge\\, seen on camera/);
  assert.ok(
    ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75),
    'long lines are folded',
  );
});

test('injected text cannot add calendar fields, and an undated slot makes no invite', () => {
  const ics = bookingIcs({
    uid: 'x',
    slot,
    title: 'Visit\r\nATTENDEE:mailto:evil@example.com',
    details: 'a\nEND:VEVENT',
  });
  assert.ok(!/\r\nATTENDEE:/.test(ics) && !/\r\nEND:VEVENT\r\nEND:VEVENT/.test(ics));
  assert.equal(bookingIcs({ uid: 'x', slot: { label: 'Tuesday' }, title: 't' }), null);
});
