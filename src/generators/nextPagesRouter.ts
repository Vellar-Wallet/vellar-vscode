/**
 * Next.js Pages Router has no official x402 adapter anywhere in the x402 ecosystem
 * (confirmed against @x402/core, @x402/next, @x402/express, and @x402/fastify source —
 * only Express, Fastify, and Next.js App Router ship a maintained HTTPAdapter).
 *
 * The adapter contract those three implement is non-trivial: it buffers the entire
 * response, monkey-patches res.write/res.end/res.writeHead, and drives
 * settlement-failure cancellation after the handler runs. Hand-rolling that as
 * generated boilerplate risks producing code that passes a type-check but is wrong
 * at runtime in ways this extension cannot verify (buffering edge cases, header
 * replay, cancellation-on-failure) — so slice one declines to inject here rather
 * than ship a plausible-looking broken payment flow.
 *
 * Pages Router routes are still detected and shown in the quick-pick so the command
 * is honest about what it found; picking one shows guidance instead of inserting code.
 */
export const PAGES_ROUTER_GUIDANCE = `Vellar x402 doesn't support the Pages Router yet.

There's no official x402 adapter for the Pages Router (Express, Fastify, and the \
Next.js App Router each have one; the Pages Router doesn't). Hand-generating that \
adapter logic risks producing code that type-checks but is wrong at runtime, so this \
command won't inject anything here.

Two ways forward:
  1. Migrate this handler to the App Router (app/.../route.ts), which Vellar x402 \
fully supports via @x402/next's withX402.
  2. Wire it up by hand using @x402/core's x402ResourceServer + x402HTTPResourceServer \
primitives — see https://github.com/x402-foundation/x402 for the current API.`;
