/**
 * The first-run welcome panel: three steps (set payTo, open a route file, run
 * the command), tracked via globalState so it shows exactly once per install.
 *
 * SECURITY, same standard as sidebar/webviewProvider.ts:
 *  - The full payToAddress NEVER crosses into this webview's JS context —
 *    only a boolean ("is it set") ever gets posted, computed at the one
 *    bridge point (postStepsUpdate) the same way toWalletDisplayState draws
 *    that line for the sidebar. There is no "confirm the value" path here at
 *    all, only "confirm it is non-empty."
 *  - CSP: nonce-only inline script, same external-stylesheet exception the
 *    sidebar already has (Google Fonts, for the same two faces, same
 *    reasoning — see renderHtml below and webviewProvider.ts's own CSP
 *    comment). No other external host, no external script, ever.
 *  - retainContextWhenHidden is not set (defaults to false) — same as the
 *    sidebar, and this panel only needs to exist for the handful of minutes
 *    a first-run onboarding takes, not to survive being hidden.
 */

import * as vscode from "vscode";
import * as crypto from "node:crypto";

const GLOBAL_STATE_KEY = "vellar-x402.onboardingState";

interface OnboardingState {
  completed: boolean;
}

/** True the very first time this runs (no prior globalState) — genuinely a
 *  once-ever check, not tied to whether the PANEL was shown, only to whether
 *  onboarding was ever completed or dismissed. See markShown()'s own comment
 *  for why "shown" and "completed" are deliberately the same flag here. */
export function hasCompletedOnboarding(globalState: vscode.Memento): boolean {
  return globalState.get<OnboardingState>(GLOBAL_STATE_KEY, { completed: false }).completed;
}

async function markOnboardingShown(globalState: vscode.Memento): Promise<void> {
  await globalState.update(GLOBAL_STATE_KEY, { completed: true } satisfies OnboardingState);
}

export type StepId = "payTo" | "routeFile" | "command";
export type StepStatus = "pending" | "active" | "done";

interface StepsSnapshot {
  payTo: StepStatus;
  routeFile: StepStatus;
  command: StepStatus;
}

/**
 * Manages one onboarding panel's lifecycle: wires the three completion
 * listeners (config change, doc open, command success), tracks step state in
 * memory only (nothing about IN-PROGRESS step state is persisted — only the
 * final "onboarding is done" flag is, via markOnboardingShown), and renders
 * the webview. A fresh instance is created each time the panel is opened
 * (see showOnboardingIfFirstRun / the "Show Vellar Onboarding" command) —
 * there is never more than one live panel, VS Code's own
 * `revealColumn`-style singleton pattern isn't needed here since this is
 * shown at most once automatically and is otherwise a deliberate re-open.
 */
