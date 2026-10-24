/*
 * End-to-end test: loads the unpacked extension into Chromium and drives the
 * fixture pages through detection, assistance and outcome tracking.
 *
 *   npm run test:e2e
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

// Serve fixtures under realistic checkout URLs.
const ROUTES = {
  '/checkout': 'checkout-radio.html',
  '/basket': 'cart-express.html',
  '/kasse/checkout': 'checkout-smart.html',
  '/product': 'product.html'
};

function serve() {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    const file = ROUTES[pathname] || path.basename(pathname);
    const full = path.join(FIXTURES, file);
    if (!full.startsWith(FIXTURES) || !fs.existsSync(full) || !file.endsWith('.html')) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(full).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, timeout = 8000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(150);
  }
  throw new Error('Timed out waiting for ' + what + (last !== undefined ? ' (last: ' + JSON.stringify(last) + ')' : ''));
}

async function main() {
  const server = await serve();
  const base = 'http://127.0.0.1:' + server.address().port;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mannapay-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: ['--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT]
  });
  // Keep the test offline: stub PayPal's SDK and button iframe.
  await context.route(/paypal\.com|paypalobjects\.com/, (route) => route.fulfill({ status: 200, body: '' }));

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');

  const bg = (fn, arg) => worker.evaluate(fn, arg);
  // The extension has no "tabs" permission, so find tabs through the state content scripts report.
  const tabIdFor = (url) => waitFor(() => bg(async (u) => {
    const { tabs } = await chrome.storage.session.get({ tabs: {} });
    const hit = Object.entries(tabs).find(([, e]) => e.page && e.page.url.startsWith(u));
    return hit ? Number(hit[0]) : null;
  }, url), 'tab for ' + url);
  const tabEntry = (tabId) => bg(async (id) => (await chrome.storage.session.get({ tabs: {} })).tabs[String(id)] || {}, tabId);
  const history = () => bg(async () => (await chrome.storage.local.get({ history: [] })).history);
  const setSettings = (s) => bg((v) => chrome.storage.sync.set({ settings: v }), s);
  const assist = (tabId) => bg((id) => chrome.tabs.sendMessage(id, { type: 'assist' }), tabId);
  const badge = (tabId) => bg((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
  const panelShown = (page) => page.evaluate(() => !!document.querySelector('mannapay-panel'));

  const results = [];
  async function step(name, fn) {
    try {
      await fn();
      results.push(['ok', name]);
      console.log('ok   ' + name);
    } catch (err) {
      results.push(['FAIL', name]);
      console.log('FAIL ' + name + '\n     ' + String(err && err.stack || err).split('\n').slice(0, 4).join('\n     '));
    }
  }

  const page = await context.newPage();
  const shots = path.join(ROOT, 'test', 'e2e', 'screenshots');
  fs.mkdirSync(shots, { recursive: true });

  await step('detects a checkout with a PayPal payment option', async () => {
    await page.goto(base + '/checkout');
    await waitFor(() => panelShown(page), 'panel');
    const tabId = await tabIdFor(base + '/checkout');
    const entry = await waitFor(async () => { const e = await tabEntry(tabId); return e.page && e; }, 'page state');
    assert.equal(entry.page.checkout.stage, 'checkout');
    assert.equal(entry.page.paypal.supported, true);
    assert.equal(entry.page.paypal.best.kind, 'payment-option');
    assert.equal(entry.page.order.merchant, 'Acme Outfitters');
    assert.equal(entry.page.order.total, 148.79);
    assert.equal(entry.page.order.currency, 'USD');
    assert.equal(await badge(tabId), 'PP');
    await page.screenshot({ path: path.join(shots, 'checkout-panel.png') });
  });

  await step('assist selects PayPal but leaves "Place order" to the user, then confirms the outcome', async () => {
    const tabId = await tabIdFor(base + '/checkout');
    await assist(tabId);
    await waitFor(() => page.evaluate(() => document.querySelector('input[value="paypal_express"]').checked), 'PayPal radio checked');
    await sleep(1000);
    assert.equal(new URL(page.url()).pathname, '/checkout', 'must not submit the order itself');
    const entry = await waitFor(async () => { const e = await tabEntry(tabId); return e.flow && e; }, 'flow');
    assert.equal(entry.flow.method, 'payment-option');
    await page.screenshot({ path: path.join(shots, 'checkout-assisted.png') });

    await page.click('#place-order'); // the user places the order
    await page.waitForURL(/thank-you/);
    const [h] = await waitFor(async () => { const h = await history(); return h.length && h; }, 'history entry');
    assert.equal(h.status, 'success');
    assert.equal(h.orderNumber, 'A10023');
    assert.equal(h.amountCheck, 'match');
    assert.equal(h.merchant, 'Acme Outfitters');
    assert.equal(await badge(tabId), '✓');
    assert.ok(await panelShown(page), 'confirmation panel');
    await page.screenshot({ path: path.join(shots, 'confirmed.png') });
  });

  await step('express PayPal button on a cart is clicked for the user; amount mismatch is flagged', async () => {
    await page.goto(base + '/basket');
    await waitFor(() => panelShown(page), 'panel');
    const tabId = await tabIdFor(base + '/basket');
    const entry = await waitFor(async () => { const e = await tabEntry(tabId); return e.page && e; }, 'page state');
    assert.equal(entry.page.checkout.stage, 'cart');
    assert.equal(entry.page.paypal.best.kind, 'button');
    assert.equal(entry.page.order.total, 58);
    await assist(tabId);
    await page.waitForURL(/thank-you\.html\?via=paypal/);
    const [h] = await waitFor(async () => { const h = await history(); return h.length === 2 && h; }, 'second history entry');
    assert.equal(h.status, 'success');
    assert.equal(h.method, 'button');
    assert.equal(h.amountCheck, 'mismatch'); // fixture confirmation shows $148.79, cart showed £58
    assert.equal(h.merchant, '127.0.0.1');
  });

  await step('smart-button checkout is highlighted for the user to click', async () => {
    await page.goto(base + '/kasse/checkout');
    await waitFor(() => panelShown(page), 'panel');
    const tabId = await tabIdFor(base + '/kasse/checkout');
    const entry = await waitFor(async () => { const e = await tabEntry(tabId); return e.page && e; }, 'page state');
    assert.equal(entry.page.paypal.best.kind, 'smart-button');
    assert.equal(entry.page.order.total, 1234.56);
    assert.equal(entry.page.order.currency, 'EUR');
    await assist(tabId);
    await waitFor(() => page.evaluate(() => document.getElementById('paypal-button-container').style.outline.includes('solid')), 'highlight');
    const after = await waitFor(async () => { const e = await tabEntry(tabId); return e.flow && e; }, 'flow');
    assert.equal(after.flow.method, 'smart-button');
  });

  await step('auto-select picks PayPal without submitting', async () => {
    await setSettings({ showPanel: true, autoSelect: true, disabledSites: [] });
    await page.goto(base + '/checkout');
    await waitFor(() => page.evaluate(() => document.querySelector('input[value="paypal_express"]').checked), 'auto-selected');
    await sleep(500);
    assert.equal(new URL(page.url()).pathname, '/checkout');
  });

  await step('no panel on product pages or disabled sites', async () => {
    await setSettings({ showPanel: true, autoSelect: false, disabledSites: [] });
    await page.goto(base + '/product');
    await sleep(1500);
    assert.equal(await panelShown(page), false);
    // The smart-button flow never reached PayPal, so leaving the checkout drops it.
    assert.equal((await tabEntry(await tabIdFor(base + '/product'))).flow, undefined);

    await setSettings({ showPanel: true, autoSelect: false, disabledSites: ['127.0.0.1'] });
    await page.goto(base + '/checkout');
    await sleep(1500);
    assert.equal(await panelShown(page), false);
    const tabId = await tabIdFor(base + '/checkout');
    assert.equal(await badge(tabId), '');
  });

  await step('popup renders', async () => {
    await setSettings({ showPanel: true, autoSelect: false, disabledSites: [] });
    const id = new URL(worker.url()).host;
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 340, height: 600 });
    await popup.goto('chrome-extension://' + id + '/src/popup/popup.html');
    await waitFor(() => popup.evaluate(() => document.querySelectorAll('#history li').length === 2), 'history list');
    await popup.screenshot({ path: path.join(shots, 'popup.png'), fullPage: true });
    await popup.close();
  });

  await context.close();
  server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const failed = results.filter(([s]) => s === 'FAIL').length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
