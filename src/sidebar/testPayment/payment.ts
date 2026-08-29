/**
 * The x402 payment flow itself — Steps 4-6 of the test-payment feature
 * (build the client, GET expecting 402, sign, retry with PAYMENT-SIGNATURE).
 *
 * Ported from vellar-facilitator/examples/buyer-classic.mjs and
 * vellar-playground/lib/pay.ts's attemptPayment(), per that file's own header
 * comment: "this is deliberately built on the OFFICIAL x402 client rather
 * than hand-rolled... Copy this file, not the mechanics underneath it." The
 * three official-client calls (getPaymentRequiredResponse,
 * createPaymentPayload, encodePaymentSignatureHeader) are UNCHANGED from
 * those two files — this module only adapts the surrounding shape (typed
 * step callback instead of NDJSON events, no catalog-driven funding target
 * since the caller already knows the exact endpoint price) to the extension
 * host.
 *
 * SECURITY: `throwawaySecret` is passed to createEd25519Signer and NOWHERE
 * else in this file — it is never interpolated into a string, never passed
 * to onStep, never included in a thrown Error's message. See
 * runTestPayment.ts for the explicit assertion (payer !== developer's
 * payToAddress) that runs before this function is ever called.
 */

import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer } from "@x402/stellar";
import { withTimeout, SOROBAN_RPC_TIMEOUT_MS } from "./usdc";

const NETWORK = "stellar:testnet";
const RPC_URL = "https://soroban-testnet.stellar.org";
const GET_TIMEOUT_MS = 30_000;

export class PaymentFlowError extends Error {
  /** Machine-readable category — same four values as vellar-playground's
   *  PaymentError, since this is testing the same protocol against the same
   *  kind of failure surface (no challenge, no matching requirement, signing
   *  failed, didn't settle). */
  code: "no_challenge" | "no_requirement" | "build_failed" | "not_settled";
  constructor(code: PaymentFlowError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "PaymentFlowError";
  }
}

export interface PaymentFlowResult {
  settlementTx: string;
  payer?: string;
}

export interface DiscoveredPaymentRequirement {
  payTo: string;
  amount: string;
  asset: string;
}

/**
 * GET `resourceUrl` and decode its real x402 payment requirement from the
 * 402 response — no scheme registration, no client-side signing capability
 * needed for this half (confirmed empirically: x402HTTPClient.
 * getPaymentRequiredResponse works against a real live 402 with ZERO
 * registered schemes; decoding the challenge is scheme-agnostic, only
 * BUILDING a payment needs ExactStellarScheme). Used two ways:
 *  - Implicitly, as the first half of runPaymentFlow below, for a catalog
 *    listing that already has its own payTo/amount from the discovery
 *    catalog (this call's result isn't even needed there beyond the 402
 *    itself resolving).
 *  - Explicitly, by runTestPayment.ts, for a manually-entered URL that has
 *    no catalog listing yet — there is no other trustworthy source for
 *    payTo/amount in that case, so this IS the discovery of them, read
 *    directly from the endpoint's own real 402 challenge, never from
 *    anything the webview claims.
 */
