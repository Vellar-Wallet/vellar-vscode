/**
 * Bundled by run-network-switch-check.js with "vscode" aliased to
 * vscode-test-stub.js (same technique as run-testpayment-assertion-check.js)
 * — needed because DataProvider.getConfiguredNetwork() genuinely calls
 * vscode.workspace.getConfiguration(...). usdc.ts's own network-keyed maps
 * (HORIZON_URL_BY_NETWORK, USDC_ISSUER_BY_NETWORK) need no such alias — that
 * module still has no vscode import at all — so this file imports them
 * directly, same as horizon-timeout-entry.ts does for usdc.ts's timeout
 * constants.
 */
import { DataProvider } from "../src/sidebar/dataProvider";
import { HORIZON_URL_BY_NETWORK, USDC_ISSUER_BY_NETWORK } from "../src/sidebar/testPayment/usdc";

interface VscodeTestNamespace {
  setNetwork(value: string): void;
  resetNetwork(): void;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeTest = require("./vscode-test-stub")._test as VscodeTestNamespace;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }
  console.log(`  ok: ${message}`);
}

/**
 * Part 1: getConfiguredNetwork() must return each of the two real settings
 * values unchanged — the "happy path" half of the validation logic, proven
 * separately from the fallback half below so a bug that broke ONE valid
 * value while leaving the other working could not hide behind an
 * always-passing "some value came back" assertion.
 */
function testValidValuesPassThrough(): void {
  vscodeTest.setNetwork("stellar:testnet");
  assert(DataProvider.getConfiguredNetwork() === "stellar:testnet", "getConfiguredNetwork() returns stellar:testnet unchanged when configured");

  vscodeTest.setNetwork("stellar:pubnet");
  assert(DataProvider.getConfiguredNetwork() === "stellar:pubnet", "getConfiguredNetwork() returns stellar:pubnet unchanged when configured");
}

/**
 * Part 2: an unrecognized value (a corrupted settings.json, or a stale value
 * left over from a future version with a third network option) must fall
 * back to the declared default (stellar:pubnet) — never propagate as a raw
 * string into a network identifier passed to Horizon, Soroban RPC, or the
 * x402 client.
 */
function testGarbageValueFallsBackToDefault(): void {
  vscodeTest.setNetwork("not-a-real-network");
  assert(
    DataProvider.getConfiguredNetwork() === "stellar:pubnet",
    "getConfiguredNetwork() falls back to stellar:pubnet for an unrecognized value",
  );

  vscodeTest.setNetwork("");
  assert(DataProvider.getConfiguredNetwork() === "stellar:pubnet", "getConfiguredNetwork() falls back to stellar:pubnet for an empty string");
}

/**
 * Part 3: with the setting entirely unset (no vellar-x402.network key at all
 * in settings.json — the real state of every workspace before this feature
 * shipped, and of any workspace that never touched the setting), the fake
 * vscode.workspace.getConfiguration(...).get(key, fallback)'s own fallback
 * argument applies, exactly like the real VS Code API. Proves the package.json
 * declared default and this file's own DEFAULT_NETWORK constant agree.
 */
function testUnsetFallsBackToDeclaredDefault(): void {
  vscodeTest.resetNetwork();
  assert(DataProvider.getConfiguredNetwork() === "stellar:pubnet", "getConfiguredNetwork() defaults to stellar:pubnet when the setting is entirely unset");
}

/**
 * Part 4: the single highest-consequence lookup in the whole feature — get
 * this wrong and a real trade targets the wrong asset (usdc.ts) or the wrong
 * ledger entirely (horizon.stellar.org vs horizon-testnet.stellar.org).
 * Network-free, no vscode needed — usdc.ts's maps are plain exported
 * constants.
 */
function testUsdcAndHorizonLookupsAreNetworkCorrect(): void {
  assert(
    HORIZON_URL_BY_NETWORK["stellar:testnet"] === "https://horizon-testnet.stellar.org",
    "HORIZON_URL_BY_NETWORK resolves testnet to the testnet Horizon instance",
  );
  assert(
    HORIZON_URL_BY_NETWORK["stellar:pubnet"] === "https://horizon.stellar.org",
    "HORIZON_URL_BY_NETWORK resolves pubnet to the mainnet Horizon instance",
  );
  assert(
    HORIZON_URL_BY_NETWORK["stellar:testnet"] !== HORIZON_URL_BY_NETWORK["stellar:pubnet"],
    "testnet and pubnet Horizon URLs are genuinely distinct",
  );

  assert(
    USDC_ISSUER_BY_NETWORK["stellar:testnet"] === "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    "USDC_ISSUER_BY_NETWORK resolves testnet to the canonical testnet USDC issuer",
  );
  assert(
    USDC_ISSUER_BY_NETWORK["stellar:pubnet"] === "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    "USDC_ISSUER_BY_NETWORK resolves pubnet to the canonical mainnet USDC issuer",
  );
  assert(
    USDC_ISSUER_BY_NETWORK["stellar:testnet"] !== USDC_ISSUER_BY_NETWORK["stellar:pubnet"],
    "testnet and pubnet USDC issuers are genuinely distinct — never the same asset across networks",
  );
}

export function runNetworkSwitchChecks(): void {
  testValidValuesPassThrough();
  testGarbageValueFallsBackToDefault();
  testUnsetFallsBackToDeclaredDefault();
  testUsdcAndHorizonLookupsAreNetworkCorrect();
}
