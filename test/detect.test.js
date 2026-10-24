'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const detect = require('../src/lib/detect.js');
const { loadFixture, domFrom } = require('./helpers.js');

test('checkout with PayPal payment radio', () => {
  const { doc, url } = loadFixture('checkout-radio.html', 'https://acme.example.com/checkout');
  const r = detect.analyze(doc, url);
  assert.equal(r.checkout.isCheckout, true);
  assert.equal(r.checkout.stage, 'checkout');
  assert.equal(r.paypal.supported, true);
  assert.equal(r.paypal.best.kind, 'payment-option');
  assert.equal(r.paypal.best.element.value, 'paypal_express');
  assert.equal(r.paypal.best.checked, false);
  // "What is PayPal?" is not an entry point.
  assert.ok(!r.paypal.candidates.some((c) => c.element.tagName === 'A'));
  assert.equal(r.order.merchant, 'Acme Outfitters');
  assert.equal(r.order.total, 148.79);
  assert.equal(r.order.currency, 'USD');
  assert.equal(r.order.currencySupported, true);
});

test('checkout with PayPal smart buttons (SDK iframe), European number format', () => {
  const { doc, url } = loadFixture('checkout-smart.html', 'https://bergwerk.example.de/kasse/checkout');
  const r = detect.analyze(doc, url);
  assert.equal(r.checkout.isCheckout, true);
  assert.equal(r.paypal.supported, true);
  assert.equal(r.paypal.confidence, 'high');
  assert.equal(r.paypal.sdk.present, true);
  assert.equal(r.paypal.sdk.currency, 'EUR');
  assert.equal(r.paypal.best.kind, 'smart-button');
  assert.equal(r.paypal.candidates.length, 1, 'container and iframe count once');
  assert.equal(r.order.merchant, 'Bergwerk Kaffee');
  assert.equal(r.order.total, 1234.56);
  assert.equal(r.order.currency, 'EUR');
});

test('cart with express PayPal button ignores subtotal and savings', () => {
  const { doc, url } = loadFixture('cart-express.html', 'https://www.linenhouse.co.uk/basket');
  const r = detect.analyze(doc, url);
  assert.equal(r.checkout.isCheckout, true);
  assert.equal(r.checkout.stage, 'cart');
  assert.equal(r.paypal.best.kind, 'button');
  assert.equal(r.paypal.best.element.id, 'express');
  assert.equal(r.order.total, 58);
  assert.equal(r.order.currency, 'GBP');
  assert.equal(r.order.merchant, 'Linenhouse');
});

test('checkout without PayPal is detected but not supported', () => {
  const { doc, url } = loadFixture('no-paypal.html', 'https://store.example.com/checkout/payment');
  const r = detect.analyze(doc, url);
  assert.equal(r.checkout.isCheckout, true);
  assert.equal(r.paypal.supported, false);
  assert.equal(r.paypal.confidence, 'none');
  assert.equal(r.order.total, 42);
  assert.equal(r.order.currency, 'USD');
});

test('product page with PayPal in footer is not a checkout and not actionable', () => {
  const { doc, url } = loadFixture('product.html', 'https://kiln.example.com/products/mug');
  const r = detect.analyze(doc, url);
  assert.equal(r.checkout.isCheckout, false);
  assert.equal(r.paypal.supported, false);
  assert.equal(r.paypal.confidence, 'low');
});

test('confirmation page reports success and order number', () => {
  const { doc, url } = loadFixture('thank-you.html', 'https://acme.example.com/checkout/thank-you');
  const outcome = detect.detectOutcome(doc, url);
  assert.equal(outcome.status, 'success');
  assert.equal(outcome.orderNumber, 'A10023');
  const r = detect.analyze(doc, url);
  assert.equal(r.checkout.stage, 'confirmation');
  assert.equal(r.checkout.isCheckout, false);
  assert.equal(r.order.total, 148.79);
});

test('cancelled payment is reported', () => {
  const { doc, url } = loadFixture('cancelled.html', 'https://acme.example.com/checkout?paypal=1');
  assert.equal(detect.detectOutcome(doc, url).status, 'cancelled');
  const viaUrl = domFrom('<h1>Checkout</h1>', 'https://acme.example.com/checkout?cancel=1');
  assert.equal(detect.detectOutcome(viaUrl.doc, viaUrl.url).status, 'cancelled');
});

test('hidden PayPal buttons are ignored', () => {
  const { doc } = domFrom('<button style="display:none">Pay with PayPal</button><div hidden><button>PayPal</button></div>');
  assert.equal(detect.detectPayPal(doc).candidates.length, 0);
});

test('explicit "pay with PayPal" button is preferred over a generic one', () => {
  const { doc } = domFrom('<button id="a">PayPal Credit</button><button id="b">Pay with PayPal</button>');
  assert.equal(detect.detectPayPal(doc).best.element.id, 'b');
});

test('isPayPalUrl', () => {
  assert.ok(detect.isPayPalUrl('https://www.paypal.com/checkoutnow?token=x'));
  assert.ok(detect.isPayPalUrl('https://www.sandbox.paypal.com/'));
  assert.ok(!detect.isPayPalUrl('https://paypal.com.evil.example/'));
  assert.ok(!detect.isPayPalUrl('not a url'));
});

test('merchant name falls back to hostname', () => {
  const { doc } = domFrom('<p>hi</p>');
  assert.equal(detect.merchantName(doc, 'https://checkout.bluebird-books.com/x'), 'Bluebird-books');
  assert.equal(detect.merchantName(doc, 'https://www.example.co.uk/'), 'Example');
  assert.equal(detect.merchantName(doc, 'http://127.0.0.1:8080/checkout'), '127.0.0.1');
  assert.equal(detect.merchantName(doc, 'http://localhost:3000/'), 'localhost');
});

test('checkout copy mentioning a future confirmation email is not a success', () => {
  const { doc, url } = domFrom('<h1>Checkout</h1><p>You will receive an order confirmation email.</p>', 'https://a.example.com/checkout');
  assert.equal(detect.detectOutcome(doc, url).status, 'unknown');
});
