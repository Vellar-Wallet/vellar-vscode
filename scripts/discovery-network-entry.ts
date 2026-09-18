/**
 * Bundled by run-discovery-network-check.js with "vscode" aliased to
 * vscode-test-stub.js and dataProvider.ts's "./httpsClient" import
 * redirected to fake-https-client-dual-network.js — the same two
 * substitutions postmessage-leak-entry.ts uses, but against a fixture that
 * genuinely models a dual-network resource (see that fixture's own header
 * comment), which fake-https-client.js's existing single-accept shape
 * cannot exercise.
 *
 * Proves fetchEndpoints() (exercised indirectly through the real
 * DataProvider.endpoints PollingSource — not a reimplementation of its
 * logic) selects the accept ENTRY matching the configured network, not
 * always accepts[0], for a resource whose accepts[] array carries multiple
 * networks with genuinely different payTo/amount/asset per entry.
 */
import { DataProvider, type EndpointsState } from "../src/sidebar/dataProvider";
import { FakeMemento } from "./fake-memento";
import { TEST_ADDRESS_TESTNET_PAYTO, TEST_ADDRESS_PUBNET_PAYTO } from "./fake-https-client-dual-network";

interface VscodeTestNamespace {
  setPayToAddress(value: string): void;
  setNetwork(value: string): void;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeTest = require("./vscode-test-stub")._test as VscodeTestNamespace;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok: ${message}`);
}

/**
 * Waits for the FIRST "ok" result on dataProvider.endpoints. DataProvider's
 * own constructor never calls PollingSource.start() on any source — that
 * only happens via the FocusVisibilityGate wiring inside
 * VellarSidebarProvider (see webviewProvider.ts's constructor and
 * onDidChangeVisibility) — so a bare DataProvider like this test
 * constructs, with no VellarSidebarProvider alongside it, never actually
 * polls unless something starts it explicitly. This calls .start() itself
 * (a real, public PollingSource method — see polling.ts's own
 * PollingSourceLike interface) rather than standing up a whole
 * VellarSidebarProvider + fake WebviewView just to reach the same effect,
 * since this test only cares about ONE source's fetch/transform logic, not
 * the webview wiring postmessage-leak-entry.ts and network-toggle-entry.ts
 * already cover.
 */
function waitForFirstLoadedResult(dataProvider: DataProvider): Promise<EndpointsState> {
  return new Promise((resolve, reject) => {
    const disposable = dataProvider.endpoints.onDidUpdate((result) => {
      if (result.status === "ok") {
        disposable.dispose();
        resolve(result.data);
      } else if (result.status === "error") {
        disposable.dispose();
        reject(new Error("endpoints fetch errored"));
      }
    });
    dataProvider.endpoints.start();
  });
}

/**
 * Part 1: configured for stellar:testnet, developer's own address matches
 * the TESTNET accept's payTo specifically. The selected entry must be the
 * testnet one — its own payTo, amount, and asset — never the pubnet
 * entry's values, even though both entries live in the same accepts[]
 * array for this one resource.
 */
async function testSelectsTestnetEntryWhenConfiguredForTestnet(): Promise<void> {
  vscodeTest.setNetwork("stellar:testnet");
  vscodeTest.setPayToAddress(TEST_ADDRESS_TESTNET_PAYTO);
  const dataProvider = new DataProvider(new FakeMemento() as never);
  try {
    const state = await waitForFirstLoadedResult(dataProvider);
    assert(state.kind === "loaded", "endpoints state is loaded");
    if (state.kind !== "loaded") return;
    assert(state.listings.length === 1, `exactly one listing is returned, got ${state.listings.length}`);
    const listing = state.listings[0];
    assert(listing.payTo === TEST_ADDRESS_TESTNET_PAYTO, "selected entry's payTo is the TESTNET accept's payTo");
    assert(listing.amount === "1000000", `selected entry's amount is the testnet accept's amount, got ${listing.amount}`);
    assert(
      listing.priceLabel === "0.10 USDC",
      `priceLabel reflects the testnet accept's own SAC contract match, got "${listing.priceLabel}"`,
    );
  } finally {
    dataProvider.dispose();
  }
}

/**
 * Part 2: same resource, configured for stellar:pubnet instead, developer's
 * own address matches the PUBNET accept's payTo. Proves the selection
 * genuinely follows the network setting, not a fixed index or an
 * accidentally-always-first-match — the two assertions (testnet above,
 * pubnet here) would look identical if the code still just read
 * accepts[0], since accepts[0] IS the testnet entry in this fixture.
 */
async function testSelectsPubnetEntryWhenConfiguredForPubnet(): Promise<void> {
  vscodeTest.setNetwork("stellar:pubnet");
  vscodeTest.setPayToAddress(TEST_ADDRESS_PUBNET_PAYTO);
  const dataProvider = new DataProvider(new FakeMemento() as never);
  try {
    const state = await waitForFirstLoadedResult(dataProvider);
    assert(state.kind === "loaded", "endpoints state is loaded");
    if (state.kind !== "loaded") return;
    assert(state.listings.length === 1, `exactly one listing is returned, got ${state.listings.length}`);
    const listing = state.listings[0];
    assert(listing.payTo === TEST_ADDRESS_PUBNET_PAYTO, "selected entry's payTo is the PUBNET accept's payTo");
    assert(listing.amount === "2500000", `selected entry's amount is the pubnet accept's amount, got ${listing.amount}`);
    assert(
      listing.priceLabel === "0.25 USDC",
      `priceLabel reflects the pubnet accept's own SAC contract match, got "${listing.priceLabel}"`,
    );
  } finally {
    dataProvider.dispose();
  }
}

export async function runDiscoveryNetworkChecks(): Promise<void> {
  await testSelectsTestnetEntryWhenConfiguredForTestnet();
  await testSelectsPubnetEntryWhenConfiguredForPubnet();
}
