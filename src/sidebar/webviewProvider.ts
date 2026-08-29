import * as vscode from "vscode";
import * as crypto from "node:crypto";
import {
  computeEarnings,
  DataProvider,
  type EndpointsState,
  type SettlementsState,
  type WalletBalanceState,
} from "./dataProvider";
import { formatDecimalAmount, looksLikeTestableResourceUrl, truncateMiddle } from "./format";
import { FocusVisibilityGate } from "./polling";
import { runTestPayment, type TestPaymentTarget } from "./testPayment/runTestPayment";

/**
 * The sidebar's single webview. `retainContextWhenHidden: false` (required) means
 * VS Code fully destroys this webview's DOM/JS state when it's hidden and gives us
 * a brand new one on the next reveal — so `resolveWebviewView` always re-sends
 * current state rather than assuming anything survived, and the extension-host
 * side (DataProvider, the polling gate) is the only place that holds state across
 * that boundary. The webview itself is a pure render of whatever it's told.
 */
export class VellarSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "vellar-x402.sidebar";

  private view: vscode.WebviewView | undefined;
  private readonly gate = new FocusVisibilityGate();
  // Guards against a second test payment firing while one is already running
  // (a double-click, or a click on a different endpoint's Test button mid-flow)
  // — a real testnet payment has a real cost and shouldn't stack silently.
  private testPaymentInFlight = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly dataProvider: DataProvider,
  ) {
    this.gate.add(this.dataProvider.wallet);
    this.gate.add(this.dataProvider.endpoints);
    this.gate.add(this.dataProvider.settlements);
    this.dataProvider.wallet.onDidUpdate((result) => this.postWalletUpdate(result));
    this.dataProvider.endpoints.onDidUpdate((result) => this.postEndpointsUpdate(result));
    this.dataProvider.settlements.onDidUpdate((result) => {
      this.postSettlementsUpdate(result);
      // Earnings has no poller of its own (see computeEarnings' own comment) — it
      // recomputes on the exact same event settlements already fires, so the two
      // sections can never show numbers derived from two different fetches.
      this.postEarningsUpdate(result);
    });

    vscode.window.onDidChangeWindowState((state) => this.gate.setFocused(state.focused));
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    // retainContextWhenHidden defaults to false and is deliberately not set to
    // true anywhere — required per the security spec, not an oversight of an
    // available option.

    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message));

    webviewView.onDidChangeVisibility(() => {
      this.gate.setVisible(webviewView.visible);
      if (webviewView.visible) {
        this.postWalletUpdate(this.dataProvider.wallet.current);
        this.postSettlementsUpdate(this.dataProvider.settlements.current);
        this.postEarningsUpdate(this.dataProvider.settlements.current);
      }
    });
    this.gate.setVisible(webviewView.visible);

    // A fresh webview (every reveal, given retainContextWhenHidden: false) starts
    // with no data of its own — send whatever the DataProvider already has
    // immediately, rather than waiting for the next poll tick.
    this.postWalletUpdate(this.dataProvider.wallet.current);
    this.postEndpointsUpdate(this.dataProvider.endpoints.current);
    this.postSettlementsUpdate(this.dataProvider.settlements.current);
    this.postEarningsUpdate(this.dataProvider.settlements.current);
  }

  /**
   * REAL BUG, FOUND AND FIXED: this comment used to say EndpointListing
   * "carries nothing sensitive" and posted it as-is — true when Step 2 wrote
   * that comment, false the moment Step 6 added payTo/amount/asset to
   * EndpointListing for runTestPayment's own use (the extension-host-side
   * assertion that the throwaway test wallet never equals the developer's
   * own payTo). Nothing re-checked that comment's premise when those fields
   * were added, so the developer's full payToAddress silently started
   * crossing into the webview on every endpoints update. Caught by
   * scripts/run-postmessage-leak-check.js (a committed test, not manual
   * inspection) — see that file for the assertion that failed and led here.
   *
   * Fixed by transforming through toEndpointsDisplayState below, the same
   * "one bridge point, strip what the webview doesn't need" pattern every
   * other section already uses. payTo/amount/asset are extension-host-only
   * fields now, in the sense that they never reach this postMessage call —
   * the webview's own render function never read them anyway (it only uses
   * resource/priceLabel/ownershipState/settlements/lastSettled).
   */
  private postEndpointsUpdate(state: import("./polling").PollResult<EndpointsState>): void {
    void this.view?.webview.postMessage({ type: "endpoints", state: toEndpointsDisplayState(state) });
  }

  /**
   * The webview's JS context is untrusted by construction (CSP notwithstanding —
   * defense in depth) — it must never receive the full payToAddress, only what
   * toWalletDisplayState() below produces. This is the one call site that bridges
   * extension-host state into the webview; every message goes through this
   * transform, there is no second path that could accidentally post raw state.
   */
  private postWalletUpdate(state: import("./polling").PollResult<WalletBalanceState>): void {
    void this.view?.webview.postMessage({ type: "wallet", state: toWalletDisplayState(state) });
  }

  /** SettlementEntry.payer is a full Stellar address — same rule as the wallet's
   *  own payToAddress, it must never cross into the webview's JS context
   *  untruncated. Bridged through toSettlementsDisplayState below, the one path
   *  that ever turns SettlementsState into what postMessage actually sends. */
  private postSettlementsUpdate(state: import("./polling").PollResult<SettlementsState>): void {
    void this.view?.webview.postMessage({ type: "settlements", state: toSettlementsDisplayState(state) });
  }

  /** EarningsSummary is already only aggregate numbers/strings — no address of
   *  any kind, truncated or otherwise, so there is no display-transform needed
   *  here the way wallet/settlements require. computeEarnings runs against
   *  DataProvider's own SettlementsState (full, untruncated payer addresses),
   *  never against what was already sent to the webview — unique-payer counting
   *  must happen on real addresses, not ones already lossy-truncated to
   *  first4+last4, however unlikely a collision there would be. */
  private postEarningsUpdate(state: import("./polling").PollResult<SettlementsState>): void {
    if (state.status !== "ok") {
      void this.view?.webview.postMessage({ type: "earnings", state });
      return;
    }
    if (state.data.kind === "unconfigured") {
      void this.view?.webview.postMessage({ type: "earnings", state: { status: "ok", data: state.data } });
      return;
    }
    const summary = computeEarnings(state.data.entries);
    void this.view?.webview.postMessage({
      type: "earnings",
      state: { status: "ok", data: { kind: "loaded", summary } },
    });
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const msg = message as { type?: string };

    if (msg.type === "copyAddress") {
      // Re-read the live setting at the moment of the click, never trust a value
      // the webview might have echoed back — the webview never received the full
      // address in the first place (see renderWalletHtml), only the truncated
      // display form, so there is nothing sensitive for it to echo even if it
      // wanted to. The extension host is the only place that ever holds the full
      // address, and only for the duration of this one call.
      const address = DataProvider.getConfiguredAddress();
      if (address) void vscode.env.clipboard.writeText(address);
      return;
    }
    if (msg.type === "openSettings") {
      void vscode.commands.executeCommand("workbench.action.openSettings", "vellar-x402.payToAddress");
      return;
    }
    if (msg.type === "testPayment") {
      const resource = (message as { resource?: unknown }).resource;
      if (typeof resource === "string") void this.startTestPaymentForListing(resource);
      return;
    }
    if (msg.type === "testManualUrl") {
      const url = (message as { url?: unknown }).url;
      if (typeof url === "string") void this.startTestPaymentForManualUrl(url);
      return;
    }
  }

  /**
   * Looks up the live listing by resource URL (never trusts anything else
   * the webview might have echoed beyond that one string — the resource URL
   * itself is not sensitive, it's the same value already shown, unmodified,
   * on every endpoint card) and runs the full throwaway test-payment flow
   * against it inside a VS Code progress notification.
   */
  private async startTestPaymentForListing(resource: string): Promise<void> {
    const endpoints = this.dataProvider.endpoints.current;
    if (endpoints.status !== "ok" || endpoints.data.kind !== "loaded") return;
    const listing = endpoints.data.listings.find((l) => l.resource === resource);
    if (!listing) return; // stale click against a listing that's no longer in the current poll

    await this.runTestPaymentFlow({ kind: "listing", listing }, listing.resource);
  }

  /**
   * The "Test a URL" entry point in My Endpoints' empty state (see
   * renderEndpoints below) — for an endpoint that hasn't had a payment
   * settle against it yet, so it has no catalog listing to click Test on.
   *
   * Unlike startTestPaymentForListing, `url` here is genuinely user-typed
   * input from the webview, not an echo of something the extension host
   * already vouched for. Two checks specifically because of that:
   *  - looksLikeTestableResourceUrl (https, or http on localhost/127.0.0.1
   *    only) — format-only, same spirit as looksLikeStellarGAddress, rejects
   *    an obviously-wrong scheme before any network call.
   *  - runTestPayment itself (via discoverPaymentRequirement) never trusts
   *    payTo/amount as implied by the URL — both are read fresh from the
   *    endpoint's own real 402 challenge, the one place they can genuinely
   *    come from regardless of how untrusted the URL that produced them is.
   */
  private async startTestPaymentForManualUrl(url: string): Promise<void> {
    if (!looksLikeTestableResourceUrl(url)) {
      void vscode.window.showErrorMessage(
        "That doesn't look like a testable URL — use https://, or http:// on localhost/127.0.0.1 for local development.",
      );
      return;
    }
    await this.runTestPaymentFlow({ kind: "manualUrl", url }, url);
  }

  private async runTestPaymentFlow(target: TestPaymentTarget, resourceForTitle: string): Promise<void> {
    if (this.testPaymentInFlight) {
      void vscode.window.showInformationMessage("A test payment is already running — wait for it to finish.");
      return;
    }

    this.testPaymentInFlight = true;
    let settlementTx: string | undefined;
    try {
      settlementTx = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Test payment: ${resourceForTitle}`,
          cancellable: true,
        },
        (progress, token) => runTestPayment(target, progress, token),
      );
    } finally {
      // REAL BUG, FOUND AND FIXED: this reset used to happen only after the
      // success notification below (the one with a "View on stellar.expert"
      // button) was AWAITED — but showInformationMessage's promise does not
      // resolve until the user dismisses it or clicks a button. A real
      // payment could fully settle, then sit with testPaymentInFlight still
      // true for as long as that toast stayed on screen (which VS Code does
      // not force to disappear quickly, especially one with an action
      // button) — a second click on Test in that window incorrectly saw
      // "already running" for a flow that had, in fact, already finished.
      // Moving the reset here means it reflects EXACTLY "is runTestPayment
      // still executing", never something about an unrelated follow-up
      // notification's own lifecycle.
      this.testPaymentInFlight = false;
    }

    if (settlementTx) {
      const txUrl = `https://stellar.expert/explorer/testnet/tx/${settlementTx}`;
      const choice = await vscode.window.showInformationMessage(
        `Test payment settled: ${settlementTx.slice(0, 6)}…`,
        "View on stellar.expert",
      );
      if (choice === "View on stellar.expert") {
        void vscode.env.openExternal(vscode.Uri.parse(txUrl));
      }

      // Manual refresh so the new settlement/updated stats appear
      // immediately rather than waiting for the next 30-60s poll tick —
      // PollingSource.refresh()'s own rate floor still applies (see
      // polling.ts), so this is a request to refresh now, not a bypass of
      // the "max one request per interval" rule if one just happened to
      // fire moments ago. For a manual URL, this is also THE mechanism
      // that makes the endpoint show up in My Endpoints afterward — the
      // freshly-settled payment is what gets it catalogued.
      void this.dataProvider.endpoints.refresh();
      void this.dataProvider.settlements.refresh();
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const tokensUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "webview", "vellar-tokens.css"));
    const componentsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview", "vellar-components.css"),
    );

    // default-src 'none' denies everything not explicitly allowed below.
    // script-src: only this exact nonce's inline script — no external scripts,
    //   no unpinned inline script, ever.
    // style-src: this extension's own bundled stylesheets (via cspSource) plus
    //   Google Fonts' stylesheet host — the one external dependency, flagged in
    //   the build log, for Plus Jakarta Sans + Space Mono (already used by
    //   vellar.xyz, not a new brand dependency).
    // font-src: Google Fonts' font-file host, needed alongside its stylesheet host.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} https://fonts.googleapis.com`,
      "font-src https://fonts.gstatic.com",
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;700;800&family=Space+Mono:wght@400;700&display=swap" />
<link rel="stylesheet" href="${tokensUri}" />
<link rel="stylesheet" href="${componentsUri}" />
</head>
<body>
<div class="eyebrow">Wallet</div>
<div id="wallet-root">
  <div class="empty-state">Loading…</div>
