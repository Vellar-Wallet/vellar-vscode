/**
 * The x402 payment flow itself — Steps 4-6 of the test-payment feature
 * (build the client, request the resource expecting 402, sign, retry with
 * PAYMENT-SIGNATURE).
 *
 * HTTP METHOD SUPPORT: every request here goes through buildRequestInit, so
 * GET, POST, PUT, PATCH and DELETE are all payable. The method is resolved by
 * resolveChallenge: a caller-supplied `knownMethod` (from the discovery
 * catalog, or from an earlier cascade) short-circuits it; otherwise the
 * BLIND_PROBE_METHODS cascade tries GET then POST and the first 402 wins.
 * Either way, a method DECLARED by the challenge's own
 * `extensions.bazaar.info.input.method` overrides the probe that found it.
 * That declared path is the only way PUT/PATCH/DELETE are ever issued —
 * see BLIND_PROBE_METHODS' own comment for why they are never guessed.
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
import { BODY_METHODS, readBazaarMethod, type HttpMethod, type StellarNetwork } from "../../types";

const RPC_URL_BY_NETWORK: Record<StellarNetwork, string> = {
  "stellar:testnet": "https://soroban-testnet.stellar.org",
  "stellar:pubnet": "https://mainnet.sorobanrpc.com",
};
const GET_TIMEOUT_MS = 30_000;

/**
 * The verbs the cascade will BLIND-PROBE against a URL whose method nobody
 * has declared — deliberately only GET and POST.
 *
 * PUT, PATCH and DELETE are supported by this flow (see resolveMethod and
 * buildRequestInit, which handle all five), but are never *guessed*: they run
 * only when the discovery catalog or the 402 challenge itself DECLARES them.
 * The reason is that a manually-typed "Test a URL" is format-checked only
 * (see webviewProvider's looksLikeTestableResourceUrl) — so a probe is a real,
 * unauthenticated, body-bearing request to a host the developer typed by
 * hand, sent BEFORE any payment header exists. If that URL isn't actually an
 * x402 endpoint (a typo, a wrong path, an internal admin route), a non-x402
 * server may genuinely act on a write. GET and POST cover the real-world x402
 * shapes, including the POST-only endpoint that motivated this feature;
 * blind-firing a DELETE at a mistyped URL is not a tradeoff worth making for
 * the remaining coverage.
 */
const BLIND_PROBE_METHODS: readonly HttpMethod[] = ["GET", "POST"];

/**
 * Per-probe timeout for probes AFTER the first. The first probe keeps the
 * full GET_TIMEOUT_MS: a cold Render/serverless host can genuinely take tens
 * of seconds on its first hit (measured on the real endpoint that motivated
 * this change — no response inside 60s cold, then 404 in ~1.2s once warm), and
 * aborting that first probe early would regress exactly the case this feature
 * exists to fix. By the time probe 2 runs the host is demonstrably warm, so a
 * tighter bound there keeps the worst-case cascade short without costing
 * correctness.
 */
const WARM_PROBE_TIMEOUT_MS = 8_000;

function hasBody(method: HttpMethod): boolean {
  return (BODY_METHODS as readonly string[]).includes(method);
}

/**
 * The ONE place a request's method, body, Content-Type and timeout are
 * decided — used by all three HTTP calls in this file (the cascade probe, the
 * registered-client challenge fetch, and the paid retry) so the
 * "GET/DELETE send no body, POST/PUT/PATCH send JSON" rule exists once.
 *
 * `extraHeaders` is where encodePaymentSignatureHeader's own
 * Record<string, string> merges in for the paid request. It is spread LAST so
 * the payment header can never be clobbered by the Content-Type this adds —
 * the payment header is the entire point of that request.
 *
 * `sampleBody` is the developer's own typed JSON (already validated as
 * parseable by runTestPayment.ts before any funds move — see its own guard).
 * It is sent VERBATIM, never re-serialized through JSON.parse/stringify: what
 * the developer typed is what their endpoint receives.
 */
function buildRequestInit(
  method: HttpMethod,
  sampleBody: string | undefined,
  timeoutMs: number,
  extraHeaders?: Record<string, string>,
): RequestInit {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (hasBody(method)) {
    const trimmed = sampleBody?.trim();
    // "{}" rather than no body at all: many JSON endpoints 400 on an absent
    // body inside their own parser, BEFORE the x402 middleware ever runs —
    // which would look exactly like "no payment gate here" to the cascade.
    body = trimmed !== undefined && trimmed !== "" ? sampleBody : "{}";
    headers["Content-Type"] = "application/json";
  }
  return { method, body, headers: { ...headers, ...extraHeaders }, signal: AbortSignal.timeout(timeoutMs) };
}

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
  /**
   * The method the PAID request must use — the challenge's own declared
   * `extensions.bazaar.info.input.method` when present (spec step 2), else
   * whichever probe actually won the 402 (spec step 1). Callers thread this
   * into runPaymentFlow so the cascade is never paid for twice.
   */
  method: HttpMethod;
}

/**
 * One probe: issue `method` at `resourceUrl` and report whether it answered
 * with a 402. Never throws for a non-402 — a 404/400/500 is a perfectly
 * normal "not this verb" answer during a cascade, not an error. A genuine
 * transport failure (DNS, TLS, timeout) resolves to `ok: false` with the
 * reason kept, so the cascade can surface the FIRST transport error if every
 * verb fails for that reason rather than a misleading "no gate found".
 */
