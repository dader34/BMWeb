/**
 * @file Reading BMWeb's PACKS: many files stored once and compressed
 * together, as an offline build carries its data. Published as the
 * `bmwebPacks` global.
 *
 * WHY PACKS. The data is thousands of files that are near-copies of one
 * another (an ECU and its variants, a wiring diagram across model years),
 * and the same file repeated under every car that has it. A zip compresses
 * each file alone and sees none of that: the chassis archives were 486 MB of
 * a 1 GB download and held 4,108 ECU files of which 1,442 were distinct.
 * A pack is those files laid end to end, like beside like, as ONE zstd
 * frame with a 32 MB window, so a file costs only what is new in it.
 * scripts/build/pack_offline.py makes them; the hosted site does not use
 * them (a hosted reader fetches one car, and a pack is a slice of every car).
 *
 * A PACK IS A PLAIN .zst FILE. What is in it is said by the index beside
 * it: each member's pack, offset, length and CRC-32.
 *
 * EVERY MEMBER IS CHECKED. `member` compares what it took out against the
 * CRC-32 the index recorded and throws rather than return something else.
 * The decompressor is third-party code with a known limit
 * (vendor/fzstd.js); the check is what makes a wrong byte an error
 * instead of a wrong answer.
 *
 * app/renderer/core/*.js style: browser global, no imports; dual-exported
 * for require() so a headless test can drive it.
 */

