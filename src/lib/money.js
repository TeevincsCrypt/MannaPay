/*
 * MannaPay — money parsing.
 *
 * Shared by the content script, background worker and Node tests. Exposes
 * itself on globalThis.MannaPay and, under Node, through module.exports.
 */
(function (root) {
  'use strict';

  // Currencies PayPal accepts for payments.
  // https://developer.paypal.com/reference/currency-codes/
  const PAYPAL_CURRENCIES = new Set([
    'AUD', 'BRL', 'CAD', 'CNY', 'CZK', 'DKK', 'EUR', 'HKD', 'HUF', 'ILS',
    'JPY', 'MYR', 'MXN', 'TWD', 'NZD', 'NOK', 'PHP', 'PLN', 'GBP', 'SGD',
    'SEK', 'CHF', 'THB', 'USD'
  ]);

  // Currencies without minor units, so "1,234" is never "1.234".
  const ZERO_DECIMAL = new Set(['JPY', 'HUF', 'TWD', 'KRW']);

  // Prefixed dollar symbols are unambiguous; a bare "$" is resolved later.
  const SYMBOLS = {
    'US$': 'USD', 'CA$': 'CAD', 'C$': 'CAD', 'AU$': 'AUD', 'A$': 'AUD',
    'NZ$': 'NZD', 'HK$': 'HKD', 'S$': 'SGD', 'R$': 'BRL', 'MX$': 'MXN',
    'NT$': 'TWD', '$': '$', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '￥': 'JPY',
    '₹': 'INR', '₩': 'KRW', '₪': 'ILS', '₱': 'PHP', '฿': 'THB', 'zł': 'PLN',
    'Kč': 'CZK', 'Ft': 'HUF', 'RM': 'MYR', 'CHF': 'CHF', 'Fr.': 'CHF'
  };

  const ISO_CODES = [
    'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'CNY', 'CHF', 'SEK',
    'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'ILS', 'MXN', 'BRL', 'HKD', 'SGD',
    'TWD', 'MYR', 'PHP', 'THB', 'INR', 'KRW', 'ZAR', 'TRY', 'RUB', 'AED'
  ];

  // Country part of a locale or TLD -> currency, used to resolve a bare "$" or "kr".
  const REGION_CURRENCY = {
    US: 'USD', CA: 'CAD', AU: 'AUD', NZ: 'NZD', HK: 'HKD', SG: 'SGD',
    MX: 'MXN', TW: 'TWD', BR: 'BRL', SE: 'SEK', NO: 'NOK', DK: 'DKK',
    GB: 'GBP', UK: 'GBP', JP: 'JPY', CN: 'CNY'
  };

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  const markerAlternation = Object.keys(SYMBOLS)
    .concat(ISO_CODES, ['kr'])
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|');

  // [marker] number [marker]; the number allows thousands separators and spaces.
  const MONEY_RE = new RegExp(
    '(' + markerAlternation + ')?\\s?' +
    '(-?\\d{1,3}(?:[.,\\u00a0\\u202f ]\\d{3})+(?:[.,]\\d{1,2})?|-?\\d+(?:[.,]\\d{1,2})?)' +
    '(?![\\d%])\\s?(' + markerAlternation + ')?',
    'g'
  );

  /**
   * Turn "1.234,56" / "1,234.56" / "1 234,56" / "12,5" into a Number.
   * @param {string} raw
   * @param {string} [currency] ISO code, used for zero-decimal currencies.
   */
  function parseAmount(raw, currency) {
    if (raw == null) return null;
    let s = String(raw).replace(/[   ]/g, '').trim();
    if (!s) return null;
    const negative = s.startsWith('-');
    s = s.replace(/^-/, '');
    if (!/^\d[\d.,]*$/.test(s)) return null;

    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    let decimalSep = null;

    if (lastDot !== -1 && lastComma !== -1) {
      decimalSep = lastDot > lastComma ? '.' : ',';
    } else if (lastDot !== -1 || lastComma !== -1) {
      const sep = lastDot !== -1 ? '.' : ',';
      const occurrences = s.split(sep).length - 1;
      const digitsAfter = s.length - s.lastIndexOf(sep) - 1;
      // A single separator followed by 1-2 digits is a decimal point ("12,50");
      // followed by 3 digits it is a thousands group ("1,234").
      if (occurrences === 1 && digitsAfter !== 3 && !ZERO_DECIMAL.has(currency)) decimalSep = sep;
    }

    let normalized;
    if (decimalSep) {
      const thousands = decimalSep === '.' ? /,/g : /\./g;
      normalized = s.replace(thousands, '').replace(decimalSep, '.');
    } else {
      normalized = s.replace(/[.,]/g, '');
    }
    const value = Number(normalized);
    if (!Number.isFinite(value)) return null;
    return negative ? -value : value;
  }

  /**
   * Resolve ambiguous markers ("$", "kr") using locale / hostname hints.
   * @param {string} marker
   * @param {{locale?: string, hostname?: string}} [hints]
   */
  function resolveCurrency(marker, hints) {
    if (!marker) return null;
    const upper = marker.toUpperCase();
    if (ISO_CODES.includes(upper)) return upper;
    const mapped = SYMBOLS[marker];
    const region = regionFromHints(hints);
    if (mapped === '$') {
      if (region && ['US', 'CA', 'AU', 'NZ', 'HK', 'SG', 'MX', 'TW'].includes(region)) {
        return REGION_CURRENCY[region];
      }
      return 'USD';
    }
    if (marker === 'kr') {
      if (region && ['SE', 'NO', 'DK'].includes(region)) return REGION_CURRENCY[region];
      return 'SEK';
    }
    if (mapped === 'JPY' && region === 'CN') return 'CNY';
    return mapped || null;
  }

  function regionFromHints(hints) {
    if (!hints) return null;
    if (hints.locale) {
      const m = /[-_]([A-Za-z]{2})\b/.exec(hints.locale);
      if (m) return m[1].toUpperCase();
    }
    if (hints.hostname) {
      const tld = hints.hostname.split('.').pop().toUpperCase();
      if (REGION_CURRENCY[tld]) return tld;
    }
    return null;
  }

  /**
   * Find every money-looking value in a string.
   * Values without a currency marker are only returned when they have decimals.
   * @returns {{amount:number, currency:string|null, text:string}[]}
   */
  function findMoney(text, hints) {
    if (!text) return [];
    const results = [];
    MONEY_RE.lastIndex = 0;
    let m;
    while ((m = MONEY_RE.exec(String(text))) !== null) {
      const marker = m[1] || m[3] || null;
      const number = m[2];
      if (!marker && !/[.,]\d{2}$/.test(number)) continue;
      const currency = resolveCurrency(marker, hints);
      const amount = parseAmount(number, currency);
      if (amount == null) continue;
      results.push({ amount, currency, text: m[0].trim() });
    }
    return results;
  }

  /** The most plausible single money value in a string, preferring ones with a currency. */
  function parseMoney(text, hints) {
    const all = findMoney(text, hints);
    if (!all.length) return null;
    return all.find((v) => v.currency) || all[0];
  }

  function formatMoney(amount, currency, locale) {
    if (amount == null || !Number.isFinite(amount)) return '';
    if (!currency) return amount.toFixed(2);
    try {
      return new Intl.NumberFormat(locale || undefined, { style: 'currency', currency }).format(amount);
    } catch (_) {
      return currency + ' ' + amount.toFixed(2);
    }
  }

  function isPayPalCurrency(code) {
    return !!code && PAYPAL_CURRENCIES.has(code.toUpperCase());
  }

  const api = {
    PAYPAL_CURRENCIES,
    parseAmount,
    resolveCurrency,
    findMoney,
    parseMoney,
    formatMoney,
    isPayPalCurrency
  };

  root.MannaPay = Object.assign(root.MannaPay || {}, { money: api });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
