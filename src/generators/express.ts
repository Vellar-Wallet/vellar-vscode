import { gateMarkerComment } from "../gateMarker";
import type { DetectedRoute, PaymentConfig } from "../types";
import { FACILITATOR_URL, renderAccepts, renderDiscoveryFields, renderPayToGuardComment } from "./shared";

/**
 * @x402/express's `paymentMiddleware` is app-level middleware — it is designed to be
 * registered once via `app.use(...)`, not wrapped inline around a single route's
 * handler. So injection here does two things:
 *   1. A setup block (facilitator client, resource server, scheme registration,
 *      route config) inserted right after this file's imports.
 *   2. `app.use(paymentMiddleware(...))` inserted on the line immediately before
 *      the selected route's registration — visible next to the route it protects,
 *      ordered correctly relative to any existing body-parser/auth middleware that
 *      already runs earlier in the file.
 * The route's handler body is never touched.
 */

const IMPORTS = `import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";`;

export function renderExpressImports(): string {
  return IMPORTS;
}

export function renderExpressSetupBlock(route: DetectedRoute, config: PaymentConfig): string {
  const routeKey = `${route.method} ${route.routePath}`;
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
    `const x402Routes = {`,
    `  "${routeKey}": {`,
    renderAccepts(config, "    "),
    renderDiscoveryFields(config, "    "),
    `  },`,
    `};`,
    `// --- end Vellar x402 setup ---`,
  ].join("\n");
}

export function renderExpressAppUse(): string {
  return `app.use(paymentMiddleware(x402Routes, x402Server)); // Vellar x402: gate the route below`;
}
