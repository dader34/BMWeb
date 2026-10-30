#!/usr/bin/env node
// Builds the BMWeb wiki: scripts/wiki/pages/<slug>.html -> app/site/wiki/<slug>.html,
// plus one page per category and the search index.
//
// A page source is an HTML fragment: a comment header, then <section id="..">
// blocks, each opened by an <h2>. Header keys (one per line, `info`, `cat` and
// `see` may repeat):
//
//   <!--
//   title: Siemens MS45.1 DME       page title
//   nav: MS45.1 DME                 shorter name for the sidebar and links
//   group: units                    sidebar group: units or topics
//   lead: One or two sentences.     the paragraph above the contents box
//   infobox: MS45.1                 infobox caption
//   info: CPU = Motorola MPC555     an infobox row (HTML allowed in the value)
//   cat: Engine computers           a category
//   see: diagnostics                a See also link to another page's slug
//   toc: no                         no contents box (the main page)
//   -->
//
// The build adds the sidebar, tabs, contents box (numbered from the h2 and h3
// headings; h3 get ids if they have none), the See also list, the category
// bar, and puts each bare <table> in a scrolling wrapper as a wikitable. The
// logo is taken from docs.html so the wiki follows the site's branding.
//
// The output is committed beside the rest of app/site, which the web build
// copies as-is. Run after editing a page:
//
//   node scripts/build/build-wiki.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'scripts', 'wiki', 'pages');
const OUT = join(ROOT, 'app', 'site', 'wiki');

// Every page, in sidebar order. `index` is the main page.
const PAGES = [
  'index',
  'ms45',
  'ms43',
  // 'smg2' is written but held back for now (scripts/wiki/pages/smg2.html).
  'gs20',
  'diagnostics',
  'coding',
];
const GROUPS = [
  ['units', 'Control units'],
  ['topics', 'Topics'],
];

const docs = readFileSync(join(ROOT, 'app', 'site', 'docs.html'), 'utf8');
const favicon = docs.match(/<link\s+rel="icon"[^>]*>/)[0];
const logo = docs
  .match(/<svg class="logo"[\s\S]*?<\/svg>/)[0]
  .replace('class="logo" ', '');

function slugify(s) {
  return plain(s)
    .toLowerCase()
    .replace(/&[a-z]+;/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function plain(s) {
  return s.replace(/<[^>]+>/g, '');
}

function text(s) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:)])/g, '$1')
    .trim();
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function parse(src, file) {
  const m = src.match(/^\s*<!--([\s\S]*?)-->/);
  if (!m) throw new Error(`${file}: missing the comment header`);
  const meta = { info: [], cat: [], see: [] };
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*(\w+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'info') {
      const at = value.indexOf(' = ');
      if (at < 0) throw new Error(`${file}: info needs "Key = Value"`);
      meta.info.push([value.slice(0, at).trim(), value.slice(at + 3).trim()]);
    } else if (key === 'cat' || key === 'see') meta[key].push(value.trim());
    else meta[key] = value.trim();
  }
  if (!meta.title) throw new Error(`${file}: header has no title`);
  return { meta, body: src.slice(m[0].length).trim() };
}

// Give every h3 an id (section id + its own slug) and collect the outline.
function outline(body) {
  const secs = [];
  let current = null;
  const out = body.replace(
    /<section id="([^"]+)">\s*<h2>([\s\S]*?)<\/h2>|<h3(\s+id="([^"]+)")?>([\s\S]*?)<\/h3>/g,
    (all, secId, h2, hasId, h3Id, h3) => {
      if (secId) {
        current = { id: secId, title: h2, subs: [] };
        secs.push(current);
        return all;
      }
      const id = h3Id || `${current ? current.id + '-' : ''}${slugify(h3)}`;
      if (current) current.subs.push({ id, title: h3 });
      return hasId ? all : `<h3 id="${id}">${h3}</h3>`;
    }
  );
  return { body: out, secs };
}

function wrapTables(body) {
  return body.replace(
    /(^[ \t]*)<table>([\s\S]*?)<\/table>/gm,
    (_, ind, inner) =>
      `${ind}<div class="table-wrap"><table class="wikitable">${inner}</table></div>`
  );
}

