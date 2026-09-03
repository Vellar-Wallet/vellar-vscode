# Changelog

All notable changes to the Vellar x402 extension are documented here.

## 0.2.3

### Fixed: 0.2.2's trustline warning was invisible, sections had no breathing room, and the panel didn't fill its own height

Follow-up fixes found by actually looking at 0.2.2 running in the sidebar,
not just at the diff:

- The trustline/unfunded warning text added in 0.2.2 rendered completely
  invisible — only its two links ("Freighter", "Stellar Laboratory") showed.
  `.field`'s CSS only promotes element children above its `::before` fill
  layer via z-index; the warning sentence was a bare text node with no
  element to promote, so it sat underneath the opaque background. Fixed by
  wrapping it in a `<p class="warning-text">`, plus restoring the amber
  `--field-border`/`--field-fill` tokens the same edit had accidentally
  dropped, and adding a proper label/spacing so it reads as a structured
  warning card.
- The gap between sidebar sections (Wallet / My Endpoints / Recent
  Settlements / Earnings Summary) was implemented as a top margin on the
  *next* section's heading, so it only existed if the *previous* section's
  last element happened to carry its own bottom margin. A section ending in
  a bare button (e.g. My Endpoints' "Activate endpoint") had no such margin
  and visually ran straight into the next heading. Fixed by wrapping each
  heading+content pair in a `<section class="sidebar-section">` and giving
  the section itself a guaranteed top margin from its predecessor —
  unconditional, regardless of what the previous section last rendered.
- Added responsive handling where there was none: `flex-wrap` on every
  two-sided row that assumed enough horizontal room (endpoint meta/stats
  rows, the payout-address-plus-Copy row, the settlements pager), ellipsis
  truncation on settlement amounts/payers instead of silent clipping, and a
  container query that collapses Earnings Summary's 2-column stat grid to
  one column once the sidebar is dragged narrow.
- The sidebar's white background stopped wherever its content ended,
  leaving VS Code's dark default background showing below it whenever the
  panel had little content (e.g. before any endpoints exist). Fixed with
  `html { height: 100% }` / `body { min-height: 100% }` so the paper
  background always fills the full panel height.

## 0.2.2

### Fixed: the Wallet panel couldn't distinguish "no USDC trustline" from "unfunded" from "genuinely zero balance"

Both an unfunded address and a funded address with no USDC trustline
previously showed the same "0.00 USDC" — indistinguishable from a funded,
trustlined account that simply hasn't been paid yet. A developer with either
of the first two problems had no signal from the sidebar that payments to
their `payToAddress` would fail on-chain.

- `dataProvider.ts`'s wallet fetch now reports three distinct states:
  unconfigured/invalid-address (unchanged), a new `unfunded` state for an
  address Horizon 404s, and `loaded` with a new `hasTrustline` flag (true
  only when the account's balances actually include a USDC trustline entry
  for the canonical testnet USDC issuer — not inferred from balance, since a
  trustline can exist with a zero balance).
- The Wallet panel shows an amber (not red — this is a precondition, not an
  error) warning below the balance when `hasTrustline` is false, linking to
  Freighter and Stellar Laboratory to open one, and a separate "not yet
  funded" message when the address doesn't exist on Stellar at all.
- Documented in the README under a new "Before you start: open a USDC
  trustline" section.

## 0.2.1

Cosmetic-only patch release.

- Replaced the activity-bar sidebar icon (`media/activity-icon.svg`, a
  placeholder $-in-circle mark) with the real Vellar "V" mark
  (`media/icon.png`). The old placeholder SVG has been removed.

## 0.2.0

A minor version bump, not a patch — this release adds an entire second
surface to the extension (a persistent sidebar and a first-run onboarding
flow) on top of 0.1.3's one-command code generator, which is unchanged.

### Fixed: test payments could hang, misreport success as failure, or falsely block a retry

Four real bugs found through live testing before release, all in the
throwaway test-payment flow:

- Two Stellar/Soroban SDK calls the flow depends on (`Horizon.Server`'s
  request client, and the Soroban RPC client `@x402/stellar` uses
  internally to sign a payment) have no request timeout of their own. A
  stalled connection at either point could hang the whole flow forever, with
  no recovery short of reloading the whole VS Code window. Both are now
  wrapped in an explicit, enforced timeout (15s for a plain read, 30s for
  the Soroban signing step, 60s for a classic-transaction submit).
- The flow's own success check looked for a settlement transaction hash
  nested inside the paid response's JSON body — which is not where the
  x402 protocol actually puts it. A real settlement was misreported as
  "not_settled" every time, even though the payment had genuinely gone
  through on-chain. Fixed to read the real `PAYMENT-RESPONSE` header
  instead, via the same official `@x402/core` client method already used
- The "a test payment is already running" guard stayed on for as long as
  the success notification (with its "View on stellar.expert" button)
  remained on screen — which VS Code does not resolve until the user
  interacts with it. A finished payment could leave the sidebar refusing to
  start a new one for as long as that toast sat unread. The guard now
  clears the moment the payment flow itself is done, independent of any
  follow-up notification's own lifecycle.
  for the initial 402 challenge.

### Added: Vellar sidebar

A new activity-bar view (webview-based, styled to match the Vellar design
system used on vellar.xyz — white paper ground, forest ink, mint/sun/coral
accents, zero-radius clip-cut corners) with four live sections:

- **Wallet** — your configured payout address's XLM and USDC balances, read
  from Horizon, polled every 30s.
- **My Endpoints** — every endpoint you're the payTo for, from the Vellar
  facilitator's discovery catalog, with an ownership-verification badge
  (Verified / Proven, unconfirmed / Unverified) and a **Test** button per
  endpoint. An endpoint only appears here after its first payment settles —
  running the add-payment command alone doesn't register it. Before that
  first payment, the empty state includes a **"Test this endpoint"** field:
  paste your endpoint's own URL and fire a real test payment against it
  directly, closing the loop for a brand-new endpoint that has no catalog
  listing yet to click Test on.
- **Recent Settlements** — your last 10 on-chain settlements (amount, payer,
  time, a link to stellar.expert), from the Vellar explorer.
- **Earnings Summary** — total / today / this-week USDC earned and a unique-
  payer count, computed from the Recent Settlements data (no extra network
  call), with an explicit note that these figures are based on your 10 most
  recent settlements, not a true all-time total.

All three data sections pause polling when the sidebar is hidden or the
window loses focus, and enforce a hard floor on request frequency
independent of what's asking.

### Added: real throwaway test payments

Clicking **Test** on an endpoint listing — or entering a URL directly in My
Endpoints' empty state — runs a real, end-to-end x402 payment against it on
Stellar testnet: a fresh keypair is generated in memory, funded via
friendbot, provisioned with testnet USDC via the DEX, and used to sign and
settle a real payment — using the same official `@x402/core` +
`@x402/stellar` client the rest of the ecosystem's reference scripts use, not
a hand-rolled signer. Progress is shown step by step in a VS Code
notification; a successful run ends with a clickable link to the real
settlement transaction on stellar.expert and immediately refreshes My
Endpoints and Recent Settlements.

For a manually-entered URL (no catalog listing yet to supply a known price or
payee), the payment requirement is read live from the endpoint's own real
402 challenge response — never assumed from the URL itself.

The throwaway keypair exists only in memory for the duration of one test run:
never written to disk or extension storage, never logged, never sent to the
webview. Explicit runtime checks refuse to proceed if the throwaway wallet's
address were ever to equal your own configured payout address, or the
endpoint's own payTo address.

### Added: notifications

Three notification triggers, compared against a persisted baseline so they
only fire on a genuine state change (never on first install, even if your
account already has activity):

- An endpoint earns its first payment.
- An endpoint's ownership state becomes Verified.
- Any new settlement — off by default, enable with the new
  `vellar-x402.notifyOnEveryPayment` setting.

### Added: first-run onboarding

A welcome panel opens automatically the first time the extension activates,
walking through three steps (set your payout address, open a route file, run
the add-payment command) with live progress as each completes. Each step
includes concrete guidance rather than just naming what to do: a real route-
handler code sample for step 2, the exact Command Palette keybinding and
command string for step 3, and a completion message that explains — by
name — that a first payment (via **My Endpoints**' Test or "Test this
endpoint") is what actually registers your endpoint in the Bazaar, not the
add-payment command alone. Shows exactly once; run **Vellar: Reopen getting
started** (`vellar-x402.reopenOnboarding`) from the Command Palette to see
it again.

### Added

- `vellar-x402.notifyOnEveryPayment` setting (boolean, default `false`).
- `vellar-x402.reopenOnboarding` command ("Vellar: Reopen getting started").
- Two committed CI checks: a postMessage security audit (asserts the
  configured payout address never reaches the sidebar webview's JS context)
  and a test-payment assertion check (confirms the throwaway-wallet safety
  check runs before any funds move).

### Unchanged

The 0.1.3 code-injection command (`vellar-x402.addPayment`) and everything
under "What's in slice one" in the README — same detection, same injection,
same supported frameworks.

## 0.1.3

- One command, **Vellar: Add x402 payment to this endpoint**
  (`vellar-x402.addPayment`): detects an HTTP route in the open file
  (Express, Fastify, or Next.js App Router) and injects a working x402
  payment gate around it.
- Next.js Pages Router routes are detected but not injected — no maintained
  `@x402/*` HTTP adapter exists for it; guidance is shown instead.
- `vellar-x402.payToAddress` setting — the one setting, read once and inlined
  into generated code.
- Package-manager-aware dependency install (pnpm/yarn/npm, detected from the
  nearest lockfile, run in the correct sub-package directory in a monorepo).
- Duplicate-gate detection: re-running the command on an already-gated route
  warns instead of injecting a second, colliding gate.
