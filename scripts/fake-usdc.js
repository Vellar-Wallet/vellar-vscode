/**
 * Fixture replacement for testPayment/usdc.js — used by
 * run-testpayment-assertion-check.js only, to make the flow terminate
 * quickly and deterministically once it has demonstrably passed the
 * assertion, without a real Horizon/DEX round trip. Always fails cleanly
 * (never throws) so runTestPayment's own error handling is exercised
 * normally rather than short-circuited by an unexpected throw shape.
 */
exports.openUsdcTrustline = function openUsdcTrustline() {
  return Promise.resolve({ ok: false, reason: "test stub — assertion-check does not exercise real USDC purchase" });
};

exports.buyUsdc = function buyUsdc() {
  return Promise.resolve({ ok: false, reason: "test stub — unreachable, openUsdcTrustline already failed" });
};
