// The scanner's reference data pack for the tests. It is not in the
// repository (app/renderer/screens/scanner/scanner-assets.js): the tests
// read the local copy the app also reads first, data/scanner/..., and the
// ones that need it skip when it is not there. Fetch it with
//   curl -L -o data/scanner/reference-1.4.0.7.json.gz --create-dirs \
//     https://huggingface.co/datasets/CraigFf/bmweb-etk/resolve/main/scanner/reference-1.4.0.7.json.gz
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
  SCANNER_ASSETS_REL,
} = require('../../app/renderer/screens/scanner/scanner-assets.js');

/**
 * @returns {object|null} The pack, or null when there is no local copy.
 */
function scannerPack() {
  const p = path.join(__dirname, '../../data', SCANNER_ASSETS_REL);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
}

/**
 * The pack, or end the test as skipped.
 * @param {string} what - The test's name, for the message.
 * @returns {object}
 */
function scannerPackOrSkip(what) {
  const pack = scannerPack();
  if (pack) return pack;
  console.log(
    `SKIP ${what}: no data/${SCANNER_ASSETS_REL} (see tools/verify/scanner_pack.js)`
  );
  process.exit(0);
}

module.exports = { scannerPack, scannerPackOrSkip };
