/**
 * @file The Wiring & Documents screen as the rest of the renderer sees it.
 *
 * This directory is ES modules; scripts/build/bundle-modules.mjs builds it
 * into core/generated/wiring.js, a classic script defining the global
 * `wiring` whose members are the exports below. The router, the chassis
 * nav and the Apps hub open the screens (`wiring.showWiring(id)`), the
 * garage borrows the clipboard helper, the ISTA window the zoom step. What
 * the screen needs from the classic shell is listed in shell.mjs.
 */

export { showWiringChassis } from './picker.mjs';
export { showWiring } from './screen.mjs';
export { showWiringVinDecoder } from './vin.mjs';
export { wiringCopyText } from './share-print.mjs';
export { wiringChassisList } from './archive.mjs';
export { WIRING_ZOOM_STEP } from './viewer.mjs';
export { wiringApplicability } from './applicability.mjs';
