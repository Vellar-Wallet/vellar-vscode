/**
 * Provision a throwaway keypair with USDC: open a trustline, then buy
 * `targetAmountAtomic`'s worth on the DEX, paying in the wallet's own
 * friendbot-funded XLM.
 *
 * The DEX purchase here is now a TESTNET-ONLY path. On mainnet the throwaway
 * wallet is sent USDC directly from the developer's own funding wallet (see
 * mainnetFunding.ts's sendUsdcToThrowaway and its header comment for why
 * trading on mainnet was removed). openUsdcTrustline below is still used by
 * BOTH networks — a wallet must have a trustline before it can hold USDC,
 * however that USDC arrives.
 *
 * Ported from vellar-playground/lib/usdc.ts (itself ported from
 * vellar-facilitator/examples/provision-testnet.mjs's USE_USDC path) — the
 * classic-Horizon submit logic, trustline, and pathPaymentStrictReceive DEX
 * purchase are UNCHANGED from that file. What's different, and why:
 *
 *  - No `lib/config.ts`/`lib/catalog.ts` imports: the playground looks up a
 *    fixed demo resource's price from the facilitator's catalog to decide a
 *    funding target. This extension already knows the exact price of the
 *    specific endpoint the developer clicked Test on (EndpointListing's own
 *    accepts[].amount, read fresh at click time) — no catalog lookup needed,
 *    the caller (runTestPayment.ts) computes the buffered target directly and
 *    passes it in as `targetAmountAtomic`.
 *  - USDC_ISSUER_BY_NETWORK is a local constant here, not imported from a
 *    shared config module — this file has no sibling config file of its own,
 *    and each network's value is identical to (and cross-checked against)
 *    dataProvider.ts's own USDC_ISSUER_BY_NETWORK constant, which already has
 *    its own provenance comment.
 *  - No `console.error`/`console.log` calls: this module is used ONLY from
 *    the extension host's test-payment flow, where ALL logging goes through
 *    outputChannel.ts's logAndGenericError (the one place raw errors are
 *    allowed to surface) — never a bare console call that would bypass that
 *    single logging path.
 *
 * Every failure mode here is EXPECTED and non-exceptional (no DEX path, a
 * submit failure, a timeout) — this module never throws. It always resolves
 * to a discriminated result so the caller can degrade / report a clean
 * failure without an unhandled rejection anywhere in the test-payment flow.
 */

