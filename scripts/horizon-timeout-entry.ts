/**
 * Bundled by run-horizon-timeout-check.js. usdc.ts has NO vscode import at
 * all (confirmed: its only import is @stellar/stellar-sdk), so this needs
 * no vscode alias/stub, unlike run-postmessage-leak-check.js and
 * run-testpayment-assertion-check.js.
 *
 * The payment.ts/SOROBAN_RPC_TIMEOUT_MS case (added alongside the second
 * occurrence of this bug, found in payment.ts's createPaymentPayload call)
 * is deliberately checked SOURCE-LEVEL ONLY here, same split already used
 * for usdc.ts's own three Horizon call sites: payment.ts hardcodes the real
 * 30s SOROBAN_RPC_TIMEOUT_MS with no injection seam for a short test-local
 * value, and actually waiting out 30s here would blow this script's 5s
 * budget for no added confidence — the real, full-duration, full-call-chain
 * proof (with testPaymentInFlight genuinely resetting after ~30s) lives in
 * this fix's live reproduction instead, not in this committed suite.
 */
import {
  withTimeout,
  HORIZON_FETCH_TIMEOUT_MS,
  HORIZON_SUBMIT_TIMEOUT_MS,
  SOROBAN_RPC_TIMEOUT_MS,
} from "../src/sidebar/testPayment/usdc";

const TEST_LOCAL_TIMEOUT_MS = 200;

/**
 * Part 1a: a promise that never resolves must still cause withTimeout to
 * reject, within a real, bounded wall-clock window — not just "eventually,"
 * and not proven by inspecting the rejection's error message alone (a
 * message can be right while the actual timing is wrong, e.g. if
 * clearTimeout/Promise.race were subtly broken in a way that still produced
 * the right string on some other path).
 */
async function testHungPromiseTimesOutWithinBound(): Promise<number> {
  const hungPromise = new Promise<never>(() => {
    // Deliberately never resolves or rejects — models the real bug: a
    // Horizon SDK call whose underlying connection stalls with no timeout
    // of its own.
  });

  const start = Date.now();
  let rejected = false;
  let rejectionMessage = "";
  try {
    await withTimeout(hungPromise, TEST_LOCAL_TIMEOUT_MS, "test-hung");
  } catch (err) {
    rejected = true;
    rejectionMessage = err instanceof Error ? err.message : String(err);
  }
  const elapsedMs = Date.now() - start;

  if (!rejected) {
    throw new Error("FAIL: withTimeout did not reject a hung promise at all");
  }
  if (!rejectionMessage.includes("test-hung") || !rejectionMessage.includes("timed out")) {
    throw new Error(`FAIL: rejection message did not identify the timeout correctly: "${rejectionMessage}"`);
  }
  // Real wall-clock bound, per the instruction: must reject within
  // 2x the requested timeout — generous enough to absorb normal test-process
  // scheduling jitter, tight enough that a broken/removed timeout (which
  // would make this hang for the test's own outer ceiling, or forever)
  // cannot silently pass.
  const bound = TEST_LOCAL_TIMEOUT_MS * 2;
  if (elapsedMs >= bound) {
    throw new Error(`FAIL: hung promise took ${elapsedMs}ms to reject, expected < ${bound}ms`);
  }
  console.log(`  ok: hung promise rejected in ${elapsedMs}ms (bound: < ${bound}ms)`);
  return elapsedMs;
}

/**
 * Part 1b: a promise that resolves quickly must still resolve with its own
 * real value — the race against the timeout must not corrupt or delay a
 * genuine success. Asserts BOTH the correct value and that it did not take
 * anywhere near the timeout window (proving the real promise won the race,
 * not that the timeout fired and something coincidentally matched).
 */
async function testFastResolvingPromiseSucceeds(): Promise<void> {
  const start = Date.now();
  const result = await withTimeout(Promise.resolve("real-value-42"), TEST_LOCAL_TIMEOUT_MS, "test-fast-resolve");
  const elapsedMs = Date.now() - start;

  if (result !== "real-value-42") {
    throw new Error(`FAIL: expected the real resolved value, got ${JSON.stringify(result)}`);
  }
  if (elapsedMs >= TEST_LOCAL_TIMEOUT_MS) {
    throw new Error(`FAIL: fast-resolving promise took ${elapsedMs}ms — the timeout race delayed a real success`);
  }
  console.log(`  ok: fast-resolving promise returned its real value in ${elapsedMs}ms (well under the ${TEST_LOCAL_TIMEOUT_MS}ms ceiling)`);
}

