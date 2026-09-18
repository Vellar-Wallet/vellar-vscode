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
 * No live network call anywhere in this script — fundWithFriendbot, the
 * USDC trustline/purchase functions, and fundThrowawayFromMainnetWallet are
 * all faked (see fake-friendbot.js, fake-usdc.js, fake-mainnet-funding.js)
 * so this runs fast and deterministically in CI, matching this repo's other
 * acceptance scripts. runTestPayment.ts's own source is completely
 * unmodified; only its four real dependencies (friendbot, usdc,
 * mainnetFunding, and — via monkey-patch, not a redirect — Keypair.random)
 * are substituted. getMainnetFundingSecret is NOT faked — it's exercised
 * for real against vscode-test-stub.js's own real (in-memory) SecretStorage
 * fake, so the mainnet test cases prove the actual configured/not-configured
 * read path, not a third layer of mocking on top of it.
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

  const { runAssertionChecks } = require(outFile);
  await runAssertionChecks();

  console.log("\n=== TEST-PAYMENT ASSERTION CHECK PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
