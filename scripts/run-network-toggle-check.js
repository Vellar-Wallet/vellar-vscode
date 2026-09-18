#!/usr/bin/env node
/**
 * Committed, CI-run acceptance check for the sidebar network toggle (the
 * Wallet panel's testnet/mainnet badge). Renders the FULL sidebar webview
 * (VellarSidebarProvider.resolveWebviewView), same technique as
 * run-postmessage-leak-check.js, then simulates the webview posting the
 * new "setNetwork" message and asserts on the real, observable
 * consequences: the setting is actually written (read back through
 * DataProvider.getConfiguredNetwork()), a confirming "network" message is
 * posted back, all three data sections refresh, a malformed payload is
 * rejected rather than acted on, and an externally-changed setting (not
 * from the toggle) also reaches the webview via onDidChangeConfiguration.
 *
 * No live network call anywhere in this script (fake-https-client.js, same
 * as run-postmessage-leak-check.js).
 */
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const outFile = path.join(root, ".test-build", "network-toggle-entry.js");

async function main() {
  console.log("=== network toggle check (committed) ===\n");

  await esbuild.build({
    entryPoints: [path.join(__dirname, "network-toggle-entry.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: outFile,
    alias: { vscode: path.join(__dirname, "vscode-test-stub.js") },
    plugins: [
      {
        name: "fake-https-client",
        setup(build) {
          build.onResolve({ filter: /^\.\/httpsClient$/ }, (args) => {
            if (args.importer.endsWith(path.join("sidebar", "dataProvider.ts"))) {
              return { path: path.join(__dirname, "fake-https-client.js") };
            }
            return undefined;
          });
        },
      },
    ],
  });

  const { runNetworkToggleChecks } = require(outFile);
  await runNetworkToggleChecks();

  console.log("\n=== NETWORK TOGGLE CHECK PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
