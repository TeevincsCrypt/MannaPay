'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const money = require('../src/lib/money.js');

test('parseAmount handles common separators', () => {
  assert.equal(money.parseAmount('1,234.56'), 1234.56);
  assert.equal(money.parseAmount('1.234,56'), 1234.56);
  assert.equal(money.parseAmount('1 234,56'), 1234.56);
  assert.equal(money.parseAmount('12,50'), 12.5);
  assert.equal(money.parseAmount('1,234'), 1234);
  assert.equal(money.parseAmount('1.234'), 1234);
  assert.equal(money.parseAmount('99'), 99);
  assert.equal(money.parseAmount('-5.00'), -5);
  assert.equal(money.parseAmount('abc'), null);
});

test('zero-decimal currencies never read a separator as decimals', () => {
  assert.equal(money.parseAmount('12,50', 'JPY'), 1250);
});

test('parseMoney finds symbol and code currencies', () => {
  assert.deepEqual(pick(money.parseMoney('Total $148.79')), [148.79, 'USD']);
  assert.deepEqual(pick(money.parseMoney('1.234,56 €')), [1234.56, 'EUR']);
  assert.deepEqual(pick(money.parseMoney('£58.00')), [58, 'GBP']);
  assert.deepEqual(pick(money.parseMoney('USD 42.00')), [42, 'USD']);
  assert.deepEqual(pick(money.parseMoney('CA$ 19.99')), [19.99, 'CAD']);
  assert.deepEqual(pick(money.parseMoney('¥3,200')), [3200, 'JPY']);
});

test('bare dollar resolves using locale and hostname hints', () => {
  assert.equal(money.parseMoney('$10.00', { locale: 'en-CA' }).currency, 'CAD');
  assert.equal(money.parseMoney('$10.00', { hostname: 'shop.example.com.au' }).currency, 'AUD');
  assert.equal(money.parseMoney('$10.00', {}).currency, 'USD');
});

test('numbers without currency need decimals to count as money', () => {
  assert.equal(money.parseMoney('Qty 2'), null);
  assert.deepEqual(pick(money.parseMoney('Total 15.00')), [15, null]);
});

test('isPayPalCurrency', () => {
  assert.ok(money.isPayPalCurrency('usd'));
  assert.ok(!money.isPayPalCurrency('INR'));
});

function pick(v) {
  return v && [v.amount, v.currency];
}
