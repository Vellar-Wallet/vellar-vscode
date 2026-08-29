/**
 * Bundled by run-postmessage-leak-check.js with "vscode" aliased to
 * vscode-test-stub.js and dataProvider.ts's "./httpsClient" import redirected
 * to fake-https-client.js (see that script's own comment for why a plugin,
 * not `alias`, is needed for the second one).
 *
 * Imports vscode-test-stub.js by its own relative path (not through the
 * "vscode" specifier) specifically to reach its `_test` namespace — that
 * namespace is deliberately absent from the real @types/vscode declarations
 * (it exists only for THIS harness to drive/inspect the fake; real vscode
 * has no such thing), so it's typed here via a small local interface rather
 * than pretending it's part of vscode's public API. `Uri`, by contrast, IS
 * real vscode API surface both the stub and the genuine module provide, so
 * that one import goes through the aliased "vscode" specifier as usual —
 * this file ends up importing the exact same physical file two different
 * ways for two different reasons, not by accident.
 */
import { VellarSidebarProvider } from "../src/sidebar/webviewProvider";
import { DataProvider } from "../src/sidebar/dataProvider";
import { Uri } from "vscode";
import { FakeMemento } from "./fake-memento";
import { TEST_ADDRESS } from "./fake-https-client";

interface VscodeTestNamespace {
  setPayToAddress(value: string): void;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeTest = require("./vscode-test-stub")._test as VscodeTestNamespace;

export async function runLeakAudit(): Promise<{ testAddress: string; posted: unknown[] }> {
  vscodeTest.setPayToAddress(TEST_ADDRESS);

  const dataProvider = new DataProvider(new FakeMemento() as never);
  const provider = new VellarSidebarProvider(Uri.joinPath({ path: "/fake/ext" } as never, ""), dataProvider);

  const posted: unknown[] = [];
  const fakeWebviewView = {
    webview: {
      cspSource: "vscode-webview://fake",
      asWebviewUri: (u: { path: string }) => ({ toString: () => `vscode-webview://fake${u.path}` }),
      options: {},
      html: "",
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: (msg: unknown) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
    },
    onDidChangeVisibility: () => ({ dispose() {} }),
    visible: true,
  };

  provider.resolveWebviewView(fakeWebviewView as never);

  // The fake httpsClient resolves instantly (no real network round trip), but
  // PollingSource.start()'s immediate refresh() is still asynchronous — give
  // the microtask/macrotask queue a turn to let all three sources' first
  // fetch actually resolve and post before asserting on what was captured.
  await new Promise((resolve) => setTimeout(resolve, 500));

  dataProvider.dispose();
  return { testAddress: TEST_ADDRESS, posted };
}
