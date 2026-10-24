/*
 * MannaPay — page analysis.
 *
 * Pure functions over a Document + URL: checkout detection, PayPal detection,
 * order recognition and payment-outcome detection. No side effects, so they
 * run unchanged in the content script and under jsdom in tests.
 */
(function (root) {
  'use strict';

  const money = root.MannaPay && root.MannaPay.money
    ? root.MannaPay.money
    : (typeof require === 'function' ? require('./money.js') : null);

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  const PAYPAL_HOST_RE = /(^|\.)paypal\.com$|(^|\.)paypalobjects\.com$/i;
  const PAYPAL_WORD_RE = /pay\s?pal/i;
  // Links and buttons that mention PayPal but do not start a payment.
  const PAYPAL_NOT_ACTION_RE = /what\s+is\s+pay\s?pal|learn\s+more|pay\s?pal\s+(credit\s+)?(terms|policy)|venmo/i;

  function isPayPalUrl(url) {
    try {
      return PAYPAL_HOST_RE.test(new URL(url).hostname);
    } catch (_) {
      return false;
    }
  }

  function clean(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    // Fallback (jsdom, older browsers): walk up checking inline/computed styles.
    const view = el.ownerDocument && el.ownerDocument.defaultView;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
      if (node.tagName === 'INPUT' && node.type === 'hidden') return false;
      const style = view ? view.getComputedStyle(node) : node.style;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    }
    return true;
  }

  /** All the human-readable names an element might carry. */
  function accessibleText(el) {
    const parts = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('alt'),
      el.getAttribute('data-funding-source'),
      el.tagName === 'INPUT' ? el.value : null,
      el.textContent
    ];
    el.querySelectorAll && el.querySelectorAll('img[alt], img[src], svg title').forEach((img) => {
      parts.push(img.getAttribute('alt'), img.getAttribute('src'), img.textContent);
    });
    return clean(parts.filter(Boolean).join(' '));
  }

  function labelFor(input) {
    const doc = input.ownerDocument;
    const texts = [];
    if (input.labels && input.labels.length) {
      input.labels.forEach((l) => texts.push(accessibleText(l)));
    } else if (input.id) {
      const l = doc.querySelector('label[for="' + cssEscape(input.id) + '"]');
      if (l) texts.push(accessibleText(l));
    }
    const wrapper = input.closest('label, li, [role="radio"], .payment-method, [class*="payment"]');
    if (wrapper && !texts.length) texts.push(accessibleText(wrapper));
    texts.push(input.value, input.id, input.name, input.getAttribute('aria-label'));
    return clean(texts.filter(Boolean).join(' '));
  }

  function cssEscape(value) {
    if (root.CSS && typeof root.CSS.escape === 'function') return root.CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function bodyText(doc, limit) {
    const body = doc.body;
    if (!body) return '';
    const text = body.innerText != null && body.innerText !== '' ? body.innerText : body.textContent;
    return clean(text).slice(0, limit || 20000);
  }

  function moneyHints(doc, url) {
    let hostname = '';
    try {
      hostname = new URL(url).hostname;
    } catch (_) { /* ignore */ }
    return { locale: doc.documentElement && doc.documentElement.lang, hostname };
  }

  // ---------------------------------------------------------------------------
  // PayPal detection
  // ---------------------------------------------------------------------------

  /**
   * Find PayPal payment entry points on the page.
   *
   * Candidate kinds, in the order MannaPay prefers to use them:
   *  - "button":         a same-origin button/link that starts the PayPal flow; MannaPay can click it.
   *  - "payment-option": a radio/checkbox that selects PayPal as the payment method; MannaPay can select it.
   *  - "smart-button":   PayPal's own cross-origin button iframe; only the user can click it.
   *
   * @returns {{supported:boolean, confidence:'high'|'medium'|'low'|'none', sdk:{present:boolean,currency:string|null,intent:string|null},
   *            candidates:{kind:string,element:Element,label:string,checked?:boolean}[], best:object|null}}
   */
  function detectPayPal(doc) {
    const candidates = [];
    const seen = new Set();

    function add(kind, element, label, extra) {
      if (seen.has(element)) return;
      seen.add(element);
      candidates.push(Object.assign({ kind, element, label: clean(label).slice(0, 120) }, extra || {}));
    }

    // 1. Payment-method radios / checkboxes.
    doc.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach((input) => {
      const label = labelFor(input);
      if (!PAYPAL_WORD_RE.test(label) || PAYPAL_NOT_ACTION_RE.test(label)) return;
      if (input.disabled) return;
      add('payment-option', input, label, { checked: !!input.checked });
    });

    // 2. PayPal smart buttons (JS SDK / Braintree). Rendered as cross-origin iframes.
    doc.querySelectorAll(
      'iframe[src*="paypal.com"], iframe[name^="__zoid__paypal"], iframe[title*="PayPal" i], ' +
      '[data-funding-source="paypal"], [id^="paypal-button"], [class*="paypal-button"], ' +
      '[id*="braintree-paypal"], [class*="braintree-paypal"]'
    ).forEach((el) => {
      if (el.matches('button, a, input, [role="button"]')) return; // handled as a button below
      if (!isVisible(el)) return;
      // Register the outermost container only, not the iframe inside it.
      if (candidates.some((c) => c.kind === 'smart-button' && c.element.contains(el))) return;
      // A container wrapping a same-origin PayPal button is handled as that button.
      const inner = el.tagName !== 'IFRAME' && el.querySelector('button, a[href], input[type="submit"], input[type="image"]');
      if (inner && PAYPAL_WORD_RE.test(accessibleText(inner))) return;
      add('smart-button', el, el.getAttribute('title') || 'PayPal button');
    });

    // 3. Clickable same-origin buttons and links.
    doc.querySelectorAll(
      'button, a[href], input[type="submit"], input[type="button"], input[type="image"], [role="button"]'
    ).forEach((el) => {
      if (el.closest('footer') && !el.closest('form')) return; // "We accept PayPal" footers
      const text = accessibleText(el);
      if (!PAYPAL_WORD_RE.test(text) || PAYPAL_NOT_ACTION_RE.test(text)) return;
      if (el.disabled || !isVisible(el)) return;
      if (el.tagName === 'A') {
        const href = el.getAttribute('href') || '';
        // Links to PayPal marketing pages are not checkout entry points.
        if (isPayPalUrl(el.href) && !/checkoutnow|webscr|\/checkout|\/pay\b|token=/i.test(href)) return;
      }
      add('button', el, text);
    });

    // 4. The PayPal JS SDK on the page tells us the merchant integrates PayPal.
    const sdk = { present: false, currency: null, intent: null };
    doc.querySelectorAll('script[src]').forEach((s) => {
      const src = s.getAttribute('src') || '';
      if (!/paypal\.com\/sdk\/js|paypalobjects\.com\/api\/checkout|js\.braintreegateway\.com\/.*paypal/i.test(src)) return;
      sdk.present = true;
      try {
        const u = new URL(src, doc.baseURI || 'https://example.invalid/');
        sdk.currency = sdk.currency || (u.searchParams.get('currency') || '').toUpperCase() || null;
        sdk.intent = sdk.intent || u.searchParams.get('intent');
      } catch (_) { /* ignore malformed */ }
    });

    const order = { button: 0, 'payment-option': 1, 'smart-button': 2 };
    candidates.sort((a, b) => {
      const byKind = order[a.kind] - order[b.kind];
      if (byKind) return byKind;
      // Prefer buttons that explicitly say "pay/checkout with PayPal".
      const strong = (c) => (/(pay|check\s?out|buy|continue)\s+(now\s+)?(with|via|to|using)\s+pay\s?pal/i.test(c.label) ? 0 : 1);
      return strong(a) - strong(b);
    });

    let confidence = 'none';
    if (candidates.some((c) => c.kind !== 'smart-button')) confidence = 'high';
    else if (candidates.length) confidence = sdk.present ? 'high' : 'medium';
    else if (sdk.present) confidence = 'medium';
    else if (PAYPAL_WORD_RE.test(bodyText(doc, 50000))) confidence = 'low';

    return {
      supported: confidence === 'high' || confidence === 'medium',
      confidence,
      sdk,
      candidates,
      best: candidates[0] || null
    };
  }

  // ---------------------------------------------------------------------------
  // Checkout detection
  // ---------------------------------------------------------------------------

  const URL_CHECKOUT_RE = /\/(checkout|checkouts|payment|payments|billing|pay|place-?order|onepage|secure-?checkout)(\/|\?|#|$|-|_)/i;
  const URL_CART_RE = /\/(cart|basket|bag|shopping-?(cart|bag))(\/|\?|#|$|\.)/i;
  const URL_CONFIRMATION_RE = /(thank-?you|thanks|order-?confirm(ation|ed)?|order-?received|order-?complete|checkout\/(success|complete)|\/success(\/|\?|$)|\/confirmation(\/|\?|$))/i;
  const ACTION_TEXT_RE = /^(place\s+(your\s+)?order|complete\s+(order|purchase|payment)|pay\s+now|submit\s+order|confirm\s+(order|purchase)|proceed\s+to\s+(checkout|payment)|continue\s+to\s+(payment|shipping|checkout)|check\s?out(\s+now)?|buy\s+now|review\s+order)\b/i;
  const HEADING_RE = /\b(checkout|order\s+summary|payment\s+(method|information|details)|shipping\s+(address|method)|billing\s+address|delivery\s+(address|options)|your\s+(cart|basket|bag)|shopping\s+(cart|bag|basket)|express\s+checkout)\b/i;
  const CART_HEADING_RE = /\b(your\s+(cart|basket|bag)|shopping\s+(cart|bag|basket))\b/i;

  /**
   * Decide whether this page is part of a checkout and which stage it is.
   * @returns {{isCheckout:boolean, stage:'cart'|'checkout'|'confirmation'|null, score:number, signals:string[]}}
   */
  function detectCheckout(doc, url, paypal) {
    const signals = [];
    let score = 0;
    let cartScore = 0;
    let path = '';
    try {
      const u = new URL(url);
      path = u.pathname + u.search + u.hash;
    } catch (_) { /* ignore */ }

    if (URL_CHECKOUT_RE.test(path)) { score += 3; signals.push('url:checkout'); }
    if (URL_CART_RE.test(path)) { score += 2; cartScore += 2; signals.push('url:cart'); }

    const paymentFields = doc.querySelectorAll(
      'input[autocomplete*="cc-number"], input[autocomplete*="cc-exp"], input[name*="cardnumber" i], ' +
      'input[name*="card_number" i], iframe[src*="stripe.com"], iframe[src*="braintree"], iframe[src*="adyen"]'
    ).length;
    if (paymentFields) { score += 3; signals.push('fields:payment'); }

    const addressFields = doc.querySelectorAll(
      'input[autocomplete*="shipping"], input[autocomplete*="billing"], input[autocomplete="postal-code"], ' +
      'input[autocomplete="address-line1"], input[name*="postcode" i], input[name*="zip" i]'
    ).length;
    if (addressFields >= 2) { score += 2; signals.push('fields:address'); }

    let actions = 0;
    doc.querySelectorAll('button, input[type="submit"], a[href], [role="button"]').forEach((el) => {
      if (actions >= 2) return;
      const text = clean(el.tagName === 'INPUT' ? el.value : el.textContent);
      if (text.length < 40 && ACTION_TEXT_RE.test(text) && isVisible(el)) {
        actions++;
        if (/check\s?out|proceed\s+to\s+checkout/i.test(text)) cartScore++;
      }
    });
    if (actions) { score += 2; signals.push('action:checkout-button'); }

    let headings = 0;
    doc.querySelectorAll('h1, h2, h3, h4, legend, [role="heading"]').forEach((el) => {
      const text = clean(el.textContent);
      if (text.length > 80) return;
      if (HEADING_RE.test(text)) {
        headings++;
        if (CART_HEADING_RE.test(text)) cartScore++;
      }
    });
    if (headings) { score += Math.min(headings, 3); signals.push('text:headings'); }

    if (paypal && paypal.candidates.length) { score += 1; signals.push('paypal:present'); }

    const outcome = detectOutcome(doc, url);
    let stage = null;
    if (outcome.status === 'success') stage = 'confirmation';
    else if (score >= 3) stage = (cartScore >= 2 && !paymentFields && !URL_CHECKOUT_RE.test(path)) ? 'cart' : 'checkout';

    return { isCheckout: stage === 'cart' || stage === 'checkout', stage, score, signals };
  }

  // ---------------------------------------------------------------------------
  // Order recognition
  // ---------------------------------------------------------------------------

  const TOTAL_LABEL_RE = /\b(grand\s+total|order\s+total|total\s+(due|to\s+pay|payable|amount|price|\(incl)|amount\s+(due|payable|to\s+pay)|you\s+pay|estimated\s+total|total)\b/i;
  const STRONG_TOTAL_RE = /\b(grand\s+total|order\s+total|total\s+(due|to\s+pay|payable)|amount\s+(due|payable|to\s+pay)|you\s+pay)\b/i;
  const NOT_TOTAL_RE = /\b(sub-?\s?total|savings|saved|discount|tax(es)?\s+total|total\s+tax|shipping\s+total|items?\s+total|total\s+items|per\s+(month|item))\b/i;

  function merchantName(doc, url) {
    const meta = (sel) => {
      const el = doc.querySelector(sel);
      return el ? clean(el.getAttribute('content')) : '';
    };
    const fromJsonLd = () => {
      for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
        let data;
        try { data = JSON.parse(s.textContent); } catch (_) { continue; }
        const items = [].concat(data['@graph'] || data);
        for (const item of items) {
          const type = [].concat(item && item['@type'] || []);
          if (type.some((t) => /^(Organization|Store|OnlineStore|WebSite|LocalBusiness)$/.test(t)) && item.name) {
            return clean(String(item.name));
          }
          if (item && item.seller && item.seller.name) return clean(String(item.seller.name));
        }
      }
      return '';
    };
    const name = meta('meta[property="og:site_name"]') || fromJsonLd() || meta('meta[name="application-name"]');
    if (name) return name.slice(0, 80);

    let hostname = '';
    try { hostname = new URL(url).hostname; } catch (_) { /* ignore */ }
    if (!hostname.includes('.') || /^[\d.]+$|^\[|:/.test(hostname)) return hostname; // localhost, IPs
    const labels = hostname.replace(/^(www|shop|store|checkout|secure|pay)\./i, '').split('.');
    // "example.co.uk" -> "example", "shop.example.com" -> "example"
    const core = labels.length > 2 && labels[labels.length - 2].length <= 3 ? labels[labels.length - 3] : labels[Math.max(0, labels.length - 2)];
    if (!core) return hostname;
    return core.charAt(0).toUpperCase() + core.slice(1);
  }

  /** Money values found in the "row" an element sits in (itself, its siblings, its parent row). */
  function rowMoney(el, hints) {
    const scopes = [];
    const own = clean(el.textContent);
    if (own.length <= 80) scopes.push(own);
    if (el.nextElementSibling) scopes.push(clean(el.nextElementSibling.textContent));
    const row = el.closest('tr, li, dl, [class*="row" i], [class*="line" i], [class*="total" i]');
    if (row && row !== el) {
      const t = clean(row.textContent);
      if (t.length <= 160) scopes.push(t);
    }
    if (el.parentElement) {
      const t = clean(el.parentElement.textContent);
      if (t.length <= 120) scopes.push(t);
    }
    for (const text of scopes) {
      const values = money.findMoney(text, hints).filter((v) => v.amount > 0);
      if (values.length) return values[values.length - 1];
    }
    return null;
  }

  /**
   * Identify merchant, order total and currency.
   * @returns {{merchant:string, total:number|null, currency:string|null, totalText:string|null,
   *            currencySupported:boolean|null, source:string|null}}
   */
  function recognizeOrder(doc, url, paypal) {
    const hints = moneyHints(doc, url);
    let best = null;

    // Structured data first: microdata / data attributes some platforms expose.
    const structured = doc.querySelector('[itemprop="totalPaymentDue"], [itemprop="price"][content], [data-checkout-payment-due-target]');
    if (structured) {
      if (structured.hasAttribute('data-checkout-payment-due-target')) {
        // Shopify stores the amount due in minor units.
        const cents = Number(structured.getAttribute('data-checkout-payment-due-target'));
        if (Number.isFinite(cents) && cents > 0) {
          const parsed = money.parseMoney(structured.textContent, hints);
          best = { amount: cents / 100, currency: parsed && parsed.currency, text: clean(structured.textContent), score: 10, source: 'shopify' };
        }
      } else {
        const content = structured.getAttribute('content');
        const amount = content ? money.parseAmount(content) : null;
        const currencyEl = doc.querySelector('[itemprop="priceCurrency"]');
        const currency = currencyEl ? (currencyEl.getAttribute('content') || clean(currencyEl.textContent)).toUpperCase() : null;
        if (amount) best = { amount, currency, text: content, score: 6, source: 'microdata' };
      }
    }

    // Heuristic: find "Total"-labelled elements and read the value from their row.
    if (!best || best.score < 10) {
      const labels = doc.querySelectorAll('th, td, dt, dd, span, div, p, strong, b, label, h2, h3, h4, li');
      let index = 0;
      labels.forEach((el) => {
        index++;
        // Only look at leaf-ish elements whose own text is short.
        if (el.children.length > 4) return;
        const text = clean(el.textContent);
        if (!text || text.length > 60) return;
        if (!TOTAL_LABEL_RE.test(text) || NOT_TOTAL_RE.test(text)) return;
        if (!isVisible(el)) return;
        const value = rowMoney(el, hints);
        if (!value) return;
        // Stronger labels win; among equals, later in the page wins (grand totals sit last).
        const score = (STRONG_TOTAL_RE.test(text) ? 4 : 2) + (value.currency ? 1 : 0);
        const candidate = { amount: value.amount, currency: value.currency, text: value.text, score, index, source: 'label' };
        if (!best || score > best.score || (score === best.score && index >= (best.index || 0))) best = candidate;
      });
    }

    let currency = best && best.currency;
    if (!currency && paypal && paypal.sdk && paypal.sdk.currency) currency = paypal.sdk.currency;
    if (!currency) {
      const priceCurrency = doc.querySelector('meta[itemprop="priceCurrency"], meta[property="product:price:currency"], meta[property="og:price:currency"]');
      if (priceCurrency) currency = clean(priceCurrency.getAttribute('content')).toUpperCase() || null;
    }

    return {
      merchant: merchantName(doc, url),
      total: best ? best.amount : null,
      currency: currency || null,
      totalText: best ? best.text : null,
      currencySupported: currency ? money.isPayPalCurrency(currency) : null,
      source: best ? best.source : null
    };
  }

  // ---------------------------------------------------------------------------
  // Payment outcome (after returning from PayPal)
  // ---------------------------------------------------------------------------

  const SUCCESS_TEXT_RE = /\b(thank\s+you\s+for\s+(your\s+)?(order|purchase|payment)|thanks\s+for\s+(your\s+)?(order|purchase)|order\s+(has\s+been\s+)?(placed|confirmed|received|is\s+confirmed)|payment\s+(was\s+)?(successful|received|complete|completed|approved)|your\s+order\s+(number|#)\s+is)\b/i;
  const CANCEL_TEXT_RE = /\b(payment\s+(was\s+|has\s+been\s+)?(cancell?ed|declined|failed|unsuccessful|not\s+completed)|transaction\s+(was\s+)?(cancell?ed|declined|failed)|order\s+(was\s+)?cancell?ed|you\s+(have\s+)?cancell?ed\s+(the|your)\s+payment)\b/i;
  const URL_CANCEL_RE = /([?&/_-]cancel(led|ed)?([=/&?_-]|$)|paypal[_-]?cancel|payment[_-]?(failed|error|declined))/i;
  const ORDER_NUMBER_RE = /\border\s*(?:number|no\.?|#|id|reference|ref\.?)\s*(?:is)?[:\s#]*([A-Z0-9][A-Z0-9-]{3,24})\b/i;

  /**
   * Work out whether this page reports a completed or failed payment.
   * @returns {{status:'success'|'cancelled'|'unknown', orderNumber:string|null, signals:string[]}}
   */
  function detectOutcome(doc, url) {
    const signals = [];
    let path = '';
    try {
      const u = new URL(url);
      path = u.pathname + u.search;
    } catch (_) { /* ignore */ }
    const text = bodyText(doc, 8000);

    const cancelled = URL_CANCEL_RE.test(path) || CANCEL_TEXT_RE.test(text);
    if (URL_CANCEL_RE.test(path)) signals.push('url:cancel');
    if (CANCEL_TEXT_RE.test(text)) signals.push('text:cancel');

    const urlSuccess = URL_CONFIRMATION_RE.test(path);
    const textSuccess = SUCCESS_TEXT_RE.test(text);
    if (urlSuccess) signals.push('url:confirmation');
    if (textSuccess) signals.push('text:confirmation');

    const numberMatch = ORDER_NUMBER_RE.exec(text);
    const orderNumber = numberMatch && /\d/.test(numberMatch[1]) ? numberMatch[1] : null;

    let status = 'unknown';
    if (cancelled) status = 'cancelled';
    else if (textSuccess || (urlSuccess && orderNumber)) status = 'success';

    return { status, orderNumber, signals };
  }

  // ---------------------------------------------------------------------------

  /** Run every detector once. */
  function analyze(doc, url) {
    const paypal = detectPayPal(doc);
    const checkout = detectCheckout(doc, url, paypal);
    const order = recognizeOrder(doc, url, paypal);
    return { url, checkout, paypal, order };
  }

  const api = {
    isPayPalUrl,
    isVisible,
    detectPayPal,
    detectCheckout,
    recognizeOrder,
    detectOutcome,
    merchantName,
    analyze
  };

  root.MannaPay = Object.assign(root.MannaPay || {}, { detect: api });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
