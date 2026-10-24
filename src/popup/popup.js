/*
 * MannaPay — toolbar popup.
 */
'use strict';

const { money, settings: Settings } = globalThis.MannaPay;
const $ = (id) => document.getElementById(id);

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      void chrome.runtime.lastError;
      resolve(response || null);
    });
  });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function hostnameOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname : null;
  } catch (_) {
    return null;
  }
}

function describe(page, flow) {
  if (flow) return { text: flow.stage === 'at-paypal' ? 'Finishing on PayPal…' : 'Payment in progress…', tone: 'ok' };
  if (!page) return { text: 'Nothing to do on this page.', tone: 'none' };
  if (page.disabled) return { text: 'MannaPay is turned off for this site.', tone: 'none' };
  if (page.checkout.stage === 'confirmation') return { text: 'Order confirmation page.', tone: 'none' };
  if (!page.checkout.isCheckout) {
    return page.paypal.supported
      ? { text: 'This site supports PayPal. MannaPay will help at checkout.', tone: 'ok' }
      : { text: 'No checkout detected on this page.', tone: 'none' };
  }
  if (page.paypal.supported) return { text: 'PayPal is available at this checkout.', tone: 'ok' };
  if (page.paypal.confidence === 'low') return { text: 'PayPal is mentioned, but no PayPal option was found yet.', tone: 'none' };
  return { text: 'This checkout doesn’t appear to offer PayPal.', tone: 'none' };
}

async function renderSite(tab, settings) {
  const hostname = hostnameOf(tab && tab.url);
  $('site-host').textContent = hostname || 'This page';
  $('site-enabled').closest('label').hidden = !hostname;
  $('site-enabled').checked = !!hostname && !Settings.isSiteDisabled(settings, hostname);

  const entry = tab ? await send({ type: 'get-tab', tabId: tab.id }) : null;
  const page = entry && entry.page;
  const flow = entry && entry.flow;
  const status = describe(page, flow);
  $('site-status').textContent = status.text;
  $('site-status').className = 'status ' + status.tone;

  const order = page && !page.disabled && page.order;
  const showOrder = !!order && (page.checkout.isCheckout || !!flow);
  $('site-order').hidden = !showOrder;
  if (showOrder) {
    $('order-merchant').textContent = order.merchant;
    $('order-total').textContent = order.total != null ? money.formatMoney(order.total, order.currency) : 'Total not detected';
    const warn = order.currency && order.currencySupported === false
      ? order.currency + ' isn’t a PayPal currency. PayPal may convert it.'
      : '';
    $('order-warn').hidden = !warn;
    $('order-warn').textContent = warn;
  }

  const canAssist = !!page && !page.disabled && !flow && page.checkout.isCheckout && page.paypal.supported && !!page.paypal.best;
  $('assist').hidden = !canAssist;
  if (canAssist) {
    $('assist').textContent = page.paypal.best.kind === 'smart-button' ? 'Show me the PayPal button' : 'Pay with PayPal';
  }
}

function renderHistory(history) {
  const list = $('history');
  list.textContent = '';
  $('history-empty').hidden = history.length > 0;
  $('clear-history').hidden = history.length === 0;
  const labels = { success: 'Confirmed', cancelled: 'Cancelled', unknown: 'Not confirmed' };
  history.slice(0, 8).forEach((h) => {
    const li = document.createElement('li');
    const what = document.createElement('div');
    what.className = 'what';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = h.merchant || h.origin || 'Unknown merchant';
    const meta = document.createElement('div');
    meta.className = 'muted';
    const when = new Date(h.finishedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    meta.textContent = when + (h.orderNumber ? ' · #' + h.orderNumber : '');
    if (h.reason) meta.title = h.reason;
    what.append(name, meta);

    const right = document.createElement('div');
    const amount = document.createElement('div');
    amount.className = 'amount';
    const value = h.confirmedTotal != null ? h.confirmedTotal : h.total;
    amount.textContent = value != null ? money.formatMoney(value, h.confirmedCurrency || h.currency) : '—';
    const pill = document.createElement('div');
    pill.className = 'pill ' + h.status;
    pill.textContent = labels[h.status] || h.status;
    if (h.amountCheck === 'mismatch') pill.textContent += ' · amount differs';
    right.append(amount, pill);

    li.append(what, right);
    list.append(li);
  });
}

async function main() {
  const [tab, settings, historyResponse] = await Promise.all([activeTab(), Settings.load(), send({ type: 'get-history' })]);

  $('show-panel').checked = settings.showPanel;
  $('auto-select').checked = settings.autoSelect;
  await renderSite(tab, settings);
  renderHistory((historyResponse && historyResponse.history) || []);

  $('show-panel').addEventListener('change', (e) => Settings.update({ showPanel: e.target.checked }));
  $('auto-select').addEventListener('change', (e) => Settings.update({ autoSelect: e.target.checked }));
  $('site-enabled').addEventListener('change', async (e) => {
    const hostname = hostnameOf(tab.url);
    const next = await Settings.setSiteDisabled(hostname, !e.target.checked);
    // Give the content script a moment to re-report the page.
    setTimeout(() => renderSite(tab, next), 300);
  });
  $('assist').addEventListener('click', async () => {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'assist' });
    } catch (_) {
      $('site-status').textContent = 'Reload the page to let MannaPay help here.';
      return;
    }
    window.close();
  });
  $('clear-history').addEventListener('click', async () => {
    await send({ type: 'clear-history' });
    renderHistory([]);
  });
}

main();
