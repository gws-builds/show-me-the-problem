import test from 'node:test';
import assert from 'node:assert/strict';
import { callerIp } from '../src/clientIp.js';

const req = (xff) => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: '10.0.0.9' } });

test('S7: the caller is counted from the trusted end of X-Forwarded-For, never a client-supplied entry', () => {
  assert.equal(
    callerIp(req('6.6.6.6, 1.2.3.4'), { trust: true, hops: 1 }),
    '1.2.3.4',
    'a spoofed first entry is ignored',
  );
  assert.equal(callerIp(req('1.2.3.4, 35.191.0.1'), { trust: true, hops: 2 }), '1.2.3.4', 'behind a load balancer');
  assert.equal(callerIp(req('1.2.3.4'), { trust: false }), '10.0.0.9', 'no proxy: the socket address');
  assert.equal(callerIp(req(''), { trust: true }), '10.0.0.9');
  assert.equal(
    callerIp(req('1.2.3.4'), { trust: true, hops: 3 }),
    '10.0.0.9',
    'too few entries falls back, never undefined',
  );
});