export async function discoverPaymentRequirement(resourceUrl: string): Promise<DiscoveredPaymentRequirement> {
  const http = new x402HTTPClient(new x402Client());

  let unpaid: Response;
  try {
    unpaid = await fetch(resourceUrl, { signal: AbortSignal.timeout(GET_TIMEOUT_MS) });
  } catch (err) {
    throw new PaymentFlowError(
      "no_challenge",
      `Could not reach the endpoint: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (unpaid.status !== 402) {
    throw new PaymentFlowError("no_challenge", `Expected a 402 payment challenge, got HTTP ${unpaid.status}.`);
  }

  const required = http.getPaymentRequiredResponse((name) => unpaid.headers.get(name), undefined);
  const req = required.accepts?.find((a) => a.network === NETWORK && a.scheme === "exact");
  if (!req) {
    throw new PaymentFlowError("no_requirement", `The endpoint has no ${NETWORK} "exact" payment option.`);
  }
  return { payTo: req.payTo, amount: req.amount, asset: req.asset };
}

/**
 * Runs GET → 402 → createPaymentPayload → retry-with-header exactly once.
 * Never retries internally — buyer-classic.mjs's own comment documents why:
 * the payment payload's signature expires based on LEDGERS, not wall-clock,
 * so a stale payload can never be safely reused; a caller that wants to
 * retry after a failure must call this again from scratch, which naturally
 * produces a fresh payload rather than replaying an expired one.
 *
 * `onStep` is invoked once per real step boundary (see PaymentFlowStep) and
 * NEVER receives `throwawaySecret` or anything derived from it beyond the
 * already-public signed transaction XDR and payer address that are the
 * whole point of a payment payload.
 */
export type PaymentFlowStep =
  | { step: "get_request"; status: "done" }
  | { step: "sign"; status: "done" }
  | { step: "settle"; status: "done"; settlementTx: string; payer?: string };

export async function runPaymentFlow(
  throwawaySecret: string,
  resourceUrl: string,
  onStep: (event: PaymentFlowStep) => void,
): Promise<PaymentFlowResult> {
  const signer = createEd25519Signer(throwawaySecret, NETWORK);
  const client = new x402Client().register(NETWORK, new ExactStellarScheme(signer, { url: RPC_URL }));
  const http = new x402HTTPClient(client);

  // Step 5: GET the resource, expect 402 with payment requirements. Not
  // reused from discoverPaymentRequirement above — that one deliberately
  // uses an unregistered client (discovery doesn't need a signer), this one
  // needs the REGISTERED client's own decode so createPaymentPayload below
  // gets a `required` object built by the same client instance it signs
  // with. A second GET here is one extra request, not a correctness risk —
  // the 402 challenge is idempotent to re-fetch.
  let unpaid: Response;
  try {
    unpaid = await fetch(resourceUrl, { signal: AbortSignal.timeout(GET_TIMEOUT_MS) });
  } catch (err) {
    throw new PaymentFlowError(
      "no_challenge",
      `Could not reach the endpoint: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (unpaid.status !== 402) {
    throw new PaymentFlowError("no_challenge", `Expected a 402 payment challenge, got HTTP ${unpaid.status}.`);
  }

  const required = http.getPaymentRequiredResponse((name) => unpaid.headers.get(name), undefined);
  const req = required.accepts?.find((a) => a.network === NETWORK && a.scheme === "exact");
  if (!req) {
    throw new PaymentFlowError("no_requirement", `The endpoint has no ${NETWORK} "exact" payment option.`);
  }
  onStep({ step: "get_request", status: "done" });

  // Step 6a: build + sign. One call — the scheme assembles the SEP-41
  // transfer and signs the auth entry; see usdc.ts's sibling comment and
  // buyer-classic.mjs's own header for why no separate simulation source is
  // needed (the official client never makes the payer the tx source).
  //
  // REAL BUG, FOUND AND FIXED: this call internally drives a Soroban RPC
  // simulate/sign-auth-entry/re-simulate sequence via @stellar/stellar-sdk's
  // rpc.Server, which has the SAME unbounded HTTP client as usdc.ts's
  // Horizon.Server (confirmed identically — no `timeout` key on its axios
  // defaults) — and neither @x402/stellar nor @x402/core add a timeout of
  // their own around it (confirmed by grepping both packages' compiled
  // source). Without withTimeout here, a stalled RPC connection at this
  // exact step hangs forever, with testPaymentInFlight in webviewProvider.ts
  // stuck true just like the usdc.ts bug did — this is that same bug,
  // recurring one step later in the same flow. See usdc.ts's own comment on
  // SOROBAN_RPC_TIMEOUT_MS for why 30s specifically.
  let payload;
  try {
    payload = await withTimeout(client.createPaymentPayload(required), SOROBAN_RPC_TIMEOUT_MS, "createPaymentPayload");
  } catch (err) {
    throw new PaymentFlowError(
      "build_failed",
      `Could not build the payment (commonly: no trustline, or an empty balance): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  onStep({ step: "sign", status: "done" });

  // Step 6b: retry the SAME resource URL with the payment attached — not the
  // facilitator directly. The seller's own x402 middleware forwards to the
  // facilitator's /verify and /settle internally; this client only ever
  // talks to the resource it's paying for, exactly like buyer-classic.mjs.
  let paid: Response;
  try {
    paid = await fetch(resourceUrl, {
      headers: http.encodePaymentSignatureHeader(payload),
      signal: AbortSignal.timeout(GET_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PaymentFlowError(
      "not_settled",
      `The paid request failed to reach the endpoint: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (paid.status !== 200) {
    const body = (await paid.json().catch(() => ({}))) as { detail?: unknown };
    const detail = body?.detail ? ` (${JSON.stringify(body.detail)})` : "";
    throw new PaymentFlowError("not_settled", `Payment did not settle: HTTP ${paid.status}${detail}`);
  }

  // REAL BUG, FOUND AND FIXED: settlement confirmation is NOT nested inside
  // the JSON response body — it never was, for this seller shape or any
  // other. It's the PAYMENT-RESPONSE header (base64 JSON, same convention as
  // PAYMENT-REQUIRED/PAYMENT-SIGNATURE elsewhere in this file), confirmed by
  // capturing a REAL settled response from a real seller: the body was the
  // seller's own plain application data ({"ok":true,...} for a health-check
  // route) with no "settlement" field anywhere, while the real tx hash sat
  // in the payment-response header the whole time, decodable via
  // x402HTTPClient's own getPaymentSettleResponse — the same official-client
  // method this file already uses the sibling of (getPaymentRequiredResponse)
  // for the 402 challenge. The old body.settlement?.transaction check could
  // never have matched a real response; it silently reported "not_settled"
  // for every payment that actually settled, discovered only by inspecting
  // a live, independently-Horizon-confirmed successful payment.
  let settleResponse: { success?: boolean; payer?: string; transaction?: string; network?: string };
  try {
    settleResponse = http.getPaymentSettleResponse((name) => paid.headers.get(name));
  } catch (err) {
    throw new PaymentFlowError(
      "not_settled",
      `Payment response was HTTP 200 but had no readable settlement header: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const tx = settleResponse.transaction;
  if (!tx) {
    throw new PaymentFlowError("not_settled", "Payment response was HTTP 200 but had no settlement transaction.");
  }

  onStep({ step: "settle", status: "done", settlementTx: tx, payer: settleResponse.payer });
  return { settlementTx: tx, payer: settleResponse.payer };
}
