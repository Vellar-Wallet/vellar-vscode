#!/usr/bin/env node
/**
 * Committed, CI-run acceptance check for the vellar-x402.network setting
 * added to support mainnet (stellar:pubnet) test payments and generated
 * boilerplate, alongside the existing stellar:testnet default. Two things,
 * network-free and deterministic (no live network call anywhere):
 *
 *  1. DataProvider.getConfiguredNetwork()'s own validation/fallback logic —
 *     both real values pass through unchanged, any unrecognized value (or an
 *     entirely unset setting) falls back to the declared default. Needs the
 *     vscode alias (same as run-testpayment-assertion-check.js) since this
 *     genuinely calls vscode.workspace.getConfiguration(...).
 *  2. usdc.ts's HORIZON_URL_BY_NETWORK / USDC_ISSUER_BY_NETWORK maps resolve
 *     each network to the correct, distinct URL/issuer — the single
 *     highest-consequence lookup in this whole feature, since getting it
 *     wrong means a real trade targets the wrong asset or the wrong ledger.
 *     No vscode alias needed for this half — usdc.ts has no vscode import.
 */
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const outFile = path.join(root, ".test-build", "network-switch-entry.js");

async function main() {
  console.log("=== network switch check (committed) ===\n");

  await esbuild.build({
    entryPoints: [path.join(__dirname, "network-switch-entry.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: outFile,
    alias: { vscode: path.join(__dirname, "vscode-test-stub.js") },
  });

  const { runNetworkSwitchChecks } = require(outFile);
  runNetworkSwitchChecks();

  console.log("\n=== NETWORK SWITCH CHECK PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
