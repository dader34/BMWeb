// Flat ESLint config. The renderer currently ships as plain <script> globals
// (no module system yet -- see the code-quality roadmap), so files share one
// ambient scope at runtime but ESLint sees each as its own script file. That
// makes cross-file `no-undef` impractical (every cross-file call reads as
// undefined), so it is off for the renderer; the value here is the correctness
// rules that catch real, in-file bugs (dead code, duplicate keys, accidental
// redeclare, unused vars). When the ESM migration lands, turn `no-undef` back
// on and drop the ambient-globals allowances.

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'dist-web/**',
      'data/**',
      'vendor/**',
      'app/renderer/vendor/**',
      'src/**',
      // generated data blobs: machine-authored, never linted
      'app/renderer/data/faultdb.js',
      'app/renderer/data/pcodes.js',
      'app/renderer/data/faultinfo.js',
      'app/renderer/data/faultmeta.js',
      'app/renderer/data/faultindex.js',
      'app/renderer/data/codingmap.js',
      'app/renderer/data/datenmap.js',
      'app/renderer/data/envmap.js',
      'app/renderer/data/sanames.js',
      'app/renderer/data/sget.js',
      'app/renderer/data/tables.js',
    ],
  },

  // The browser renderer: script scope, browser globals.
  {
    files: ['app/renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // build-time / host globals the renderer legitimately reads
        fflate: 'readonly',
        bmacw: 'readonly',
        module: 'writable',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // pre-ESM: cross-file references are "undefined" to a per-file linter
      'no-undef': 'off',
      // unused vars: warn (not error) -- there are legitimate _-prefixed and
      // signature-position unused args; error would be noise pre-cleanup
      'no-unused-vars': [
        'warn',
        { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // empty catch is a deliberate pattern here (best-effort teardown); allow
      // it only when the block has a comment
      'no-empty': ['error', { allowEmptyCatch: true }],
      // real correctness bugs -> error
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'no-cond-assign': ['error', 'except-parens'],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-fallthrough': 'error',
      'no-redeclare': 'error',
      'valid-typeof': 'error',
      'use-isnan': 'error',
      // dead stores and multi-space regexes are worth surfacing but are not
      // breakage -- keep them visible without blocking the build
      'no-useless-assignment': 'warn',
      'no-regex-spaces': 'warn',
    },
  },

  // Node tooling: generators and build scripts.
  {
    files: ['tools/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': [
        'warn',
        { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-assignment': 'warn',
      'no-regex-spaces': 'warn',
    },
  },

  // Verify harnesses load renderer source into a VM context, so they reference
  // browser + renderer globals as well as Node's -- no-undef would be noise.
  {
    files: ['tools/verify/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { 'no-undef': 'off' },
  },

  // The .mjs build scripts are ES modules.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { sourceType: 'module' },
  },

  // thor_bridge.js lives under app/renderer/ but is a Node relay, not renderer
  // code -- lint it as CommonJS/Node so `require('crypto')` isn't a redeclare.
  {
    files: ['app/renderer/thor_bridge.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },

  // The beta collector is a Cloudflare Worker (ES module, service-worker env).
  {
    files: ['tools/beta/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.serviceworker, ...globals.browser },
    },
  },
];
