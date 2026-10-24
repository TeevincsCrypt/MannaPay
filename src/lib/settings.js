/*
 * MannaPay — user settings, stored in chrome.storage.sync.
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    showPanel: true,     // show the in-page assistant on checkouts that accept PayPal
    autoSelect: false,   // automatically select PayPal as the payment method (never submits)
    disabledSites: []    // hostnames where MannaPay stays out of the way
  };

  function normalize(stored) {
    const s = Object.assign({}, DEFAULTS, stored || {});
    s.disabledSites = Array.isArray(s.disabledSites) ? s.disabledSites : [];
    return s;
  }

  function load() {
    return new Promise((resolve) => {
      chrome.storage.sync.get({ settings: DEFAULTS }, (data) => resolve(normalize(data && data.settings)));
    });
  }

  async function update(patch) {
    const next = normalize(Object.assign(await load(), patch));
    await new Promise((resolve) => chrome.storage.sync.set({ settings: next }, resolve));
    return next;
  }

  function isSiteDisabled(settings, hostname) {
    return !!hostname && settings.disabledSites.includes(hostname);
  }

  async function setSiteDisabled(hostname, disabled) {
    const s = await load();
    const sites = new Set(s.disabledSites);
    if (disabled) sites.add(hostname); else sites.delete(hostname);
    return update({ disabledSites: Array.from(sites) });
  }

  const api = { DEFAULTS, normalize, load, update, isSiteDisabled, setSiteDisabled };

  root.MannaPay = Object.assign(root.MannaPay || {}, { settings: api });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
