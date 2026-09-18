/** HTTP method a detected route responds to. Uppercase, matching x402's route-config keys. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * The single canonical list of methods this extension understands, shared by
 * the route detectors, the test-payment discovery cascade, and the discovery
 * catalog's own method parsing — so "which verbs do we support" is stated
 * exactly once rather than re-listed per module.
 */
export const HTTP_METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/**
 * The verbs that carry a request body. GET and DELETE deliberately do not:
 * a body on either is legal-but-unusual per HTTP semantics, and sending one
 * to a seller that doesn't expect it is more likely to break the request
 * than to help it.
 */
export const BODY_METHODS: readonly HttpMethod[] = ["POST", "PUT", "PATCH"];

/** True only for one of the five exact, uppercase method literals above. */
export function isHttpMethod(value: unknown): value is HttpMethod {
  return typeof value === "string" && (HTTP_METHODS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads `bazaar.info.input.method` out of an x402 `extensions` blob.
 *
 * Two callers, deliberately sharing one implementation so the nested path can
 * never drift between them:
 *  - testPayment/payment.ts, against a decoded 402 challenge's own
 *    `PaymentRequired.extensions` (a TOP-LEVEL field, sibling of `accepts` —
 *    `PaymentRequirements` entries carry `extra`, NOT `extensions`, confirmed
 *    against @x402/core's own .d.ts and a live challenge, so there is no
 *    per-accept method to read even though the spec draft implied one).
 *  - sidebar/dataProvider.ts, against a discovery catalog item's own
 *    `extensions` (again a sibling of `accepts`, confirmed live: all 19
 *    catalogued testnet resources declare `input.method`).
 *
 * Returns undefined for EVERY malformed shape and for any method outside the
 * five known verbs, rather than throwing: this is remote, third-party data
 * (a seller's own declaration, relayed by the facilitator) and an unexpected
 * shape must degrade to "method unknown", never crash a payment flow or let
 * an arbitrary string reach fetch()'s `method`. Uppercased before matching
 * since HTTP verbs are case-insensitive on the wire but our own comparisons
 * are not.
 */
export function readBazaarMethod(extensions: unknown): HttpMethod | undefined {
  if (!isRecord(extensions)) return undefined;
  const bazaar = extensions["bazaar"];
  if (!isRecord(bazaar)) return undefined;
  const info = bazaar["info"];
  if (!isRecord(info)) return undefined;
  const input = info["input"];
  if (!isRecord(input)) return undefined;
  const method = input["method"];
  if (typeof method !== "string") return undefined;
  const upper = method.toUpperCase();
  return isHttpMethod(upper) ? upper : undefined;
}

/**
 * Stellar CAIP-2 network identifier, per @x402/stellar — the only two values
 * vellar-x402.network's package.json enum declares. Shared here (rather than
 * defined next to getConfiguredNetwork() in dataProvider.ts) so pure,
 * vscode-free modules like testPayment/usdc.ts and testPayment/payment.ts can
 * import the type without importing anything vscode-shaped.
 */
export type StellarNetwork = "stellar:testnet" | "stellar:pubnet";

/** Frameworks slice one knows how to detect and inject into. */
export type Framework =
  | "express"
  | "fastify"
  | "next-app-router"
  | "next-pages-router";

/**
 * One HTTP route definition found in the active editor.
 *
 * `insertionLine` and `insertionCharacter` mark where generated code should be
 * inserted: immediately before the handler body starts executing, so the 402
 * challenge/verification runs first without replacing any existing logic.
 */
export interface DetectedRoute {
  framework: Framework;
  method: HttpMethod;
  /** Route path, e.g. "/users/:id". For Next.js this is derived from the file path. */
  routePath: string;
  /** 0-based line where the route/handler declaration starts (for the quick-pick label). */
  declarationLine: number;
  /** 0-based line where injected code should be inserted. */
  insertionLine: number;
  /** 0-based character offset on insertionLine where injected code should be inserted. */
  insertionCharacter: number;
  /** Text shown in the quick-pick, e.g. "GET /users/:id (Express)". */
  label: string;
  /** Detail line shown under the label, e.g. the raw source line. */
  detail: string;
  /** Indentation string (spaces/tabs) to prefix each injected line with, matching surroundings. */
  indent: string;
  /**
   * The app/router/fastify instance variable name at the call site (e.g. "app",
   * "router", "fastify", "server"). Used so Express's `app.use(...)` and Fastify's
   * `paymentMiddleware(instance, ...)` reference the same variable already in scope,
   * rather than assuming a fixed name. Undefined for Next.js routes (no instance).
   */
  appVarName?: string;
}

/** Answers collected from the user before code generation. */
export interface PaymentConfig {
  /** USDC price as a validated decimal string, e.g. "0.05". Never a float — precision matters. */
  priceUsdc: string;
  /** Stellar G-address from vellar-x402.payToAddress. */
  payToAddress: string;
  /**
   * Stellar network from vellar-x402.network, resolved once by the (vscode-
   * aware) command handler that builds this config — same seam payToAddress
   * already uses. Generators (src/generators/**, src/injector.ts) stay pure,
   * vscode-free functions: they read this field rather than resolving the
   * setting themselves.
   */
  network: StellarNetwork;
  /** Endpoint URL used as the description default. Best-effort; editable by the developer. */
  endpointUrl: string;
  /**
   * Best-effort service name for RouteConfig.serviceName — the workspace's
   * package.json "name" field, falling back to the open file's basename when no
   * package.json is found or it has no "name" field.
   */
  serviceName: string;
}