export class OnboardingPanel {
  public static readonly viewType = "vellar-x402.onboarding";

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private steps: StepsSnapshot;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalState: vscode.Memento,
    private readonly onCommandSuccess: vscode.Event<void>,
  ) {
    const payToAlreadySet = (vscode.workspace.getConfiguration("vellar-x402").get<string>("payToAddress", "") ?? "")
      .trim().length > 0;
    this.steps = {
      payTo: payToAlreadySet ? "done" : "active",
      routeFile: "pending",
      command: "pending",
    };

    this.panel = vscode.window.createWebviewPanel(
      OnboardingPanel.viewType,
      "Welcome to Vellar x402",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
        retainContextWhenHidden: false,
      },
    );
    this.panel.webview.html = this.renderHtml(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message), undefined, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    this.wireCompletionListeners();
    this.postStepsUpdate();
  }

  static open(
    extensionUri: vscode.Uri,
    globalState: vscode.Memento,
    onCommandSuccess: vscode.Event<void>,
  ): OnboardingPanel {
    return new OnboardingPanel(extensionUri, globalState, onCommandSuccess);
  }

  private wireCompletionListeners(): void {
    // Step 1: payTo address becomes non-empty. Fires on ANY configuration
    // change, so this narrows to the one section/key that matters — a
    // change to an unrelated setting must not spuriously re-check this.
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("vellar-x402.payToAddress")) return;
        const value = (vscode.workspace.getConfiguration("vellar-x402").get<string>("payToAddress", "") ?? "").trim();
        this.updateStep("payTo", value.length > 0 ? "done" : "active");
      }),
    );

    // Step 2: any .js/.ts/.mjs file opened, per the instruction's exact
    // extension list — deliberately NOT reusing SUPPORTED_LANGUAGES from
    // extension.ts (that set is about what addPayment can inject into,
    // .jsx/.tsx included; this step is specifically "opened a route FILE",
    // scoped to exactly the three extensions named, matching the instruction
    // literally rather than silently broadening it).
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        const path = doc.uri.fsPath.toLowerCase();
        if (path.endsWith(".js") || path.endsWith(".ts") || path.endsWith(".mjs")) {
          this.updateStep("routeFile", "done");
        }
      }),
    );

    // Step 3: addPayment's own successful-injection event, fired from
    // extension.ts at the exact point injection actually succeeded — not a
    // guess re-derived from some other signal, the real completion event the
    // instruction asks for.
    this.disposables.push(
      this.onCommandSuccess(() => this.updateStep("command", "done")),
    );
  }

  private updateStep(id: StepId, status: StepStatus): void {
    if (this.steps[id] === status) return; // no-op, avoid a redundant postMessage
    this.steps = { ...this.steps, [id]: status };
    // Advance the NEXT pending step to "active" once its predecessor
    // completes, so the progress indicator always has exactly one active
    // step (until all three are done) — matches the "current active step"
    // language in the design spec, not just done/pending with no notion of
    // "next."
    if (id === "payTo" && status === "done" && this.steps.routeFile === "pending") {
      this.steps = { ...this.steps, routeFile: "active" };
    }
    if (id === "routeFile" && status === "done" && this.steps.command === "pending") {
      this.steps = { ...this.steps, command: "active" };
    }
    this.postStepsUpdate();

    if (this.steps.payTo === "done" && this.steps.routeFile === "done" && this.steps.command === "done") {
      void markOnboardingShown(this.globalState);
      // Auto-open the sidebar the moment all three steps complete, rather
      // than making the developer notice and click the completion panel's
      // own button. That button stays too (renderHtml below) — VS Code's
      // view-reveal behavior can vary by platform/window state, so it's a
      // guaranteed fallback if the auto-open doesn't end up focused. This
      // `if` block only runs on the transition INTO all-three-done (guarded
      // by updateStep's own early return above whenever a status doesn't
      // actually change), so this fires once per completion, not on every
      // subsequent no-op call.
      void vscode.commands.executeCommand("workbench.view.extension.vellar-x402");
    }
  }

  private postStepsUpdate(): void {
    // Only booleans/status strings cross this boundary — never the
    // payToAddress value itself, matching the instruction's explicit rule.
    void this.panel.webview.postMessage({ type: "steps", steps: this.steps });
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const msg = message as { type?: string };

    if (msg.type === "openSettings") {
      void vscode.commands.executeCommand("workbench.action.openSettings", "vellar-x402.payToAddress");
      return;
    }
    if (msg.type === "openSidebar") {
      // Reveals the activity-bar view container, per the instruction — the
      // container id from package.json's viewsContainers.activitybar, not
      // the individual view id (that's what focuses the webview view
      // specifically, which VS Code does automatically once its container
      // is visible).
      void vscode.commands.executeCommand("workbench.view.extension.vellar-x402");
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const tokensUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "webview", "vellar-tokens.css"));
    const componentsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview", "vellar-components.css"),
    );
    const onboardingUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview", "vellar-onboarding.css"),
    );

    // Same CSP as the sidebar's own (see webviewProvider.ts's comment): the
    // one external host is Google Fonts, inherited from the design system
    // itself, not a new dependency introduced for this panel.
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
<link rel="stylesheet" href="${onboardingUri}" />
</head>
<body>
<div class="onboarding-shell">
  <div class="eyebrow">Vellar x402</div>
  <h1 class="onboarding-title">Get your first endpoint earning</h1>
  <p class="onboarding-sub">Three steps, then your endpoint is live in the Bazaar.</p>

  <ol class="step-list" id="step-list">
    <li class="step-item" data-step="payTo">
      <div class="step-marker"></div>
      <div class="step-body">
        <div class="step-title">1. Set your payTo address</div>
        <div class="step-explainer">This is the Stellar wallet address that receives USDC every time someone pays your endpoint.</div>
        <div class="step-detail">
          <span id="payto-status" class="mono step-status-text">Checking…</span>
          <button class="btn btn--outline" id="open-settings">Open Settings</button>
        </div>
      </div>
    </li>
    <li class="step-item" data-step="routeFile">
      <div class="step-marker"></div>
      <div class="step-body">
        <div class="step-title">2. Open a route file</div>
        <div class="step-explainer">
          A "route" is any HTTP endpoint handler in your project — Express, Fastify, or a Next.js
          App Router file. Open the file that has the route you want to charge for, for example:
        </div>
        <pre class="code-sample mono"><code>app.get("/weather", (req, res) =&gt; {
  res.json({ temp: 72 });
});</code></pre>
        <div class="step-detail">Any .js, .ts, or .mjs file with a route like this counts.</div>
      </div>
    </li>
    <li class="step-item" data-step="command">
      <div class="step-marker"></div>
      <div class="step-body">
        <div class="step-title">3. Run the command</div>
        <div class="step-explainer">
          Open the Command Palette (<span class="mono">Cmd/Ctrl+Shift+P</span>), type
          <span class="mono">Vellar</span>, and run:
        </div>
        <div class="command-sample mono">Vellar: Add x402 payment to this endpoint</div>
        <div class="step-detail">Pick your route from the list, enter a price in USDC, and the payment gate is added automatically.</div>
      </div>
    </li>
  </ol>

  <div id="completion-panel" class="completion-panel" hidden>
    <p class="completion-message">Once you deploy your app and activate your endpoint, any developer or AI agent can discover and pay it.</p>
    <p class="completion-detail">
      Deploy your app, then paste your live URL into <strong>My Endpoints</strong> and click
      <strong>"Activate endpoint"</strong> to send a real test payment.
      Your endpoint will appear in the sidebar once it settles.
    </p>
    <button class="btn" id="open-sidebar">Open the Vellar sidebar</button>
  </div>
