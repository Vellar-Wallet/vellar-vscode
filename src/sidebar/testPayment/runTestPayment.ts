/**
 * Orchestrates a test payment against whichever network vellar-x402.network
 * currently names (read once, live, at the top of runTestPayment — see
 * DataProvider.getConfiguredNetwork()). The two networks take deliberately
 * different routes to the same place:
 *
 * MAINNET (stellar:pubnet) — pay directly from the developer's own
 * configured funding wallet. One signature, nothing created, nothing
 * stranded. That wallet already exists, already holds a USDC trustline, and
 * already holds the USDC, so every precondition a throwaway wallet would
 * have to be walked through is already satisfied.
 *
 * TESTNET — the throwaway route: generate a keypair, friendbot it, open a
 * trustline, buy USDC on the DEX, pay, discard. Every step is free here, so
 * a disposable identity costs nothing and keeps test payments isolated from
 * any real wallet.
 *
 * WHY NOT A THROWAWAY ON MAINNET, since that was the original design: it
 * required a 1.0 XLM account reserve plus 0.5 XLM for its trustline, both
 * LOCKED by protocol and stranded permanently when the keypair is discarded
 * seconds later — and it added an account creation, a trustline submission
 * and an asset transfer, each a step that could fail with real money already
 * committed. The isolation it bought is worth nothing on mainnet, where the
 * developer is spending their own funds either way.
 *
 * Then, on both networks: build the x402 client, request the resource
 * expecting 402, sign, retry with PAYMENT-SIGNATURE (see payment.ts).
 *
 * HTTP METHOD: the endpoint's verb is resolved BEFORE any funds move, either
 * from the catalog listing's own declared method or by probing the endpoint's
 * 402 challenge (see payment.ts's resolveChallenge), then threaded into
 * runPaymentFlow so the paid request uses the verb the endpoint actually
 * routes. A developer-supplied sample JSON body rides along for POST/PUT/
 * PATCH, and is JSON-validated up front so malformed JSON fails free rather
 * than after a real payment has settled.
 *
 * On stellar:pubnet specifically, two extra guards run before Step 2, in
 * order: (a) a hard ceiling refusing any endpoint priced above
 * MAINNET_PRICE_CEILING_USDC, since a misconfigured or malicious endpoint
 * price must never be able to drain more than that from the developer's own
 * funding wallet in one click, and (b) a check that a mainnet funding
 * wallet is actually configured at all, with a clear error pointing at the
 * "Vellar: Configure mainnet test wallet" command if not.
 *
 * THIS IS THE HIGHEST-SECURITY-RISK FILE IN THE SIDEBAR. Every rule below is
 * enforced structurally, not just documented:
 *
 *  - The throwaway Keypair is a local `const` inside runTestPayment() only.
 *    It is never assigned to any field on any object, never returned, never
 *    put in a closure that outlives this function, never passed to anything
 *    other than usdc.ts's functions and payment.ts's runPaymentFlow (both of
 *    which take only the secret string, not the Keypair itself, and neither
 *    of which persists it — see their own file-level comments). When this
 *    function returns (success or throw), nothing anywhere still references
 *    it, and it is eligible for garbage collection like any other local.
 *  - It is never written to vscode.Memento (globalState/workspaceState),
 *    never passed to logAndGenericError or any other output-channel call,
 *    never included in a postMessage payload — grep this file: the only
 *    thing derived from the keypair that ever crosses into `progress.report`
 *    or `webview.postMessage` is the PUBLIC key (via `.publicKey()`) and,
 *    at the very end, the public settlement tx hash.
 *  - The explicit assertion (payer !== developer's payToAddress) runs BEFORE
 *    runPaymentFlow is called, using the keypair's own `.publicKey()` — not
 *    a comment, a real `if` that throws if it's ever somehow wrong.
 *  - No retry of any kind, anywhere, automatically. A failure at any step
 *    ends the flow; the partially-provisioned throwaway keypair (funded but
 *    payment failed, say) is simply never referenced again after this
 *    function returns — there is nothing to "discard" as a separate action,
 *    since nothing outside this function ever held a reference to keep.
 */

