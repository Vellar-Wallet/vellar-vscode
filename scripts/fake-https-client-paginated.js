/**
 * A controllable fake httpsGetJson, purpose-built for
 * run-settlements-pagination-check.js — unlike fake-https-client.js's fixed
 * fixtures (right for the leak-check's "does one realistic response leak
 * the address" question), this test needs DIFFERENT /payments responses
 * across successive calls within the same run (page 1, then page 2, then a
 * poll tick with new data, etc.), and needs to record every call's URL so
 * the test can assert the real cursor value was actually sent.
 *
 * `/accounts/` (wallet) and `/discovery/resources` (endpoints) always return
 * a fixed, minimal, correctly-shaped response — this test only cares about
 * Recent Settlements, those two sections just need to not error out so the
 * sidebar's other pollers don't spam the output channel during the run.
 *
 * `/payments` calls are served from `paymentsResponses`, a queue set by the
 * test before each action that should trigger a fetch — `shiftPaymentsResponse`
 * throws loudly if the test forgot to queue one, rather than silently
 * falling through to a stale/wrong response.
 */

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const paymentsCalls = [];
let paymentsResponses = [];

function queuePaymentsResponse(response) {
  paymentsResponses.push(response);
}

function resetPaymentsFake() {
  paymentsCalls.length = 0;
  paymentsResponses = [];
}

function httpsGetJson(url) {
  if (url.includes("horizon-testnet.stellar.org/accounts/")) {
    return Promise.resolve({
      balances: [
        { asset_type: "native", balance: "100.0000000" },
        { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_ISSUER, balance: "0.0000000" },
      ],
    });
  }
  if (url.includes("/discovery/resources")) {
    return Promise.resolve({ items: [] });
  }
  if (url.includes("/payments")) {
    paymentsCalls.push(url);
    if (paymentsResponses.length === 0) {
      return Promise.reject(new Error(`fake-https-client-paginated: no queued /payments response for ${url}`));
    }
    return Promise.resolve(paymentsResponses.shift());
  }
  return Promise.reject(new Error(`fake-https-client-paginated: no fixture wired for ${url}`));
}

class HttpStatusError extends Error {
  constructor(status, url, bodySnippet) {
    super(`HTTP ${status} from ${url}`);
    this.status = status;
    this.url = url;
    this.bodySnippet = bodySnippet;
    this.name = "HttpStatusError";
  }
}

module.exports = {
  httpsGetJson,
  HttpStatusError,
  queuePaymentsResponse,
  resetPaymentsFake,
  paymentsCalls,
};
