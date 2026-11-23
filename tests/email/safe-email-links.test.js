// #348 follow-up: vendor-supplied links (booking paymentLink, order trackingUrl)
// must be http(s) only and attribute-escaped before they reach an email href.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { safeHttpUrl, esc } = require('../../utils/emailTemplates/baseLayout');
const logoPath = require.resolve('../../utils/emailLogoAttachment');
require.cache[logoPath] = { id: logoPath, filename: logoPath, loaded: true, exports: {
  resolvePlatformLogoAttachment: async () => ({ attachment: null, logoSrcForHtml: 'https://example.test/logo.png' }),
  withOptionalLogoAttachment: o => o,
} };

function loadWithCapture(rel) {
  const modPath = path.resolve(__dirname, '../..', rel);
  const sent = [];
  const originalLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'nodemailer') return { createTransport: () => ({ sendMail: async m => { sent.push(m); return { messageId: 't' }; } }) };
    if (req.endsWith('/smtpTransport') || req === './smtpTransport') return {
      createMosaicTransport: () => ({ sendMail: async m => { sent.push(m); return { messageId: 't' }; } }),
      formatMosaicFromHeader: () => 'Mosaic <sender@example.test>',
      isSuppressedMailResult: () => false,
    };
    if (req === './emailLogoAttachment') return {
      resolvePlatformLogoAttachment: async () => ({ attachment: null, logoSrcForHtml: 'https://example.test/logo.png' }),
      withOptionalLogoAttachment: o => o,
    };
    return originalLoad.call(this, req, parent, isMain);
  };
  delete require.cache[modPath];
  try { return { mod: require(modPath), sent }; } finally { Module._load = originalLoad; }
}

const hrefs = html => [...html.matchAll(/href="([^"]*)"/g)].map(m => m[1]);
const HOSTILE = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'data:text/html;base64,PHNjcmlwdD4=',
  'https://user:pass@evil.example/pay',
  'not a url',
  '',
];

test('safeHttpUrl accepts only absolute http(s) URLs without credentials', () => {
  assert.equal(safeHttpUrl('https://pay.example.com/p?a=1&b=2'), 'https://pay.example.com/p?a=1&b=2');
  assert.equal(safeHttpUrl('  http://pay.example.com  '), 'http://pay.example.com/');
  for (const value of HOSTILE) assert.equal(safeHttpUrl(value), null, value);
  assert.equal(safeHttpUrl(null), null);
  assert.equal(safeHttpUrl({}), null);
  assert.equal(safeHttpUrl('https://a.example/' + 'x'.repeat(2100)), null);
});

test('attribute-breaking quotes in an otherwise valid URL are neutralized, not injected', async () => {
  const injected = 'https://x.example/" style="display:none" data-x="';
  assert.doesNotMatch(safeHttpUrl(injected), /"/);
  const { mod, sent } = loadWithCapture('utils/bookingMailer.js');
  await mod.sendCustomerServicePaymentRequestEmail({ to: 'customer@example.test', customerName: 'C', vendorName: 'V', bookingId: 'b1', date: 'd', slot: 's', paymentLink: injected });
  assert.doesNotMatch(sent[0].html, /data-x="/);
  assert.ok(hrefs(sent[0].html).includes(esc(safeHttpUrl(injected))));
  const { mod: phase, sent: sent2 } = loadWithCapture('utils/orderPhase.js');
  await phase.sendOrderUpdateEmail('customer@example.test', 'shipped', injected, { firstName: 'C', orderNo: 'o1', trackingId: 't1' });
  assert.doesNotMatch(sent2[0].html, /data-x="/);
  assert.ok(hrefs(sent2[0].html).includes(esc(safeHttpUrl(injected))));
});

test('payment request email: valid link is escaped; hostile link falls back to the bookings page', async () => {
  const { mod, sent } = loadWithCapture('utils/bookingMailer.js');
  const base = { to: 'customer@example.test', customerName: 'C', vendorName: 'V', bookingId: 'b1', date: '2026-11-23', slot: '10:00' };
  await mod.sendCustomerServicePaymentRequestEmail({ ...base, paymentLink: 'https://pay.example.com/p?a=1&b=2' });
  assert.ok(hrefs(sent[0].html).includes('https://pay.example.com/p?a=1&amp;b=2'));
  for (const value of HOSTILE) {
    sent.length = 0;
    await mod.sendCustomerServicePaymentRequestEmail({ ...base, paymentLink: value });
    const links = hrefs(sent[0].html);
    assert.equal(links.length, 1, value);
    assert.match(links[0], /\/customer\/bookings$/, value);
    assert.doesNotMatch(sent[0].html, /javascript:|data:text|evil\.example|style="display:none"/i, value);
  }
});

test('shipped email: hostile tracking URL falls back to the orders page in HTML and text', async () => {
  const { mod, sent } = loadWithCapture('utils/orderPhase.js');
  for (const value of HOSTILE) {
    sent.length = 0;
    await mod.sendOrderUpdateEmail('customer@example.test', 'shipped', value, { firstName: 'C', orderNo: 'o1', trackingId: 't1' });
    const msg = sent[0];
    assert.ok(msg, value);
    assert.doesNotMatch(msg.html, /javascript:|data:text|evil\.example|style="display:none"/i, value);
    assert.doesNotMatch(String(msg.text || ''), /javascript:|data:text|evil\.example/i, value);
    assert.ok(hrefs(msg.html).some(h => /\/customer\/order$/.test(h)), value);
  }
  sent.length = 0;
  await mod.sendOrderUpdateEmail('customer@example.test', 'shipped', 'https://track.example.com/t?id=1&c=2', { firstName: 'C', orderNo: 'o1', trackingId: 't1' });
  assert.ok(hrefs(sent[0].html).includes('https://track.example.com/t?id=1&amp;c=2'));
});
