# Vellar x402

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/VellarWallet.vellar-x402?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=VellarWallet.vellar-x402)

Add an x402 payment gate to an HTTP endpoint from inside VS Code, in one command.

Vellar x402 scans the file you have open for route definitions (Express, Fastify,
or Next.js), lets you pick one, asks how much to charge in USDC, and injects
working boilerplate that:

- Returns a 402 challenge for unpaid requests, via [`@x402/stellar`](https://www.npmjs.com/package/@x402/stellar)'s `ExactStellarScheme`
- Verifies and settles payment against the Vellar facilitator
  (`https://vellar-facilitator.onrender.com`)
- Reads your payout address from a VS Code setting, never hardcodes a placeholder
- Leaves your existing route logic untouched — the payment gate is added around
  the handler, not inside it

<img width="605" height="362" alt="Vellar x402 route picker" src="https://github.com/user-attachments/assets/112cfeec-ad90-42e0-a21d-58a59d4d5bcf" />

## What's in slice one

One command: **Vellar: Add x402 payment to this endpoint** (`vellar-x402.addPayment`).

Supported frameworks:

| Framework | Detected via | Injection |
|---|---|---|
| Express | `app.get/post/put/patch/delete`, `router.*` | `paymentMiddleware` + `app.use(...)` before the route |
| Fastify | `fastify.get/post/route`, `server.*` | `paymentMiddleware(app, ...)` before the route |
| Next.js App Router | exported `GET`/`POST`/`PUT`/`PATCH`/`DELETE` handlers | `withX402(...)` wraps the handler |
| Next.js Pages Router | detected, **not injected** — see below | — |

### Next.js Pages Router: detected, not supported

The x402 ecosystem (`@x402/core`, `@x402/express`, `@x402/fastify`, `@x402/next`)
ships a maintained HTTP adapter for Express, Fastify, and the Next.js App Router —
each does real work: buffering the response, replaying headers, and driving
settlement-failure cancellation after the handler runs. There is no equivalent
adapter for the Pages Router anywhere in the ecosystem as of this writing.

Hand-generating that adapter logic as boilerplate risks producing code that
type-checks but is wrong at runtime in ways this extension can't verify. So Pages
Router routes are still detected and shown in the picker — the command is honest
about what it found — but selecting one shows guidance instead of injecting code:
migrate the handler to the App Router, or wire it up by hand against
`@x402/core`'s `x402ResourceServer` primitives.

### Bazaar discovery metadata: simplified from the original spec

The x402 Bazaar catalog's rich discovery metadata (`declareDiscoveryExtension` +
registering `bazaarResourceServerExtension` on the resource server) needs a
JSON-schema description of the endpoint's input and output shape — information
route detection can't infer from a handler's source alone. Slice one populates
`RouteConfig`'s own simple, correctly-typed fields instead:

- `description` — a placeholder built from the service name, route, and price
- `serviceName` — read from the nearest `package.json`'s `"name"` field
- `tags` — defaults to `["api", "x402"]`

