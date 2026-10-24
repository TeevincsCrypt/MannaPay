/*
 * MannaPay — payment flow bookkeeping.
 *
 * A "flow" starts when the user asks MannaPay to help pay with PayPal and ends
 * when the merchant reports an outcome, or the flow is abandoned or expires.
 */
(function (root) {
  'use strict';

  const FLOW_TTL_MS = 30 * 60 * 1000;
  const HISTORY_LIMIT = 50;

  function createFlow(tabId, page, method, now) {
    const order = (page && page.order) || {};
    return {
      id: 'flow_' + (now ?? Date.now()).toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      tabId,
      origin: page && page.origin,
      startUrl: page && page.url,
      merchant: order.merchant || null,
      total: order.total == null ? null : order.total,
      currency: order.currency || null,
      method: method || null,
      stage: 'started', // started -> at-paypal -> returned
      paypalTabId: null,
      startedAt: now ?? Date.now()
    };
  }

  function isExpired(flow, now) {
    return !flow || (now ?? Date.now()) - flow.startedAt > FLOW_TTL_MS;
  }

  /**
   * Compare the amount on the confirmation page with the checkout total.
   * @returns {'match'|'mismatch'|'unverified'}
   */
  function verifyAmount(flow, result) {
    if (!flow || flow.total == null || !result || result.total == null) return 'unverified';
    if (flow.currency && result.currency && flow.currency !== result.currency) return 'mismatch';
    return Math.abs(flow.total - result.total) < 0.01 ? 'match' : 'mismatch';
  }

  /**
   * @param {object} flow
   * @param {{status:'success'|'cancelled'|'unknown', orderNumber?:string, total?:number, currency?:string, reason?:string}} result
   */
  function historyEntry(flow, result, now) {
    return {
      id: flow.id,
      merchant: flow.merchant,
      origin: flow.origin,
      total: flow.total,
      currency: flow.currency,
      method: flow.method,
      status: result.status,
      orderNumber: result.orderNumber || null,
      confirmedTotal: result.total == null ? null : result.total,
      confirmedCurrency: result.currency || null,
      amountCheck: result.status === 'success' ? verifyAmount(flow, result) : 'unverified',
      reason: result.reason || null,
      startedAt: flow.startedAt,
      finishedAt: now ?? Date.now()
    };
  }

  function appendHistory(history, entry) {
    return [entry].concat((history || []).filter((e) => e.id !== entry.id)).slice(0, HISTORY_LIMIT);
  }

  const api = { FLOW_TTL_MS, HISTORY_LIMIT, createFlow, isExpired, verifyAmount, historyEntry, appendHistory };

  root.MannaPay = Object.assign(root.MannaPay || {}, { flow: api });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
