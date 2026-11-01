import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseMobile, createSms } from '../src/sms.js';

test('only North American mobiles in any common format', () => {
  assert.equal(normaliseMobile('416-555-0100'), '+14165550100');
  assert.equal(normaliseMobile('+1 (302) 400-8040'), '+13024008040');
  assert.equal(normaliseMobile('1 416 555 0100'), '+14165550100');
  for (const bad of ['', '911', '+442079460958', '+10165550100', '416555010']) assert.equal(normaliseMobile(bad), null, bad);
});

test('no key or no sending line means no texting, never a crash', () => {
  assert.equal(createSms({ apiKey: '', from: '+13024008040' }), null);
  assert.equal(createSms({ apiKey: 'k', from: 'abc' }), null);
});

test('a carrier refusal reads as words, and 10DLC is named', async () => {
  const sms = createSms({ apiKey: 'k', from: '+13024008040', fetchImpl: async () => new Response(JSON.stringify({ errors: [{ code: '40010', title: 'x' }] }), { status: 400 }) });
  await assert.rejects(sms.send('+14165550100', 'hi'), /10DLC/);
});
