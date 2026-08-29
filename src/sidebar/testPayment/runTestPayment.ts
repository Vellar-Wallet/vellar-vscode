/**
 * Orchestrates the full 6-step throwaway test payment:
 *   1. Generate keypair (in memory only)
 *   2. Fund via friendbot
 *   3. Acquire USDC via testnet DEX (trustline + DEX purchase)
 *   4-6. Build the x402 client, GET expecting 402, sign, retry with
 *        PAYMENT-SIGNATURE (see payment.ts)
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

const FUNDING_MULTIPLE = 5n;
const GENERIC_FAILURE_MESSAGE = "Test payment failed — see the Vellar x402 output channel for details.";

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
export type TestPaymentTarget = { kind: "listing"; listing: EndpointListing } | { kind: "manualUrl"; url: string };

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
): Promise<string | undefined> {
  const resource = target.kind === "listing" ? target.listing.resource : target.url;
  try {
    let payTo: string;
    let amount: string;

    if (target.kind === "listing") {
      if (!target.listing.payTo || !target.listing.amount) {
        throw new Error(`Endpoint has no usable payment requirement to test against: ${resource}`);
      }
      payTo = target.listing.payTo;
      amount = target.listing.amount;
    } else {
      // Manual URL: no catalog entry exists yet, so payTo/amount are
      // discovered live from the endpoint's own 402 challenge — never
      // assumed, never taken from anything the webview sent alongside the
      // URL (it sent nothing alongside it; the URL is the only input).
      progress.report({ message: "Checking the endpoint's payment requirement…", increment: 0 });
      const discovered = await discoverPaymentRequirement(target.url);
      payTo = discovered.payTo;
      amount = discovered.amount;
    }

    // Step 1: generate the throwaway keypair. Nothing above this line has
    // touched key material at all; nothing below this function's `return`/
    // `catch` will let it escape.
    progress.report({ message: "Generating a throwaway test wallet…", increment: 0 });
    const keypair = Keypair.random();
    const throwawayPublicKey = keypair.publicKey();
    const throwawaySecret = keypair.secret();

    // The non-negotiable assertion, run BEFORE any network call that could
    // spend anything: the throwaway wallet must never be the developer's own
    // configured payout address. Reads the LIVE setting, same rule every
    // other payToAddress read in this codebase follows (never cached) —
    // static analysis of "this constant differs from that constant" would
    // prove nothing if either read a stale value.
    const developerPayToAddress = DataProvider.getConfiguredAddress();
    if (developerPayToAddress !== undefined && throwawayPublicKey === developerPayToAddress) {
      // Cryptographically this branch should be unreachable (Keypair.random()
      // colliding with a specific existing address has probability ~0), but
      // the instruction is explicit: assert it in code, not just a comment.
      // If this ever somehow fired, the safe behavior is to abort loudly
      // before any funds move, not to proceed.
      throw new Error("Assertion failed: throwaway test wallet must never equal the developer's own payTo address.");
    }
    // Second, distinct check, meaningful specifically for the manual-URL
    // case: `payTo` here is the ENDPOINT's own receiving address (from the
    // catalog, or freshly discovered from its 402 for a manual URL) — not
    // necessarily the same value as developerPayToAddress if the developer
    // is testing an endpoint they don't own. The throwaway wallet must never
    // equal the payee it's about to pay, regardless of whose address that is.
    if (throwawayPublicKey === payTo) {
      throw new Error("Assertion failed: throwaway test wallet must never equal the endpoint's own payTo address.");
    }

    if (token.isCancellationRequested) return undefined;

    // Step 2: fund via friendbot.
    progress.report({ message: "Funding the test wallet via friendbot…", increment: 15 });
    await fundWithFriendbot(throwawayPublicKey);
    if (token.isCancellationRequested) return undefined;

    // Step 3: acquire USDC — trustline, then DEX purchase. Target = 5x the
    // endpoint's own price, per the instruction, computed from the REAL
    // atomic amount (from the catalog listing, or freshly discovered above
    // for a manual URL — never re-derived from a formatted display string
    // either way).
    progress.report({ message: "Opening a USDC trustline…", increment: 15 });
    const trustline = await openUsdcTrustline(keypair);
    if (!trustline.ok) throw new Error(`USDC trustline failed: ${trustline.reason}`);
    if (token.isCancellationRequested) return undefined;

    progress.report({ message: "Buying testnet USDC on the DEX…", increment: 15 });
    const targetAtomic = (BigInt(amount) * FUNDING_MULTIPLE).toString();
    const purchase = await buyUsdc(keypair, targetAtomic);
    if (!purchase.ok) throw new Error(`USDC purchase failed: ${purchase.reason}`);
    if (token.isCancellationRequested) return undefined;

    // Steps 4-6: the real x402 payment flow.
    progress.report({ message: "Requesting the endpoint (expecting 402)…", increment: 15 });
    const result = await runPaymentFlow(throwawaySecret, resource, (event) => {
      if (event.step === "sign") {
        progress.report({ message: "Signing the payment…", increment: 15 });
      } else if (event.step === "settle") {
        progress.report({ message: "Submitting payment to the endpoint…", increment: 15 });
      }
    });

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