/**
 * Part 1c: a promise that rejects quickly with its OWN error must propagate
 * that exact error unmodified — withTimeout must never swallow or rewrite a
 * genuine failure from the underlying call into a misleading "timed out"
 * message when it didn't actually time out.
 */
async function testFastRejectingPromisePropagatesOwnError(): Promise<void> {
  const ownError = new Error("real underlying failure, not a timeout");
  const start = Date.now();
  let caught: unknown;
  try {
    await withTimeout(Promise.reject(ownError), TEST_LOCAL_TIMEOUT_MS, "test-fast-reject");
  } catch (err) {
    caught = err;
  }
  const elapsedMs = Date.now() - start;

  if (caught !== ownError) {
    throw new Error(`FAIL: expected withTimeout to propagate the exact same error object, got ${String(caught)}`);
  }
  if (elapsedMs >= TEST_LOCAL_TIMEOUT_MS) {
    throw new Error(`FAIL: fast-rejecting promise took ${elapsedMs}ms — the timeout race delayed a real failure`);
  }
  console.log(`  ok: fast-rejecting promise's own error propagated unmodified in ${elapsedMs}ms`);
}

/**
 * Part 2: wiring — confirms, by reading the REAL usdc.ts source text (not a
 * mock, not a re-implementation), that all three Horizon SDK calls this bug
 * was about are actually wrapped in withTimeout(...). A test that only
 * exercised withTimeout in isolation (Part 1 above) would pass even if
 * every call site in usdc.ts had never been updated to use it at all — this
 * is the check that closes that gap.
 *
 * Matches `withTimeout(` followed by the Horizon call, ALLOWING whitespace
 * (including newlines) between them — a real, deliberate multi-line call
 * (e.g. `withTimeout(\n  horizon.strictReceivePaths(...)`) is legitimate,
 * readable formatting, not something this check should force onto one
 * cramped line just to satisfy a rigid substring match. `\s*` here is doing
 * real work: a first draft of this check used a plain substring match and
 * it genuinely failed against the real, correctly-wired multi-line call
 * site, which is what motivated writing it this way instead.
 */
