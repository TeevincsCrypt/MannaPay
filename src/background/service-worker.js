/*
 * MannaPay — background service worker.
 *
 * Keeps per-tab page state (for the badge and popup), tracks PayPal payment
 * flows across navigations and PayPal popup windows, and records outcomes.
 */
'use strict';

importScripts('/src/lib/money.js', '/src/lib/detect.js', '/src/lib/flow.js');

const { detect, flow: Flow, money } = globalThis.MannaPay;

// ---------------------------------------------------------------------------
// Storage. Service workers are short-lived, so per-tab data lives in
// storage.session (cleared when the browser closes) and history in storage.local.
// ---------------------------------------------------------------------------

async function getTabs() {
  const { tabs } = await chrome.storage.session.get({ tabs: {} });
  return tabs;
}

// Events arrive concurrently; run read-modify-write updates one at a time.
let queue = Promise.resolve();

/** Apply `mutate` to a tab's entry. Returning null deletes the entry. */
function updateTab(tabId, mutate) {
  const run = queue.then(async () => {
    const tabs = await getTabs();
    const key = String(tabId);
    const next = mutate(tabs[key] ? Object.assign({}, tabs[key]) : {});
    if (next && Object.keys(next).length) tabs[key] = next; else delete tabs[key];
    await chrome.storage.session.set({ tabs });
    return next || {};
  });
  queue = run.catch(() => {});
  return run;
}

async function findFlowByPayPalTab(tabId) {
  const tabs = await getTabs();
  for (const [key, entry] of Object.entries(tabs)) {
    if (entry.flow && entry.flow.paypalTabId === tabId) return Number(key);
  }
  return null;
}

async function getHistory() {
  const { history } = await chrome.storage.local.get({ history: [] });
  return history;
}

async function record(flow, result) {
  const entry = Flow.historyEntry(flow, result);
  await saveHistoryEntry(entry);
  return entry;
}

async function saveHistoryEntry(entry) {
  await chrome.storage.local.set({ history: Flow.appendHistory(await getHistory(), entry) });
}

const EXPIRED = { status: 'unknown', reason: 'No confirmation was detected within 30 minutes.' };

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

function setBadge(tabId, kind) {
  const styles = {
    available: { text: 'PP', color: '#0070BA' },
    pending: { text: '…', color: '#0070BA' },
    success: { text: '✓', color: '#1E8E3E' },
    cancelled: { text: '!', color: '#B3261E' },
    none: { text: '', color: '#000000' }
  };
  const s = styles[kind] || styles.none;
  chrome.action.setBadgeText({ tabId, text: s.text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: s.color }).catch(() => {});
}

function badgeFor(entry) {
  if (entry.flow) return 'pending';
  if (entry.lastResult && entry.lastResult.status === 'success') return 'success';
  if (entry.lastResult && entry.lastResult.status === 'cancelled') return 'cancelled';
  const page = entry.page;
  if (page && !page.disabled && page.paypal.supported && page.checkout.isCheckout) return 'available';
  return 'none';
}

// ---------------------------------------------------------------------------
// Flow lifecycle
// ---------------------------------------------------------------------------

async function finishFlow(tabId, result) {
  let item = null;
  await updateTab(tabId, (e) => {
    if (!e.flow) return e;
    item = Flow.historyEntry(e.flow, result);
    delete e.flow;
    e.lastResult = item;
    return e;
  });
  if (!item) return null;
  await saveHistoryEntry(item);
  setBadge(tabId, result.status === 'success' ? 'success' : result.status === 'cancelled' ? 'cancelled' : 'none');
  return item;
}

// ---------------------------------------------------------------------------
// Messages from content scripts and the popup
// ---------------------------------------------------------------------------

