#!/usr/bin/env node
/**
 * Committed, CI-run acceptance check for mainnetFundingWallet.ts — the
 * "Vellar: Configure mainnet test wallet" command and the SecretStorage
 * read path runTestPayment.ts relies on for the mainnet funding feature.
 * Exercises the REAL source directly (no fakes on the module under test),
 * against vscode-test-stub.js's real (in-memory) SecretStorage and a
 * controllable showInputBox — proving a valid secret is stored and its
 * derived public key confirmed back, a malformed secret is rejected before
 * ever being stored, cancelling does nothing, and the "unconfigured" read
 * contract holds for both a never-stored and a whitespace-only value.
 *
 * No live network call anywhere in this script — Keypair.fromSecret is the
 * real @stellar/stellar-sdk function (pure, local, no network), not faked.
 */
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const outFile = path.join(root, ".test-build", "mainnet-funding-wallet-entry.js");

async function main() {
  console.log("=== mainnet funding wallet check (committed) ===\n");

  await esbuild.build({
    entryPoints: [path.join(__dirname, "mainnet-funding-wallet-entry.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: outFile,
    alias: { vscode: path.join(__dirname, "vscode-test-stub.js") },
  });

  const { runMainnetFundingWalletChecks } = require(outFile);
  await runMainnetFundingWalletChecks();

  console.log("\n=== MAINNET FUNDING WALLET CHECK PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