import { Asset, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "../../types";

// Exported (read-only, no behavior change) so scripts/network-switch-entry.ts
// can assert the real network->URL/issuer mapping directly, the same reason
// HORIZON_FETCH_TIMEOUT_MS etc. below are exported — this is the single
// highest-consequence lookup in the whole network-switching feature (get it
// wrong and a real trade targets the wrong asset or the wrong ledger).
export const HORIZON_URL_BY_NETWORK: Record<StellarNetwork, string> = {
  "stellar:testnet": "https://horizon-testnet.stellar.org",
  "stellar:pubnet": "https://horizon.stellar.org",
};
// Exported (read-only, no behavior change) so
// mainnetFunding.ts can build a real classic Payment transaction with the
// correct network passphrase — same reasoning as HORIZON_URL_BY_NETWORK and
// USDC_ISSUER_BY_NETWORK just above, kept private until a real second
// consumer needed it.
export const PASSPHRASE_BY_NETWORK: Record<StellarNetwork, string> = {
  "stellar:testnet": Networks.TESTNET,
  "stellar:pubnet": Networks.PUBLIC,
};

// Same canonical USDC issuers as dataProvider.ts's USDC_ISSUER_BY_NETWORK —
// see that file's own comment for how each was confirmed (matched by
// asset_code AND asset_issuer together, cross-checked against the live
// facilitator and explorer). Not imported from there to avoid a payment-flow
// module reaching into the polling/display module for an unrelated constant;
// kept as its own literal here, with this note pointing at the sibling copy
// so the two never silently drift without the drift being obvious in a diff.
export const USDC_ISSUER_BY_NETWORK: Record<StellarNetwork, string> = {
  "stellar:testnet": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "stellar:pubnet": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

const SUBMIT_TIMEOUT_SECONDS = 35;
// Exported (read-only, no behavior change) so scripts/run-horizon-timeout-check.js
// can assert real sane bounds on these values directly, rather than
// duplicating a second, possibly-drifting copy of "15000" in the test file.
export const HORIZON_FETCH_TIMEOUT_MS = 15_000;

// REAL BUG, FOUND AND FIXED: SUBMIT_TIMEOUT_SECONDS above bounds the
// transaction ENVELOPE's own validity window (how long Horizon will keep
// retrying inclusion of an already-submitted tx before the envelope itself
// expires) — it is NOT an HTTP request timeout, and `Horizon.Server`'s
// underlying client (confirmed by inspecting `new Horizon.Server(...)
// .httpClient.defaults` directly: no `timeout` key present at all) has NO
// request timeout of its own by default. That gap meant loadAccount,
// submitTransaction, and strictReceivePaths().call() could all hang
// indefinitely on a stalled connection — which is exactly what happened in
// production: a test payment got stuck with no bound, testPaymentInFlight
// in webviewProvider.ts never reset, and the only recovery was reloading
// the whole extension host window.
//
// HORIZON_SUBMIT_TIMEOUT_MS is a SEPARATE, explicit HTTP-request timeout —
// deliberately not reusing SUBMIT_TIMEOUT_SECONDS for this, since conflating
// "how long the tx envelope stays valid" with "how long we'll wait for
// Horizon's HTTP response" is exactly the confusion that let this bug slip
// through unnoticed. 60s is generous enough to cover the envelope's own 35s
// validity window plus Horizon's own processing/retry time, while still
// being a real, bounded ceiling rather than none at all.
export const HORIZON_SUBMIT_TIMEOUT_MS = 60_000;

// SECOND occurrence of the same bug class, found in payment.ts: `@stellar/
// stellar-sdk`'s Soroban `rpc.Server` (used internally by
// `@x402/stellar`'s ExactStellarScheme.createPaymentPayload, via
// contract.AssembledTransaction.build()'s simulate/sign-auth-entry/
// re-simulate sequence) has the SAME unbounded HTTP client as
// Horizon.Server above — confirmed the identical way: `new rpc.Server(...)
// .httpClient.defaults` has no `timeout` key either. Neither @x402/stellar
// nor @x402/core add any timeout of their own around this call (confirmed
// by grepping both packages' compiled source — zero timeout/AbortSignal
// references in @x402/stellar's client code, and @x402/core's only
// timeout-related export, FacilitatorTimeoutError, belongs to a different
// code path — calling the facilitator's own HTTP API — not this
// in-process signing call).
//
// This constant bounds SPECIFICALLY the Soroban RPC simulation
// client.createPaymentPayload(required) triggers in payment.ts — not the
// payment payload's own ledger-based validity window (that's the x402
// scheme's concern, unrelated to this HTTP timeout), and not a call to the
// facilitator (this extension's client never calls the facilitator
// directly — see payment.ts's own comment on why the retry targets the
// seller's resource URL, not /verify or /settle). 30s: real headroom above
// observed simulation latency, deliberately less generous than the 60s
// submit ceiling above since a simulate-only RPC round trip should be
// faster than an actual ledger-committing submit.
export const SOROBAN_RPC_TIMEOUT_MS = 30_000;

/**
 * Slippage ceiling for the DEX purchase, as a multiple of the live quoted
 * price — NOT a flat XLM-per-USDC figure.
 *
 * REAL BUG, FOUND AND FIXED: this was `250` and sendMax was computed as
 * `wholeUnitsCeil * 250` XLM, i.e. "I will pay up to 250 XLM per whole USDC
 * unit". That was survivable on testnet, where the throwaway wallet holds
 * 10000 free friendbot XLM and an absurd ceiling costs nothing. On mainnet
 * it broke every purchase: buying 0.6 USDC rounds up to 1 whole unit, so
 * sendMax became 250 XLM against a wallet holding ~4.5 spendable — and
 * Stellar rejects a pathPaymentStrictReceive whose sendMax exceeds the
 * balance BEFORE attempting any trade, regardless of what the trade would
 * actually have cost (2.65 XLM at the time). The purchase could never
 * succeed no matter how the wallet was funded.
 *
 * Quoting the real price and allowing a modest multiple over it keeps the
 * protection this was meant to provide (a broken or manipulated order book
 * can't drain the wallet) while staying achievable with a realistically
 * funded wallet. 2x absorbs ordinary book movement between quote and submit.
 */
const SLIPPAGE_MULTIPLIER = 2;

const USDC_DECIMALS = 7;
const ATOMIC_SCALE = 10n ** BigInt(USDC_DECIMALS);

export type OpenTrustlineResult = { ok: true } | { ok: false; reason: string };
export type BuyUsdcResult = { ok: true; balanceUsdc: string } | { ok: false; reason: string };

/**
 * Races `promise` against a timer that REJECTS after `ms` milliseconds —
 * the one mechanism this file uses to put a real, enforced ceiling on a
 * Horizon SDK call that has no timeout option of its own (unlike this
 * file's OWN fetch call below, which already uses AbortSignal.timeout, and
 * unlike friendbot.ts/payment.ts elsewhere in this codebase, which do the
 * same). `clearTimeout` in `finally` matters: without it, a WON race (the
 * real promise resolving first) would still leave the timer running for the
 * full `ms`, needlessly keeping the Node event loop alive and holding a
 * closure over `promise`/`label` until it eventually fires and is ignored.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Exported so mainnetFunding.ts's USDC transfer formats its amount through
 *  the SAME 7-decimal conversion the DEX purchase here already uses, rather
 *  than growing a second, subtly-different copy of the same arithmetic. */
export function atomicToDecimalString(atomic: bigint): string {
  const whole = atomic / ATOMIC_SCALE;
  const frac = atomic % ATOMIC_SCALE;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}


/**
 * Build, sign, and submit a classic (non-Soroban) transaction via Horizon,
 * then poll until it's confirmed. CRITICAL (per the source file): this
 * deliberately uses classic `Horizon.Server` + `TransactionBuilder`, NOT
 * Soroban RPC — Soroban RPC's `prepareTransaction` rejects classic operations
 * like `changeTrust`/`pathPaymentStrictReceive` outright.
 *
 * `kp` here is the throwaway keypair, held only in this function's stack —
 * signing happens via `tx.sign(kp)` and nothing about `kp` is captured into
 * any returned value, logged string, or object outside this call.
 */
async function submitClassic(
  horizon: Horizon.Server,
  kp: Keypair,
  ops: ReturnType<typeof Operation.changeTrust | typeof Operation.pathPaymentStrictReceive>[],
  label: string,
  network: StellarNetwork,
): Promise<{ ok: true; hash: string } | { ok: false; reason: string }> {
  try {
    const account = await withTimeout(horizon.loadAccount(kp.publicKey()), HORIZON_FETCH_TIMEOUT_MS, `${label}: loadAccount`);
    let txBuilder = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE_BY_NETWORK[network] });
    for (const op of ops) txBuilder = txBuilder.addOperation(op);
    const tx = txBuilder.setTimeout(SUBMIT_TIMEOUT_SECONDS).build();
    tx.sign(kp);

    const sent = await withTimeout(horizon.submitTransaction(tx), HORIZON_SUBMIT_TIMEOUT_MS, `${label}: submitTransaction`);
    if (!sent.successful) {
      return { ok: false, reason: `${label} did not settle` };
    }
    return { ok: true, hash: sent.hash };
  } catch {
    // Raw error is intentionally swallowed here, not logged — this is a leaf
    // helper with no access to the output channel; the caller
    // (runTestPayment.ts) is responsible for logging with full context via
    // logAndGenericError. Returning a short reason string, never the raw
    // error object, keeps this consistent with every other reason string in
    // this file regardless of which caller eventually surfaces it.
    return { ok: false, reason: `${label} failed` };
  }
}