</div>
<div class="eyebrow" style="margin-top: var(--sp-6);">My Endpoints</div>
<div id="endpoints-root">
  <div class="empty-state">Loading…</div>
</div>
<div class="eyebrow" style="margin-top: var(--sp-6);">Recent Settlements</div>
<div id="settlements-root">
  <div class="empty-state">Loading…</div>
</div>
<div class="eyebrow" style="margin-top: var(--sp-6);">Earnings Summary</div>
<div id="earnings-root">
  <div class="empty-state">Loading…</div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("wallet-root");

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function render(state) {
    if (state.status === "loading") {
      root.innerHTML = '<div class="empty-state">Loading…</div>';
      return;
    }
    if (state.status === "error") {
      root.innerHTML = '<div class="empty-state">Could not load data — check your connection.</div>';
      return;
    }
    const data = state.data;
    if (data.kind === "unconfigured") {
      root.innerHTML =
        '<div class="empty-state">Not configured.<br/><button class="btn btn--outline" id="open-settings">Open Settings</button></div>';
      document.getElementById("open-settings").addEventListener("click", () => {
        vscode.postMessage({ type: "openSettings" });
      });
      return;
    }
    if (data.kind === "invalid-address") {
      root.innerHTML =
        '<div class="empty-state">The configured payTo address doesn\\'t look like a valid Stellar address.<br/><button class="btn btn--outline" id="open-settings">Open Settings</button></div>';
      document.getElementById("open-settings").addEventListener("click", () => {
        vscode.postMessage({ type: "openSettings" });
      });
      return;
    }

    root.innerHTML = \`
      <div class="field">
        <div class="lbl">USDC balance</div>
        <div class="row"><span class="amt amt--lg">\${escapeHtml(data.usdcDisplay)}</span></div>
      </div>
      <div class="field">
        <div class="lbl">XLM balance</div>
        <div class="row"><span class="amt amt--sm">\${escapeHtml(data.xlmDisplay)}</span></div>
      </div>
      <div class="field">
        <div class="lbl">Payout address</div>
        <div class="sub"><span class="mono">\${escapeHtml(data.truncatedAddress)}</span>
          <button class="btn btn--outline" id="copy-address">Copy</button>
        </div>
      </div>
    \`;
    document.getElementById("copy-address").addEventListener("click", () => {
      vscode.postMessage({ type: "copyAddress" });
    });
  }

  // --- My Endpoints -------------------------------------------------------
  const endpointsRoot = document.getElementById("endpoints-root");
  const BADGE_LABEL = {
    verified: "Verified",
    "proven-unconfirmed": "Proven, unconfirmed",
    unverified: "Unverified",
    unknown: "Unknown",
  };

  // Small standalone copy of format.ts's relativeTime() — the webview's inline
  // script can't import a TS module across the extension-host/webview boundary,
  // so this is a deliberate, minimal duplication, not a missed reuse.
  function relativeTime(iso) {
    const diffSeconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (diffSeconds < 60) return "just now";
    const m = Math.round(diffSeconds / 60);
    if (m < 60) return \`\${m} minute\${m === 1 ? "" : "s"} ago\`;
    const h = Math.round(m / 60);
    if (h < 24) return \`\${h} hour\${h === 1 ? "" : "s"} ago\`;
    const d = Math.round(h / 24);
    return \`\${d} day\${d === 1 ? "" : "s"} ago\`;
  }

  function renderEndpoints(state) {
    if (state.status === "loading") {
      endpointsRoot.innerHTML = '<div class="empty-state">Loading…</div>';
      return;
    }
    if (state.status === "error") {
      endpointsRoot.innerHTML = '<div class="empty-state">Could not load data — check your connection.</div>';
      return;
    }
    const data = state.data;
    if (data.kind === "unconfigured") {
      endpointsRoot.innerHTML = '<div class="empty-state">Set your payout address to see your endpoints.</div>';
      return;
    }
    if (data.listings.length === 0) {
      // Copy reframed around "activate" rather than "test" — the underlying
      // flow (runTestPaymentFlow -> startTestPaymentForManualUrl) is
      // UNCHANGED, only the label/framing here changed, per the instruction.
      // "Activate" is used because this action's real effect is registering
      // the endpoint in the Bazaar's discovery catalog, not just verifying
      // it works — "Test" (kept on already-listed cards' own button, see
      // renderEndpoints below) is the more accurate word for a repeat
      // payment against something already listed.
      endpointsRoot.innerHTML = \`
        <div class="empty-state">
          No endpoints listed yet. Once you deploy your app, paste your live
          endpoint URL below to activate it — this fires a real payment that
          registers it in the Vellar Bazaar and makes it discoverable by
          developers and AI agents.
          <div class="test-url-form">
            <input type="text" id="test-url-input" class="mono" placeholder="https://your-endpoint.example.com/route" />
            <button class="btn btn--outline" id="test-url-submit">Activate endpoint</button>
          </div>
        </div>
      \`;
      const input = document.getElementById("test-url-input");
      document.getElementById("test-url-submit").addEventListener("click", () => {
        const url = input.value.trim();
        if (url) vscode.postMessage({ type: "testManualUrl", url });
      });
      return;
    }

    endpointsRoot.innerHTML = data.listings
      .map((listing) => {
        const settledLine =
          listing.lastSettled === undefined
            ? "never settled"
            : \`last settled \${relativeTime(listing.lastSettled)}\`;
        return \`
        <div class="endpoint-card">
          <a class="resource-link mono" href="\${escapeHtml(listing.resource)}" target="_blank" rel="noreferrer">\${escapeHtml(listing.resource)}</a>
          <div class="meta-row">
            <span class="price">\${escapeHtml(listing.priceLabel)}</span>
            <span class="badge badge--\${listing.ownershipState}">\${escapeHtml(BADGE_LABEL[listing.ownershipState] ?? "Unknown")}</span>
          </div>
          <div class="stats-row">
            <span>\${listing.settlements} settlement\${listing.settlements === 1 ? "" : "s"} · \${escapeHtml(settledLine)}</span>
            <button class="btn btn--outline" data-test-resource="\${escapeHtml(listing.resource)}" title="Fire a real testnet payment against this endpoint">Test</button>
          </div>
        </div>
      \`;
      })
      .join("");

    // The resource URL is the lookup key posted back to the extension host,
    // not an array index — indices go stale across re-renders/filtering, a
    // resource URL is the same stable identity the card already displays.
    // Nothing sensitive in this round-trip: it's the exact string already
    // visible, unmodified, in the anchor tag right next to this button.
    endpointsRoot.querySelectorAll("[data-test-resource]").forEach((btn) => {
      btn.addEventListener("click", () => {
        vscode.postMessage({ type: "testPayment", resource: btn.dataset.testResource });
      });
    });
  }

  // --- Recent Settlements --------------------------------------------------
  const settlementsRoot = document.getElementById("settlements-root");
  const STELLAR_EXPERT_TX_BASE = "https://stellar.expert/explorer/testnet/tx/";

  // Tx hash display truncation happens HERE, not on the extension-host side, on
  // purpose: a tx hash is public on-chain data, not a secret like the payout
  // address, but the link's href still needs the FULL hash even though only 6
  // chars show — truncating before it reaches the webview would break the link
  // itself, not just the label.
  function truncateTxHash(hash) {
    return hash.length <= 6 ? hash : \`\${hash.slice(0, 6)}…\`;
  }

  function renderSettlements(state) {
    if (state.status === "loading") {
      settlementsRoot.innerHTML = '<div class="empty-state">Loading…</div>';
      return;
    }
    if (state.status === "error") {
      settlementsRoot.innerHTML = '<div class="empty-state">Could not load data — check your connection.</div>';
      return;
    }
    const data = state.data;
    if (data.kind === "unconfigured") {
      settlementsRoot.innerHTML = '<div class="empty-state">Set your payout address to see your settlements.</div>';
      return;
    }
    if (data.entries.length === 0) {
      settlementsRoot.innerHTML = '<div class="empty-state">No settlements yet.</div>';
      return;
    }

    settlementsRoot.innerHTML = data.entries
      .map(
        (entry) => \`
        <div class="settlement-row">
          <div class="settlement-main">
            <span class="settlement-amount">\${escapeHtml(entry.amountLabel)}</span>
            <span class="settlement-payer mono">\${escapeHtml(entry.truncatedPayer)}</span>
          </div>
          <div class="settlement-meta">
            <span class="settlement-time">\${escapeHtml(relativeTime(entry.closedAt))}</span>
            <a class="settlement-tx-link" href="\${STELLAR_EXPERT_TX_BASE}\${encodeURIComponent(entry.txHash)}" target="_blank" rel="noreferrer">\${escapeHtml(truncateTxHash(entry.txHash))}</a>
          </div>
        </div>
      \`,
      )
      .join("");
  }

  // --- Earnings Summary -----------------------------------------------------
  const earningsRoot = document.getElementById("earnings-root");

  function renderEarnings(state) {
    if (state.status === "loading") {
      earningsRoot.innerHTML = '<div class="empty-state">Loading…</div>';
      return;
    }
    if (state.status === "error") {
      earningsRoot.innerHTML = '<div class="empty-state">Could not load data — check your connection.</div>';
      return;
    }
    const data = state.data;
    if (data.kind === "unconfigured") {
      earningsRoot.innerHTML = '<div class="empty-state">Set your payout address to see your earnings.</div>';
      return;
    }
    const s = data.summary;
    if (s.basedOnCount === 0) {
      earningsRoot.innerHTML = '<div class="empty-state">No settlements yet.</div>';
      return;
    }

    earningsRoot.innerHTML = \`
      <div class="stat-grid">
        <div class="field">
          <div class="lbl">Total earned</div>
          <div class="row"><span class="amt amt--lg">\${escapeHtml(s.totalUsdcLabel)}</span></div>
        </div>
        <div class="field">
          <div class="lbl">Earned today</div>
          <div class="row"><span class="amt amt--sm">\${escapeHtml(s.todayUsdcLabel)}</span></div>
        </div>
        <div class="field">
          <div class="lbl">Earned this week</div>
          <div class="row"><span class="amt amt--sm">\${escapeHtml(s.thisWeekUsdcLabel)}</span></div>
        </div>
        <div class="field">
          <div class="lbl">Unique payers</div>
          <div class="row"><span class="amt amt--sm">\${s.uniquePayers}</span></div>
        </div>
      </div>
      <div class="earnings-note">Based on your \${s.basedOnCount} most recent settlement\${s.basedOnCount === 1 ? "" : "s"}.</div>
    \`;
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type === "wallet") render(event.data.state);
    if (event.data?.type === "endpoints") renderEndpoints(event.data.state);
    if (event.data?.type === "settlements") renderSettlements(event.data.state);
    if (event.data?.type === "earnings") renderEarnings(event.data.state);
  });
</script>
</body>
</html>`;
  }
}

