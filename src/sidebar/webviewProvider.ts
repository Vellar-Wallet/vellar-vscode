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
import { logAndGenericError } from "./outputChannel";
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

  /**
   * Recent Settlements pagination state — owned entirely here, not in
   * DataProvider (mirrors DataProvider never owning "which page/tab is
   * shown" for any other section) and not in the webview's own JS (a fresh
   * webview loses all JS-side state every time it's hidden, since
   * retainContextWhenHidden is false — see this class's own doc comment).
   *
   * settlementsSource (DataProvider.settlements) ALWAYS polls page 1 only —
   * see fetchSettlements' own comment for why that must never change.
   * Pages beyond 1 are fetched on demand via DataProvider.fetchSettlementsPage
   * and held here, independent of the poller entirely.
   *
   * cursorStack[0] is always undefined (page 1 needs no cursor); cursorStack[n]
   * is the cursor that fetches page n+1, pushed the first time Next reaches a
   * page not visited yet. pageIndex is 0 when on page 1 (in which case the
   * poller's own current/onDidUpdate data IS the display state — no separate
   * fetch happens for page 1, see postSettlementsUpdate).
   */
  private settlementsCursorStack: (string | undefined)[] = [undefined];
  private settlementsPageIndex = 0;
  /** Only used while pageIndex > 0 — the last on-demand page fetch's result,
   *  since the poller's `.current` only ever reflects page 1. Left stale
   *  (unused) whenever pageIndex returns to 0, at which point page-1 data
   *  always comes from the poller directly instead. */
  private settlementsPagedResult: import("./polling").PollResult<SettlementsState> | undefined;
  /** The newest entry's txHash last shown on page 1, used to detect "the poller
   *  just saw a genuinely new settlement" (vs. just another poll tick with an
   *  unchanged top entry) so Recent Settlements can snap back to page 1 only
   *  when there is actually something new to show there — see
   *  handleSettlementsPollUpdate. undefined until the first "ok" page-1 result
   *  ever arrives, so the very first load never counts as "new". */
  private settlementsKnownTopTxHash: string | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly dataProvider: DataProvider,
  ) {
    this.gate.add(this.dataProvider.wallet);
    this.gate.add(this.dataProvider.endpoints);
    this.gate.add(this.dataProvider.settlements);
    this.dataProvider.wallet.onDidUpdate((result) => this.postWalletUpdate(result));
    this.dataProvider.endpoints.onDidUpdate((result) => this.postEndpointsUpdate(result));
    this.dataProvider.settlements.onDidUpdate((result) => this.handleSettlementsPollUpdate(result));

    vscode.window.onDidChangeWindowState((state) => this.gate.setFocused(state.focused));
  }

  /**
   * Every page-1 poll tick arrives here (unconditionally — the poller itself
   * is untouched by pagination, see the settlementsCursorStack doc comment
   * above). Earnings Summary always recomputes from this page-1 data,
   * regardless of what page Recent Settlements is currently showing — that
   * was an explicit, deliberate choice: earnings stays "based on your N most
   * recent settlements" and never means something different depending on
   * pagination state.
   *
   * Recent Settlements itself only re-renders from THIS poll data when the
   * developer is on page 1 (pageIndex === 0) OR when this tick's newest
   * entry is genuinely new compared to the last one this class has seen —
   * in the latter case the view snaps back to page 1 to surface it, exactly
   * the "new settlement arrived while paging" behavior chosen for this
   * feature. A tick whose newest txHash is unchanged never touches a paged
   * (pageIndex > 0) view the developer might currently be looking at.
   */
  private handleSettlementsPollUpdate(result: import("./polling").PollResult<SettlementsState>): void {
    this.postEarningsUpdate(result);

    if (result.status !== "ok" || result.data.kind !== "loaded") {
      // loading/error/unconfigured: only page 1 could ever be affected, and
      // only page 1 is ever this poller's concern — a paged view keeps
      // showing its own last-fetched page/error untouched.
      if (this.settlementsPageIndex === 0) this.postSettlementsUpdate(result);
      return;
    }

    const newTopTxHash = result.data.entries[0]?.txHash;
    const isGenuinelyNew =
      this.settlementsKnownTopTxHash !== undefined &&
      newTopTxHash !== undefined &&
      newTopTxHash !== this.settlementsKnownTopTxHash;
    this.settlementsKnownTopTxHash = newTopTxHash;

    if (isGenuinelyNew && this.settlementsPageIndex !== 0) {
      // Snap back to page 1 so the new settlement is immediately visible,
      // per the chosen "new data pulls the view back to page 1" behavior.
      this.settlementsPageIndex = 0;
      this.settlementsCursorStack = [undefined];
      this.settlementsPagedResult = undefined;
    }

    if (this.settlementsPageIndex === 0) this.postSettlementsUpdate(result);
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
        this.postSettlementsUpdate(this.currentSettlementsResult());
        this.postEarningsUpdate(this.dataProvider.settlements.current);
      }
    });
    this.gate.setVisible(webviewView.visible);

    // A fresh webview (every reveal, given retainContextWhenHidden: false) starts
    // with no data of its own — send whatever the DataProvider already has
    // immediately, rather than waiting for the next poll tick. Settlements
    // specifically uses currentSettlementsResult(), NOT
    // dataProvider.settlements.current directly, so a webview rebuilt while
    // the developer was on page 2/3 (e.g. the sidebar was hidden and shown
    // again) redraws the page it was actually on, not silently back to page 1.
    this.postWalletUpdate(this.dataProvider.wallet.current);
    this.postEndpointsUpdate(this.dataProvider.endpoints.current);
    this.postSettlementsUpdate(this.currentSettlementsResult());
    this.postEarningsUpdate(this.dataProvider.settlements.current);
  }

  /** The result that should currently be shown for Recent Settlements —
   *  the poller's own page-1 data while pageIndex is 0, or the last
   *  on-demand page fetch otherwise. The one place both resolveWebviewView
   *  and the visibility-change handler read from, so a webview rebuild never
   *  has its own separate (and easy to get out of sync) copy of this logic. */
  private currentSettlementsResult(): import("./polling").PollResult<SettlementsState> {
    if (this.settlementsPageIndex === 0) return this.dataProvider.settlements.current;
    return this.settlementsPagedResult ?? { status: "loading" };
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
   *  that ever turns SettlementsState into what postMessage actually sends.
   *
   *  Pagination metadata (page number, hasPrev, hasNext) is computed HERE from
   *  this class's own cursor-stack state, not carried inside SettlementsState
   *  itself — DataProvider has no notion of "which page is currently shown",
   *  by design (see settlementsCursorStack's own doc comment). */
  private postSettlementsUpdate(state: import("./polling").PollResult<SettlementsState>): void {
    const page = this.settlementsPageIndex + 1;
    const hasPrev = this.settlementsPageIndex > 0;
    const hasNext = state.status === "ok" && state.data.kind === "loaded" && state.data.nextCursor !== undefined;
    void this.view?.webview.postMessage({
      type: "settlements",
      state: toSettlementsDisplayState(state),
      pagination: { page, hasPrev, hasNext },
    });
  }

  /**
   * Prev/Next click handler (see handleMessage's "settlementsPage" case).
   * `direction` is exactly "prev" or "next" — validated in handleMessage
   * before this is ever called, same "narrow at the message boundary"
   * discipline testPayment/testManualUrl already use for their own payloads.
   *
   * Page 1 (pageIndex 0) is never fetched here — it always comes from
   * settlementsSource's own poller/current, per fetchSettlements' own
   * comment on why paging must stay independent of the always-on poll. Only
   * pageIndex > 0 ever calls DataProvider.fetchSettlementsPage.
   */
  private async goToSettlementsPage(direction: "prev" | "next"): Promise<void> {
    if (direction === "prev") {
      if (this.settlementsPageIndex === 0) return; // already on page 1, nothing to do
      this.settlementsPageIndex -= 1;

      if (this.settlementsPageIndex === 0) {
        // Back on page 1 — the poller's own current data is authoritative,
        // no fetch needed.
        this.settlementsPagedResult = undefined;
        this.postSettlementsUpdate(this.dataProvider.settlements.current);
        return;
      }

      // Back to a page between 1 and the one we just left (page
      // settlementsPageIndex + 1, 1-indexed) — re-fetch it using the cursor
      // that reaches it, which is whatever page settlementsPageIndex - 1
      // (1-indexed) stored at the time IT was first reached. Re-fetching
      // rather than caching full page content: settlements are append-only
      // from the newest end, so an already-visited page's content genuinely
      // doesn't change, but re-fetching is simpler than a full page cache
      // and costs one extra request, not a correctness issue either way.
      const cursorForThisPage = this.settlementsCursorStack[this.settlementsPageIndex - 1];
      await this.fetchAndShowSettlementsPage(cursorForThisPage);
      return;
    }

    // direction === "next"
    const currentResult = this.currentSettlementsResult();
    const nextCursor =
      currentResult.status === "ok" && currentResult.data.kind === "loaded" ? currentResult.data.nextCursor : undefined;
    if (nextCursor === undefined) return; // already on the last known page, nothing to do

    this.settlementsPageIndex += 1;
    // settlementsCursorStack[i] holds the cursor that reaches page i+2
    // (1-indexed pages, 0-indexed stack) — captured HERE, from the page we
    // are LEAVING's own nextCursor, at the exact moment we leave it, rather
    // than read back out of the stack after the index already moved. This
    // is also what makes a later Prev-then-Next-again reach the same page
    // without re-deriving its cursor from scratch.
    this.settlementsCursorStack[this.settlementsPageIndex - 1] = nextCursor;
    await this.fetchAndShowSettlementsPage(nextCursor);
  }

  /** Shared by both the "reach a page beyond 1 for the first time" and
   *  "re-fetch a previously-visited page beyond 1" paths in
   *  goToSettlementsPage above — posts a "loading" state immediately, then
   *  the real result once DataProvider.fetchSettlementsPage resolves (or an
   *  "error" result if it rejects, same one-path-to-a-user-visible-error
   *  rule logAndGenericError enforces everywhere else in this file). */
  private async fetchAndShowSettlementsPage(cursor: string | undefined): Promise<void> {
    this.postSettlementsUpdate({ status: "loading" });
    let result: import("./polling").PollResult<SettlementsState>;
    try {
      const data = await this.dataProvider.fetchSettlementsPage(cursor);
      result = { status: "ok", data };
    } catch (err) {
      logAndGenericError("settlement page fetch failed", err);
      result = { status: "error" };
    }
    this.settlementsPagedResult = result;
    this.postSettlementsUpdate(result);
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
    if (msg.type === "settlementsPage") {
      // Narrowed to exactly "prev"/"next" here, same "never trust the
      // webview's payload beyond a known-safe shape" rule copyAddress/
      // testManualUrl already follow above — an unrecognized value is
      // silently ignored rather than acted on.
      const direction = (message as { direction?: unknown }).direction;
      if (direction === "prev" || direction === "next") void this.goToSettlementsPage(direction);
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
    if (data.kind === "unfunded") {
      root.innerHTML = \`
        <div class="field">
          <div class="lbl">Payout address</div>
          <div class="sub"><span class="mono">\${escapeHtml(data.truncatedAddress)}</span></div>
        </div>
        <div class="field field--warning">
          This address is not yet funded on Stellar. Fund it with XLM first, then open a USDC trustline.
        </div>
      \`;
      return;
    }

    // Amber, not red (--coral): a missing trustline is a precondition the
    // developer hasn't completed yet, not an error state — they can still use
    // every other part of the extension, they just can't receive USDC until
    // this is done. Reuses .field's own clip-cut shape via the
    // --field-border/--field-fill override hooks it already exposes, rather
    // than inventing a second box style for what's still fundamentally a
    // labeled info card.
    const trustlineWarning = data.hasTrustline
      ? ""
      : \`<div class="field field--warning">
          Your wallet has no USDC trustline. Payments to this address will fail on-chain.
          Open a trustline first in <a href="https://freighter.app" target="_blank" rel="noreferrer">Freighter</a>
          or <a href="https://laboratory.stellar.org" target="_blank" rel="noreferrer">Stellar Laboratory</a>.
        </div>\`;

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
      \${trustlineWarning}
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
    // The manual-URL "Activate endpoint" form is ALWAYS rendered below,
    // regardless of how many listings already exist — a developer selling
    // more than one endpoint needs to activate a second, third, etc. without
    // ever going back to zero listings, which was the only way to reach this
    // form before. Only the copy immediately around it changes: the
    // empty-state explanation when there's nothing yet, vs. a short
    // "Activate another endpoint" label once at least one listing exists —
    // the underlying flow (runTestPaymentFlow -> startTestPaymentForManualUrl,
    // via the exact same "testManualUrl" postMessage) is IDENTICAL either way
    // and doesn't care how many listings existed when it was sent.
    //
    // "Activate" (not "Test") is used here because this action's intent is
    // registering the endpoint in the Bazaar's discovery catalog, not just
    // verifying it works — "Test" (kept on each already-listed card's own
    // button below) is the more accurate word for a repeat payment against
    // something already listed. Registration only actually happens if the
    // route declares the Bazaar discovery extension (see
    // generators/shared.ts's renderExtensionsField) — the payment alone
    // does not guarantee it, so neither copy states that as a certainty.
    const activateFormHtml = \`
      <div class="activate-endpoint-form">
        <div class="test-url-form">
          <div class="test-url-input-frame">
            <input type="text" id="test-url-input" class="mono" placeholder="https://your-endpoint.example.com/route" />
          </div>
          <button class="btn btn--outline" id="test-url-submit">Activate endpoint</button>
        </div>
      </div>
    \`;

    if (data.listings.length === 0) {
      endpointsRoot.innerHTML = \`
        <div class="empty-state">
          No endpoints listed yet. Once you deploy your app, paste your live
          endpoint URL below and click Activate endpoint to send a real test
          payment. If your route includes the Bazaar discovery extension
          (added automatically by the Add x402 payment command), your
          endpoint will appear here after the payment settles.
        </div>
        \${activateFormHtml}
      \`;
    } else {
      const cardsHtml = data.listings
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

      endpointsRoot.innerHTML = \`
        \${cardsHtml}
        <div class="activate-another-label">Activate another endpoint</div>
        \${activateFormHtml}
      \`;
    }

    // Wired unconditionally — the form above is always in the DOM now
    // (empty-state or listings-present branch alike), so this listener
    // attachment no longer needs its own early "return" the way the old
    // empty-state-only branch did.
    const input = document.getElementById("test-url-input");
    document.getElementById("test-url-submit").addEventListener("click", () => {
      const url = input.value.trim();
      if (url) vscode.postMessage({ type: "testManualUrl", url });
    });

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

  // pagination is undefined on a "loading"/"error"/first-ever message (the
  // extension host always sends it alongside settlements state today, but
  // this function still degrades to "no pager" rather than throwing if it
  // were ever missing — same defensiveness as every other field read off
  // event.data below).
  function renderSettlements(state, pagination) {
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
    if (data.entries.length === 0 && (!pagination || pagination.page === 1)) {
      settlementsRoot.innerHTML = '<div class="empty-state">No settlements yet.</div>';
      return;
    }

    const rows = data.entries
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

    // The pager only ever needs to show once there's somewhere else to go —
    // page 1 with no next page (the common case for a developer with only a
    // few settlements) shows no pager at all, matching how this sidebar
    // never shows controls with nothing for them to do.
    const showPager = pagination && (pagination.hasPrev || pagination.hasNext);
    const pagerHtml = !showPager
      ? ""
      : \`
        <div class="settlements-pager">
          <button class="btn btn--outline" id="settlements-prev" \${pagination.hasPrev ? "" : "disabled"}>← Prev</button>
          <span class="settlements-pager-label">Page \${pagination.page}</span>
          <button class="btn btn--outline" id="settlements-next" \${pagination.hasNext ? "" : "disabled"}>Next →</button>
        </div>
      \`;

    settlementsRoot.innerHTML = rows + pagerHtml;

    if (showPager) {
      const prevBtn = document.getElementById("settlements-prev");
      const nextBtn = document.getElementById("settlements-next");
      if (pagination.hasPrev) prevBtn.addEventListener("click", () => vscode.postMessage({ type: "settlementsPage", direction: "prev" }));
      if (pagination.hasNext) nextBtn.addEventListener("click", () => vscode.postMessage({ type: "settlementsPage", direction: "next" }));
    }
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
    if (event.data?.type === "settlements") renderSettlements(event.data.state, event.data.pagination);
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
  | { kind: "unfunded"; truncatedAddress: string }
  | {
      kind: "loaded";
      usdcDisplay: string;
      xlmDisplay: string;
      truncatedAddress: string;
      hasTrustline: boolean;
    }
> {
  if (state.status !== "ok") return state;
  const data = state.data;
  if (data.kind === "unconfigured" || data.kind === "invalid-address") return { status: "ok", data };
  if (data.kind === "unfunded") {
    return { status: "ok", data: { kind: "unfunded", truncatedAddress: truncateMiddle(data.address) } };
  }
  return {
    status: "ok",
    data: {
      kind: "loaded",
      // Horizon's classic balance field is already decimal — formatDecimalAmount
      // only comma-groups it, it does not (and must not) scale it further.
      usdcDisplay: `${formatDecimalAmount(data.usdc)} USDC`,
      xlmDisplay: `${formatDecimalAmount(data.xlm)} XLM`,
      truncatedAddress: truncateMiddle(data.address),
      hasTrustline: data.hasTrustline,
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