</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  document.getElementById("open-settings").addEventListener("click", () => {
    vscode.postMessage({ type: "openSettings" });
  });
  document.getElementById("open-sidebar").addEventListener("click", () => {
    vscode.postMessage({ type: "openSidebar" });
  });

  const STATUS_LABEL = { pending: "Not yet", active: "Waiting…", done: "Done" };

  function render(steps) {
    for (const id of ["payTo", "routeFile", "command"]) {
      const item = document.querySelector(\`[data-step="\${id}"]\`);
      item.classList.remove("step-item--done", "step-item--active");
      if (steps[id] === "done") item.classList.add("step-item--done");
      if (steps[id] === "active") item.classList.add("step-item--active");
    }

    // Step 1's status text — the ONLY thing shown here is "is it set", never
    // the address value itself: the extension host never sends the value,
    // only the status string, so there is nothing sensitive for this to
    // even accidentally echo.
    document.getElementById("payto-status").textContent =
      steps.payTo === "done" ? "✓ Address set" : "Not set yet";

    // The completed steps stay visible (each shown with its mint "done"
    // marker) once the completion panel appears — this is confirmation of
    // what was just finished, not a screen to navigate away from.
    const allDone = steps.payTo === "done" && steps.routeFile === "done" && steps.command === "done";
    document.getElementById("completion-panel").hidden = !allDone;
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type === "steps") render(event.data.steps);
  });
</script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
