/**
 * @file The parts catalogue (BMW ETK) as the rest of the renderer sees it.
 *
 * This directory is ES modules; scripts/build/bundle-modules.mjs builds it
 * into core/generated/etk.js, a classic script defining the global `etk`
 * whose members are the exports below. The router and the Apps hub open
 * the screens (`etk.showEtk()`), the garage and the vehicle-identity screen
 * decode VINs (`etk.decodeVin(await etk.loadVinIndex(), vin)`). What the
 * catalogue needs from the classic shell is listed in shell.mjs.
 */

export {
  showEtk,
  showEtkChassis,
  showEtkDeep,
  showEtkGrid,
  etkBackAction,
  ETK_STATE,
} from './catalogue.mjs';
export { decodeVin, loadVinIndex } from './vin.mjs';
export { loadVehicles, etkChassisList, loadEtk } from './data.mjs';
export { showVinDecoder, etkMatchVariant } from './identify.mjs';
