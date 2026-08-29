/**
 * Fixture replacement for testPayment/friendbot.js's fundWithFriendbot,
 * substituted via esbuild's onResolve plugin (same technique as
 * fake-https-client.js) so run-testpayment-assertion-check.js can assert
 * on WHETHER this was called, without making a real friendbot request.
 */
let callCount = 0;

exports.fundWithFriendbot = function fundWithFriendbot() {
  callCount += 1;
  return Promise.resolve();
};

exports._test = {
  get callCount() {
    return callCount;
  },
  reset() {
    callCount = 0;
  },
};
