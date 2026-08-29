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
 * serviceName, tags, and now the real Bazaar discovery-extension declaration
 * (`extensions: declareDiscoveryExtension({...})`, see renderExtensionsField
 * below). description/serviceName/tags are real, simple, correctly-typed
 * top-level fields on @x402/core's RouteConfig (confirmed against its .d.ts).
 *
 * Without the `extensions` field, a settled payment against a generated
 * endpoint NEVER registers it in the facilitator's discovery catalog —
 * confirmed against the facilitator's own source (bazaar.ts's onAfterSettle
 * hook: `extractDiscoveryInfo(paymentPayload, requirements)` returns null,
 * and cataloging silently no-ops, unless the settled payment payload carries
 * the bazaar extension the SELLER declared). Adding it here is what makes
 * the sidebar's "Activate endpoint" feature actually true for
 * extension-generated code, which it was not before this field existed.
 */
export function renderDiscoveryFields(config: PaymentConfig, indent: string): string {
  return [
    `${indent}description: "${config.serviceName} — ${config.endpointUrl} ($${config.priceUsdc} USDC)", // TODO: add the actual resource description`,
    `${indent}serviceName: "${config.serviceName}",`,
    `${indent}tags: ["api", "x402"],`,
    renderExtensionsField(indent),
  ].join("\n");
}

/**
 * Marker the FIRST TODO comment inside the generated extensions block
 * carries — findFirstExtensionsTodoSelection (injector.ts) scans for this
 * exact string, same "single source of truth for a marker string" pattern
 * EDIT_ME_MARKER already uses for the description field.
 *
 * REAL BUG, FOUND AND FIXED: this used to be the generic prefix "// TODO:" —
 * but the description field's OWN comment ("// TODO: add the actual
 * resource description") also starts with that exact prefix and appears
 * EARLIER in the generated file, so findIndex's "first match" search kept
 * landing on the description's TODO instead of this block's. Caught by
 * actually printing the real generated output and checking the selected
 * substring, not by inspection — the two markers looked distinct enough on
 * paper. Fixed by using the marker's own full, specific text (matching
 * EDIT_ME_MARKER's own convention: the WHOLE comment, not a shared prefix),
 * which cannot collide with any other generated comment.
 */
export const EXTENSIONS_TODO_MARKER = "// TODO: example values for this endpoint's query/body";

/**
 * Renders the `extensions: declareDiscoveryExtension({ input, inputSchema,
 * output })` field — real placeholder objects with TODO comments, same
 * discipline as the description field above: the generator cannot infer a
 * route's actual input/output shape from detection alone (a bare
 * `app.get("/x", handler)` says nothing about what query/body fields matter
 * or what the JSON response looks like), so it leaves clearly-marked
 * placeholders for the developer to fill in rather than guessing at a shape
 * that could be wrong.
 *
 * `input` and `inputSchema` are SEPARATE SIBLING fields on
 * DeclareQueryDiscoveryExtensionConfig (confirmed against the real installed
 * @x402/extensions .d.ts, not assumed) — `input` holds EXAMPLE VALUES (e.g.
 * `{ topic: "perseverance" }`), `inputSchema` holds the JSON-schema shape
 * describing those values' types (e.g.
 * `{ properties: { topic: { type: "string" } } }`). They are not nested
 * inside each other. Matches the real, working seller.mjs's own usage
 * exactly, so the developer fills in the TODOs without restructuring
 * anything the generator produced.
 */
function renderExtensionsField(indent: string): string {
  return [
    `${indent}extensions: declareDiscoveryExtension({`,
    `${indent}  input: {`,
    `${indent}    ${EXTENSIONS_TODO_MARKER}`,
    `${indent}    // parameters, e.g. { topic: "perseverance" }`,
    `${indent}  },`,
    `${indent}  inputSchema: {`,
    `${indent}    // TODO: JSON schema for those parameters, e.g.`,
    `${indent}    // { properties: { topic: { type: "string" } } }`,
    `${indent}  },`,
    `${indent}  output: {`,
    `${indent}    example: {`,
    `${indent}      // TODO: add a real example response object,`,
    `${indent}      // e.g. { result: "..." }`,
    `${indent}    },`,
    `${indent}  },`,
    `${indent}}),`,
  ].join("\n");
}

export function renderPayToGuardComment(indent: string): string {
  return `${indent}// payTo is read from the "vellar-x402.payToAddress" VS Code setting at runtime.`;
}
