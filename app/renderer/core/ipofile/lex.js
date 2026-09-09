/**
 * @file Tokenizer for INPA's script language (.IPS / .SRC).
 *
 * The language is C-shaped: line and block comments, string / number / boolean
 * literals, identifiers, punctuation and the operator set the bytecode's BINOPS
 * table can express. `%NAME` state labels are lexed as one token because the
 * compiler emits them as one, and `#include "..."` is lexed as a directive
 * rather than stitched together from '#' and a string.
 *
 * Every token carries its line so a compile error can name it -- the whole
 * point of compiling in the app is that the user sees which line the compiler
 * could not take.
 */

/** Keywords the parser branches on, rather than treating as identifiers. */
const IPOF_KEYWORDS = new Set([
  'MENU', 'SCREEN', 'STATEMACHINE', 'STATE', 'INIT', 'ITEM', 'LINE',
  'if', 'else', 'while', 'return', 'in', 'out', 'inout',
  'bool', 'byte', 'int', 'long', 'real', 'string',
  'TRUE', 'FALSE',
]);

/**
 * The multi-character operators, longest first so `<=` never lexes as `<` `=`.
 * @type {string[]}
 */
const IPOF_OPS3 = ['&&', '||', '^^', '<=', '>=', '==', '!='];

/** Single-character punctuation and operators. */
const IPOF_OPS1 = '+-*/<>=!&|^(){},;:%';

/**
 * A lexical error, carrying the line the user has to look at.
 */
class IpofSyntaxError extends Error {
  /**
   * @param {string} message What went wrong.
   * @param {number} line The 1-based source line.
   */
  constructor(message, line) {
    super(`line ${line}: ${message}`);
    this.name = 'IpofSyntaxError';
    this.line = line;
  }
}

/**
 * Read a quoted string literal, honouring the backslash escapes the
 * decompiler emits (`\\` and `\"`).
 *
 * @param {string} src The source text.
 * @param {number} i Offset of the opening quote.
 * @param {number} line The current line, for errors.
 * @returns {{value: string, next: number}} The text and the offset after the
 *   closing quote.
 */
function ipofLexString(src, i, line) {
  let s = '';
  let p = i + 1;
  while (p < src.length && src[p] !== '"') {
    if (src[p] === '\\' && p + 1 < src.length) {
      const c = src[p + 1];
      s += c === 'n' ? '\n' : c === 't' ? '\t' : c;
      p += 2;
      continue;
    }
    if (src[p] === '\n') throw new IpofSyntaxError('unterminated string', line);
    s += src[p];
    p += 1;
  }
  if (p >= src.length) throw new IpofSyntaxError('unterminated string', line);
  return { value: s, next: p + 1 };
}

/**
 * Read a numeric literal.
 *
 * A dot or an exponent makes it a real; `0x` makes it an int written in hex.
 * The distinction matters downstream: the pool stores reals as f64 and ints as
 * a u16, so the literal's spelling picks its storage.
 *
 * @param {string} src The source text.
 * @param {number} i Offset of the first digit.
 * @returns {{value: number, real: boolean, next: number}} The value, whether it
 *   is a real, and the offset after it.
 */
function ipofLexNumber(src, i) {
  let p = i;
  if (src[p] === '0' && (src[p + 1] === 'x' || src[p + 1] === 'X')) {
    p += 2;
    while (p < src.length && /[0-9a-fA-F]/.test(src[p])) p += 1;
    return { value: parseInt(src.slice(i, p), 16), real: false, next: p };
  }
  let real = false;
  while (p < src.length && /[0-9]/.test(src[p])) p += 1;
  if (src[p] === '.' && /[0-9]/.test(src[p + 1] || '')) {
    real = true;
    p += 1;
    while (p < src.length && /[0-9]/.test(src[p])) p += 1;
  }
  if (src[p] === 'e' || src[p] === 'E') {
    const save = p;
    p += 1;
    if (src[p] === '+' || src[p] === '-') p += 1;
    if (/[0-9]/.test(src[p] || '')) {
      real = true;
      while (p < src.length && /[0-9]/.test(src[p])) p += 1;
    } else p = save;
  }
  const text = src.slice(i, p);
  return { value: real ? parseFloat(text) : parseInt(text, 10), real, next: p };
}

/**
 * Tokenize one INPA source file.
 *
 * @param {string} src The source text.
 * @returns {Array<{kind: string, value: *, line: number, real?: boolean}>} The
 *   tokens; `kind` is one of include, id, kw, str, num, op, state, eof.
 * @throws {IpofSyntaxError} On an unterminated string or an illegal character.
 */
function ipofLex(src) {
  const toks = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line += 1; i += 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === '#') {
      // `#include "name"` -- a directive, not a '#' followed by a string
      const m = /^#\s*include\s*"([^"]*)"/.exec(src.slice(i));
      if (m) {
        toks.push({ kind: 'include', value: m[1], line });
        i += m[0].length;
        continue;
      }
      // any other directive is skipped to end of line, as a preprocessor would
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '"') {
      const r = ipofLexString(src, i, line);
      toks.push({ kind: 'str', value: r.value, line });
      i = r.next;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const r = ipofLexNumber(src, i);
      toks.push({
        kind: 'num', value: r.value, real: r.real, line,
      });
      i = r.next;
      continue;
    }
    if (c === '%' && /[A-Za-z_]/.test(src[i + 1] || '')) {
      // a state label: `%NAME`, one token because it compiles to one
      let p = i + 1;
      while (p < src.length && /[A-Za-z0-9_]/.test(src[p])) p += 1;
      toks.push({ kind: 'state', value: src.slice(i + 1, p), line });
      i = p;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let p = i;
      while (p < src.length && /[A-Za-z0-9_]/.test(src[p])) p += 1;
      const word = src.slice(i, p);
      toks.push({ kind: IPOF_KEYWORDS.has(word) ? 'kw' : 'id', value: word, line });
      i = p;
      continue;
    }
    const two = src.substr(i, 2);
    if (IPOF_OPS3.indexOf(two) >= 0) {
      toks.push({ kind: 'op', value: two, line });
      i += 2;
      continue;
    }
    if (IPOF_OPS1.indexOf(c) >= 0) {
      toks.push({ kind: 'op', value: c, line });
      i += 1;
      continue;
    }
    throw new IpofSyntaxError(`unexpected character ${JSON.stringify(c)}`, line);
  }
  toks.push({ kind: 'eof', value: null, line });
  return toks;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ipofLex, IpofSyntaxError, IPOF_KEYWORDS,
  };
}
