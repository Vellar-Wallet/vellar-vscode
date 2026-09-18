/**
 * Bundled by run-network-toggle-check.js with "vscode" aliased to
 * vscode-test-stub.js and dataProvider.ts's "./httpsClient" import
 * redirected to fake-https-client.js — same two substitutions
 * postmessage-leak-entry.ts already uses, reused here rather than
 * duplicated, since this test also needs the full, real
 * VellarSidebarProvider.resolveWebviewView() wired to a real DataProvider.
 *
 * Exercises the sidebar network toggle end to end against the REAL source
 * (webviewProvider.ts, dataProvider.ts) — not a reimplementation of the
 * toggle's logic — via a fake WebviewView that captures every posted
 * message and every PollingSource.refresh() call, and a fake
 * vscode.workspace whose getConfiguration(...).update(...) and
 * onDidChangeConfiguration are REAL (see vscode-test-stub.js), so this
 * proves the actual round trip: webview posts "setNetwork" -> host writes
 * the setting -> host posts "network" back -> host refreshes all three
 * pollers, and separately, an EXTERNAL config change (not from the toggle)
 * also reaches the webview via the onDidChangeConfiguration listener.
 */
import { VellarSidebarProvider } from "../src/sidebar/webviewProvider";
import { DataProvider } from "../src/sidebar/dataProvider";
import { Uri } from "vscode";
import { FakeMemento } from "./fake-memento";

interface FakeSecretStorage {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  onDidChange: unknown;
}
interface VscodeTestNamespace {
  setPayToAddress(value: string): void;
  setNetwork(value: string): void;
  setNetworkExternally(value: string): void;
  createFakeSecretStorage(): FakeSecretStorage;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeTest = require("./vscode-test-stub")._test as VscodeTestNamespace;

const TEST_ADDRESS = "GAATVGLRHZXFC66GEN5QNKD56HC5JJZVHQ3P7ZJNVCCI4WKLN44FICSC";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok: ${message}`);
}

/** Builds a fresh provider + fake webview pair, isolated per test function —
 *  mirrors postmessage-leak-entry.ts's own single-run shape, but as a
 *  reusable factory since this file runs several independent scenarios,
 *  each needing its own untouched refresh-call counters and posted-message
 *  log rather than one shared, accumulating run. */
function setup() {
  vscodeTest.setPayToAddress(TEST_ADDRESS);

  const dataProvider = new DataProvider(new FakeMemento() as never);

  const refreshCalls: string[] = [];
  const originalWalletRefresh = dataProvider.wallet.refresh.bind(dataProvider.wallet);
  const originalEndpointsRefresh = dataProvider.endpoints.refresh.bind(dataProvider.endpoints);
  const originalSettlementsRefresh = dataProvider.settlements.refresh.bind(dataProvider.settlements);
  dataProvider.wallet.refresh = () => {
    refreshCalls.push("wallet");
    return originalWalletRefresh();
  };
  dataProvider.endpoints.refresh = () => {
    refreshCalls.push("endpoints");
    return originalEndpointsRefresh();
  };
  dataProvider.settlements.refresh = () => {
    refreshCalls.push("settlements");
    return originalSettlementsRefresh();
  };

  const provider = new VellarSidebarProvider(
    Uri.joinPath({ path: "/fake/ext" } as never, ""),
    dataProvider,
    vscodeTest.createFakeSecretStorage() as never,
  );

  const posted: { type?: string; [key: string]: unknown }[] = [];
  let receivedMessageHandler: ((message: unknown) => void) | undefined;
  const fakeWebviewView = {
    webview: {
      cspSource: "vscode-webview://fake",
      asWebviewUri: (u: { path: string }) => ({ toString: () => `vscode-webview://fake${u.path}` }),
      options: {},
      html: "",
      onDidReceiveMessage: (cb: (message: unknown) => void) => {
        receivedMessageHandler = cb;
        return { dispose() {} };
      },
      postMessage: (msg: { type?: string; [key: string]: unknown }) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
    },
    onDidChangeVisibility: () => ({ dispose() {} }),
    visible: true,
  };

  provider.resolveWebviewView(fakeWebviewView as never);

  return {
    dataProvider,
    posted,
    refreshCalls,
    sendFromWebview: (message: unknown) => {
      if (!receivedMessageHandler) throw new Error("resolveWebviewView never registered onDidReceiveMessage");
      receivedMessageHandler(message);
    },
  };
}

async function settle(): Promise<void> {
  // Same reasoning as postmessage-leak-entry.ts's own wait: the fake
  // httpsClient resolves instantly, but PollingSource.start()'s immediate
  // refresh() (and setNetwork's own explicit refresh() calls below) are
  // still asynchronous — give the microtask/macrotask queue a turn.
  await new Promise((resolve) => setTimeout(resolve, 300));
}