import * as vscode from "vscode";
import { Keypair } from "@stellar/stellar-sdk";
import { DataProvider, type EndpointListing } from "../dataProvider";
import { logAndGenericError } from "../outputChannel";
import { fundWithFriendbot } from "./friendbot";
import { buyUsdc, openUsdcTrustline } from "./usdc";
import { runPaymentFlow, discoverPaymentRequirement, PaymentFlowError } from "./payment";
import { getMainnetFundingSecret } from "./mainnetFundingWallet";
import type { HttpMethod } from "../../types";

/**
 * How much USDC to buy, relative to the endpoint's own price.
 *
 * Was 5x, which made sense only on testnet where the XLM being spent is free
 * from a faucet. On mainnet it is real money and 5x is actively harmful: at
 * ~$0.097/XLM a $0.50 endpoint needs ~2.57 XLM of USDC to pay once, but 5x
 * demanded ~12.86 XLM — more than the 3 XLM the throwaway wallet is funded
 * with, so the DEX purchase failed outright and no mainnet test could ever
 * complete. 20% over the exact price is enough to absorb DEX slippage
 * between quoting and trading without stranding meaningful value in a wallet
 * that is discarded seconds later.
 *
 * Applied as integer math on 7-decimal atomic amounts: multiply by 12, then
 * divide by 10. Done in that order so the division truncates at most 1 atomic
 * unit (0.0000001 USDC), rather than losing precision before the multiply.
 */
const FUNDING_NUMERATOR = 12n;
const FUNDING_DENOMINATOR = 10n;
const GENERIC_FAILURE_MESSAGE = "Test payment failed — see the Vellar x402 output channel for details.";

// USDC atomic amounts are 7-decimal (see usdc.ts's own comment on this same
// convention) — $2.00 is 2 * 10^7 atomic units. A hard ceiling on the
// endpoint's OWN declared price, checked before any mainnet funding call,
// so a misconfigured or malicious endpoint price can never cause a single
// test payment to drain more than this from the developer's own funding
// wallet, regardless of what the funding buffer would otherwise compute to
// for an inflated price.
const MAINNET_PRICE_CEILING_ATOMIC = 20_000_000n;
const MAINNET_PRICE_CEILING_USDC_DISPLAY = "2.00";

/**
 * Either a catalog listing (payTo/amount/asset already known from the
 * facilitator's discovery response, matched against the developer's own
 * configured address to have appeared in My Endpoints at all) or a bare
 * resource URL the developer typed in manually (My Endpoints' empty-state
 * "Test a URL" entry — for an endpoint that hasn't settled its first
 * payment yet, so it isn't catalogued anywhere).
 *
 * SECURITY, for the manual-URL case specifically: a URL typed into the
 * webview is user input, not something the extension host already vouched
 * for the way a catalog listing's resource field is (echoed back exactly as
 * the host sent it). This function never trusts a manually-entered URL's
 * IMPLIED payTo/amount — there is no such thing, nothing about the URL
 * string claims a price or a payee. Both are discovered fresh via
 * discoverPaymentRequirement(), which reads them from the endpoint's own
 * real 402 challenge response, the one place they can genuinely come from
 * regardless of which path led here.
 */
export type TestPaymentTarget = (
  | { kind: "listing"; listing: EndpointListing }
  | { kind: "manualUrl"; url: string }
) & {
  /**
   * The developer's own "Sample request body (JSON)" for a POST/PUT/PATCH
   * endpoint, typed into the sidebar. Webview-originated, so it is narrowed
   * to `typeof === "string"` and length-capped at the message boundary (see
   * webviewProvider's handleMessage) before it ever reaches here, and
   * JSON-validated below before any funds move.
   *
   * Undefined means "none supplied" — the flow then sends `{}` for
   * body-bearing verbs (see payment.ts's buildRequestInit), which many
   * endpoints accept well enough to prove the x402 gate works even when
   * their own validation then rejects the empty payload.
   *
   * SECURITY: this string is NEVER logged. It is not passed to
   * logAndGenericError, never interpolated into a thrown Error's message,
   * and never sent to progress.report — a request body can contain
   * API keys or personal data the developer pasted while testing.
   */
  sampleBody?: string;
};

