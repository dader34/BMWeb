/**
 * @file The shim's composition root: lock the bus, publish the public
 * surface on window, and install the fetch shim. Loads last, after every
 * other core/webshim/ piece.
 */

/**
 * Forget everything known about the car on the other end of the cable:
 * the EDIABAS sessions (without ENDE -- the wire is already going away) and
 * the resolved variants. Run before the bus disconnects.
 */
function forgetCar() {
  forgetSessions();
  forgetResolvedVariants();
}

lockBus(webBus, forgetCar);

if (typeof window !== 'undefined') {
  window.webBus = webBus;
  window.installWebShim = installWebShim;
  // group -> variant resolution, for the sweep screen: which SGBD answers
  // at this diagnostic address? (lowercased SGBD name, or null)
  window.webResolveVariant = webResolveVariant;
  window.webResolveVariantLast = webResolveVariantLast;
  // The explicitly-confirmed coding write path (the UI's "code this module"
  // action). Gated on opts.confirmed and its own re-read proof; see coding.js.
  window.webWriteCoding = webWriteCoding;
  installWebShim();
}
