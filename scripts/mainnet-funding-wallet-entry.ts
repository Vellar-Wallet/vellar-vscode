/**
 * Bundled by run-mainnet-funding-wallet-check.js with "vscode" aliased to
 * vscode-test-stub.js. Exercises mainnetFundingWallet.ts's real source
 * directly (no fakes on the module under test itself) — the "Vellar:
 * Configure mainnet test wallet" command and the read path runTestPayment.ts
 * relies on, against the stub's real (in-memory) SecretStorage and real
 * showInputBox control.
 */
import {
  configureMainnetTestWalletCommand,
  getMainnetFundingSecret,
  clearMainnetFundingSecret,
} from "../src/sidebar/testPayment/mainnetFundingWallet";

interface FakeSecretStorage {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  onDidChange: unknown;
}
interface VscodeTestNamespace {
  setNextInputBoxValue(value: string | undefined): void;
  createFakeSecretStorage(): FakeSecretStorage;
  outputChannelLines: string[];
  notificationsShown: string[];
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeTest = require("./vscode-test-stub")._test as VscodeTestNamespace;

// A genuinely real Stellar secret/public keypair — generated once via
// Keypair.random() while writing this test, not hand-typed — so the "valid
// input" case exercises Keypair.fromSecret's REAL parse/derive path, not a
// string that merely looks plausible.
const REAL_SECRET = "SAJ3AWPX3Z3AHKFS7JAQ7ZDRLTB47UEZIBOWXBPDFRHG76KLB5FVPGPJ";
const REAL_PUBLIC = "GBXUOOEZM6PF455C7ETZHEFAXQUAAR63G46WMDOGJESDAVZ76VMTTWBU";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok: ${message}`);
}

/**
 * Part 1: a valid secret is stored, round-trips back out via
 * getMainnetFundingSecret, and the derived PUBLIC key (never the secret
 * itself) is shown back to the developer in the confirmation message — the
 * one way they can confirm they entered the key they meant to.
 */
async function testValidSecretIsStoredAndConfirmed(): Promise<void> {
  const secrets = vscodeTest.createFakeSecretStorage();
  vscodeTest.notificationsShown.length = 0;
  vscodeTest.setNextInputBoxValue(REAL_SECRET);

  await configureMainnetTestWalletCommand(secrets as never);

  const stored = await getMainnetFundingSecret(secrets as never);
  assert(stored === REAL_SECRET, "a valid secret round-trips back out through getMainnetFundingSecret unchanged");

  const confirmation = vscodeTest.notificationsShown.find((n) => n.includes("configured"));
  assert(Boolean(confirmation), "a confirmation message was shown after storing a valid secret");
  assert(
    Boolean(confirmation && confirmation.includes(REAL_PUBLIC)),
    "the confirmation message shows the DERIVED PUBLIC key",
  );
  assert(
    Boolean(confirmation && !confirmation.includes(REAL_SECRET)),
    "the confirmation message never includes the secret key itself",
  );
}

/**
 * Part 2: a malformed secret (doesn't parse as a real Stellar secret) is
 * REJECTED — never stored, and a clear error is shown instead of a raw SDK
 * exception. Proves Keypair.fromSecret's own validation is actually wired
 * in as a real gate, not just attempted.
 */
async function testMalformedSecretIsRejected(): Promise<void> {
  const secrets = vscodeTest.createFakeSecretStorage();
  vscodeTest.notificationsShown.length = 0;
  vscodeTest.setNextInputBoxValue("not-a-real-secret-key");

  await configureMainnetTestWalletCommand(secrets as never);

  const stored = await getMainnetFundingSecret(secrets as never);
  assert(stored === undefined, "a malformed secret is never stored");
  const errorShown = vscodeTest.notificationsShown.some((n) => n.includes("doesn't look like a valid Stellar secret key"));
  assert(errorShown, "a clear validation error is shown for a malformed secret");
}

/**
 * Part 3: cancelling the input box (showInputBox resolves undefined, same
 * as a real user pressing Escape) does nothing — no store, no error, no
 * confirmation. A cancel is not a failure and should stay silent.
 */
async function testCancelDoesNothing(): Promise<void> {
  const secrets = vscodeTest.createFakeSecretStorage();
  vscodeTest.notificationsShown.length = 0;
  vscodeTest.setNextInputBoxValue(undefined);

  await configureMainnetTestWalletCommand(secrets as never);

  const stored = await getMainnetFundingSecret(secrets as never);
  assert(stored === undefined, "cancelling the input box stores nothing");
  assert(vscodeTest.notificationsShown.length === 0, "cancelling the input box shows no message at all");
}

/**
 * Part 4: getMainnetFundingSecret's own "unconfigured" contract — undefined
 * with nothing stored, and undefined again for a stored-but-blank/whitespace
 * value (mirrors DataProvider.getConfiguredAddress()'s own trim-then-check
 * pattern, since a secret that's genuinely just whitespace should read the
 * same as genuinely unconfigured, not as a configured empty string).
 */
async function testGetMainnetFundingSecretUnconfiguredContract(): Promise<void> {
  const emptySecrets = vscodeTest.createFakeSecretStorage();
  const neverStored = await getMainnetFundingSecret(emptySecrets as never);
  assert(neverStored === undefined, "getMainnetFundingSecret returns undefined when nothing was ever stored");

  const whitespaceSecrets = vscodeTest.createFakeSecretStorage();
  await whitespaceSecrets.store("vellar-x402.mainnetFundingWalletSecret", "   ");
  const whitespaceOnly = await getMainnetFundingSecret(whitespaceSecrets as never);
  assert(whitespaceOnly === undefined, "getMainnetFundingSecret treats a whitespace-only stored value as unconfigured");
}

/** Part 5: clearMainnetFundingSecret actually removes a previously-stored
 *  value — exercised directly since no command is wired to it yet (see its
 *  own doc comment), but it's real, reachable code that should work. */
async function testClearRemovesStoredSecret(): Promise<void> {
  const secrets = vscodeTest.createFakeSecretStorage();
  vscodeTest.setNextInputBoxValue(REAL_SECRET);
  await configureMainnetTestWalletCommand(secrets as never);
  assert((await getMainnetFundingSecret(secrets as never)) === REAL_SECRET, "sanity check: secret is stored before clearing");

  await clearMainnetFundingSecret(secrets as never);
  assert((await getMainnetFundingSecret(secrets as never)) === undefined, "clearMainnetFundingSecret removes the stored secret");
}

export async function runMainnetFundingWalletChecks(): Promise<void> {
  await testValidSecretIsStoredAndConfirmed();
  await testMalformedSecretIsRejected();
  await testCancelDoesNothing();
  await testGetMainnetFundingSecretUnconfiguredContract();
  await testClearRemovesStoredSecret();
}
