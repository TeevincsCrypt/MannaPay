'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

/** Load a fixture into jsdom as if served from `url`. */
function loadFixture(name, url) {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  const dom = new JSDOM(html, { url: url || 'https://shop.example.com/' + name });
  return { doc: dom.window.document, url: dom.window.location.href, window: dom.window };
}

function domFrom(html, url) {
  const dom = new JSDOM(html, { url: url || 'https://shop.example.com/' });
  return { doc: dom.window.document, url: dom.window.location.href, window: dom.window };
}

module.exports = { loadFixture, domFrom };