/**
 * Runs the full flow for one endpoint (either a known catalog listing or a
 * manually-entered URL — see TestPaymentTarget), reporting progress through
 * `progress` (a vscode.Progress from withProgress) and returning the
 * settlement tx hash on success, or `undefined` on any failure (already
 * logged to the output channel and shown to the user via a generic message
 * by the time this returns — callers don't need to show anything further on
 * a failure, only react to success by refreshing).
 */
export async function runTestPayment(
  target: TestPaymentTarget,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
  secrets: vscode.SecretStorage,
): Promise<string | undefined> {
  const resource = target.kind === "listing" ? target.listing.resource : target.url;
  try {
    // Read live, same rule as every other setting read in this flow — never
    // cached, so a mid-session network switch takes effect on the next run.
    const network = DataProvider.getConfiguredNetwork();

    const sampleBody = target.sampleBody;

    // Fail free and loud on malformed JSON, BEFORE any funds move. The spec
    // sends the body verbatim, and this does not change that — JSON.parse
    // here is validation only, its result discarded; payment.ts still
    // transmits exactly the string the developer typed. Without this, a
    // stray trailing comma costs a real mainnet payment (up to the ceiling,
    // plus the XLM funding and DEX fees) and returns an endpoint-side
    // validation error indistinguishable from "the x402 gate is broken".
    // The parse error's own text is safe to surface (it describes the
    // developer's own syntax, e.g. position/token) — the BODY itself is
    // never included.
    if (sampleBody !== undefined && sampleBody.trim() !== "") {
      try {
        JSON.parse(sampleBody);
      } catch (err) {
        throw new Error(
          `The sample request body isn't valid JSON (${err instanceof Error ? err.message : String(err)}). Fix it before running a test payment — nothing has been spent.`,
        );
      }
    }

    let payTo: string;
    let amount: string;
    // The verb the paid request must use. Resolved before any funds move, by
    // whichever source can answer soonest, and threaded into runPaymentFlow
    // so the cascade is never run (or paid for) twice.
    let method: HttpMethod | undefined;

    if (target.kind === "listing") {
      if (!target.listing.payTo || !target.listing.amount) {
        throw new Error(`Endpoint has no usable payment requirement to test against: ${resource}`);
      }
      payTo = target.listing.payTo;
      amount = target.listing.amount;
      method = target.listing.method;

      if (method === undefined) {
        // A catalogued endpoint whose seller never declared a method. The
        // card displays (and is gated as) GET, but GET may well be wrong —
        // the motivating real case was a POST-only route. Resolve it now,
        // from the endpoint's own 402, BEFORE the funding guards below:
        // read-only, moves nothing, and makes the "the cascade will find the
        // right method anyway" fallback actually true for this path rather
        // than only for manual URLs. Costs zero extra requests whenever the
        // catalog did declare a method, since this branch is skipped.
        progress.report({ message: "Checking the endpoint's request method…", increment: 0 });
        const discovered = await discoverPaymentRequirement(resource, network, sampleBody);
        method = discovered.method;
      }
    } else {
      // Manual URL: no catalog entry exists yet, so payTo/amount/method are
      // discovered live from the endpoint's own 402 challenge — never
      // assumed, never taken from anything the webview sent alongside the
      // URL (it sent only the URL and an optional sample body, neither of
      // which claims a price or a payee).
      //
      // The probes move no funds — no payment header is attached to any of
      // them — but they are NOT merely read-only: a POST probe is a real
      // write request to a host the developer typed by hand. See
      // payment.ts's BLIND_PROBE_METHODS for why the blind cascade stops at
      // GET and POST rather than trying every verb.
      progress.report({ message: "Checking the endpoint's payment requirement…", increment: 0 });
      const discovered = await discoverPaymentRequirement(target.url, network, sampleBody);
      payTo = discovered.payTo;
      amount = discovered.amount;
      method = discovered.method;
    }

    // Two mainnet-only guards, both run BEFORE Step 1 even generates the
    // throwaway keypair (before any funds could possibly move) and in this
    // order deliberately: the price ceiling first (a pure, local check
    // against `amount`, no async call needed), THEN the
    // funding-wallet-configured check (needs an await on SecretStorage) —
    // cheapest/most certain check first. `mainnetFundingSecret` is read
    // here (once) and carried into Step 2 below, rather than re-read there
    // — it never leaves this function's own scope, never logged, never
    // passed to anything other than fundThrowawayFromMainnetWallet's own
    // secret parameter, same discipline this file's header comment already
    // requires of the THROWAWAY keypair's own secret further down.
    let mainnetFundingSecret: string | undefined;
    if (network === "stellar:pubnet") {
      // Hard ceiling on the ENDPOINT's own declared price — checked against
      // the real atomic amount (never a formatted display string), same
      // "never re-derive from a formatted string" rule the funding target
      // below already follows. Refuses BEFORE the funding buffer is ever
      // computed from this amount, so an inflated or malicious price can't
      // multiply into a larger real spend than this ceiling allows in the
      // first place.
      if (BigInt(amount) > MAINNET_PRICE_CEILING_ATOMIC) {
        throw new Error(
          `This endpoint's price exceeds the $${MAINNET_PRICE_CEILING_USDC_DISPLAY} mainnet test-payment ceiling — refusing to fund a throwaway wallet for it.`,
        );
      }

      mainnetFundingSecret = await getMainnetFundingSecret(secrets);
      if (mainnetFundingSecret === undefined) {
        throw new Error(
          'No mainnet funding wallet is configured — run "Vellar: Configure mainnet test wallet" first, then fund that address with a small amount of real XLM.',
        );
      }
    }

    // MAINNET SHORT PATH: pay directly from the developer's own funding
    // wallet, and skip the throwaway wallet entirely.
    //
    // The throwaway wallet exists for TESTNET, where friendbot hands out free
    // XLM and a disposable identity costs nothing. On mainnet it cost a great
    // deal for no benefit: creating it required a 1.0 XLM base reserve plus
    // 0.5 XLM for its USDC trustline — both LOCKED by protocol and stranded
    // forever when the keypair is discarded seconds later — on top of an
    // account creation, a trustline submission, and a USDC transfer, every
    // one of which was a step that could (and repeatedly did) fail.
    //
    // The funding wallet already satisfies every one of those preconditions:
    // it exists, it has a USDC trustline, and it holds the USDC. Paying from
    // it directly reduces the whole mainnet flow to a single signature and
    // strands nothing.
    //
    // The payer/payee assertions below still apply and are checked the same
    // way — they are about "never pay yourself", which is exactly as
    // meaningful for the funding wallet as for a throwaway one.
    const payFromFundingWallet = network === "stellar:pubnet";

    // Derive the payer's identity FIRST, and assert on it BEFORE any network
    // call that could spend anything. On testnet that means generating the
    // keypair but NOT yet funding it; provisioning happens further down,
    // after both assertions have passed. Getting this order wrong would
    // friendbot a wallet before establishing it is safe to use — caught by
    // scripts/run-testpayment-assertion-check.js, which asserts
    // fundWithFriendbot is never reached when an assertion fires.
    let payerSecret: string;
    let payerPublicKey: string;
    let throwawayKeypair: Keypair | undefined;
    if (payFromFundingWallet) {
      payerSecret = mainnetFundingSecret as string;
      payerPublicKey = Keypair.fromSecret(payerSecret).publicKey();
    } else {
      progress.report({ message: "Generating a throwaway test wallet…", increment: 0 });
      throwawayKeypair = Keypair.random();
      payerPublicKey = throwawayKeypair.publicKey();
      payerSecret = throwawayKeypair.secret();
    }

    // The non-negotiable assertion, run BEFORE any network call that could
    // spend anything: the payer must never be the developer's own configured
    // payout address. Reads the LIVE setting, same rule every other
    // payToAddress read in this codebase follows (never cached) — static
    // analysis of "this constant differs from that constant" would prove
    // nothing if either read a stale value.
    //
    // This matters MORE now, not less, than when the payer was always a
    // throwaway: on mainnet the payer is the developer's real funding
    // wallet, so "am I about to pay myself" is a live question rather than a
    // cryptographic impossibility.
    const developerPayToAddress = DataProvider.getConfiguredAddress();
    if (developerPayToAddress !== undefined && payerPublicKey === developerPayToAddress) {
      throw new Error("Assertion failed: the paying wallet must never equal the developer's own payTo address.");
    }
    // Second, distinct check: `payTo` here is the ENDPOINT's own receiving
    // address (from the catalog, or freshly discovered from its 402 for a
    // manual URL) — not necessarily the same value as developerPayToAddress
    // if the developer is testing an endpoint they don't own. The payer must
    // never equal the payee it's about to pay, whoever that is.
    if (payerPublicKey === payTo) {
      throw new Error("Assertion failed: the paying wallet must never equal the endpoint's own payTo address.");
    }

    if (token.isCancellationRequested) return undefined;

    // Testnet only: NOW provision the throwaway wallet, once the assertions
    // above have cleared it. Mainnet needs none of this — its funding wallet
    // is already funded, already has a trustline, and already holds USDC.
    if (throwawayKeypair !== undefined) {
      progress.report({ message: "Funding the test wallet via friendbot…", increment: 15 });
      await fundWithFriendbot(payerPublicKey);
      if (token.isCancellationRequested) return undefined;

      progress.report({ message: "Opening a USDC trustline…", increment: 15 });
      const trustline = await openUsdcTrustline(throwawayKeypair, network);
      if (!trustline.ok) throw new Error(`USDC trustline failed: ${trustline.reason}`);
      if (token.isCancellationRequested) return undefined;

      progress.report({ message: "Buying USDC on the DEX…", increment: 15 });
      const targetAtomic = ((BigInt(amount) * FUNDING_NUMERATOR) / FUNDING_DENOMINATOR).toString();
      const purchase = await buyUsdc(throwawayKeypair, targetAtomic, network);
      if (!purchase.ok) throw new Error(`USDC purchase failed: ${purchase.reason}`);
      if (token.isCancellationRequested) return undefined;
    }

    const throwawaySecret = payerSecret;

    // Steps 4-6: the real x402 payment flow.
    progress.report({ message: "Requesting the endpoint (expecting 402)…", increment: 15 });
    const result = await runPaymentFlow(
      throwawaySecret,
      resource,
      network,
      (event) => {
        if (event.step === "sign") {
          progress.report({ message: "Signing the payment…", increment: 15 });
        } else if (event.step === "settle") {
          progress.report({ message: "Submitting payment to the endpoint…", increment: 15 });
        }
      },
      sampleBody,
      // Always defined by this point — both branches above resolve it — so
      // runPaymentFlow's own cascade never re-runs. Passing it is what makes
      // the paid request use the verb the endpoint actually routes.
      method,
    );

    progress.report({ message: "Payment settled.", increment: 25 });
    return result.settlementTx;
  } catch (err) {
    // The ONE place a raw error from this whole flow is allowed to surface —
    // to the output channel only, via the same logAndGenericError every
    // other section of this sidebar uses. A PaymentFlowError's .message is
    // already a safe, non-raw-SDK string (see payment.ts); logAndGenericError
    // still routes it the same way as any other error for one consistent
    // "raw detail goes to the channel, generic message goes to the user" rule.
    logAndGenericError(
      `test payment failed for ${resource}${err instanceof PaymentFlowError ? ` (${err.code})` : ""}`,
      err,
    );
    void vscode.window.showErrorMessage(GENERIC_FAILURE_MESSAGE);
    return undefined;
  }
}
