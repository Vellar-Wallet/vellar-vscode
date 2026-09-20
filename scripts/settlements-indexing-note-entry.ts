/**
 * Bundled by run-settlements-indexing-note-check.js with "vscode" aliased to
 * vscode-test-stub.js — the same substitution the other webview harnesses in
 * this repo use.
 *
 * Exposes the REAL webview script, pulled out of the REAL
 * VellarSidebarProvider.renderHtml() output, so the test runs the shipped
 * render logic rather than a copy of it. Extracting from renderHtml() (rather
 * than exporting the script separately from webviewProvider.ts) keeps the
 * production code unchanged: there is no test-only seam to drift.
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
  createFakeSecretStorage(): FakeSecretStorage;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeTest = require("./vscode-test-stub")._test as VscodeTestNamespace;

export function extractWebviewScript(): string {
  vscodeTest.setPayToAddress("GD6TC7QY35TZ5VHPMGCPQUDHRBLXZEI3HCBLHTBBAY2RX3L6PBWI5C2O");
  vscodeTest.setNetwork("stellar:pubnet");

  const dataProvider = new DataProvider(new FakeMemento() as never);
  try {
    const provider = new VellarSidebarProvider(
      Uri.joinPath({ path: "/fake/ext" } as never, ""),
      dataProvider,
      vscodeTest.createFakeSecretStorage() as never,
    );

    let html = "";
    const fakeWebviewView = {
      webview: {
        cspSource: "vscode-webview://fake",
        asWebviewUri: (u: { path: string }) => ({ toString: () => `vscode-webview://fake${u.path}` }),
        options: {},
        set html(value: string) {
          html = value;
        },
        get html() {
          return html;
        },
        onDidReceiveMessage: () => ({ dispose() {} }),
        postMessage: () => Promise.resolve(true),
      },
      onDidChangeVisibility: () => ({ dispose() {} }),
      visible: true,
    };

    provider.resolveWebviewView(fakeWebviewView as never);

    // The page has exactly one inline <script> block (styles are external
    // files under media/). Take the LAST match so a future <script src=...>
    // in <head> could not silently shadow the inline one.
    const matches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    if (matches.length === 0) throw new Error("renderHtml() produced no inline <script> block");
    return matches[matches.length - 1][1];
  } finally {
    dataProvider.dispose();
  }
}
