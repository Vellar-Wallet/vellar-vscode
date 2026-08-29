/**
 * Bundled by run-settlements-pagination-check.js with "vscode" aliased to
 * vscode-test-stub.js and dataProvider.ts's "./httpsClient" import redirected
 * to fake-https-client-paginated.js — same isolation pattern
 * postmessage-leak-entry.ts already established, see that file's own
 * comment for why a plugin (not esbuild's `alias`) is needed for a relative
 * specifier.
 *
 * Unlike postmessage-leak-entry.ts's fake webview (which discards whatever
 * callback resolveWebviewView registers via onDidReceiveMessage — that
 * script only needs to capture POSTED messages, never to send one INTO the
 * provider), this fake webview actually stores that callback so the test can
 * call it directly — the exact same path a real webview click uses to reach
 * VellarSidebarProvider.handleMessage, just invoked by hand instead of by an
 * actual button click in an actual webview.
 */
import { VellarSidebarProvider } from "../src/sidebar/webviewProvider";
import { DataProvider } from "../src/sidebar/dataProvider";
import { Uri } from "vscode";
import { FakeMemento } from "./fake-memento";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const paymentsFake = require("./fake-https-client-paginated") as {
  queuePaymentsResponse(response: unknown): void;
  resetPaymentsFake(): void;
  paymentsCalls: string[];
};

interface VscodeTestNamespace {
  setPayToAddress(value: string): void;
  outputChannelLines: string[];
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeTest = require("./vscode-test-stub")._test as VscodeTestNamespace;

const TEST_ADDRESS = "GAATVGLRHZXFC66GEN5QNKD56HC5JJZVHQ3P7ZJNVCCI4WKLN44FICSC";

function makePayment(txHash: string, closedAt: string) {
  return {
    txHash,
    closedAt,
    buyer: "GB5STIDS4JSM76JRVRDBKK7KAQ5XE7STBHFY7PN24NRJVO62TVWMF364",
    amount: "1000000",
    assetSymbol: "USDC",
  };
}

/**
 * One fresh provider + dataProvider pair per harness instance, so each of
 * the 4 test cases in run-settlements-pagination-check.js gets an isolated
 * PollingSource with its own untouched rate floor (see that script's own
 * comment on why the floor makes a single shared instance impractical
 * across cases that each need their own initial poll).
 *
 * `initialPage1Response` MUST be queued before this returns — a real
 * DataProvider fires its very first fetch SYNCHRONOUSLY inside
 * FocusVisibilityGate.add()'s call to source.start(), itself called from
 * VellarSidebarProvider's own constructor (see resolveWebviewView/gate.add
 * in webviewProvider.ts) — so by the time a caller could otherwise queue a
 * response, the first fetch has already gone out and found nothing queued.
 * Taking it as a parameter here, queued before `new DataProvider(...)` runs,
 * is what makes that first fetch land on real data instead of erroring.
 */
export function createHarness(initialPage1Response: unknown): {
  postedSettlementsMessages: { state: unknown; pagination: unknown }[];
  sendMessageFromWebview(message: unknown): void;
  waitForInitialLoad(): Promise<void>;
  simulateNextPollTick(): Promise<void>;
  dispose(): void;
} {
  paymentsFake.resetPaymentsFake();
  vscodeTest.setPayToAddress(TEST_ADDRESS);
  paymentsFake.queuePaymentsResponse(initialPage1Response);

  const dataProvider = new DataProvider(new FakeMemento() as never);
  const provider = new VellarSidebarProvider(Uri.joinPath({ path: "/fake/ext" } as never, ""), dataProvider);

  const postedSettlementsMessages: { state: unknown; pagination: unknown }[] = [];
  let capturedMessageHandler: ((message: unknown) => void) | undefined;

  const fakeWebviewView = {
    webview: {
      cspSource: "vscode-webview://fake",
      asWebviewUri: (u: { path: string }) => ({ toString: () => `vscode-webview://fake${u.path}` }),
      options: {},
      html: "",
      onDidReceiveMessage: (cb: (message: unknown) => void) => {
        capturedMessageHandler = cb;
        return { dispose() {} };
      },
      postMessage: (msg: { type?: string; state?: unknown; pagination?: unknown }) => {
        if (msg?.type === "settlements") {
          postedSettlementsMessages.push({ state: msg.state, pagination: msg.pagination });
        }
        return Promise.resolve(true);
      },
    },
    onDidChangeVisibility: () => ({ dispose() {} }),
    visible: true,
  };

  provider.resolveWebviewView(fakeWebviewView as never);

  return {
    postedSettlementsMessages,
    sendMessageFromWebview(message: unknown) {
      if (!capturedMessageHandler) throw new Error("resolveWebviewView never registered a message handler");
      capturedMessageHandler(message);
    },
    // The fake httpsClient resolves instantly (no real network round trip),
    // but PollingSource.start()'s immediate refresh() is still asynchronous
    // — give the microtask/macrotask queue a turn, same wait
    // postmessage-leak-entry.ts already uses for the same reason.
    async waitForInitialLoad() {
      await new Promise((resolve) => setTimeout(resolve, 200));
    },
    /**
     * Simulates a SECOND page-1 poll tick (for the "new-data diff" case) —
     * PollingSource.refresh() has a real, deliberate rate floor
     * (elapsed < intervalMs skips silently, see polling.ts's own comment on
     * why that must hold regardless of caller), and settlements polls every
     * 30s in production, so a genuine second refresh() call made moments
     * after the first is floored and does nothing. Rather than weakening
     * that floor (a real, tested, production-correct behavior) or waiting
     * out 30 real seconds in a test that must run in under 5, this
     * temporarily fast-forwards Date.now() for the one internal check that
     * reads it, restoring the real Date.now immediately after refresh() is
     * called — the smallest surface that makes "as if 30s passed" true
     * without touching PollingSource itself or any of its private state.
     */
    async simulateNextPollTick(): Promise<void> {
      const realNow = Date.now;
      Date.now = () => realNow() + 31_000;
      try {
        await dataProvider.settlements.refresh();
      } finally {
        Date.now = realNow;
      }
    },
    dispose() {
      dataProvider.dispose();
    },
  };
}

export function getOutputChannelLines(): string[] {
  return vscodeTest.outputChannelLines;
}

export { makePayment, paymentsFake };
