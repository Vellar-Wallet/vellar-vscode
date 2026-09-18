/**
 * Bundled by run-method-cascade-check.js with "vscode" aliased to
 * vscode-test-stub.js. Exercises payment.ts's REAL discoverPaymentRequirement
 * against a stubbed global fetch.
 *
 * Why a global-fetch stub rather than an esbuild module redirect (the
 * technique every other harness here uses): payment.ts calls the global
 * `fetch`, not an imported module, so there is no specifier to redirect.
 * Swapping globalThis.fetch is the only interception point, and it is a
 * faithful one — payment.ts's own source is completely unmodified and every
 * request it builds (method, headers, body) is captured exactly as it would
 * hit the wire.
 *
 * The stub also encodes a real x402 402 response: the challenge lives in a
 * base64 `payment-required` header, which is the actual wire format
 * (confirmed against a live endpoint), so x402HTTPClient's own real decoder
 * runs rather than being faked.
 */
import { discoverPaymentRequirement, PaymentFlowError } from "../src/sidebar/testPayment/payment";
import type { HttpMethod } from "../src/types";

const NETWORK = "stellar:pubnet";
const PAY_TO = "GD6TC7QY35TZ5VHPMGCPQUDHRBLXZEI3HCBLHTBBAY2RX3L6PBWI5C2O";
const ASSET = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const AMOUNT = "1000000";

interface CapturedRequest {
  method: string;
  body: string | undefined;
  contentType: string | undefined;
  paymentHeader: string | undefined;
}

let captured: CapturedRequest[] = [];

/**
 * Builds a real x402 402 response, matching the live wire format: the
 * challenge is base64 JSON in a `payment-required` header, NOT in the body.
 * `declaredMethod`, when given, becomes extensions.bazaar.info.input.method —
 * the spec's step-2 override.
 */
function make402(declaredMethod?: string): Response {
  const challenge: Record<string, unknown> = {
    x402Version: 2,
    error: "Payment required",
    resource: { url: "https://example.test/route" },
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        amount: AMOUNT,
        asset: ASSET,
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: {},
      },
    ],
  };
  if (declaredMethod !== undefined) {
    challenge.extensions = { bazaar: { info: { input: { type: "http", method: declaredMethod } } } };
  }
  const encoded = Buffer.from(JSON.stringify(challenge)).toString("base64");
  return new Response("{}", { status: 402, headers: { "payment-required": encoded } });
}

/**
 * Installs a global fetch that answers per-method. `answers` maps an HTTP
 * method to the status (or a full Response) it should return. Any method not
 * listed answers 404 — modelling a route that simply is not registered for
 * that verb, which is exactly what the real motivating endpoint does on GET.
 */
