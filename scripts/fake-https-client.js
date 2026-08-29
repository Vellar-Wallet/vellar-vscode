/**
 * Fixture-serving replacement for sidebar/httpsClient.js's httpsGetJson,
 * substituted via esbuild's --alias so scripts/run-postmessage-leak-check.js
 * can exercise DataProvider's real fetch/transform/postMessage logic
 * deterministically and offline — no live network call anywhere in this
 * test, matching this repo's other acceptance scripts (see ci.yml's own
 * "deliberately vscode-free" comment; this is the equivalent for network
 * dependence). Every fixture value below is a plausible, correctly-shaped
 * real response — not exercising anything httpsGetJson itself does (that's
 * covered by this whole feature having been built against live data across
 * every step's own manual verification), only exercising what DataProvider/
 * webviewProvider do with a response once they have one.
 */

const TEST_ADDRESS = "GAATVGLRHZXFC66GEN5QNKD56HC5JJZVHQ3P7ZJNVCCI4WKLN44FICSC";
const TEST_PAYER = "GB5STIDS4JSM76JRVRDBKK7KAQ5XE7STBHFY7PN24NRJVO62TVWMF364";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

exports.TEST_ADDRESS = TEST_ADDRESS;
exports.TEST_PAYER = TEST_PAYER;

function httpsGetJson(url) {
  if (url.includes("horizon-testnet.stellar.org/accounts/")) {
    return Promise.resolve({
      balances: [
        { asset_type: "native", balance: "9999.9999900" },
        { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_ISSUER, balance: "42.5000000" },
      ],
    });
  }
  if (url.includes("/discovery/resources")) {
    return Promise.resolve({
      items: [
        {
          resource: "https://vellar-seller-demo.onrender.com/quote",
          accepts: [{ asset: USDC_SAC, amount: "1000000", payTo: TEST_ADDRESS }],
          trust: { settlements: 3, lastSettled: "2026-08-24T20:35:00.000Z", ownershipState: "verified" },
        },
      ],
    });
  }
  if (url.includes("/payments")) {
    return Promise.resolve({
      items: [
        {
          txHash: "6fc5f7ad7b2a170fa41e5594af1e9f05808c16639ffcf1cea099e06df6f46801",
          closedAt: "2026-08-24T23:16:13.000Z",
          buyer: TEST_PAYER,
          amount: "1000000",
          assetSymbol: "USDC",
        },
      ],
    });
  }
  return Promise.reject(new Error(`fake-https-client: no fixture wired for ${url}`));
}

exports.httpsGetJson = httpsGetJson;

class HttpStatusError extends Error {
  constructor(status, url, bodySnippet) {
    super(`HTTP ${status} from ${url}`);
    this.status = status;
    this.url = url;
    this.bodySnippet = bodySnippet;
    this.name = "HttpStatusError";
  }
}
exports.HttpStatusError = HttpStatusError;
