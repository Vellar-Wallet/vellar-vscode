#!/usr/bin/env node
/**
 * Committed, CI-run acceptance check for the developer-supplied sample
 * request body added alongside HTTP method support.
 *
 * Two concerns:
 *  1. narrowSampleBody (webviewProvider.ts) — the webview message boundary.
 *     Asserts every non-string shape becomes undefined rather than being
 *     forwarded into a live HTTP request body, and that the 64KB cap rejects
 *     rather than truncates.
 *  2. runTestPayment's JSON pre-validation guard — malformed JSON must fail
 *     BEFORE any funding call (so a typo costs nothing), valid JSON must pass
 *     through, and the body's own contents must NEVER reach the output
 *     channel (a request body can carry API keys a developer pasted).
 *
 * friendbot/usdc/mainnetFunding are faked exactly as
 * run-testpayment-assertion-check.js does, so no live network call happens.
 */
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const outFile = path.join(root, ".test-build", "sample-body-entry.js");

async function main() {
  console.log("=== sample request body check (committed) ===\n");

  await esbuild.build({
    entryPoints: [path.join(__dirname, "sample-body-entry.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: outFile,
    alias: { vscode: path.join(__dirname, "vscode-test-stub.js") },
    plugins: [
      {
        name: "sample-body-fakes",
        setup(build) {
          build.onResolve({ filter: /^\.\/friendbot$/ }, (args) => {
            if (args.importer.endsWith(path.join("sidebar", "testPayment", "runTestPayment.ts"))) {
              return { path: path.join(__dirname, "fake-friendbot.js") };
            }
            return undefined;
          });
          build.onResolve({ filter: /^\.\/usdc$/ }, (args) => {
            if (args.importer.endsWith(path.join("sidebar", "testPayment", "runTestPayment.ts"))) {
              return { path: path.join(__dirname, "fake-usdc.js") };
            }
            return undefined;
          });
          build.onResolve({ filter: /^\.\/mainnetFunding$/ }, (args) => {
            if (args.importer.endsWith(path.join("sidebar", "testPayment", "runTestPayment.ts"))) {
              return { path: path.join(__dirname, "fake-mainnet-funding.js") };
            }
            return undefined;
          });
        },
      },
    ],
  });

  const { runSampleBodyChecks } = require(outFile);
  await runSampleBodyChecks();

  console.log("\n=== SAMPLE REQUEST BODY CHECK PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
