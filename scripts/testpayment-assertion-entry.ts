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
import * as fakeMainnetFunding from "./fake-mainnet-funding";

interface FakeSecretStorage {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  onDidChange: unknown;
}
interface VscodeTestNamespace {
  setPayToAddress(value: string): void;
  setNetwork(value: string): void;
  outputChannelLines: string[];
  createFakeSecretStorage(): FakeSecretStorage;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeTest = require("./vscode-test-stub")._test as VscodeTestNamespace;

/** Fresh, empty (unconfigured) fake SecretStorage — most tests in this file
 *  want a mainnet funding wallet that's genuinely NOT configured, since
 *  they're testing testnet paths or the "not configured" gate itself; tests
 *  that need a CONFIGURED wallet build their own via
 *  vscodeTest.createFakeSecretStorage() + a real .store() call instead. */
function emptySecrets(): FakeSecretStorage {
  return vscodeTest.createFakeSecretStorage();
}

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
  // These tests exercise the payTo-collision assertions specifically, which
  // run AFTER the network gate — force testnet so the flow actually reaches
  // them, isolated from testNetworkPubnetFailsBeforeFriendbot's own coverage
  // of the gate itself, below.
  vscodeTest.setNetwork("stellar:testnet");
  const { publicKey, restore } = installCollidingRandom();
  vscodeTest.setPayToAddress(publicKey); // developer's own address == what Keypair.random() will now return
  vscodeTest.outputChannelLines.length = 0;

  const result = await runTestPayment(FAKE_TARGET, fakeProgress() as never, fakeToken() as never, emptySecrets() as never);
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
  vscodeTest.setNetwork("stellar:testnet");
  vscodeTest.setPayToAddress("GDIFFERENTPAYTOTHATISNOTUSED0000000000000000000000000000");
  vscodeTest.outputChannelLines.length = 0;

  // Keypair.random() is NOT patched here — a genuinely fresh random keypair
  // is used, which (with probability indistinguishable from 1) differs from
  // the fixed developer address above. fundWithFriendbot is faked to resolve
  // instantly (see fake-friendbot.js) so this test doesn't depend on any
  // live network call — it only needs to prove the assertion did NOT block
  // progress, not that the whole payment flow succeeds end-to-end (that's
  // covered by this feature's own live-data verification during Step 6).
  await runTestPayment(FAKE_TARGET, fakeProgress() as never, fakeToken() as never, emptySecrets() as never);

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
  vscodeTest.setNetwork("stellar:testnet");
  const { publicKey, restore } = installCollidingRandom();
  vscodeTest.setPayToAddress("GDEVELOPERSOWNUNRELATEDADDRESS00000000000000000000000000");
  vscodeTest.outputChannelLines.length = 0;

