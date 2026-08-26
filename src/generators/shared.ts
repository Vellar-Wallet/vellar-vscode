import type { PaymentConfig } from "../types";

export const FACILITATOR_URL = "https://vellar-facilitator.onrender.com";

/**
 * Stellar CAIP-2 network identifiers, per @x402/stellar. Slice one always targets
 * testnet in generated code — switching to mainnet (`stellar:pubnet`) is a one-line
 * edit the developer makes deliberately, not something a code-gen command should
 * decide silently.
 */
export const STELLAR_TESTNET_NETWORK = "stellar:testnet";

/** Formats the validated USDC price as the `$0.05`-style dollar-string @x402/stellar expects. */
export function formatPrice(priceUsdc: string): string {
  return `$${priceUsdc}`;
}

/**
 * Renders the `accepts` route-config block shared verbatim across Express, Fastify,
 * and Next.js App Router injections (only the surrounding call differs).
 *
 * `scheme` and `network` are given explicit literal types (`"exact"` and
 * `` `${string}:${string}` `` respectively via `as const`-equivalent annotations) —
 * @x402/core types `PaymentOption.network` as a template-literal type, and without
 * this the object literal widens to plain `string` and fails to type-check against
 * `RoutesConfig`. Confirmed against @x402/core's real .d.ts, not assumed.
 */
export function renderAccepts(config: PaymentConfig, indent: string): string {
  return [
    `${indent}accepts: {`,
    `${indent}  scheme: "exact" as const,`,
    `${indent}  price: "${formatPrice(config.priceUsdc)}",`,
    `${indent}  network: "${STELLAR_TESTNET_NETWORK}" as const,`,
    `${indent}  payTo: PAYMENT_CONFIG.payToAddress,`,
    `${indent}},`,
  ].join("\n");
}

/**
 * Renders RouteConfig's own optional discovery-adjacent fields — description,
 * serviceName, tags. These are real, simple, correctly-typed top-level fields on
 * @x402/core's RouteConfig (confirmed against its .d.ts), unlike the full Bazaar
 * discovery-extension machinery (`declareDiscoveryExtension` +
 * `bazaarResourceServerExtension`), which needs a JSON-schema description of the
 * endpoint's input/output that can't be inferred from route detection alone —
 * deliberately out of scope for slice one. See README for how to add it by hand.
 */
export function renderDiscoveryFields(config: PaymentConfig, indent: string): string {
  return [
    `${indent}description: "${config.serviceName} — ${config.endpointUrl} ($${config.priceUsdc} USDC)", // TODO: add the actual resource description`,
    `${indent}serviceName: "${config.serviceName}",`,
    `${indent}tags: ["api", "x402"],`,
  ].join("\n");
}

export function renderPayToGuardComment(indent: string): string {
  return `${indent}// payTo is read from the "vellar-x402.payToAddress" VS Code setting at runtime.`;
}
