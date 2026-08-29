/**
 * Bundled by run-testpayment-assertion-check.js with "vscode" aliased to
 * vscode-test-stub.js and testPayment/friendbot's "./friendbot" import
 * redirected to fake-friendbot.js (an onResolve plugin, not `alias`, for the
 * same reason as fake-https-client.js — relative specifier).
 *
 * Keypair.random() is monkey-patched at the @stellar/stellar-sdk module
 * level (not via an esbuild redirect) — same technique already used and
 * proven during Step 6's own live verification. This is legitimate: it
 * intercepts calls to the REAL SDK's real Keypair class, it doesn't fake the
 * SDK itself, and runTestPayment.ts's own source is completely unmodified.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { runTestPayment, type TestPaymentTarget } from "../src/sidebar/testPayment/runTestPayment";
import type { EndpointListing } from "../src/sidebar/dataProvider";
import * as fakeFriendbot from "./fake-friendbot";

interface VscodeTestNamespace {
  setPayToAddress(value: string): void;
  outputChannelLines: string[];
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeTest = require("./vscode-test-stub")._test as VscodeTestNamespace;

const FAKE_LISTING: EndpointListing = {
  resource: "https://example.test/never-reached",
  priceLabel: "0.01 USDC",
  ownershipState: "unknown",
  settlements: 0,
  lastSettled: undefined,
  payTo: "GDIFFERENTPAYTOTHATISNOTUSED0000000000000000000000000000",
  amount: "100000",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
};
const FAKE_TARGET: TestPaymentTarget = { kind: "listing", listing: FAKE_LISTING };

function fakeProgress() {
  return { report: () => {} };
}
function fakeToken() {
  return { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
}

/**
 * Forces Keypair.random()'s NEXT call to return a keypair whose public key
 * is EXACTLY `forcedPublicKey` — done by generating real random keypairs
 * until one happens to... no: that's not feasible (astronomically
 * improbable). Instead this patches Keypair.random to return a Keypair
 * reconstructed via Keypair.fromSecret(knownSecret) for a secret whose
 * public key we already know equals the target, achieved by simply reusing
 * the target's own generation: we generate ONE real keypair, read its public
 * key, and use THAT as both the "developer's configured address" and the
 * value Keypair.random() is patched to return — this exercises the exact
 * equality runTestPayment.ts checks (throwawayPublicKey === developerPayToAddress)
 * without needing to defeat elliptic-curve randomness.
 */
function installCollidingRandom(): { publicKey: string; restore(): void } {
  const real = Keypair.random;
  const collidingKeypair = real.call(Keypair);
  const publicKey = collidingKeypair.publicKey();
  (Keypair as unknown as { random(): Keypair }).random = () => collidingKeypair;
  return {
    publicKey,
    restore: () => {
      (Keypair as unknown as { random: typeof real }).random = real;
    },
  };
}

async function testCollisionThrowsBeforeFriendbot(): Promise<void> {
  fakeFriendbot._test.reset();
  const { publicKey, restore } = installCollidingRandom();
  vscodeTest.setPayToAddress(publicKey); // developer's own address == what Keypair.random() will now return
  vscodeTest.outputChannelLines.length = 0;

  const result = await runTestPayment(FAKE_TARGET, fakeProgress() as never, fakeToken() as never);
  restore();

  if (result !== undefined) {
    throw new Error(`FAIL: expected runTestPayment to fail (return undefined) on a colliding keypair, got ${result}`);
  }
  if (fakeFriendbot._test.callCount !== 0) {
    throw new Error(
      `FAIL: fundWithFriendbot was called ${fakeFriendbot._test.callCount} time(s) — the assertion must throw BEFORE any network call`,
    );
  }
  const loggedAssertion = vscodeTest.outputChannelLines.some((line) => line.includes("Assertion failed"));
  if (!loggedAssertion) {
    throw new Error(
      `FAIL: expected the output channel to record the assertion failure; got: ${JSON.stringify(vscodeTest.outputChannelLines)}`,
    );
  }
  console.log("  ok: colliding keypair — runTestPayment fails, fundWithFriendbot is NEVER called, assertion is logged");
}