/** Step 1 of USDC provisioning: open a trustline to the canonical USDC
 *  issuer for `network` on `keypair`'s account. Never throws. */
export async function openUsdcTrustline(keypair: Keypair, network: StellarNetwork): Promise<OpenTrustlineResult> {
  const horizon = new Horizon.Server(HORIZON_URL_BY_NETWORK[network]);
  const asset = new Asset("USDC", USDC_ISSUER_BY_NETWORK[network]);

  const trustlineResult = await submitClassic(horizon, keypair, [Operation.changeTrust({ asset })], "USDC trustline", network);
  if (!trustlineResult.ok) return { ok: false, reason: "couldn't open a USDC trustline" };
  return { ok: true };
}

/**
 * Step 2 of USDC provisioning: buy `targetAmountAtomic` (base-10 atomic
 * string, 7 decimals) worth of USDC via a strict-receive path payment funded
 * by the wallet's own XLM. Assumes a trustline is already open. Never
 * throws.
 */
export async function buyUsdc(
  keypair: Keypair,
  targetAmountAtomic: string,
  network: StellarNetwork,
): Promise<BuyUsdcResult> {
  if (!/^\d+$/.test(targetAmountAtomic) || BigInt(targetAmountAtomic) <= 0n) {
    return { ok: false, reason: "invalid funding target" };
  }

  const horizon = new Horizon.Server(HORIZON_URL_BY_NETWORK[network]);
  const asset = new Asset("USDC", USDC_ISSUER_BY_NETWORK[network]);
  const targetAtomic = BigInt(targetAmountAtomic);
  const destAmount = atomicToDecimalString(targetAtomic);

  // See vellar-playground/lib/usdc.ts's own comment on the @stellar/stellar-sdk
  // strictReceivePaths type-vs-runtime mismatch this cast works around — the
  // runtime shape (`.records`) is correct regardless of the builder's
  // declared TypeScript type.
  let path: Asset[];
  let quotedSourceAmount: number;
  try {
    const paths = (await withTimeout(
      horizon.strictReceivePaths([Asset.native()], asset, destAmount).call(),
      HORIZON_FETCH_TIMEOUT_MS,
      "USDC purchase: strictReceivePaths",
    )) as unknown as Horizon.ServerApi.CollectionPage<Horizon.ServerApi.PaymentPathRecord>;
    if (!paths.records.length) {
      return { ok: false, reason: "no USDC market route available right now" };
    }
    path = paths.records[0].path.map((p) =>
      p.asset_type === "native" ? Asset.native() : new Asset(p.asset_code!, p.asset_issuer!),
    );
    // The REAL quoted cost of this trade, used for sendMax below instead of
    // a flat per-unit constant.
    quotedSourceAmount = Number(paths.records[0].source_amount);
  } catch {
    return { ok: false, reason: "couldn't look up a USDC purchase route" };
  }

  // sendMax is derived from the LIVE QUOTE, not a flat per-unit ceiling —
  // see SLIPPAGE_MULTIPLIER's own comment for the real bug the old
  // `wholeUnitsCeil * 250` form caused (a sendMax larger than the wallet's
  // entire balance, which Stellar rejects outright before trading).
  const sendMax = (quotedSourceAmount * SLIPPAGE_MULTIPLIER).toFixed(7);

  const purchaseResult = await submitClassic(
    horizon,
    keypair,
    [
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax,
        destination: keypair.publicKey(),
        destAsset: asset,
        destAmount,
        path,
      }),
    ],
    "USDC purchase",
    network,
  );
  if (!purchaseResult.ok) return { ok: false, reason: "couldn't buy USDC on the market" };

  // Re-read the real balance from Horizon rather than assuming destAmount
  // landed exactly.
  try {
    const res = await fetch(`${HORIZON_URL_BY_NETWORK[network]}/accounts/${encodeURIComponent(keypair.publicKey())}`, {
      signal: AbortSignal.timeout(HORIZON_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`horizon returned HTTP ${res.status}`);
    const account = (await res.json()) as {
      balances?: Array<{ asset_code?: string; asset_issuer?: string; balance: string }>;
    };
    const line = account.balances?.find(
      (b) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER_BY_NETWORK[network],
    );
    if (!line) return { ok: false, reason: "USDC purchase didn't complete as expected" };
    return { ok: true, balanceUsdc: line.balance };
  } catch {
    return { ok: false, reason: "USDC purchase may have succeeded, but we couldn't confirm the balance" };
  }
}
