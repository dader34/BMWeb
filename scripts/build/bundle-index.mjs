#!/usr/bin/env node
// Collapse a built index.html's renderer <script src> tags into a single
// <script src="bundle.js">, at the position of the LAST such tag -- the app's
// scripts sit at the END of <body> (after the DOM), and app.js in particular
// must run after the body exists, so the bundle has to load there too, not up
// in <head>.
//
// version.js is left exactly where it is: it is injected into <head> to set
// window.BMACW_VERSION before anything reads it, and it is NOT part of the
// concatenated bundle (bundle-renderer.mjs reads the source index.html, which
// has no version.js). So this only collapses the renderer's own tags and never
// touches version.js. Remote (https://) scripts are also left in place.
//
//   node scripts/build/bundle-index.mjs <index.html>
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: bundle-index.mjs <index.html>');
  process.exit(1);
}
let html = readFileSync(file, 'utf8');

// local <script src> tags EXCEPT version.js (kept as its own head tag)
const tag =
  /[ \t]*<script src="(?!https?:)(?!version\.js")[^"]+"><\/script>\n?/g;
const matches = [...html.matchAll(tag)];
if (!matches.length) {
  console.error('bundle-index: no renderer <script src> tags found');
  process.exit(1);
}
// anchor at the LAST match so the bundle lands where app.js did (end of body)
const last = matches[matches.length - 1];
const anchor = last.index + last[0].length;
const head = html.slice(0, anchor).replace(tag, '');
const tail = html.slice(anchor);
html = head + '  <script src="bundle.js"></script>\n' + tail;

writeFileSync(file, html);
const n = (html.match(/<script/g) || []).length;
console.log(`bundle-index: ${file} now has ${n} <script> tags`);