/**
 * Strips EndpointListing down to exactly the fields the webview's own
 * renderEndpoints() reads (resource, priceLabel, ownershipState, settlements,
 * lastSettled) — payTo/amount/asset are extension-host-only fields
 * (runTestPayment's own assertion + funding-target math need them; the
 * webview render function never did). See postEndpointsUpdate's own comment
 * for why this function exists: it didn't, for two steps, and that was a
 * real leak.
 */
export function toEndpointsDisplayState(
  state: import("./polling").PollResult<EndpointsState>,
): import("./polling").PollResult<
  | { kind: "unconfigured" }
  | {
      kind: "loaded";
      listings: {
        resource: string;
        priceLabel: string;
        ownershipState: "verified" | "proven-unconfirmed" | "unverified" | "unknown";
        settlements: number;
        lastSettled: string | undefined;
      }[];
    }
> {
  if (state.status !== "ok") return state;
  const data = state.data;
  if (data.kind !== "loaded") return { status: "ok", data };
  return {
    status: "ok",
    data: {
      kind: "loaded",
      listings: data.listings.map((listing) => ({
        resource: listing.resource,
        priceLabel: listing.priceLabel,
        ownershipState: listing.ownershipState,
        settlements: listing.settlements,
        lastSettled: listing.lastSettled,
      })),
    },
  };
}

