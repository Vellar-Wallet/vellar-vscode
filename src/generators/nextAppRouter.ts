import { gateMarkerComment } from "../gateMarker";
import type { DetectedRoute, PaymentConfig } from "../types";
import { FACILITATOR_URL, renderAccepts, renderDiscoveryFields, renderPayToGuardComment } from "./shared";

/**
 * `withX402` wraps the exported handler directly, so App Router injection matches
 * the "inject before the handler body" framing literally: the setup block goes at
 * the top of the file (after imports), and the existing
 * `export async function GET(...) { ... }` is left completely untouched — a new
 * `export const GET = withX402(GET_impl, ...)` line is appended after it, with the
 * original function renamed to `GET_impl` so both the original logic and the export
 * name survive without duplicating the handler body.
 *
 * This file only ever touches one route.ts per command invocation (slice one scope);
 * a shared resourceServer across multiple routes is a later-slice concern.
 */

const IMPORTS = `import { withX402, x402ResourceServer } from "@x402/next";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";`;

export function renderNextAppRouterImports(): string {
  return IMPORTS;
}

export function renderNextAppRouterSetupBlock(route: DetectedRoute, config: PaymentConfig): string {
  return [
    gateMarkerComment(route),
    renderPayToGuardComment(""),
    `const PAYMENT_CONFIG = {`,
    `  payToAddress: "${config.payToAddress}",`,
    `};`,
    ``,
    `const x402FacilitatorClient = new HTTPFacilitatorClient({ url: "${FACILITATOR_URL}" });`,
    `const x402Server = new x402ResourceServer(x402FacilitatorClient)`,
    `  .register("stellar:testnet", new ExactStellarScheme())`,
    `  .registerExtension(bazaarResourceServerExtension);`,
    ``,
    `const x402RouteConfig = {`,
    renderAccepts(config, "  "),
    renderDiscoveryFields(config, "  "),
    `};`,
    `// --- end Vellar x402 setup ---`,
  ].join("\n");
}

/**
 * Renders the `export const METHOD = withX402(METHOD_impl, x402RouteConfig, x402Server);`
 * line, and the sed-style rename needed on the original declaration
 * (`function GET` -> `function GET_impl`, or `const GET =` -> `const GET_impl =`).
 */
export function renderNextAppRouterWrapExport(method: string): string {
  return `export const ${method} = withX402(${method}_impl, x402RouteConfig, x402Server); // Vellar x402: gate this handler`;
}

export function implName(method: string): string {
  return `${method}_impl`;
}
