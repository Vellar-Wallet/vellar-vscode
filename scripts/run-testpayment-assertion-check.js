#!/usr/bin/env node
/**
 * Committed, CI-run version of the test-payment assertion check that was
 * originally a throwaway scratchpad harness during Step 6 of the sidebar
 * build. Confirms structurally (not just by inspection) that
 * runTestPayment.ts's "throwaway keypair must never equal the developer's
 * own payTo address" assertion:
 *   1. Throws BEFORE fundWithFriendbot is ever called, when they match.
 *   2. Does NOT throw (proceeds to call fundWithFriendbot and beyond), when
 *      they genuinely differ.
 *
 * No live network call anywhere in this script — fundWithFriendbot and the
 * USDC trustline/purchase functions are faked (see fake-friendbot.js,
 * fake-usdc.js) so this runs fast and deterministically in CI, matching this
 * repo's other acceptance scripts. runTestPayment.ts's own source is
 * completely unmodified; only its three real dependencies (friendbot, usdc,
 * and — via monkey-patch, not a redirect — Keypair.random) are substituted.
 */
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const outFile = path.join(root, ".test-build", "testpayment-assertion-entry.js");

async function main() {
  console.log("=== test-payment assertion check (committed) ===\n");

  await esbuild.build({
    entryPoints: [path.join(__dirname, "testpayment-assertion-entry.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: outFile,
    alias: { vscode: path.join(__dirname, "vscode-test-stub.js") },
    plugins: [
      {
        name: "testpayment-fakes",
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
        },
      },
    ],
  });

  const { runAssertionChecks } = require(outFile);
  await runAssertionChecks();

  console.log("\n=== TEST-PAYMENT ASSERTION CHECK PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
