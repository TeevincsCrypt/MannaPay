'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Flow = require('../src/lib/flow.js');

const page = { url: 'https://acme.example.com/checkout', origin: 'https://acme.example.com', order: { merchant: 'Acme', total: 148.79, currency: 'USD' } };

test('createFlow snapshots the order', () => {
  const f = Flow.createFlow(7, page, 'payment-option', 1000);
  assert.equal(f.tabId, 7);
  assert.equal(f.merchant, 'Acme');
  assert.equal(f.total, 148.79);
  assert.equal(f.stage, 'started');
  assert.equal(f.startedAt, 1000);
});

test('isExpired after 30 minutes', () => {
  const f = Flow.createFlow(1, page, 'button', 0);
  assert.equal(Flow.isExpired(f, Flow.FLOW_TTL_MS - 1), false);
  assert.equal(Flow.isExpired(f, Flow.FLOW_TTL_MS + 1), true);
});

test('verifyAmount', () => {
  const f = Flow.createFlow(1, page, 'button');
  assert.equal(Flow.verifyAmount(f, { total: 148.79, currency: 'USD' }), 'match');
  assert.equal(Flow.verifyAmount(f, { total: 150, currency: 'USD' }), 'mismatch');
  assert.equal(Flow.verifyAmount(f, { total: 148.79, currency: 'EUR' }), 'mismatch');
  assert.equal(Flow.verifyAmount(f, { total: null }), 'unverified');
});

test('historyEntry only checks amounts for successful payments', () => {
  const f = Flow.createFlow(1, page, 'button');
  assert.equal(Flow.historyEntry(f, { status: 'success', total: 148.79, currency: 'USD', orderNumber: 'A1' }).amountCheck, 'match');
  assert.equal(Flow.historyEntry(f, { status: 'cancelled', total: 1 }).amountCheck, 'unverified');
});

test('appendHistory keeps newest first, dedupes and caps', () => {
  let h = [];
  for (let i = 0; i < Flow.HISTORY_LIMIT + 5; i++) h = Flow.appendHistory(h, { id: 'x' + i });
  assert.equal(h.length, Flow.HISTORY_LIMIT);
  assert.equal(h[0].id, 'x' + (Flow.HISTORY_LIMIT + 4));
  h = Flow.appendHistory(h, { id: h[3].id, again: true });
  assert.equal(h.filter((e) => e.id === h[0].id).length, 1);
  assert.equal(h[0].again, true);
});