const handlers = {
  // Content script reports what it found on the page.
  async 'page-state'(msg, sender) {
    const tabId = sender.tab.id;
    let expired = null;
    const entry = await updateTab(tabId, (e) => {
      e.page = msg.page;
      if (e.flow && Flow.isExpired(e.flow)) {
        expired = e.flow;
        delete e.flow;
      }
      return e;
    });
    // Only record expired flows where the user actually reached PayPal.
    if (expired && expired.stage !== 'started') await record(expired, EXPIRED);
    setBadge(tabId, badgeFor(entry));
    return { flow: entry.flow || null, lastResult: entry.lastResult || null };
  },

  // User asked MannaPay to help pay with PayPal.
  async 'flow-start'(msg, sender) {
    const tabId = sender.tab.id;
    const entry = await updateTab(tabId, (e) => {
      // Keep an in-progress flow (e.g. the user pressed the button twice).
      if (!e.flow || Flow.isExpired(e.flow)) e.flow = Flow.createFlow(tabId, msg.page, msg.method);
      delete e.lastResult;
      return e;
    });
    setBadge(tabId, 'pending');
    return { flow: entry.flow };
  },

  // Merchant page reported a success/cancel outcome.
  async 'flow-result'(msg, sender) {
    const entry = await finishFlow(sender.tab.id, msg.result);
    return { entry };
  },

  // User dismissed the flow from the panel.
  async 'flow-abort'(msg, sender) {
    await updateTab(sender.tab.id, (e) => {
      delete e.flow;
      return e;
    });
    return { ok: true };
  },

  async 'get-tab'(msg) {
    const tabs = await getTabs();
    return tabs[String(msg.tabId)] || {};
  },

  async 'get-history'() {
    return { history: await getHistory() };
  },

  async 'clear-history'() {
    await chrome.storage.local.set({ history: [] });
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && handlers[msg.type];
  if (!handler) return false;
  // Content-script messages must come from a tab; popup messages come from our own pages.
  if (['page-state', 'flow-start', 'flow-result', 'flow-abort'].includes(msg.type) && !(sender.tab && sender.tab.id >= 0)) {
    return false;
  }
  handler(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String(err && err.message || err) }));
  return true; // async response
});

// ---------------------------------------------------------------------------
// Tab tracking: PayPal redirects, PayPal popup windows, closed tabs
// ---------------------------------------------------------------------------

// Smart buttons open PayPal in a popup whose opener is the merchant tab.
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId == null) return;
  const url = tab.pendingUrl || tab.url || '';
  if (url && url !== 'about:blank' && !detect.isPayPalUrl(url)) return;
  await updateTab(tab.openerTabId, (e) => {
    if (e.flow && !e.flow.paypalTabId) e.flow.paypalTabId = tab.id;
    return e;
  });
});

// MannaPay doesn't ask for the "tabs" permission, so URLs are only visible
// here for paypal.com (a host permission). Merchant pages are reported by the
// content script instead.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading' && !changeInfo.url) return;
  const url = changeInfo.url || (tab && tab.url) || '';
  if (url && detect.isPayPalUrl(url)) {
    // Same-tab redirect to PayPal, or the popup we linked in onCreated.
    const owner = (await findFlowByPayPalTab(tabId)) ?? tabId;
    await updateTab(owner, (e) => {
      if (e.flow) {
        e.flow.stage = 'at-paypal';
        if (owner !== tabId) e.flow.paypalTabId = tabId;
      }
      return e;
    });
    return;
  }
  if (changeInfo.status !== 'loading') return;
  // A new page is loading: forget the old one; the content script reports the new one.
  await updateTab(tabId, (e) => {
    if (e.flow && e.flow.stage === 'at-paypal' && e.flow.paypalTabId == null) e.flow.stage = 'returned';
    delete e.page;
    if (!e.flow) delete e.lastResult;
    return e;
  });
  setBadge(tabId, 'none');
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  // A PayPal popup closed: the merchant page usually updates in place, ask it to look again.
  const owner = await findFlowByPayPalTab(tabId);
  if (owner != null) {
    await updateTab(owner, (e) => {
      if (e.flow) e.flow.stage = 'returned';
      return e;
    });
    chrome.tabs.sendMessage(owner, { type: 'recheck-outcome' }).catch(() => {});
  }

  // The merchant tab itself closed mid-payment.
  const tabs = await getTabs();
  const entry = tabs[String(tabId)];
  await updateTab(tabId, () => null);
  if (entry && entry.flow && entry.flow.stage !== 'started') {
    await record(entry.flow, { status: 'unknown', reason: 'The tab was closed before a confirmation was shown.' });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeTextColor && chrome.action.setBadgeTextColor({ color: '#FFFFFF' }).catch(() => {});
});

// Exposed for debugging from the service worker console.
globalThis.MannaPayDebug = { getTabs, getHistory, money };