async function probeForChallenge(
  resourceUrl: string,
  method: HttpMethod,
  sampleBody: string | undefined,
  timeoutMs: number,
): Promise<{ ok: true; response: Response } | { ok: false; status?: number; transportError?: string }> {
  let response: Response;
  try {
    response = await fetch(resourceUrl, buildRequestInit(method, sampleBody, timeoutMs));
  } catch (err) {
    return { ok: false, transportError: err instanceof Error ? err.message : String(err) };
  }
  if (response.status !== 402) return { ok: false, status: response.status };
  return { ok: true, response };
}

/**
 * Spec step 1 + 2, shared by both public functions below so the cascade,
 * the declared-method override, and the error wording exist exactly once.
 *
 * `knownMethod` short-circuits the cascade entirely when the caller already
 * knows the verb (a catalogued listing's declared method, or a method a
 * previous cascade already resolved) — that is the ONLY way PUT/PATCH/DELETE
 * are ever issued, since BLIND_PROBE_METHODS deliberately excludes them.
 */
async function resolveChallenge(
  http: x402HTTPClient,
  resourceUrl: string,
  sampleBody: string | undefined,
  knownMethod: HttpMethod | undefined,
): Promise<{ required: ReturnType<x402HTTPClient["getPaymentRequiredResponse"]>; method: HttpMethod }> {
  const order: readonly HttpMethod[] = knownMethod ? [knownMethod] : BLIND_PROBE_METHODS;

  let firstTransportError: string | undefined;
  const attempted: string[] = [];

  for (const [index, method] of order.entries()) {
    const timeoutMs = index === 0 ? GET_TIMEOUT_MS : WARM_PROBE_TIMEOUT_MS;
    const probe = await probeForChallenge(resourceUrl, method, sampleBody, timeoutMs);
    if (!probe.ok) {
      attempted.push(probe.transportError ? `${method} (unreachable)` : `${method} → ${probe.status}`);
      if (probe.transportError && firstTransportError === undefined) firstTransportError = probe.transportError;
      continue;
    }

    const required = http.getPaymentRequiredResponse((name) => probe.response.headers.get(name), undefined);
    // Spec step 2: the challenge's OWN declared method wins over whichever
    // verb happened to elicit it. `extensions` is read off the TOP level of
    // the decoded challenge — PaymentRequirements entries carry `extra`, not
    // `extensions`, so there is no per-accept method to consult.
    const declared = readBazaarMethod(required.extensions);
    return { required, method: declared ?? method };
  }

  if (firstTransportError !== undefined) {
    throw new PaymentFlowError("no_challenge", `Could not reach the endpoint: ${firstTransportError}`);
  }
  throw new PaymentFlowError(
    "no_challenge",
    `No x402 payment gate found on this endpoint (tried ${attempted.join(", ")}).`,
  );
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
export async function discoverPaymentRequirement(
  resourceUrl: string,
  network: StellarNetwork,
  sampleBody?: string,
  knownMethod?: HttpMethod,
): Promise<DiscoveredPaymentRequirement> {
  const http = new x402HTTPClient(new x402Client());

  const { required, method } = await resolveChallenge(http, resourceUrl, sampleBody, knownMethod);

  const req = required.accepts?.find((a) => a.network === network && a.scheme === "exact");
  if (!req) {
    throw new PaymentFlowError("no_requirement", `The endpoint has no ${network} "exact" payment option.`);
  }
  return { payTo: req.payTo, amount: req.amount, asset: req.asset, method };
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
  network: StellarNetwork,
  onStep: (event: PaymentFlowStep) => void,
  sampleBody?: string,
  knownMethod?: HttpMethod,
): Promise<PaymentFlowResult> {
  const signer = createEd25519Signer(throwawaySecret, network);
  const client = new x402Client().register(network, new ExactStellarScheme(signer, { url: RPC_URL_BY_NETWORK[network] }));
  const http = new x402HTTPClient(client);

  // Step 5: request the resource, expect 402 with payment requirements. Not
  // reused from discoverPaymentRequirement above — that one deliberately
  // uses an unregistered client (discovery doesn't need a signer), this one
  // needs the REGISTERED client's own decode so createPaymentPayload below
  // gets a `required` object built by the same client instance it signs
  // with. A second request here is one extra round trip, not a correctness
  // risk — the 402 challenge is idempotent to re-fetch.
  //
  // `knownMethod` is normally supplied by runTestPayment.ts (already resolved
  // by an earlier discoverPaymentRequirement call), which collapses this to a
  // single-verb call rather than re-running the whole blind cascade — the
  // cascade is never paid for twice. When it's absent this falls back to the
  // same cascade, so this function remains correct called standalone.
  const { required, method } = await resolveChallenge(http, resourceUrl, sampleBody, knownMethod);

  const req = required.accepts?.find((a) => a.network === network && a.scheme === "exact");
  if (!req) {
    throw new PaymentFlowError("no_requirement", `The endpoint has no ${network} "exact" payment option.`);
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
  //
  // Uses the RESOLVED method (and the developer's sample body, for the
  // body-bearing verbs) — the same verb the challenge was obtained with, or
  // the one the challenge itself declared. Sending the payment header on a
  // GET when the endpoint only routes POST is exactly the failure this whole
  // feature exists to fix. The payment header merges in via extraHeaders and
  // is spread last inside buildRequestInit, so Content-Type can never
  // displace it.
  let paid: Response;
  try {
    paid = await fetch(
      resourceUrl,
      buildRequestInit(method, sampleBody, GET_TIMEOUT_MS, http.encodePaymentSignatureHeader(payload)),
    );
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
