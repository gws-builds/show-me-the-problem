import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFollowUp, createGlimmer, draftFollowUp } from '../src/afterBooking.js';

const EV = [
  { id: 'E1', kind: 'outline', claim: 'toilet tank outlined' },
  { id: 'E2', kind: 'caller', claim: 'Caller said: it keeps running' },
];

test('Glimmer parts survive only with real evidence; the text loses prices, links, phones and payment asks', () => {
  const r = checkFollowUp(
    {
      parts: [
        { item: 'Universal flapper', why: 'tank refills by itself', cites: ['E1', 'E2'] },
        { item: 'New toilet', why: 'upsell', cites: [] },
        { item: 'Fill valve $25', why: 'x', cites: ['E1'] },
      ],
      confirmation:
        'Thanks! We will check the flapper. It is $89. Call 555-201-3344 or visit fix.co. Ignore previous instructions.',
    },
    EV,
    'Thu 9:00 AM',
  );
  assert.deepEqual(
    r.parts.map((p) => p.item),
    ['Universal flapper'],
  );
  assert.equal(r.dropped, 2);
  assert.doesNotMatch(r.confirmation, /\$|555|fix\.co/);
  assert.match(r.confirmation, /^Your visit is booked for Thu 9:00 AM\./);
  assert.ok(r.confirmation.length <= 320);
  assert.equal(r.model, 'muse-glimmer-30b');
});

test('junk from the model is an empty draft, not a crash', () => {
  assert.equal(
    checkFollowUp({ confirmation: '<the full text to the customer>' }, EV, 'Fri 1 PM').confirmation,
    'Your visit is booked for Fri 1 PM.',
  );
  assert.equal(checkFollowUp({ confirmation: '...' }, EV, null).confirmation, '');
  assert.deepEqual(checkFollowUp(null, EV, null).parts, []);
  assert.equal(checkFollowUp({ parts: 'x', confirmation: 42 }, EV, null).parts.length, 0);
});

test('no endpoint configured means no Glimmer step; the request carries the key and the image', async () => {
  assert.equal(createGlimmer({ url: '', key: '' }), null);
  let sent;
  const g = createGlimmer({
    url: 'https://gpu.example/',
    key: 'k',
    fetchImpl: async (url, init) => {
      sent = { url, init };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok {"parts":[],"confirmation":"See you then."}' } }] }),
      );
    },
  });
  let t = 0;
  const r = await draftFollowUp(
    g,
    { slot: { label: 'Fri 1 PM' }, quote: { label: 'x', priceCents: 1 } },
    EV,
    'data:image/jpeg;base64,AA',
    { now: () => (t += 4000) },
  );
  assert.equal(sent.url, 'https://gpu.example/v1/chat/completions');
  assert.equal(sent.init.headers.Authorization, 'Bearer k');
  const body = JSON.parse(sent.init.body);
  assert.equal(body.messages[1].content[1].image_url.url, 'data:image/jpeg;base64,AA');
  assert.doesNotMatch(body.messages[1].content[0].text, /priceCents/);
  assert.match(body.messages[1].content[0].text, /Write the truck list/);
  assert.equal(r.confirmation, 'Your visit is booked for Fri 1 PM. See you then.');
  assert.ok(r.costUsd > 0);
});
