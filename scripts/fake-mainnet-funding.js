/**
 * Fixture replacement for testPayment/mainnetFunding.js's
 * fundThrowawayFromMainnetWallet, substituted via esbuild's onResolve
 * plugin (same technique as fake-friendbot.js/fake-usdc.js) so
 * run-testpayment-assertion-check.js can assert on WHETHER/HOW this was
 * called, without a real Horizon submit. Always succeeds (unlike
 * fake-usdc.js, which always fails) — the assertion-check's mainnet cases
 * need to observe the flow PROCEED past funding into the (faked, always-
 * failing) USDC trustline step, to prove funding itself was reached with
 * the right arguments, not that the whole flow succeeds end-to-end.
 */
let calls = [];

exports.fundThrowawayFromMainnetWallet = function fundThrowawayFromMainnetWallet(secret, publicKey, network) {
  calls.push({ secret, publicKey, network });
  return Promise.resolve({ ok: true });
};

exports._test = {
  get calls() {
    return calls;
  },
  get callCount() {
    return calls.length;
  },
  reset() {
    calls = [];
  },
};