(function (root) {
  'use strict';

  /** The CRC-32 table, made on first use. @type {Uint32Array|null} */
  let table = null;
  /**
   * CRC-32 (the zlib one) of some bytes.
   * @param {Uint8Array} bytes - What to sum.
   * @returns {number} Unsigned.
   */
  function crc32(bytes) {
    if (!table) {
      table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++)
          c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++)
      c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /**
   * A reader over one folder of packs.
   *
   * A pack is unpacked whole to read one member, so the last two are kept:
   * what is read next is usually beside what was read last. `keep` bounds
   * the memory: a pack is 32 MB unpacked, and there is a reader per kind
   * of data (ECUs, ISTA, wiring, documents, plain files).
   * @param {object} o - How to read.
   * @param {(name: string) => Promise<Uint8Array>} o.fetchPack - A pack's
   *   bytes, by its file name. Rejects when it cannot be had.
   * @param {(z: Uint8Array) => Uint8Array} o.decompress - zstd
   *   (fzstd.decompress).
   * @param {number} [o.keep=2] - How many unpacked packs to hold.
   * @returns {{member: (name: string, rawLength: number, at: number[]) =>
   *   Promise<Uint8Array>}}
   */
  function reader(o) {
    const keep = o.keep || 2;
    /** @type {Map<string, Promise<Uint8Array>>} newest last */
    const held = new Map();

    const unpacked = (name, rawLength) => {
      const hit = held.get(name);
      if (hit) {
        held.delete(name);
        held.set(name, hit);
        return hit;
      }
      const p = o.fetchPack(name).then((z) => {
        const raw = o.decompress(z);
        if (raw.length !== rawLength)
          throw new Error(
            `pack ${name} unpacked to ${raw.length} bytes, not its ${rawLength}`
          );
        return raw;
      });
      held.set(name, p);
      p.catch(() => {
        if (held.get(name) === p) held.delete(name);
      });
      while (held.size > keep) held.delete(held.keys().next().value);
      return p;
    };

    /**
     * One member, as its own bytes (a copy: it does not pin the pack).
     * @param {string} name - The pack's file name.
     * @param {number} rawLength - The pack's unpacked length, from the index.
     * @param {number[]} at - [offset, length, crc32] within the pack.
     * @returns {Promise<Uint8Array>}
     * @throws {Error} When the pack cannot be read, or the member is not
     *   the bytes that were packed.
     */
    const member = async (name, rawLength, at) => {
      const raw = await unpacked(name, rawLength);
      const [offset, length, crc] = at;
      if (offset + length > raw.length)
        throw new Error(`pack ${name} is shorter than its index says`);
      const bytes = raw.slice(offset, offset + length);
      if (crc32(bytes) !== crc)
        throw new Error(
          `a file from pack ${name} is not what was packed; it was not used`
        );
      return bytes;
    };
    return { member };
  }

  /**
   * Whether this build may carry packs at all. Only an offline build does
   * (its offline.js sets BMWEB_OFFLINE); the hosted site is never asked,
   * or every visit would cost it a 404 per kind of pack. BMWEB_PACKS is the
   * same switch for a development copy.
   * @returns {boolean}
   */
  function wanted() {
    return !!(root.BMWEB_OFFLINE || root.BMWEB_PACKS);
  }

  /**
   * A folder of packed ARCHIVES: what were zip files of many members (a
   * car's ISTA bundle, its wiring archive), now each member once in the
   * folder's packs, with a list per archive saying where its members are.
   * A member is read when it is asked for; nothing is unzipped up front.
   *
   *   <dir>/index.json    {"packs", "raw", "archives": {"E46.ista":
   *                        [list file, its length, its crc32]}}
   *   <dir>/E46.idx.zst   {"<member>": [pack, offset, length, crc32, gz?]}
   *
   * `gz` marks a member that was gzipped in the archive and is kept as
   * what it unzips to.
   * @param {object} o - How to read.
   * @param {string} o.dir - The folder's URL, no trailing slash.
   * @param {(url: string) => Promise<Response>} o.fetch - A fetch that
   *   reaches the files.
   * @param {(z: Uint8Array) => Uint8Array} o.decompress - zstd.
   * @param {number} [o.keep] - Unpacked packs to hold (see reader).
   * @returns {{has: (archive: string) => Promise<boolean>,
   *   members: (archive: string) => Promise<string[]|undefined>,
   *   file: (archive: string, member: string) =>
   *     Promise<{bytes: Uint8Array, gz: boolean}|null|undefined>,
   *   zip: (archive: string, fflate: any) => Promise<Uint8Array|undefined>}}
   *   `file`, `members` and `zip` answer undefined when this build does not
   *   pack that archive (so the caller reads it the old way), and `file`
   *   null when it does and the archive has no such member. `zip` is the
   *   archive made whole again, for the one reader that wants the FILE (the
   *   offline exporter): the same members under the same names, a gzipped
   *   one gzipped again.
   */
  function archives(o) {
    /** @type {Promise<{index: any, read: {member: Function}}|null>|null} */
    let opening = null;
    /** @type {Map<string, Promise<Record<string, number[]>>>} */
    const lists = new Map();
    const bytesOf = async (name) => {
      const r = await o.fetch(`${o.dir}/${name}`);
      if (!r.ok)
        throw new Error(`${o.dir}/${name}: ${r.statusText || r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    };
    const open = () => {
      if (!opening)
        opening = (async () => {
          if (!wanted()) return null;
          try {
            const r = await o.fetch(`${o.dir}/index.json`);
            if (!r.ok) return null;
            const index = await r.json();
            if (!index || !index.archives || !Array.isArray(index.packs))
              return null;
            return {
              index,
              read: reader({
                fetchPack: bytesOf,
                decompress: o.decompress,
                keep: o.keep,
              }),
            };
          } catch (e) {
            return null;
          }
        })();
      return opening;
    };
    const list = (st, archive) => {
      if (!lists.has(archive)) {
        const [file, length, crc] = st.index.archives[archive];
        const p = bytesOf(file).then((z) => {
          const raw = o.decompress(z);
          if (raw.length !== length || crc32(raw) !== crc)
            throw new Error(`the list of ${archive} is not what was packed`);
          return JSON.parse(new TextDecoder('utf-8').decode(raw));
        });
        lists.set(archive, p);
        p.catch(() => lists.delete(archive));
      }
      return lists.get(archive);
    };
    return {
      async has(archive) {
        const st = await open();
        return !!(st && st.index.archives[archive]);
      },
      async members(archive) {
        const st = await open();
        if (!st || !st.index.archives[archive]) return undefined;
        return Object.keys(await list(st, archive));
      },
      async file(archive, member) {
        const st = await open();
        if (!st || !st.index.archives[archive]) return undefined;
        const at = (await list(st, archive))[member];
        if (!at) return null;
        const bytes = await st.read.member(
          st.index.packs[at[0]],
          st.index.raw[at[0]],
          at.slice(1, 4)
        );
        return { bytes, gz: !!at[4] };
      },
      async zip(archive, fflate) {
        const st = await open();
        if (!st || !st.index.archives[archive]) return undefined;
        const l = await list(st, archive);
        // in the packs' own order, so each pack is unpacked once
        const names = Object.keys(l).sort(
          (a, b) => l[a][0] - l[b][0] || l[a][1] - l[b][1]
        );
        const files = {};
        for (const name of names) {
          const at = l[name];
          const bytes = await st.read.member(
            st.index.packs[at[0]],
            st.index.raw[at[0]],
            at.slice(1, 4)
          );
          // a gzipped member is stored (it will not deflate again), a plain
          // one deflated, as the archives are built
          files[name] = at[4]
            ? [fflate.gzipSync(bytes, { level: 6 }), { level: 0 }]
            : [bytes, { level: 6 }];
        }
        return fflate.zipSync(files);
      },
    };
  }

  /** Folders of packed archives, by URL: one reader (and its held packs) each. */
  const folders = new Map();
  /**
   * The reader over one folder of packed archives, made once per folder so
   * that every caller shares the packs it holds unpacked.
   * @param {string} dir - The folder's URL, no trailing slash.
   * @param {(url: string) => Promise<Response>} fetch - A fetch that reaches
   *   the files.
   * @param {(z: Uint8Array) => Uint8Array} decompress - zstd.
   * @returns {ReturnType<typeof archives>}
   */
  function folder(dir, fetch, decompress) {
    if (!folders.has(dir))
      folders.set(dir, archives({ dir, fetch, decompress }));
    return folders.get(dir);
  }

  const api = { crc32, reader, wanted, archives, folder };
  if (typeof root !== 'undefined') root.bmwebPacks = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