All editable after generation. To add the richer discovery extension yourself,
see [`@x402/extensions`](https://www.npmjs.com/package/@x402/extensions)'s Bazaar
docs.

## Install

**From the Marketplace** (recommended): search **"Vellar x402"** in VS Code's
Extensions panel (`Cmd/Ctrl+Shift+X`) and click Install, or install directly from
[marketplace.visualstudio.com/items?itemName=VellarWallet.vellar-x402](https://marketplace.visualstudio.com/items?itemName=VellarWallet.vellar-x402).

**From source** (for development, or to try an unreleased change):

```bash
git clone https://github.com/Vellar-Wallet/vellar-vscode.git
cd vellar-vscode
npm install
npm run vsce-package   # builds dist/extension.js, then packages vellar-x402-<version>.vsix
```

Then in VS Code: **Extensions → ... menu → Install from VSIX...** and select the
generated `.vsix` file, or from the command line:

```bash
code --install-extension vellar-x402-<version>.vsix
```

## Configure

Open Settings (`Cmd/Ctrl+,`) and search for **Vellar x402**, or set directly in
`settings.json`:

```json
{
  "vellar-x402.payToAddress": "GA...YOUR_STELLAR_G_ADDRESS"
}
```

This is the only setting slice one has. It's where USDC payments for every
endpoint you gate will land. If it's unset when you run the command, Vellar x402
prompts you to open Settings before generating any code.

The address is read once and inlined into the generated code (`PAYMENT_CONFIG.payToAddress`)
rather than read from settings at runtime. If you change your payTo address after
generating a gate, re-run the command on that route to update the inlined address.

## Use it

1. Open a `.js`, `.ts`, `.mjs` file with an Express, Fastify, or Next.js route in it.
2. Run **Vellar: Add x402 payment to this endpoint** from the Command Palette
   (`Cmd/Ctrl+Shift+P`).
3. Pick the route from the quick-pick list.
4. Enter a price in USDC (default `0.01`, up to 7 decimal places).
5. Review the injected code, then click **Install dependencies** on the success
   notification — it detects your project's package manager (pnpm/yarn/npm, from
   whichever lockfile it finds walking up from the file) and runs the install
   command in a new terminal, in the correct package directory (important in a
   monorepo — it installs into the sub-package's `package.json`, not the repo
   root's). Or install manually:
   ```bash
   npm install @x402/stellar @x402/core @x402/express   # or @x402/fastify, @x402/next
   ```
   Next.js App Router requires Next.js `>=16.2.6` (a peer dependency of `@x402/next`).

The generated `description` field is a placeholder — edit it to describe what the
endpoint actually returns.

Running the command again on a route that already has a gate (detected via its
`// --- Vellar x402: payment gate for ... ---` marker comment) shows a warning
and stops instead of injecting a second, colliding set of declarations. Remove
the existing gate first if you want to regenerate it.

## Known limitations

Route detection uses regex and may miss multi-line route signatures or routes
with non-string paths (template literals, variables). If your route isn't
detected, open an issue.

## Acceptance test

Verified against fresh fixture projects with real `@x402/*` packages installed and
`tsc --noEmit` run on the injected output — not just a syntax check.

- **Express** (the spec's acceptance test): 3 routes in one file, ran the command,
  picked `GET /weather`, price `0.05`, injected. Result: **passed** — all 3 routes
  detected, injection landed exactly at the picked route, the other two routes'
  registrations and bodies were untouched, and `tsc --noEmit` passed with zero
  errors against `@x402/core@^2.14.0`, `@x402/express@^2.14.0`, `@x402/stellar@^2.14.0`.
- **Fastify**: both the `fastify.get(...)` and `fastify.route({...})` config-object
  forms detected; injected against the `.route({...})` route. Result: **passed**,
  `tsc --noEmit` clean.
- **Next.js App Router**: exported `GET` handler wrapped with `withX402`, original
  implementation preserved and renamed rather than duplicated. Result: **passed**,
  `tsc --noEmit` clean (against Next.js `16.2.6`, the minimum `@x402/next@2.23.0`
  requires as a peer).

Re-run any of these yourself:

```bash
npm run compile
node scripts/run-acceptance-test.js                   # Express — the spec's acceptance test
node scripts/run-fastify-check.js                      # Fastify
node scripts/run-next-app-router-check.js               # Next.js App Router
node scripts/run-fastify-multiline-import-check.js       # regression: see below
node scripts/run-package-manager-check.js                # pnpm/yarn/npm detection
```

Each script resets its fixture's git-tracked source back to its pristine,
un-injected state after running, so the fixtures stay reusable.

## Vellar sidebar

Since 0.2.0, the extension also adds a **Vellar** view to the activity bar: your
wallet balance, every endpoint you're the payTo for (with a real **Test** button
that fires a genuine throwaway-wallet testnet payment), your recent settlements,
and an earnings summary — plus a first-run onboarding panel that walks through
getting your first endpoint set up. See [CHANGELOG.md](CHANGELOG.md#020) for the
full list of what's in it.

## What the add-payment command deliberately does not do

Per scope: `vellar-x402.addPayment` (described above) is code generation and
nothing else — no test runner, no deployment, no wallet management of its own.
See the two deviations from the original spec noted above (Pages Router, Bazaar
metadata) — both are scope adjustments made after finding the real `@x402/*`
package APIs didn't support what a naive reading of the spec would generate, not
omissions.