  const collidingTarget: TestPaymentTarget = {
    kind: "listing",
    listing: { ...FAKE_LISTING, payTo: publicKey },
  };
  const result = await runTestPayment(
    collidingTarget,
    fakeProgress() as never,
    fakeToken() as never,
    emptySecrets() as never,
  );
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

/**
 * Proves the "no mainnet funding wallet configured" gate: with network at
 * stellar:pubnet and an EMPTY (unconfigured) SecretStorage, runTestPayment
 * must fail fast, before ANY network call (including friendbot — which
 * must never fire on pubnet at all — and fundThrowawayFromMainnetWallet),
 * with a message pointing at the configure command. Uses a genuinely random
 * keypair and a non-colliding payTo — isolated from the payTo-collision
 * assertions above on purpose, so a failure here can only mean this gate,
 * not one of those.
 */
async function testNetworkPubnetWithNoWalletConfiguredFails(): Promise<void> {
  fakeFriendbot._test.reset();
  fakeMainnetFunding._test.reset();
  vscodeTest.setNetwork("stellar:pubnet");
  vscodeTest.setPayToAddress("GDIFFERENTPAYTOTHATISNOTUSED0000000000000000000000000000");
  vscodeTest.outputChannelLines.length = 0;

  const result = await runTestPayment(FAKE_TARGET, fakeProgress() as never, fakeToken() as never, emptySecrets() as never);

  if (result !== undefined) {
    throw new Error(`FAIL: expected runTestPayment to fail on stellar:pubnet with no wallet configured, got ${result}`);
  }
  if (fakeFriendbot._test.callCount !== 0) {
    throw new Error(
      `FAIL: fundWithFriendbot was called ${fakeFriendbot._test.callCount} time(s) — friendbot must NEVER be called on pubnet`,
    );
  }
  if (fakeMainnetFunding._test.callCount !== 0) {
    throw new Error(
      `FAIL: fundThrowawayFromMainnetWallet was called ${fakeMainnetFunding._test.callCount} time(s) — the not-configured gate must throw BEFORE any funding call`,
    );
  }
  const loggedGate = vscodeTest.outputChannelLines.some((line) => line.includes("No mainnet funding wallet is configured"));
  if (!loggedGate) {
    throw new Error(
      `FAIL: expected the output channel to record the not-configured error; got: ${JSON.stringify(vscodeTest.outputChannelLines)}`,
    );
  }
  console.log("  ok: network=stellar:pubnet, no wallet configured — runTestPayment fails, no funding call is ever made, gate is logged");

  vscodeTest.setNetwork("stellar:testnet"); // restore, so later tests in this process aren't affected
}

/**
 * Proves the $2 mainnet price ceiling: with network at stellar:pubnet, a
 * WALLET CONFIGURED (so this test isolates the ceiling from the
 * not-configured gate above), and an endpoint priced above the ceiling,
 * runTestPayment must fail before any funding call — the ceiling check runs
 * first, before even the wallet-configured check, per runTestPayment.ts's
 * own ordering (a pure local check ahead of an async SecretStorage read).
 */
async function testNetworkPubnetOverPriceCeilingFails(): Promise<void> {
  fakeFriendbot._test.reset();
  fakeMainnetFunding._test.reset();
  vscodeTest.setNetwork("stellar:pubnet");
  vscodeTest.setPayToAddress("GDIFFERENTPAYTOTHATISNOTUSED0000000000000000000000000000");
  vscodeTest.outputChannelLines.length = 0;

  const secrets = vscodeTest.createFakeSecretStorage();
  await secrets.store("vellar-x402.mainnetFundingWalletSecret", "SDUMMYFUNDINGWALLETSECRETFORTESTS0000000000000000000000000");

  // 20_000_001 atomic (7 decimals) = $2.0000001, one atomic unit over the
  // $2.00 ceiling — the tightest possible over-the-line case, not a wildly
  // inflated price that would pass by a wide, less meaningful margin.
  const overCeilingTarget: TestPaymentTarget = {
    kind: "listing",
    listing: { ...FAKE_LISTING, amount: "20000001" },
  };
  const result = await runTestPayment(overCeilingTarget, fakeProgress() as never, fakeToken() as never, secrets as never);

  if (result !== undefined) {
    throw new Error(`FAIL: expected runTestPayment to fail for a price over the mainnet ceiling, got ${result}`);
  }
  if (fakeMainnetFunding._test.callCount !== 0) {
    throw new Error(
      `FAIL: fundThrowawayFromMainnetWallet was called ${fakeMainnetFunding._test.callCount} time(s) — the price ceiling must throw BEFORE any funding call, even with a wallet configured`,
    );
  }
  const loggedCeiling = vscodeTest.outputChannelLines.some((line) => line.includes("mainnet test-payment ceiling"));
  if (!loggedCeiling) {
    throw new Error(
      `FAIL: expected the output channel to record the price-ceiling error; got: ${JSON.stringify(vscodeTest.outputChannelLines)}`,
    );
  }
  console.log("  ok: network=stellar:pubnet, price over $2.00 ceiling — runTestPayment fails before any funding call, even with a wallet configured");

  vscodeTest.setNetwork("stellar:testnet");
}

/**
 * Proves the successful mainnet path: network at stellar:pubnet, a
 * genuinely configured funding wallet, and a price AT the ceiling (exactly
 * $2.00 — proving the ceiling is inclusive, not exclusive) all together
 * must let the flow proceed PAST both guards and actually call
 * fundThrowawayFromMainnetWallet with the right arguments (the throwaway
 * wallet's own public key, and the configured secret) — then continue into
 * Step 3 (USDC trustline), which fake-usdc.js fails deterministically, so
 * this test only needs to prove funding was reached and called correctly,
 * not that the whole flow settles end to end.
 */
async function testNetworkPubnetWithWalletConfiguredProceedsToFunding(): Promise<void> {
  fakeFriendbot._test.reset();
  fakeMainnetFunding._test.reset();
  vscodeTest.setNetwork("stellar:pubnet");
  vscodeTest.setPayToAddress("GDIFFERENTPAYTOTHATISNOTUSED0000000000000000000000000000");
  vscodeTest.outputChannelLines.length = 0;

  const configuredSecret = "SDUMMYFUNDINGWALLETSECRETFORTESTS0000000000000000000000000";
  const secrets = vscodeTest.createFakeSecretStorage();
  await secrets.store("vellar-x402.mainnetFundingWalletSecret", configuredSecret);

  // amount === the ceiling exactly (20_000_000 atomic = $2.00) — proves the
  // ceiling check is `>`, not `>=`, i.e. inclusive of the ceiling itself.
  const atCeilingTarget: TestPaymentTarget = {
    kind: "listing",
    listing: { ...FAKE_LISTING, amount: "20000000" },
  };
  await runTestPayment(atCeilingTarget, fakeProgress() as never, fakeToken() as never, secrets as never);

  if (fakeFriendbot._test.callCount !== 0) {
    throw new Error(
      `FAIL: fundWithFriendbot was called ${fakeFriendbot._test.callCount} time(s) — friendbot must NEVER be called on pubnet, even on the successful path`,
    );
  }
  if (fakeMainnetFunding._test.callCount !== 1) {
    throw new Error(
      `FAIL: expected fundThrowawayFromMainnetWallet to be called exactly once, was called ${fakeMainnetFunding._test.callCount} time(s)`,
    );
  }
  const call = fakeMainnetFunding._test.calls[0];
  if (call.secret !== configuredSecret) {
    throw new Error("FAIL: fundThrowawayFromMainnetWallet was called with the wrong secret — not the one that was configured");
  }
  if (call.network !== "stellar:pubnet") {
    throw new Error(`FAIL: fundThrowawayFromMainnetWallet was called with network="${call.network}", expected "stellar:pubnet"`);
  }
  // publicKey must be a real, well-shaped throwaway public key — not
  // asserting an exact value (Keypair.random() here is genuinely random,
  // unpatched, same as testDifferentAddressesProceedPastAssertion above),
  // just that SOME real public key was passed, proving the throwaway
  // keypair generated in Step 1 is what actually got funded.
  if (typeof call.publicKey !== "string" || call.publicKey.length !== 56 || !call.publicKey.startsWith("G")) {
    throw new Error(`FAIL: fundThrowawayFromMainnetWallet was called with a malformed publicKey: ${JSON.stringify(call.publicKey)}`);
  }
  console.log(
    "  ok: network=stellar:pubnet, wallet configured, price at the $2.00 ceiling — fundThrowawayFromMainnetWallet is called once with the configured secret and the throwaway wallet's real public key",
  );

  vscodeTest.setNetwork("stellar:testnet");
}

export async function runAssertionChecks(): Promise<void> {
  await testCollisionThrowsBeforeFriendbot();
  await testDifferentAddressesProceedPastAssertion();
  await testPayToCollisionThrowsBeforeFriendbot();
  await testNetworkPubnetWithNoWalletConfiguredFails();
  await testNetworkPubnetOverPriceCeilingFails();
  await testNetworkPubnetWithWalletConfiguredProceedsToFunding();
}
