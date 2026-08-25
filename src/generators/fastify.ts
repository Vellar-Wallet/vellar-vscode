import { gateMarkerComment } from "../gateMarker";
import type { DetectedRoute, PaymentConfig } from "../types";
import { FACILITATOR_URL, renderAccepts, renderDiscoveryFields, renderPayToGuardComment } from "./shared";

/**
 * @x402/fastify's `paymentMiddleware(app, routes, server)` registers hooks directly
 * on the Fastify instance — same "app-level, not inline" shape as Express. Injection
 * mirrors the Express generator: a setup block after imports, then a
 * `paymentMiddleware(...)` call inserted immediately before the selected route's
 * registration. The handler body is never touched.
 */

const IMPORTS = `import { paymentMiddleware, x402ResourceServer } from "@x402/fastify";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";`;

export function renderFastifyImports(): string {
  return IMPORTS;
}

export function renderFastifySetupBlock(route: DetectedRoute, config: PaymentConfig): string {
  const routeKey = `${route.method} ${route.routePath}`;
  return [
    gateMarkerComment(route),
    renderPayToGuardComment(""),
    `const PAYMENT_CONFIG = {`,
    `  payToAddress: "${config.payToAddress}",`,
    `};`,
    ``,
    `const x402FacilitatorClient = new HTTPFacilitatorClient({ url: "${FACILITATOR_URL}" });`,
    `const x402Server = new x402ResourceServer(x402FacilitatorClient).register(`,
    `  "stellar:testnet",`,
    `  new ExactStellarScheme(),`,
    `);`,
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

/**
 * @param appVarName - The Fastify instance variable name detected at the call site
 * (e.g. `fastify` or `server`), so the injected call matches how the app is referred
 * to elsewhere in this file rather than assuming a fixed name.
 */
export function renderFastifyRegisterCall(appVarName: string): string {
  return `paymentMiddleware(${appVarName}, x402Routes, x402Server); // Vellar x402: gate the route below`;
}
