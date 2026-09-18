#!/usr/bin/env node
/**
 * Committed, CI-run acceptance check for payment.ts's HTTP-method cascade —
 * the feature that lets the test-payment flow pay POST/PUT/PATCH/DELETE
 * endpoints, not just GET.
 *
 * Covers: GET-404-then-POST-402 (the real motivating case), stopping at the
 * first 402, the challenge's own declared method overriding the winning
 * probe, garbage/lowercase declared methods, knownMethod short-circuiting,
 * destructive verbs never being blind-probed, the "no gate found" error,
 * verbatim sample-body transmission, and a transport error staying distinct
 * from "no gate".
 *
 * Unlike this repo's other checks, this one stubs the GLOBAL fetch rather
 * than redirecting a module import — payment.ts calls global fetch, so there
 * is no specifier to redirect (see method-cascade-entry.ts's own header).
 * payment.ts's source is unmodified; the stub speaks the real x402 wire
 * format (base64 `payment-required` header) so the official decoder runs for
 * real. No live network call anywhere in this script.
 */
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const outFile = path.join(root, ".test-build", "method-cascade-entry.js");

async function main() {
  console.log("=== HTTP method cascade check (committed) ===\n");

  await esbuild.build({
    entryPoints: [path.join(__dirname, "method-cascade-entry.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: outFile,
    alias: { vscode: path.join(__dirname, "vscode-test-stub.js") },
  });

  const { runMethodCascadeChecks } = require(outFile);
  await runMethodCascadeChecks();

  console.log("\n=== HTTP METHOD CASCADE CHECK PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