async function testDifferentAddressesProceedPastAssertion(): Promise<void> {
  fakeFriendbot._test.reset();
  vscodeTest.setPayToAddress("GDIFFERENTPAYTOTHATISNOTUSED0000000000000000000000000000");
  vscodeTest.outputChannelLines.length = 0;

  // Keypair.random() is NOT patched here — a genuinely fresh random keypair
  // is used, which (with probability indistinguishable from 1) differs from
  // the fixed developer address above. fundWithFriendbot is faked to resolve
  // instantly (see fake-friendbot.js) so this test doesn't depend on any
  // live network call — it only needs to prove the assertion did NOT block
  // progress, not that the whole payment flow succeeds end-to-end (that's
  // covered by this feature's own live-data verification during Step 6).
  await runTestPayment(FAKE_TARGET, fakeProgress() as never, fakeToken() as never);

  if (fakeFriendbot._test.callCount !== 1) {
    throw new Error(
      `FAIL: expected fundWithFriendbot to be called exactly once when addresses differ, was called ${fakeFriendbot._test.callCount} time(s)`,
    );
  }
  const loggedAssertion = vscodeTest.outputChannelLines.some((line) => line.includes("Assertion failed"));
  if (loggedAssertion) {
    throw new Error("FAIL: the assertion fired even though the throwaway and developer addresses genuinely differ");
  }
  console.log("  ok: distinct addresses — the assertion does not fire, fundWithFriendbot IS called");
}

/**
 * The SECOND assertion (throwawayPublicKey === payTo, distinct from the
 * developer's-own-configured-address check above) — added when the manual
 * "Test a URL" entry point was added, since a manual URL's payTo can differ
 * from the developer's own configured address (testing an endpoint you
 * don't own). Same technique as testCollisionThrowsBeforeFriendbot: force
 * Keypair.random() to return a specific keypair, but this time set the
 * LISTING's payTo to that keypair's public key instead of the developer's
 * configured setting (which is set to something else entirely here, to
 * isolate this from the first assertion).
 */
async function testPayToCollisionThrowsBeforeFriendbot(): Promise<void> {
  fakeFriendbot._test.reset();
  const { publicKey, restore } = installCollidingRandom();
  vscodeTest.setPayToAddress("GDEVELOPERSOWNUNRELATEDADDRESS00000000000000000000000000");
  vscodeTest.outputChannelLines.length = 0;

  const collidingTarget: TestPaymentTarget = {
    kind: "listing",
    listing: { ...FAKE_LISTING, payTo: publicKey },
  };
  const result = await runTestPayment(collidingTarget, fakeProgress() as never, fakeToken() as never);
  restore();

  if (result !== undefined) {
    throw new Error(`FAIL: expected runTestPayment to fail when throwaway === endpoint's payTo, got ${result}`);
  }
  if (fakeFriendbot._test.callCount !== 0) {
    throw new Error(
      `FAIL: fundWithFriendbot was called ${fakeFriendbot._test.callCount} time(s) — the payTo assertion must throw BEFORE any network call`,
    );
  }
  const loggedAssertion = vscodeTest.outputChannelLines.some((line) => line.includes("Assertion failed"));
  if (!loggedAssertion) {
    throw new Error(
      `FAIL: expected the output channel to record the payTo assertion failure; got: ${JSON.stringify(vscodeTest.outputChannelLines)}`,
    );
  }
  console.log("  ok: throwaway === endpoint's payTo — runTestPayment fails, fundWithFriendbot is NEVER called");
}

export async function runAssertionChecks(): Promise<void> {
  await testCollisionThrowsBeforeFriendbot();
  await testDifferentAddressesProceedPastAssertion();
  await testPayToCollisionThrowsBeforeFriendbot();
}
