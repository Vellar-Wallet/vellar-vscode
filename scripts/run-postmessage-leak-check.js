#!/usr/bin/env node
/**
 * Committed, CI-run version of the postMessage-leak audit that was originally
 * a throwaway scratchpad harness during Steps 1-4 of the sidebar build.
 *
 * Renders the FULL sidebar webview (VellarSidebarProvider.resolveWebviewView),
 * with a real Stellar address configured via a fake vscode.workspace, and a
 * fixture-backed httpsClient (see fake-https-client.js — no live network call
 * anywhere in this script, matching this repo's other acceptance scripts).
 * Captures every object actually passed to webview.postMessage — not the
 * source code, the real runtime objects — across all four sections (wallet,
 * endpoints, settlements, earnings), and asserts the full configured address
 * string does not appear anywhere in their serialized form.
 *
 * This is deliberately an assertion about POSTED MESSAGES, not about
 * dataProvider.ts's internal state (which legitimately DOES hold the full
 * address in DataProvider.getConfiguredAddress()'s return value and in
 * WalletBalanceState/SettlementEntry — see those files' own comments on why
 * that's correct and where truncation is supposed to happen instead). A test
 * that asserted "the address never appears anywhere in memory" would be
 * testing the wrong boundary and would break the moment any correct,
 * necessary internal use of the real address was added.
 *
 * Uses esbuild's async build() (not the buildSync() this repo's other
 * scripts use) because it needs an onResolve PLUGIN, not just the `alias`
 * option — dataProvider.ts imports "./httpsClient" as a RELATIVE specifier,
 * and esbuild's `alias` option only matches bare/package-style specifiers
 * (confirmed: passing a relative path to `alias` throws "Invalid alias
 * name" outright, it is not silently ignored). A plugin's onResolve is the
 * documented way to redirect a relative import instead.
 */
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const outFile = path.join(root, ".test-build", "postmessage-leak-entry.js");

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`  ok: ${message}`);
}

async function main() {
  console.log("=== postMessage leak audit (committed) ===\n");

  await esbuild.build({
    entryPoints: [path.join(__dirname, "postmessage-leak-entry.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: outFile,
    alias: { vscode: path.join(__dirname, "vscode-test-stub.js") },
    plugins: [
      {
        name: "fake-https-client",
        setup(build) {
          // Matches dataProvider.ts's own `import { httpsGetJson } from "./httpsClient"`
          // specifically — scoped to that importer so this plugin can't
          // accidentally redirect an unrelated "./httpsClient"-named import
          // elsewhere in the bundle, if one is ever added.
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

  const { runLeakAudit } = require(outFile);
  const { testAddress, posted } = await runLeakAudit();

  assert(typeof testAddress === "string" && testAddress.length === 56, "a real-shaped test address was configured");
  assert(posted.length > 0, "at least one message was posted during the audit run");

  const sectionsSeen = new Set(posted.map((m) => m.type));
  for (const expected of ["wallet", "endpoints", "settlements", "earnings"]) {
    assert(sectionsSeen.has(expected), `a "${expected}" message was captured`);
  }

  const serialized = JSON.stringify(posted);
  assert(!serialized.includes(testAddress), "the full configured address does not appear in any posted message");

  console.log("\n=== POSTMESSAGE LEAK CHECK PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
