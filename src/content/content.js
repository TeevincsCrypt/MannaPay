/*
 * MannaPay — content script.
 *
 * Analyzes the page, shows the assistant panel on checkouts that accept PayPal,
 * performs the steps the user asks for, and reports payment outcomes.
 *
 * Safety rules:
 *  - Nothing is clicked or submitted unless the user pressed a MannaPay button,
 *    except the opt-in "auto-select PayPal" setting, which only selects the
 *    PayPal payment option and never submits a form.
 *  - MannaPay never runs on paypal.com and never enters credentials. Payment is
 *    always approved by the user on PayPal itself.
 */
(function () {
  'use strict';

  if (window.top !== window || globalThis.__mannapayLoaded) return;
  globalThis.__mannapayLoaded = true;

  const { detect, money, settings: Settings } = globalThis.MannaPay;

  const DISMISS_KEY = 'mannapay:dismissed';
  const ACTION_TEXT_RE = /^(place\s+(your\s+)?order|complete\s+(order|purchase|payment)|submit\s+order|confirm\s+(order|purchase)|continue(\s+to\s+(pay\s?pal|payment|checkout))?|proceed(\s+to\s+(pay\s?pal|payment))?|pay(\s+now)?|review\s+order)\b/i;

  let settings = Settings.DEFAULTS;
  let analysis = null;
  let flow = null;
  let lastUrl = location.href;
  let autoSelectedOn = null;
  let outcomeReported = false;
  let status = null; // transient message in the panel: {tone, text}
  let result = null; // last flow outcome for this page
  let lastSent = null; // last page summary sent to the background, as JSON

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          void chrome.runtime.lastError; // extension reloaded / worker asleep
          resolve(response || null);
        });
      } catch (_) {
        resolve(null); // extension context invalidated
      }
    });
  }

  function summary() {
    const a = analysis;
    return {
      url: location.href,
      origin: location.origin,
      hostname: location.hostname,
      disabled: Settings.isSiteDisabled(settings, location.hostname),
      checkout: a ? { isCheckout: a.checkout.isCheckout, stage: a.checkout.stage, signals: a.checkout.signals } : { isCheckout: false, stage: null, signals: [] },
      paypal: a ? {
        supported: a.paypal.supported,
        confidence: a.paypal.confidence,
        sdk: a.paypal.sdk.present,
        best: a.paypal.best ? { kind: a.paypal.best.kind, label: a.paypal.best.label, checked: !!a.paypal.best.checked } : null,
        count: a.paypal.candidates.length
      } : { supported: false, confidence: 'none', sdk: false, best: null, count: 0 },
      order: a ? a.order : null
    };
  }

  // ---------------------------------------------------------------------------
  // Analysis loop
  // ---------------------------------------------------------------------------

  /** Report the page to the background when it changed (or when forced), and pick up any flow. */
  async function report(force) {
    const page = summary();
    const json = JSON.stringify(page);
    if (!force && json === lastSent) return;
    lastSent = json;
    const response = await send({ type: 'page-state', page });
    flow = response && response.flow;
    if (response && response.lastResult && !result) result = response.lastResult;
  }

  async function refresh(force) {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      status = null;
      outcomeReported = false;
    }
    if (Settings.isSiteDisabled(settings, location.hostname)) {
      analysis = null;
      render();
      await report(force);
      return;
    }

    analysis = detect.analyze(document, location.href);
    maybeAutoSelect();
    await report(force);
    if (flow) checkOutcome();
    render();
  }

  function maybeAutoSelect() {
    if (!settings.autoSelect || !analysis.checkout.isCheckout) return;
    const option = analysis.paypal.candidates.find((c) => c.kind === 'payment-option');
    // Only once per URL, so we never fight a user who picked another method.
    if (!option || option.checked || autoSelectedOn === location.href) return;
    autoSelectedOn = location.href;
    selectOption(option.element);
    status = { tone: 'info', text: 'PayPal was selected as your payment method.' };
  }

  /** After a PayPal flow, look for a success or cancellation message. */
  function checkOutcome() {
    if (!flow || outcomeReported || flow.origin !== location.origin) return;
    // On the page where the flow started, wait until the user has been to PayPal.
    if (location.href === flow.startUrl && flow.stage === 'started') return;
    const outcome = detect.detectOutcome(document, location.href);
    if (outcome.status === 'unknown') {
      // The user left the checkout without ever reaching PayPal: drop the flow.
      if (flow.stage === 'started' && analysis && !analysis.checkout.isCheckout) {
        send({ type: 'flow-abort' });
        flow = null;
        status = null;
      }
      return;
    }
    outcomeReported = true;
    const order = analysis ? analysis.order : {};
    send({
      type: 'flow-result',
      result: { status: outcome.status, orderNumber: outcome.orderNumber, total: order.total, currency: order.currency }
    }).then((response) => {
      flow = null;
      result = response && response.entry;
      status = null;
      render();
    });
  }

  // Throttled rather than debounced, so pages that never stop mutating still get analyzed.
  let timer = null;
  function scheduleRefresh(delay, force) {
    if (timer && delay == null) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      refresh(force);
    }, delay == null ? 1000 : delay);
  }

  const observer = new MutationObserver((records) => {
    // Ignore mutations caused by our own panel host.
    if (records.every((r) => r.target === host || [...r.addedNodes, ...r.removedNodes].every((n) => n === host))) return;
    scheduleRefresh();
  });

  // ---------------------------------------------------------------------------
  // Assistance
  // ---------------------------------------------------------------------------

  function selectOption(input) {
    if (input.checked) return;
    // A real click runs the site's own handlers (many checkouts listen for click, not change).
    input.click();
    if (!input.checked) {
      input.checked = true;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function highlight(el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const prev = { outline: el.style.outline, offset: el.style.outlineOffset, transition: el.style.transition };
    el.style.transition = 'outline-color 0.3s';
    el.style.outline = '3px solid #0070BA';
    el.style.outlineOffset = '4px';
    setTimeout(() => {
      el.style.outline = prev.outline;
      el.style.outlineOffset = prev.offset;
      el.style.transition = prev.transition;
    }, 6000);
  }

  /** The button that moves the checkout forward once PayPal is selected. */
  function findContinueButton(input) {
    const scope = input.form || input.closest('form') || document;
    const buttons = [...scope.querySelectorAll('button, input[type="submit"], [role="button"]')].filter((b) => {
      if (b.disabled || !detect.isVisible(b)) return false;
      const text = (b.tagName === 'INPUT' ? b.value : b.textContent || '').replace(/\s+/g, ' ').trim();
      return text.length < 50 && (ACTION_TEXT_RE.test(text) || /pay\s?pal/i.test(text));
    });
    const label = (b) => (b.tagName === 'INPUT' ? b.value : b.textContent || '');
    return buttons.find((b) => /pay\s?pal/i.test(label(b))) || buttons[0] || null;
  }

  async function startFlow(method) {
    const response = await send({ type: 'flow-start', page: summary(), method });
    flow = response && response.flow;
    result = null;
  }

  async function assist() {
    analysis = detect.analyze(document, location.href);
    const best = analysis.paypal.best;
    if (!best) {
      status = { tone: 'warn', text: 'No PayPal option was found on this page.' };
      render();
      return;
    }

    if (best.kind === 'button') {
      await startFlow('button');
      status = { tone: 'info', text: 'Opening PayPal…' };
      render();
      highlight(best.element);
      best.element.click();
      return;
    }

    if (best.kind === 'payment-option') {
      selectOption(best.element);
      highlight(best.element);
      // Selecting PayPal often swaps "Place order" for a PayPal button; give the page a moment.
      await new Promise((r) => setTimeout(r, 700));
      analysis = detect.analyze(document, location.href);
      const next = analysis.paypal.candidates.find((c) => c.kind === 'button' || c.kind === 'smart-button');
      if (next && next.kind === 'button') {
        await startFlow('payment-option');
        status = { tone: 'info', text: 'PayPal selected. Opening PayPal…' };
        render();
        next.element.click();
        return;
      }
      if (next && next.kind === 'smart-button') {
        await startFlow('payment-option');
        highlight(next.element);
        status = { tone: 'info', text: 'PayPal selected. Click the PayPal button to continue.' };
        render();
        return;
      }
      const button = findContinueButton(best.element);
      await startFlow('payment-option');
      if (button && /pay\s?pal/i.test(button.tagName === 'INPUT' ? button.value : button.textContent)) {
        status = { tone: 'info', text: 'PayPal selected. Opening PayPal…' };
        render();
        button.click();
      } else {
        // A generic "Place order" might charge a saved payment method on some
        // sites, so the user presses it themselves after reviewing the order.
        if (button) highlight(button);
        status = {
          tone: 'info',
          text: button
            ? 'PayPal selected. Review your order, then press “' + (button.value || button.textContent).trim() + '” to continue to PayPal.'
            : 'PayPal selected. Continue with the checkout to finish on PayPal.'
        };
        render();
      }
      return;
    }

    // Smart buttons live in a cross-origin PayPal iframe: only the user can press them.
    await startFlow('smart-button');
    highlight(best.element);
    status = { tone: 'info', text: 'Click the highlighted PayPal button. PayPal opens in a secure window.' };
    render();
  }

  // ---------------------------------------------------------------------------
  // Panel (closed shadow DOM so the page's CSS and scripts can't reach it)
  // ---------------------------------------------------------------------------

  const host = document.createElement('mannapay-panel');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; right: 16px; bottom: 16px;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .card {
        font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        width: 300px; max-width: calc(100vw - 32px); box-sizing: border-box;
        background: #fff; color: #1b1f24; border-radius: 12px; padding: 14px 16px;
        box-shadow: 0 8px 30px rgba(0,0,0,.18), 0 0 0 1px rgba(0,0,0,.06);
      }
      @media (prefers-color-scheme: dark) {
        .card { background: #1f2329; color: #e8eaed; box-shadow: 0 8px 30px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.08); }
        .muted { color: #a3abb5 !important; }
        .secondary { color: #8ab4f8 !important; }
      }
      .head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .logo { width: 22px; height: 22px; border-radius: 6px; background: #0070BA; color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 13px; }
      .brand { font-weight: 600; flex: 1; }
      .close { all: unset; cursor: pointer; padding: 2px 6px; border-radius: 6px; color: inherit; opacity: .6; font-size: 18px; line-height: 1; }
      .close:hover, .close:focus-visible { opacity: 1; background: rgba(127,127,127,.15); }
      .merchant { font-weight: 600; }
      .total { font-size: 22px; font-weight: 700; margin: 2px 0 6px; }
      .muted { color: #5f6b7a; font-size: 12.5px; }
      .warn { color: #8a5300; background: #fff4e0; padding: 6px 8px; border-radius: 8px; font-size: 12.5px; margin: 6px 0; }
      .status { font-size: 13px; margin: 8px 0 0; }
      .status.ok { color: #1E8E3E; }
      .status.bad { color: #B3261E; }
      .primary {
        all: unset; box-sizing: border-box; display: block; width: 100%; text-align: center; cursor: pointer;
        margin-top: 10px; padding: 10px 12px; border-radius: 999px; background: #FFC439; color: #111; font-weight: 600;
      }
      .primary:hover { background: #f2b730; }
      .primary:focus-visible { outline: 2px solid #0070BA; outline-offset: 2px; }
      .secondary { all: unset; cursor: pointer; color: #0b57d0; font-size: 12.5px; margin-top: 8px; display: inline-block; }
      .secondary:hover { text-decoration: underline; }
      [hidden] { display: none !important; }
    </style>
    <div class="card" role="region" aria-label="MannaPay checkout assistant">
      <div class="head">
        <div class="logo" aria-hidden="true">M</div>
        <div class="brand">MannaPay</div>
        <button class="close" type="button" aria-label="Hide MannaPay on this page">×</button>
      </div>
      <div class="body"></div>
    </div>`;

  const bodyEl = shadow.querySelector('.body');
  shadow.querySelector('.close').addEventListener('click', () => {
    try { sessionStorage.setItem(DISMISS_KEY, location.pathname); } catch (_) { /* storage blocked */ }
    host.remove();
  });

  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
    if (text != null) node.textContent = text;
    return node;
  }

  function dismissedHere() {
    try { return sessionStorage.getItem(DISMISS_KEY) === location.pathname; } catch (_) { return false; }
  }

  function actionLabel(kind) {
    if (kind === 'payment-option') return 'Pay with PayPal';
    if (kind === 'smart-button') return 'Show me the PayPal button';
    return 'Pay with PayPal';
  }

  function renderResult() {
    const fmt = (amount, currency) => money.formatMoney(amount, currency);
    if (result.status === 'success') {
      bodyEl.append(el('div', { class: 'status ok' }, '✓ Payment confirmed' + (result.merchant ? ' at ' + result.merchant : '')));
      const details = [];
      if (result.orderNumber) details.push('Order #' + result.orderNumber);
      if (result.confirmedTotal != null) details.push(fmt(result.confirmedTotal, result.confirmedCurrency || result.currency));
      else if (result.total != null) details.push(fmt(result.total, result.currency));
      if (details.length) bodyEl.append(el('div', { class: 'muted' }, details.join(' · ')));
      if (result.amountCheck === 'match') {
        bodyEl.append(el('div', { class: 'muted' }, 'The confirmed amount matches the checkout total.'));
      } else if (result.amountCheck === 'mismatch') {
        bodyEl.append(el('div', { class: 'warn' },
          'Heads up: the confirmation shows ' + fmt(result.confirmedTotal, result.confirmedCurrency) +
          ' but checkout showed ' + fmt(result.total, result.currency) + '. Check your PayPal activity.'));
      } else {
        bodyEl.append(el('div', { class: 'muted' }, 'You can verify this payment in your PayPal activity.'));
      }
    } else if (result.status === 'cancelled') {
      bodyEl.append(el('div', { class: 'status bad' }, 'The PayPal payment was cancelled or declined.'));
      bodyEl.append(el('div', { class: 'muted' }, 'You can try again or choose another payment method.'));
    }
  }

  function render() {
    bodyEl.textContent = '';
    const a = analysis;
    const showResult = result && (result.status === 'success' || result.status === 'cancelled') && result.origin === location.origin;
    const showOffer = a && a.checkout.isCheckout && a.paypal.supported && settings.showPanel;
    const flowHere = !!flow && flow.origin === location.origin;
    const visible = !Settings.isSiteDisabled(settings, location.hostname) && !dismissedHere() && (showResult || showOffer || flowHere);

    if (!visible) {
      host.remove();
      return;
    }

    if (showResult && !flowHere) {
      renderResult();
    } else if (a) {
      const order = a.order;
      bodyEl.append(el('div', { class: 'muted' }, 'PayPal accepted at'));
      bodyEl.append(el('div', { class: 'merchant' }, order.merchant));
      if (order.total != null) {
        bodyEl.append(el('div', { class: 'total' }, money.formatMoney(order.total, order.currency)));
      } else {
        bodyEl.append(el('div', { class: 'muted' }, 'Order total not detected; check it on PayPal before approving.'));
      }
      if (order.currency && order.currencySupported === false) {
        bodyEl.append(el('div', { class: 'warn' }, order.currency + ' isn’t a PayPal currency. PayPal may convert it at checkout.'));
      }
      if (flowHere) {
        const where = flow.stage === 'at-paypal' ? 'Waiting for you to finish on PayPal…' : 'Waiting for the payment to be confirmed…';
        bodyEl.append(el('div', { class: 'status' }, where));
        const cancel = el('button', { class: 'secondary', type: 'button' }, 'Stop tracking this payment');
        cancel.addEventListener('click', async () => {
          await send({ type: 'flow-abort' });
          flow = null;
          status = null;
          render();
        });
        bodyEl.append(cancel);
      } else if (a.paypal.best) {
        const button = el('button', { class: 'primary', type: 'button' }, actionLabel(a.paypal.best.kind));
        button.addEventListener('click', assist);
        bodyEl.append(button);
      }
    }

    if (status && !(showResult && !flowHere)) {
      bodyEl.append(el('div', { class: 'status' + (status.tone === 'warn' ? ' bad' : '') }, status.text));
    }
    if (!host.isConnected) document.documentElement.append(host);
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === 'assist') {
      try { sessionStorage.removeItem(DISMISS_KEY); } catch (_) { /* ignore */ }
      // Reply first: assisting may navigate away and close the message port.
      sendResponse({ ok: true });
      assist();
      return false;
    }
    if (msg.type === 'get-state') {
      sendResponse(summary());
      return false;
    }
    if (msg.type === 'recheck-outcome') {
      // The PayPal popup closed; give the merchant page a moment to update.
      scheduleRefresh(800, true);
      setTimeout(() => refresh(true), 3000);
      return false;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      settings = Settings.normalize(changes.settings.newValue);
      scheduleRefresh(0, true);
    }
  });

  Settings.load().then((loaded) => {
    settings = loaded;
    refresh(true);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    window.addEventListener('popstate', () => scheduleRefresh(200));
    window.addEventListener('pageshow', (e) => { if (e.persisted) scheduleRefresh(0, true); });
  });
})();
