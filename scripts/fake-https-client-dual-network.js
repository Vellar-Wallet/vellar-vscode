/**
 * Second, purpose-built fixture for the discovery network-matching
 * regression check (run-discovery-network-check.js) — deliberately
 * SEPARATE from fake-https-client.js rather than adding a second accept
 * entry there, so every other acceptance script that already depends on
 * fake-https-client.js's single-accept shape (run-postmessage-leak-check.js,
 * run-network-toggle-check.js) keeps its existing, already-passing
 * assertions untouched.
 *
 * Models the REAL shape confirmed live against the facilitator's
 * /discovery/resources for a genuinely dual-network resource (the real
 * /quote endpoint, confirmed via `curl` while building this fix): one item
 * whose accepts[] array carries BOTH a stellar:testnet AND a stellar:pubnet
 * entry, with DIFFERENT payTo/amount/asset per entry — the exact shape that
 * would previously break under a blind accepts[0] read.
 */

const TEST_ADDRESS_TESTNET_PAYTO = "GAATVGLRHZXFC66GEN5QNKD56HC5JJZVHQ3P7ZJNVCCI4WKLN44FICSC";
const TEST_ADDRESS_PUBNET_PAYTO = "GD6TC7QY35TZ5VHPMGCPQUDHRBLXZEI3HCBLHTBBAY2RX3L6PBWI5C2O";
const USDC_SAC_TESTNET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const USDC_SAC_PUBNET = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

exports.TEST_ADDRESS_TESTNET_PAYTO = TEST_ADDRESS_TESTNET_PAYTO;
exports.TEST_ADDRESS_PUBNET_PAYTO = TEST_ADDRESS_PUBNET_PAYTO;

function httpsGetJson(url) {
  if (url.includes("/discovery/resources")) {
    return Promise.resolve({
      items: [
        {
          resource: "https://vellar-seller-demo.onrender.com/quote",
          accepts: [
            {
              scheme: "exact",
              network: "stellar:testnet",
              asset: USDC_SAC_TESTNET,
              amount: "1000000",
              payTo: TEST_ADDRESS_TESTNET_PAYTO,
            },
            {
              scheme: "exact",
              network: "stellar:pubnet",
              asset: USDC_SAC_PUBNET,
              amount: "2500000",
              payTo: TEST_ADDRESS_PUBNET_PAYTO,
            },
          ],
          trust: { settlements: 290, lastSettled: "2026-09-17T21:21:40.153Z", ownershipState: "verified" },
        },
      ],
    });
  }
  return Promise.reject(new Error(`fake-https-client-dual-network: no fixture wired for ${url}`));
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