function testWiringInRealSource(sourceFilePath: string, fileContents: string): void {
  const requiredPatterns: [label: string, pattern: RegExp][] = [
    ["horizon.loadAccount", /withTimeout\(\s*horizon\.loadAccount/],
    ["horizon.strictReceivePaths", /withTimeout\(\s*horizon\.strictReceivePaths/],
    ["horizon.submitTransaction", /withTimeout\(\s*horizon\.submitTransaction/],
  ];
  for (const [label, pattern] of requiredPatterns) {
    if (!pattern.test(fileContents)) {
      throw new Error(`FAIL: ${sourceFilePath} does not wrap ${label} in withTimeout(...) — a Horizon call is unbounded again`);
    }
    console.log(`  ok: ${sourceFilePath} wraps ${label} in withTimeout(...)`);
  }
}

/**
 * SECOND occurrence of the wiring check, for payment.ts's single
 * withTimeout call site (the SOROBAN_RPC_TIMEOUT_MS fix). Plain substring
 * matches, per the instruction — payment.ts's real call site is a single
 * line (`await withTimeout(client.createPaymentPayload(required),
 * SOROBAN_RPC_TIMEOUT_MS, ...)`), unlike usdc.ts's genuinely multi-line
 * strictReceivePaths call, so there's no whitespace-tolerance concern here
 * to motivate a regex the way there was for usdc.ts's checks above.
 */
function testPaymentWiringInRealSource(sourceFilePath: string, fileContents: string): void {
  const requiredSubstrings = ["withTimeout(client.createPaymentPayload", "SOROBAN_RPC_TIMEOUT_MS"];
  for (const substring of requiredSubstrings) {
    if (!fileContents.includes(substring)) {
      throw new Error(`FAIL: ${sourceFilePath} does not contain "${substring}" — the Soroban RPC call is unbounded again`);
    }
    console.log(`  ok: ${sourceFilePath} contains "${substring}"`);
  }
}

/** Part 3: the exported constants must be sane on their face — catches an
 *  accidental swap (submit shorter than fetch, Soroban outside its own
 *  intended band) or a zeroed-out value, without needing to wait for any of
 *  them to actually fire. */
function testConstantsAreSane(): void {
  if (!(HORIZON_FETCH_TIMEOUT_MS >= 5_000 && HORIZON_FETCH_TIMEOUT_MS <= 30_000)) {
    throw new Error(`FAIL: HORIZON_FETCH_TIMEOUT_MS (${HORIZON_FETCH_TIMEOUT_MS}) is outside the sane 5000-30000ms range`);
  }
  console.log(`  ok: HORIZON_FETCH_TIMEOUT_MS (${HORIZON_FETCH_TIMEOUT_MS}ms) is within the sane 5000-30000ms range`);

  if (!(HORIZON_SUBMIT_TIMEOUT_MS > HORIZON_FETCH_TIMEOUT_MS)) {
    throw new Error(
      `FAIL: HORIZON_SUBMIT_TIMEOUT_MS (${HORIZON_SUBMIT_TIMEOUT_MS}) must be greater than HORIZON_FETCH_TIMEOUT_MS (${HORIZON_FETCH_TIMEOUT_MS}) — a submit needs more room than a plain fetch`,
    );
  }
  console.log(
    `  ok: HORIZON_SUBMIT_TIMEOUT_MS (${HORIZON_SUBMIT_TIMEOUT_MS}ms) > HORIZON_FETCH_TIMEOUT_MS (${HORIZON_FETCH_TIMEOUT_MS}ms)`,
  );

  if (!(SOROBAN_RPC_TIMEOUT_MS >= 15_000 && SOROBAN_RPC_TIMEOUT_MS <= 60_000)) {
    throw new Error(`FAIL: SOROBAN_RPC_TIMEOUT_MS (${SOROBAN_RPC_TIMEOUT_MS}) is outside the sane 15000-60000ms range`);
  }
  console.log(`  ok: SOROBAN_RPC_TIMEOUT_MS (${SOROBAN_RPC_TIMEOUT_MS}ms) is within the sane 15000-60000ms range`);

  if (!(SOROBAN_RPC_TIMEOUT_MS > HORIZON_FETCH_TIMEOUT_MS)) {
    throw new Error(
      `FAIL: SOROBAN_RPC_TIMEOUT_MS (${SOROBAN_RPC_TIMEOUT_MS}) must be greater than HORIZON_FETCH_TIMEOUT_MS (${HORIZON_FETCH_TIMEOUT_MS}) — Soroban simulation needs more room than a plain Horizon read`,
    );
  }
  console.log(
    `  ok: SOROBAN_RPC_TIMEOUT_MS (${SOROBAN_RPC_TIMEOUT_MS}ms) > HORIZON_FETCH_TIMEOUT_MS (${HORIZON_FETCH_TIMEOUT_MS}ms)`,
  );

  if (!(SOROBAN_RPC_TIMEOUT_MS < HORIZON_SUBMIT_TIMEOUT_MS)) {
    throw new Error(
      `FAIL: SOROBAN_RPC_TIMEOUT_MS (${SOROBAN_RPC_TIMEOUT_MS}) must be less than HORIZON_SUBMIT_TIMEOUT_MS (${HORIZON_SUBMIT_TIMEOUT_MS}) — a simulate-only RPC round trip should be faster than an actual ledger-committing submit`,
    );
  }
  console.log(
    `  ok: SOROBAN_RPC_TIMEOUT_MS (${SOROBAN_RPC_TIMEOUT_MS}ms) < HORIZON_SUBMIT_TIMEOUT_MS (${HORIZON_SUBMIT_TIMEOUT_MS}ms)`,
  );
}

export async function runHorizonTimeoutChecks(
  usdcSourceFilePath: string,
  usdcFileContents: string,
  paymentSourceFilePath: string,
  paymentFileContents: string,
): Promise<number> {
  const hungElapsedMs = await testHungPromiseTimesOutWithinBound();
  await testFastResolvingPromiseSucceeds();
  await testFastRejectingPromisePropagatesOwnError();
  testWiringInRealSource(usdcSourceFilePath, usdcFileContents);
  testPaymentWiringInRealSource(paymentSourceFilePath, paymentFileContents);
  testConstantsAreSane();
  return hungElapsedMs;
}