const pages = PAGES.map((slug) => {
  const file = join(SRC, `${slug}.html`);
  const { meta, body } = parse(readFileSync(file, 'utf8'), file);
  const { body: withIds, secs } = outline(body);
  return { slug, meta, body: withIds, secs, nav: meta.nav || meta.title };
});
const bySlug = Object.fromEntries(pages.map((p) => [p.slug, p]));

const categories = new Map();
for (const p of pages)
  for (const c of p.meta.cat) {
    if (!categories.has(c)) categories.set(c, []);
    categories.get(c).push(p);
  }
const catFile = (c) => `category-${slugify(c)}.html`;

function sidebar(here) {
  const li = (href, label, on) =>
    `            <li${on ? ' class="here"' : ''}><a href="${href}">${label}</a></li>`;
  const groups = GROUPS.map(([key, label]) => {
    const items = pages.filter((p) => p.meta.group === key);
    return `        <nav class="portal" aria-label="${label}">
          <h3>${label}</h3>
          <ul>
${items.map((p) => li(`${p.slug}.html`, p.nav, p.slug === here)).join('\n')}
          </ul>
        </nav>`;
  }).join('\n');
  const cats = [...categories.keys()]
    .sort()
    .map((c) => li(catFile(c), c, catFile(c) === here))
    .join('\n');
  return `      <aside class="side" id="side">
        <div class="side-top">
          <a class="logo-link" href="index.html">
            ${logo}
            <span class="wm">BMWeb Wiki</span>
          </a>
          <button class="menu-btn" type="button" aria-controls="side" aria-expanded="false">Menu</button>
        </div>
        <div class="search" role="search">
          <input id="wiki-search" type="search" placeholder="Search the wiki" autocomplete="off" aria-label="Search the wiki" />
          <div class="search-results" id="wiki-results" role="listbox"></div>
        </div>
        <nav class="portal" aria-label="Navigation">
          <h3>Navigation</h3>
          <ul>
${li('index.html', 'Main page', here === 'index')}
            <li><a href="../docs.html">BMWeb documentation</a></li>
            <li><a href="../index.html" data-link="app">Open the app</a></li>
          </ul>
        </nav>
${groups}
        <nav class="portal" aria-label="Categories">
          <h3>Categories</h3>
          <ul>
${cats}
          </ul>
        </nav>
      </aside>`;
}

function shell({ here, title, description, tab, heading, tagline, body }) {
  return `<!doctype html>
<!-- Generated by scripts/build/build-wiki.mjs. Edit scripts/wiki/pages/, not this file. -->
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, viewport-fit=cover"
    />
    <title>${title}</title>
    <meta name="description" content="${escapeAttr(description)}" />
    ${favicon}
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="wiki.css" />
    <script src="search-index.js" defer></script>
    <script src="wiki.js" defer></script>
  </head>
  <body>
    <div class="shell">
${sidebar(here)}
      <div class="main">
        <div class="tabs">
          <ul>
            <li class="on"><a href="#">${tab}</a></li>
          </ul>
          <ul>
            <li><a href="../docs.html">Docs</a></li>
            <li><a href="../index.html" data-link="app">Open the app</a></li>
          </ul>
        </div>
        <main class="content">
          <h1 class="firstHeading">${heading}</h1>
          <p class="tagline">${tagline}</p>
          <div class="body">
${body}
          </div>
        </main>
        <footer class="footer">
          <p>Facts on this wiki come from BMWeb's own work: cars, emulators running the units' own software, disassembly and BMW's data files. Each carries a tag saying which.</p>
          <p><a href="index.html#safety">Read this before using any of it on a car.</a> Part of <a href="https://github.com/dader34/BMWeb">BMWeb</a>.</p>
        </footer>
      </div>
    </div>
  </body>
</html>
`;
}

function contents(secs) {
  if (!secs.length) return '';
  const items = secs
    .map((s, i) => {
      const subs = s.subs.length
        ? `\n                <ol>\n${s.subs
            .map(
              (h, j) =>
                `                  <li><a href="#${h.id}"><span class="num">${i + 1}.${j + 1}</span>${plain(h.title)}</a></li>`
            )
            .join('\n')}\n                </ol>`
        : '';
      return `              <li><a href="#${s.id}"><span class="num">${i + 1}</span>${plain(s.title)}</a>${subs}</li>`;
    })
    .join('\n');
  return `            <nav class="toc" id="toc" aria-label="Contents">
              <p class="toc-title">Contents <button type="button" class="toc-toggle">[hide]</button></p>
              <ol>
${items}
              </ol>
            </nav>`;
}