/**
 * Part 1: the toggle's own click, end to end. Proves the "network" message
 * always sent on webview build reflects the real default, then proves a
 * simulated "setNetwork" message from the webview actually writes the
 * setting (via the REAL DataProvider.getConfiguredNetwork() read back
 * afterward, not just inspecting the fake's internal state) and posts a
 * confirming "network" message back.
 */
async function testTogglePostsNetworkAndWritesSetting(): Promise<void> {
  vscodeTest.setNetwork("stellar:testnet");
  const { dataProvider, posted, sendFromWebview } = setup();
  try {
    await settle();

    const initialNetworkMessages = posted.filter((m) => m.type === "network");
    assert(initialNetworkMessages.length > 0, "a \"network\" message is posted on webview build");
    assert(
      initialNetworkMessages[0].network === "stellar:testnet",
      `the initial "network" message reflects the configured value, got ${JSON.stringify(initialNetworkMessages[0])}`,
    );

    posted.length = 0;
    sendFromWebview({ type: "setNetwork", network: "stellar:pubnet" });
    await settle();

    assert(
      DataProvider.getConfiguredNetwork() === "stellar:pubnet",
      "DataProvider.getConfiguredNetwork() reflects the toggle's write, read back through the real API",
    );
    const confirmMessages = posted.filter((m) => m.type === "network");
    assert(confirmMessages.length > 0, "a \"network\" message is posted back after the toggle's write");
    assert(
      confirmMessages[confirmMessages.length - 1].network === "stellar:pubnet",
      "the confirming \"network\" message carries the new value",
    );
  } finally {
    dataProvider.dispose();
  }
}

/**
 * Part 2: the toggle rejects a malformed/unrecognized payload — same
 * "never trust the webview's payload beyond a known-safe shape" discipline
 * settlementsPage's direction check already has coverage for elsewhere.
 * Proves the setting is NOT written and no "network" message is posted for
 * a value that isn't one of the two real literals.
 */
async function testTogglerejectsUnknownNetworkValue(): Promise<void> {
  vscodeTest.setNetwork("stellar:testnet");
  const { dataProvider, posted, sendFromWebview } = setup();
  try {
    await settle();

    posted.length = 0;
    sendFromWebview({ type: "setNetwork", network: "stellar:not-a-real-network" });
    await settle();

    assert(
      DataProvider.getConfiguredNetwork() === "stellar:testnet",
      "an unrecognized network value in the message is NOT written to the setting",
    );
    assert(
      posted.filter((m) => m.type === "network").length === 0,
      "no \"network\" message is posted for a rejected setNetwork payload",
    );
  } finally {
    dataProvider.dispose();
  }
}

/**
 * Part 3: the immediate refresh. Proves wallet/endpoints/settlements are
 * ALL refreshed as a direct result of a successful toggle, same
 * "don't leave stale data under a new label" pattern already used after a
 * test payment settles.
 */
async function testToggleRefreshesAllThreeSections(): Promise<void> {
  vscodeTest.setNetwork("stellar:testnet");
  const { dataProvider, refreshCalls, sendFromWebview } = setup();
  try {
    await settle();

    refreshCalls.length = 0; // clear the initial PollingSource.start() calls, isolate to the toggle's own refresh
    sendFromWebview({ type: "setNetwork", network: "stellar:pubnet" });
    await settle();

    for (const section of ["wallet", "endpoints", "settlements"]) {
      assert(refreshCalls.includes(section), `${section}.refresh() was called after a successful toggle`);
    }
  } finally {
    dataProvider.dispose();
  }
}

/**
 * Part 4: an EXTERNAL config change (native Settings UI, a direct
 * settings.json edit — never mentions "setNetwork" at all) also reaches the
 * webview, via the onDidChangeConfiguration listener added in
 * VellarSidebarProvider's constructor — proving the sidebar doesn't only
 * learn about its OWN toggle clicks.
 */
async function testExternalConfigChangeUpdatesBadge(): Promise<void> {
  vscodeTest.setNetwork("stellar:testnet");
  const { dataProvider, posted } = setup();
  try {
    await settle();

    posted.length = 0;
    vscodeTest.setNetworkExternally("stellar:pubnet");
    await settle();

    const networkMessages = posted.filter((m) => m.type === "network");
    assert(networkMessages.length > 0, "an externally-changed setting posts a \"network\" message to the webview");
    assert(
      networkMessages[networkMessages.length - 1].network === "stellar:pubnet",
      "the externally-triggered \"network\" message carries the new value",
    );
  } finally {
    dataProvider.dispose();
  }
}

export async function runNetworkToggleChecks(): Promise<void> {
  await testTogglePostsNetworkAndWritesSetting();
  await testTogglerejectsUnknownNetworkValue();
  await testToggleRefreshesAllThreeSections();
  await testExternalConfigChangeUpdatesBadge();
}
