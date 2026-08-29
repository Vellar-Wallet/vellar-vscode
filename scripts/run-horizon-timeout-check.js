#!/usr/bin/env node
/**
 * Regression test for TWO occurrences of the same Horizon/Soroban-hang bug:
 *  1. usdc.ts's Horizon.Server calls (loadAccount, submitTransaction,
 *     strictReceivePaths().call()) had NO request timeout at all.
 *  2. payment.ts's client.createPaymentPayload(required) — which internally
 *     drives a Soroban RPC simulate/sign-auth-entry/re-simulate sequence via
 *     @stellar/stellar-sdk's rpc.Server — has the identical unbounded HTTP
 *     client, with neither @x402/stellar nor @x402/core adding a timeout of
 *     their own around it.
 * Both: the underlying axios client's own defaults have no `timeout` key —
 * so a stalled connection at either point could hang the whole test-payment
 * flow indefinitely, leaving webviewProvider.ts's testPaymentInFlight flag
 * stuck true with no recovery short of reloading the extension host window.
 *
 * usdc.ts has no `vscode` import at all (only @stellar/stellar-sdk), so this
 * bundles with plain esbuild.buildSync + external:["vscode"] — no vscode
 * alias/stub needed, unlike run-postmessage-leak-check.js and
 * run-testpayment-assertion-check.js.
 *
 * This test proves withTimeout's own logic in isolation (fast, short
 * test-local timeouts, real wall-clock assertions) AND proves the real
 * usdc.ts/payment.ts source actually wires withTimeout into every call site
 * — two separate things, since testing withTimeout alone would pass even if
 * nothing ever called it. The payment.ts/SOROBAN_RPC_TIMEOUT_MS case is
 * checked SOURCE-LEVEL ONLY here (not a real 30s wait) — see
 * horizon-timeout-entry.ts's own header comment for why, and this fix's own
 * live reproduction for the real, full-duration, full-call-chain proof.
 */
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const usdcSourcePath = path.join(root, "src", "sidebar", "testPayment", "usdc.ts");
const paymentSourcePath = path.join(root, "src", "sidebar", "testPayment", "payment.ts");
const outFile = path.join(root, ".test-build", "horizon-timeout-entry.js");

// Hard ceiling on the WHOLE test process, per the instruction: if
// withTimeout itself were ever removed or broken such that a hung promise
// no longer rejects, this test must FAIL loudly rather than hang the CI run
// forever waiting on it. 30s is enormous headroom over the ~200-400ms this
// test actually needs when everything is working — it only exists to catch
// the "and now it hangs forever" failure mode, not to bound normal runtime.
const HARD_CEILING_MS = 30_000;

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`  ok: ${message}`);
}

async function main() {
  console.log("=== Horizon timeout regression check (committed) ===\n");

  esbuild.buildSync({
    entryPoints: [path.join(__dirname, "horizon-timeout-entry.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: outFile,
    external: ["vscode"],
  });

  const { runHorizonTimeoutChecks } = require(outFile);
  const usdcSource = fs.readFileSync(usdcSourcePath, "utf8");
  const paymentSource = fs.readFileSync(paymentSourcePath, "utf8");

  const overallStart = Date.now();
  const hardCeilingTimer = setTimeout(() => {
    console.error(
      `FAIL: the whole test exceeded its own ${HARD_CEILING_MS}ms hard ceiling — withTimeout itself may no longer be rejecting a hung promise at all.`,
    );
    process.exit(1);
  }, HARD_CEILING_MS);
  hardCeilingTimer.unref?.(); // never keeps the process alive on its own if everything else finishes cleanly

  const hungElapsedMs = await runHorizonTimeoutChecks(usdcSourcePath, usdcSource, paymentSourcePath, paymentSource);
  clearTimeout(hardCeilingTimer);

  const totalElapsedMs = Date.now() - overallStart;
  assert(totalElapsedMs < 5_000, `total test time (${totalElapsedMs}ms) is under the required 5000ms`);

  console.log(`\nHung-promise case took ${hungElapsedMs}ms wall-clock (test-local ceiling: 200ms).`);
  console.log("=== HORIZON TIMEOUT CHECK PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
