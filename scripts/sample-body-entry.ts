/**
 * Bundled by run-sample-body-check.js with "vscode" aliased to
 * vscode-test-stub.js, and runTestPayment.ts's friendbot/usdc/mainnetFunding
 * imports redirected to the existing fakes (same plugin shape
 * run-testpayment-assertion-check.js uses).
 *
 * Two concerns, both about the developer-supplied sample request body:
 *  1. narrowSampleBody — the webview message boundary. Webview-authored
 *     input that becomes a live HTTP request body must be narrowed exactly
 *     like every other field handleMessage reads.
 *  2. The JSON pre-validation guard in runTestPayment — malformed JSON must
 *     fail BEFORE any funds move, and the body must never be logged.
 */
import { narrowSampleBody } from "../src/sidebar/webviewProvider";
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

const LISTING: EndpointListing = {
  resource: "https://example.test/never-reached",
  priceLabel: "0.01 USDC",
  ownershipState: "unknown",
  settlements: 0,
  lastSettled: undefined,
  payTo: "GDIFFERENTPAYTOTHATISNOTUSED0000000000000000000000000000",
  amount: "100000",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  // Declared POST so the flow reaches the body guard without a live probe.
  method: "POST",
};

function fakeProgress() {
  return { report: () => {} };
}
function fakeToken() {
  return { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok: ${message}`);
}

/** Part 1: the message boundary rejects everything that isn't a sane string. */
function testNarrowSampleBody(): void {
  assert(narrowSampleBody({ sampleBody: '{"a":1}' }) === '{"a":1}', "a real string passes through unchanged");
  assert(narrowSampleBody({}) === undefined, "an absent sampleBody is undefined");
  assert(narrowSampleBody({ sampleBody: undefined }) === undefined, "an explicit undefined stays undefined");
  assert(narrowSampleBody({ sampleBody: 42 }) === undefined, "a number is rejected");
  assert(narrowSampleBody({ sampleBody: { a: 1 } }) === undefined, "an object is rejected");
  assert(narrowSampleBody({ sampleBody: ["a"] }) === undefined, "an array is rejected");
  assert(narrowSampleBody({ sampleBody: null }) === undefined, "null is rejected");
  assert(narrowSampleBody({ sampleBody: true }) === undefined, "a boolean is rejected");
  assert(narrowSampleBody({ sampleBody: "" }) === undefined, "an empty string reads as none supplied");
  assert(narrowSampleBody({ sampleBody: "   \n  " }) === undefined, "a whitespace-only string reads as none supplied");

  // 64KB cap: at the limit passes, one byte over is rejected outright rather
  // than silently truncated (a half-body would be invalid JSON anyway).
  const atLimit = "x".repeat(64 * 1024);
  assert(narrowSampleBody({ sampleBody: atLimit }) === atLimit, "a body exactly at the 64KB cap is accepted");
  assert(narrowSampleBody({ sampleBody: atLimit + "x" }) === undefined, "a body over the 64KB cap is rejected");
}

/** Part 2: malformed JSON fails before any funding call. */
async function testMalformedJsonFailsBeforeFunding(): Promise<void> {
  fakeFriendbot._test.reset();
  fakeMainnetFunding._test.reset();
  vscodeTest.setNetwork("stellar:testnet");
  vscodeTest.setPayToAddress("GDEVELOPERSOWNUNRELATEDADDRESS00000000000000000000000000");
  vscodeTest.outputChannelLines.length = 0;

  const target: TestPaymentTarget = { kind: "listing", listing: LISTING, sampleBody: '{"topic": "oops",}' };
  const result = await runTestPayment(
    target,
    fakeProgress() as never,
    fakeToken() as never,
    vscodeTest.createFakeSecretStorage() as never,
  );

  assert(result === undefined, "runTestPayment fails on malformed JSON");
  assert(
    fakeFriendbot._test.callCount === 0,
    `friendbot was NEVER called — the guard runs before funding, got ${fakeFriendbot._test.callCount}`,
  );
  assert(fakeMainnetFunding._test.callCount === 0, "no mainnet funding call was made either");
  const logged = vscodeTest.outputChannelLines.join("\n");
  assert(logged.includes("isn't valid JSON"), "the output channel records a clear invalid-JSON message");
  assert(logged.includes("nothing has been spent"), "the message reassures that nothing was spent");
}

/** Part 3: the body itself is NEVER written to the output channel. A request
 *  body can carry API keys or personal data a developer pasted while
 *  testing — the error names the syntax problem, never the payload. */
async function testBodyIsNeverLogged(): Promise<void> {
  fakeFriendbot._test.reset();
  vscodeTest.setNetwork("stellar:testnet");
  vscodeTest.setPayToAddress("GDEVELOPERSOWNUNRELATEDADDRESS00000000000000000000000000");
  vscodeTest.outputChannelLines.length = 0;

  const secretish = "sk_live_SUPERSECRET_DO_NOT_LOG";
  const target: TestPaymentTarget = {
    kind: "listing",
    listing: LISTING,
    sampleBody: `{"apiKey": "${secretish}",}`, // malformed on purpose: trailing comma
  };
  await runTestPayment(
    target,
    fakeProgress() as never,
    fakeToken() as never,
    vscodeTest.createFakeSecretStorage() as never,
  );

  const logged = vscodeTest.outputChannelLines.join("\n");
  assert(!logged.includes(secretish), "the sample body's contents never reach the output channel");
}

/** Part 4: valid JSON passes the guard and the flow proceeds to funding. */
async function testValidJsonProceeds(): Promise<void> {
  fakeFriendbot._test.reset();
  vscodeTest.setNetwork("stellar:testnet");
  vscodeTest.setPayToAddress("GDEVELOPERSOWNUNRELATEDADDRESS00000000000000000000000000");
  vscodeTest.outputChannelLines.length = 0;

  const target: TestPaymentTarget = {
    kind: "listing",
    listing: LISTING,
    sampleBody: '{"topic": "perseverance"}',
  };
  await runTestPayment(
    target,
    fakeProgress() as never,
    fakeToken() as never,
    vscodeTest.createFakeSecretStorage() as never,
  );

  assert(
    fakeFriendbot._test.callCount === 1,
    `valid JSON passes the guard and the flow reaches funding, got ${fakeFriendbot._test.callCount} funding calls`,
  );
  const logged = vscodeTest.outputChannelLines.join("\n");
  assert(!logged.includes("isn't valid JSON"), "no invalid-JSON error was raised for valid JSON");
}

/** Part 5: no body supplied at all is fine — the flow proceeds, and
 *  payment.ts's own {} default (covered by the cascade check) applies. */
async function testNoBodyProceeds(): Promise<void> {
  fakeFriendbot._test.reset();
  vscodeTest.setNetwork("stellar:testnet");
  vscodeTest.setPayToAddress("GDEVELOPERSOWNUNRELATEDADDRESS00000000000000000000000000");
  vscodeTest.outputChannelLines.length = 0;

  const target: TestPaymentTarget = { kind: "listing", listing: LISTING };
  await runTestPayment(
    target,
    fakeProgress() as never,
    fakeToken() as never,
    vscodeTest.createFakeSecretStorage() as never,
  );

  assert(fakeFriendbot._test.callCount === 1, "a listing with no sample body still proceeds to funding");
}

export async function runSampleBodyChecks(): Promise<void> {
  testNarrowSampleBody();
  await testMalformedJsonFailsBeforeFunding();
  await testBodyIsNeverLogged();
  await testValidJsonProceeds();
  await testNoBodyProceeds();
}
