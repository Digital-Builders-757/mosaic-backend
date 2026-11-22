'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const {
  DEFAULT_TRUST_PROXY_HOPS,
  resolveTrustProxyHops,
} = require('../../utils/trustProxy');
const { createContactInquiryLimiter } = require('../../middlewares/publicRateLimit');

// Mirrors EB LoadBalanced + nginx: the ALB appends the client IP, then nginx
// appends the ALB node IP; supertest's socket peer (loopback) is nginx.
const ALB_NODE_IP = '10.0.1.20';
const xffFor = (clientIp, spoofed) =>
  [spoofed, clientIp, ALB_NODE_IP].filter(Boolean).join(', ');

function ipEchoApp(hops) {
  const app = express();
  app.set('trust proxy', hops);
  app.get('/ip', (req, res) => res.json({ ip: req.ip }));
  return app;
}

test('resolveTrustProxyHops defaults to 2 and only accepts small integers', () => {
  assert.equal(DEFAULT_TRUST_PROXY_HOPS, 2);
  assert.equal(resolveTrustProxyHops(undefined), 2);
  assert.equal(resolveTrustProxyHops(''), 2);
  assert.equal(resolveTrustProxyHops('1'), 1);
  assert.equal(resolveTrustProxyHops('0'), 0);
  assert.equal(resolveTrustProxyHops(' 3 '), 3);
  for (const bad of ['4', '99', '-1', 'true', '1.5', 'loopback', '2abc']) {
    assert.equal(resolveTrustProxyHops(bad), 2, `fallback for ${bad}`);
  }
});

test('one trusted hop resolves every visitor to the ALB node IP (the bug)', async () => {
  const app = ipEchoApp(1);
  const a = await request(app).get('/ip').set('X-Forwarded-For', xffFor('203.0.113.7'));
  const b = await request(app).get('/ip').set('X-Forwarded-For', xffFor('198.51.100.9'));
  assert.equal(a.body.ip, ALB_NODE_IP);
  assert.equal(b.body.ip, ALB_NODE_IP);
});

test('two trusted hops resolve the real client IP behind ALB + nginx', async () => {
  const app = ipEchoApp(resolveTrustProxyHops(undefined));
  const res = await request(app).get('/ip').set('X-Forwarded-For', xffFor('203.0.113.7'));
  assert.equal(res.body.ip, '203.0.113.7');
});

test('a client-supplied X-Forwarded-For prefix cannot spoof the resolved IP', async () => {
  const app = ipEchoApp(resolveTrustProxyHops(undefined));
  const res = await request(app)
    .get('/ip')
    .set('X-Forwarded-For', xffFor('203.0.113.7', '6.6.6.6'));
  assert.equal(res.body.ip, '203.0.113.7');
});

test('contact limiter keeps separate buckets per real client behind ALB + nginx', async () => {
  const app = express();
  app.set('trust proxy', resolveTrustProxyHops(undefined));
  app.post('/contact', createContactInquiryLimiter(), (req, res) => res.status(201).end());

  for (let i = 0; i < 5; i += 1) {
    const ok = await request(app).post('/contact').set('X-Forwarded-For', xffFor('203.0.113.7'));
    assert.equal(ok.status, 201);
  }
  const limited = await request(app).post('/contact').set('X-Forwarded-For', xffFor('203.0.113.7'));
  assert.equal(limited.status, 429);

  const otherClient = await request(app).post('/contact').set('X-Forwarded-For', xffFor('198.51.100.9'));
  assert.equal(otherClient.status, 201, 'a different visitor must not inherit the first bucket');
});
