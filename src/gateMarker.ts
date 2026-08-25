import type { DetectedRoute } from "./types";

/**
 * The marker comment every generator (Express, Fastify, Next.js App Router) opens
 * its setup block with — single source of truth so detection (`hasExistingGate`)
 * can never drift out of sync with what the generators actually emit.
 */
export function gateMarkerComment(route: Pick<DetectedRoute, "method" | "routePath">): string {
  return `// --- Vellar x402: payment gate for ${route.method} ${route.routePath} ---`;
}

/**
 * True when this file already has a Vellar x402 gate for the given route. Running
 * the command again on an already-gated route would otherwise inject a second,
 * colliding set of `const x402Server = ...` / `const PAYMENT_CONFIG = ...`
 * declarations and fail to compile — so the caller should warn and stop instead of
 * injecting a duplicate.
 */
export function hasExistingGate(fileText: string, route: Pick<DetectedRoute, "method" | "routePath">): boolean {
  return fileText.includes(gateMarkerComment(route));
}
