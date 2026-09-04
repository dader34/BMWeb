#!/usr/bin/env node
// Collapse a built index.html's local <script src> tags into a single
// <script src="bundle.js"> (paired with bundle-renderer.mjs, which concatenated
// those same files in this order). Remote scripts (https://) are left in place.
// The bundle tag takes the position of the FIRST local tag, so ordering vs any
// surrounding inline scripts is preserved.
//
//   node scripts/build/bundle-index.mjs <index.html>
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: bundle-index.mjs <index.html>');
  process.exit(1);
}
let html = readFileSync(file, 'utf8');

const localTag = /[ \t]*<script src="(?!https?:)[^"]+"><\/script>\n?/g;
const first = html.search(localTag);
if (first === -1) {
  console.error('bundle-index: no local <script src> tags found');
  process.exit(1);
}
const before = html.slice(0, first);
const after = html.slice(first).replace(localTag, '');
html = before + '  <script src="bundle.js"></script>\n' + after;

writeFileSync(file, html);
const n = (html.match(/<script/g) || []).length;
console.log(`bundle-index: ${file} now has ${n} <script> tags`);
