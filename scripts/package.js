/*
 * Build a store-ready zip: dist/mannapay-<version>.zip
 * Contains only what the extension loads (manifest, icons, src).
 */
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const out = path.join(root, 'dist', 'mannapay-' + version + '.zip');

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
execFileSync('zip', ['-r', '-q', out, 'manifest.json', 'icons', 'src', '-x', '*.DS_Store'], { cwd: root, stdio: 'inherit' });
console.log('wrote ' + path.relative(root, out));