function installFetch(answers: Record<string, number | Response>): void {
  captured = [];
  (globalThis as { fetch: unknown }).fetch = (url: unknown, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    captured.push({
      method,
      body: typeof init?.body === "string" ? init.body : undefined,
      contentType: headers["Content-Type"],
      // The real payment header name the x402 client emits; captured so a
      // test can assert probes never carry one.
      paymentHeader: headers["PAYMENT-SIGNATURE"] ?? headers["payment-signature"],
    });
    const answer = answers[method];
    if (answer === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
    if (typeof answer === "number") return Promise.resolve(new Response("{}", { status: answer }));
    return Promise.resolve(answer);
  };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok: ${message}`);
}

/** The motivating real case: GET 404s, POST answers 402. */
async function testCascadeFindsPostWhenGetIs404(): Promise<void> {
  installFetch({ POST: make402() });

  const result = await discoverPaymentRequirement("https://example.test/route", NETWORK);

  assert(result.method === "POST", `resolved method is POST, got ${result.method}`);
  assert(result.payTo === PAY_TO, "payTo comes from the challenge");
  assert(result.amount === AMOUNT, "amount comes from the challenge");
  assert(captured.length === 2, `exactly two probes were made (GET then POST), got ${captured.length}`);
  assert(captured[0].method === "GET", "the first probe is GET");
  assert(captured[1].method === "POST", "the second probe is POST");
  assert(captured[0].body === undefined, "the GET probe sends no body");
  assert(captured[1].body === "{}", `the POST probe sends {} when no sample body is supplied, got ${captured[1].body}`);
  assert(captured[1].contentType === "application/json", "the POST probe sets Content-Type: application/json");
  assert(
    captured.every((c) => c.paymentHeader === undefined),
    "no probe ever carries a payment header",
  );
}

/** GET answering 402 must stop the cascade immediately — no stray POST. */
async function testCascadeStopsAtGet(): Promise<void> {
  installFetch({ GET: make402(), POST: make402() });

  const result = await discoverPaymentRequirement("https://example.test/route", NETWORK);

  assert(result.method === "GET", `resolved method is GET, got ${result.method}`);
  assert(captured.length === 1, `only ONE probe was made, got ${captured.length}`);
  assert(captured[0].method === "GET", "that single probe is GET");
}

/** Spec step 2: a method DECLARED by the challenge overrides the probe. */
async function testDeclaredMethodOverridesProbe(): Promise<void> {
  // GET wins the probe, but the challenge itself declares PUT.
  installFetch({ GET: make402("PUT") });

  const result = await discoverPaymentRequirement("https://example.test/route", NETWORK);

  assert(result.method === "PUT", `the challenge's declared PUT overrides the winning GET probe, got ${result.method}`);
}

/** A declared method outside the five known verbs must NOT reach fetch. */
async function testGarbageDeclaredMethodFallsBackToProbe(): Promise<void> {
  installFetch({ GET: make402("TRACE") });

  const result = await discoverPaymentRequirement("https://example.test/route", NETWORK);

  assert(
    result.method === "GET",
    `an unrecognized declared method ("TRACE") is ignored and the winning probe stands, got ${result.method}`,
  );
}

/** A declared lowercase method is normalized, not rejected. */
async function testLowercaseDeclaredMethodIsNormalized(): Promise<void> {
  installFetch({ GET: make402("post") });

  const result = await discoverPaymentRequirement("https://example.test/route", NETWORK);

  assert(result.method === "POST", `lowercase "post" normalizes to POST, got ${result.method}`);
}

/** knownMethod short-circuits the cascade — the ONLY way PUT/PATCH/DELETE
 *  are ever issued, since they are never blind-probed. */
async function testKnownMethodSkipsCascade(): Promise<void> {
  installFetch({ DELETE: make402() });

  const result = await discoverPaymentRequirement(
    "https://example.test/route",
    NETWORK,
    undefined,
    "DELETE" as HttpMethod,
  );

  assert(result.method === "DELETE", `a known DELETE is used directly, got ${result.method}`);
  assert(captured.length === 1, `only the known verb is tried, got ${captured.length} probes`);
  assert(captured[0].method === "DELETE", "the single request is DELETE");
  assert(captured[0].body === undefined, "DELETE sends no body");
}

/** Destructive verbs are NEVER blind-probed. */
async function testDestructiveVerbsAreNeverBlindProbed(): Promise<void> {
  // Only DELETE would answer 402 — but nothing declared it, so the cascade
  // must never reach it and must fail instead.
  installFetch({ DELETE: make402() });

  let threw: unknown;
  try {
    await discoverPaymentRequirement("https://example.test/route", NETWORK);
  } catch (err) {
    threw = err;
  }

  assert(threw instanceof PaymentFlowError, "a cascade that finds no gate throws PaymentFlowError");
  assert(
    captured.every((c) => c.method === "GET" || c.method === "POST"),
    `only GET and POST were ever sent, got ${captured.map((c) => c.method).join(", ")}`,
  );
  assert(
    !captured.some((c) => c.method === "DELETE" || c.method === "PUT" || c.method === "PATCH"),
    "no destructive/undeclared verb was blind-probed",
  );
}

/** No verb answering 402 => the clear, spec-mandated error. */
async function testNoGateFoundError(): Promise<void> {
  installFetch({});

  let message = "";
  let code = "";
  try {
    await discoverPaymentRequirement("https://example.test/route", NETWORK);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
    code = err instanceof PaymentFlowError ? err.code : "";
  }

  assert(code === "no_challenge", `the error code is no_challenge, got "${code}"`);
  assert(
    message.includes("No x402 payment gate found on this endpoint"),
    `the message states no gate was found, got "${message}"`,
  );
}

/** A supplied sample body is sent VERBATIM, not re-serialized. */
async function testSampleBodyIsSentVerbatim(): Promise<void> {
  installFetch({ POST: make402() });
  // Deliberately odd-but-valid formatting: whitespace and key order must
  // survive exactly, proving no JSON.parse/stringify round trip happened.
  const body = '{\n  "topic":   "perseverance",\n  "z": 1,\n  "a": 2\n}';

  await discoverPaymentRequirement("https://example.test/route", NETWORK, body);

  const post = captured.find((c) => c.method === "POST");
  assert(post !== undefined, "a POST probe was made");
  assert(post?.body === body, "the supplied sample body is transmitted byte-for-byte unchanged");
}

/** A transport failure must not be reported as "no gate found". */
async function testTransportErrorIsDistinctFromNoGate(): Promise<void> {
  captured = [];
  (globalThis as { fetch: unknown }).fetch = () => Promise.reject(new Error("ECONNREFUSED"));

  let message = "";
  try {
    await discoverPaymentRequirement("https://example.test/route", NETWORK);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }

  assert(message.includes("Could not reach the endpoint"), `an unreachable host reports reachability, got "${message}"`);
  assert(
    !message.includes("No x402 payment gate found"),
    "an unreachable host is NOT misreported as having no payment gate",
  );
}

export async function runMethodCascadeChecks(): Promise<void> {
  const realFetch = globalThis.fetch;
  try {
    await testCascadeFindsPostWhenGetIs404();
    await testCascadeStopsAtGet();
    await testDeclaredMethodOverridesProbe();
    await testGarbageDeclaredMethodFallsBackToProbe();
    await testLowercaseDeclaredMethodIsNormalized();
    await testKnownMethodSkipsCascade();
    await testDestructiveVerbsAreNeverBlindProbed();
    await testNoGateFoundError();
    await testSampleBodyIsSentVerbatim();
    await testTransportErrorIsDistinctFromNoGate();
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  }
}