/** Shapes a WalletBalanceState into exactly the display strings the webview
 *  is allowed to see — the full address never crosses into the webview's own
 *  JS context, only its truncated form. Kept here, next to the HTML it feeds,
 *  rather than in dataProvider.ts, which has no reason to know about display
 *  formatting. */
export function toWalletDisplayState(
  state: import("./polling").PollResult<WalletBalanceState>,
): import("./polling").PollResult<
  | { kind: "unconfigured" }
  | { kind: "invalid-address" }
  | { kind: "loaded"; usdcDisplay: string; xlmDisplay: string; truncatedAddress: string }
> {
  if (state.status !== "ok") return state;
  const data = state.data;
  if (data.kind !== "loaded") return { status: "ok", data };
  return {
    status: "ok",
    data: {
      kind: "loaded",
      // Horizon's classic balance field is already decimal — formatDecimalAmount
      // only comma-groups it, it does not (and must not) scale it further.
      usdcDisplay: `${formatDecimalAmount(data.usdc)} USDC`,
      xlmDisplay: `${formatDecimalAmount(data.xlm)} XLM`,
      truncatedAddress: truncateMiddle(data.address),
    },
  };
}

/** Same rule as toWalletDisplayState above, applied to SettlementEntry.payer:
 *  the full payer address is truncated HERE, at the one bridge into the
 *  webview's JS context, never left for the webview script to truncate itself
 *  (which would mean the full address had to cross the boundary first). txHash
 *  is deliberately passed through untouched — display-truncating it is the
 *  webview's job (see renderHtml's truncateTxHash), since the link href needs
 *  the full hash even when the label doesn't. */
export function toSettlementsDisplayState(
  state: import("./polling").PollResult<SettlementsState>,
): import("./polling").PollResult<
  | { kind: "unconfigured" }
  | { kind: "loaded"; entries: { txHash: string; amountLabel: string; truncatedPayer: string; closedAt: string }[] }
> {
  if (state.status !== "ok") return state;
  const data = state.data;
  if (data.kind !== "loaded") return { status: "ok", data };
  return {
    status: "ok",
    data: {
      kind: "loaded",
      entries: data.entries.map((entry) => ({
        txHash: entry.txHash,
        amountLabel: entry.amountLabel,
        truncatedPayer: truncateMiddle(entry.payer),
        closedAt: entry.closedAt,
      })),
    },
  };
}