function infobox(meta) {
  if (!meta.info.length) return '';
  const rows = meta.info
    .map(
      ([k, v]) =>
        `              <tr><th scope="row">${k}</th><td>${v}</td></tr>`
    )
    .join('\n');
  return `            <table class="infobox">
              <caption>${meta.infobox || meta.title}</caption>
${rows}
            </table>`;
}

function catbar(cats) {
  if (!cats.length) return '';
  return `            <div class="catlinks"><a href="${catFile(cats[0])}">Categories</a>:
              <ul>${cats.map((c) => `<li><a href="${catFile(c)}">${c}</a></li>`).join('')}</ul>
            </div>`;
}

function seeAlso(see) {
  if (!see.length) return '';
  return `            <section id="see-also">
              <h2>See also</h2>
              <ul>
${see
  .map((s) => {
    const p = bySlug[s];
    if (!p) throw new Error(`see: no page "${s}"`);
    return `                <li><a href="${p.slug}.html">${p.meta.title}</a>${p.meta.lead ? ` - ${text(p.meta.lead).split('. ')[0].replace(/\.$/, '')}` : ''}</li>`;
  })
  .join('\n')}
              </ul>
            </section>`;
}

function renderPage(p) {
  const { slug, meta, secs } = p;
  const isMain = slug === 'index';
  const parts = [
    infobox(meta),
    meta.lead ? `            <p class="lead">${meta.lead}</p>` : '',
    meta.toc === 'no' ? '' : contents(secs),
    wrapTables(p.body),
    seeAlso(meta.see),
    catbar(meta.cat),
  ].filter(Boolean);
  return shell({
    here: slug,
    title: isMain ? 'BMWeb Wiki' : `${plain(meta.title)} - BMWeb Wiki`,
    description: text(meta.lead || meta.title),
    tab: isMain ? 'Main page' : 'Page',
    heading: isMain ? 'Main page' : meta.title,
    tagline: 'From BMWeb Wiki',
    body: parts.join('\n'),
  });
}

function renderCategory(name, members) {
  const list = [...members]
    .sort((a, b) => plain(a.meta.title).localeCompare(plain(b.meta.title)))
    .map(
      (p) =>
        `                <li><a href="${p.slug}.html">${p.meta.title}</a></li>`
    )
    .join('\n');
  const n = members.length;
  return shell({
    here: catFile(name),
    title: `Category: ${name} - BMWeb Wiki`,
    description: `Pages in the category ${name}.`,
    tab: 'Category',
    heading: `Category: ${name}`,
    tagline: 'From BMWeb Wiki',
    body: `            <h2>Pages in category "${name}"</h2>
            <p>This category contains ${n === 1 ? 'the following page' : `the following ${n} pages`}.</p>
            <ul>
${list}
            </ul>`,
  });
}

// One entry per page and per section, with a snippet to show under the hit.
function searchIndex() {
  const out = [];
  for (const p of pages) {
    out.push({
      t: plain(p.meta.title),
      u: `${p.slug}.html`,
      x: text(p.meta.lead || ''),
    });
    const parts = p.body.split(/(?=<section id=")/);
    for (const part of parts) {
      const m = part.match(/^<section id="([^"]+)">\s*<h2>([\s\S]*?)<\/h2>/);
      if (!m) continue;
      out.push({
        t: `${plain(p.meta.title)} § ${plain(m[2])}`,
        u: `${p.slug}.html#${m[1]}`,
        x: text(part.slice(m[0].length)),
      });
    }
  }
  return `// Generated by scripts/build/build-wiki.mjs.\nwindow.WIKI_INDEX = ${JSON.stringify(out)};\n`;
}

mkdirSync(OUT, { recursive: true });
for (const p of pages) {
  writeFileSync(join(OUT, `${p.slug}.html`), renderPage(p));
  console.log(`wiki/${p.slug}.html  ${p.secs.length} sections`);
}
for (const [name, members] of categories) {
  writeFileSync(join(OUT, catFile(name)), renderCategory(name, members));
  console.log(`wiki/${catFile(name)}  ${members.length} pages`);
}
writeFileSync(join(OUT, 'search-index.js'), searchIndex());
console.log('wiki/search-index.js');
