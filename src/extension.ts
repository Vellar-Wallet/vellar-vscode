import * as vscode from "vscode";
import { detectExpressFastifyRoutes } from "./detectors/expressFastify";
import { detectNextAppRouterRoutes, detectNextPagesRouterRoutes } from "./detectors/nextjs";
import { hasExistingGate } from "./gateMarker";
import { computeEdits, findDescriptionSelection, type TextEdit } from "./injector";
import { PAGES_ROUTER_GUIDANCE } from "./generators/nextPagesRouter";
import { detectPackageManager, findNearestPackageDir, renderInstallCommand } from "./packageManager";
import { DEFAULT_PRICE_USDC, validatePriceInput } from "./priceValidation";
import { requiredPackagesFor } from "./requiredPackages";
import { resolveServiceName } from "./serviceName";
import type { DetectedRoute, PaymentConfig } from "./types";
import { DataProvider } from "./sidebar/dataProvider";
import { VellarSidebarProvider } from "./sidebar/webviewProvider";
import { hasCompletedOnboarding, OnboardingPanel } from "./onboarding/onboardingProvider";

const SUPPORTED_LANGUAGES = new Set(["javascript", "typescript", "javascriptreact", "typescriptreact"]);

// Fired once per successful addPayment injection — Step 3 of onboarding
// listens on this, per the instruction ("the existing command already fires
// after a successful injection — wire a completion event from there").
// Module-level (not a class field) because addPaymentCommand() itself is a
// plain function, not a method on anything that could hold this — a single
// extension-lifetime emitter matches the single extension-lifetime command
// registration it's paired with.
const commandSuccessEmitter = new vscode.EventEmitter<void>();

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand("vellar-x402.addPayment", () => addPaymentCommand());
  context.subscriptions.push(disposable);
  context.subscriptions.push(commandSuccessEmitter);

  // A developer who dismisses the auto-opened panel before finishing the
  // three steps isn't locked out of it — this always opens a FRESH
  // OnboardingPanel (never reuses a possibly-already-disposed instance from
  // auto-open or a prior manual open), same "one instance per open" design
  // OnboardingPanel itself already documents. Available regardless of
  // hasCompletedOnboarding — reopening after completion is a legitimate
  // "let me see that again" action, not an error.
  context.subscriptions.push(
    vscode.commands.registerCommand("vellar-x402.reopenOnboarding", () => {
      const panel = OnboardingPanel.open(context.extensionUri, context.globalState, commandSuccessEmitter.event);
      context.subscriptions.push(panel);
    }),
  );

  // The DataProvider owns all polling state (currently: wallet balance) for the
  // sidebar's lifetime — disposing it on deactivate stops every timer, so nothing
  // keeps ticking (and nothing keeps calling Horizon) after the extension unloads.
  const dataProvider = new DataProvider(context.globalState);
  context.subscriptions.push(dataProvider);

  const sidebarProvider = new VellarSidebarProvider(context.extensionUri, dataProvider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VellarSidebarProvider.viewType, sidebarProvider),
  );

  // Onboarding opens automatically ONLY on a genuine first activation — no
  // prior globalState record of it having been completed/shown. Every
  // subsequent activation (including ones where the developer never actually
  // finished the three steps) leaves it closed; a developer who wants to see
  // it again can still do so — there's no command wired for that today, but
  // nothing here prevents adding one later, since OnboardingPanel.open() is
  // already a plain, re-callable function, not a first-run-only code path.
  if (!hasCompletedOnboarding(context.globalState)) {
    const panel = OnboardingPanel.open(context.extensionUri, context.globalState, commandSuccessEmitter.event);
    context.subscriptions.push(panel);
  }
}

export function deactivate(): void {
  // Disposal happens via context.subscriptions (registered in activate), which
  // VS Code tears down automatically — nothing additional to do here.
}

async function addPaymentCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !SUPPORTED_LANGUAGES.has(editor.document.languageId)) {
    vscode.window.showInformationMessage(
      "Vellar x402 works on JavaScript/TypeScript files (.js, .ts, .jsx, .tsx) containing " +
        "Express, Fastify, or Next.js route definitions. Open one of those files and try again.",
    );
    return;
  }

  const routes = detectRoutes(editor.document);
  if (routes.length === 0) {
    vscode.window.showInformationMessage(
      "No HTTP route definitions found in this file. Vellar x402 detects: " +
        "Express (app.get/post/put/patch/delete, router.*), Fastify (fastify.get/post/route, server.*), " +
        "Next.js App Router (exported GET/POST/PUT/PATCH/DELETE handlers), and " +
        "Next.js Pages Router (a default-exported (req, res) handler).",
    );
    return;
  }

  const picked = await pickRoute(routes);
  if (!picked) return; // user cancelled

  if (picked.framework === "next-pages-router") {
    vscode.window.showInformationMessage(PAGES_ROUTER_GUIDANCE, { modal: true });
    return;
  }

  if (hasExistingGate(editor.document.getText(), picked)) {
    vscode.window.showWarningMessage(
      `${picked.method} ${picked.routePath} already has an x402 payment gate. ` +
        "Remove the existing gate first if you want to regenerate it.",
    );
    return;
  }

  const payToAddress = await ensurePayToAddress();
  if (!payToAddress) return; // user cancelled or setting still unset

  const priceUsdc = await promptForPrice();
  if (!priceUsdc) return; // user cancelled

  const workspaceRoot = vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath;
  const serviceName = resolveServiceName(editor.document.uri.fsPath, workspaceRoot);

  const config: PaymentConfig = {
    priceUsdc,
    payToAddress,
    endpointUrl: picked.routePath,
    serviceName,
  };

  await applyRouteInjection(editor, picked, config);
  // Injection has now actually happened (the edit was applied) — this is the
  // real "addPayment ran successfully" moment onboarding Step 3 listens for,
  // fired before the (optional, secondary) dependency-install prompt below.
  commandSuccessEmitter.fire();
  await offerDependencyInstall(editor, picked, workspaceRoot, priceUsdc);
}

/**
 * Shows the success message with two actions: "Install dependencies"
 * (unchanged behavior — opens a new integrated terminal in the nearest
 * package directory and runs the install command for whichever package
 * manager the project actually uses) and "Open Vellar sidebar" (new —
 * reveals the activity-bar view container, same command the onboarding
 * panel's own "Open the Vellar sidebar" button already uses).
 *
 * Copy change only: the message no longer echoes the install command inline
 * (the button itself still knows what to run, from `installCommand` below —
 * only the DISPLAYED sentence changed) and now points the developer at
 * "activate your endpoint in the Vellar sidebar" — the first time "activate"
 * appears in the developer-facing flow, setting up the empty state's own
 * "Activate endpoint" language rather than introducing a new word there.
 */
async function offerDependencyInstall(
  editor: vscode.TextEditor,
  route: DetectedRoute,
  workspaceRoot: string | undefined,
  priceUsdc: string,
): Promise<void> {
  if (route.framework === "next-pages-router") return; // never reaches here; guarded earlier

  const filePath = editor.document.uri.fsPath;
  const manager = detectPackageManager(filePath, workspaceRoot);
  const packageDir = findNearestPackageDir(filePath, workspaceRoot);
  const packages = requiredPackagesFor(route.framework);
  const installCommand = renderInstallCommand(manager, packages);

  const choice = await vscode.window.showInformationMessage(
    `Vellar x402: added a $${priceUsdc} USDC payment gate to ${route.method} ${route.routePath}. ` +
      `Deploy your app, then activate your endpoint in the Vellar sidebar to list it in the Bazaar.`,
    "Install dependencies",
    "Open Vellar sidebar",
  );

  if (choice === "Install dependencies") {
    const terminal = vscode.window.createTerminal({ name: "Vellar x402: install", cwd: packageDir });
    terminal.show();
    terminal.sendText(installCommand, true); // true = run immediately, like pressing Enter
  } else if (choice === "Open Vellar sidebar") {
    void vscode.commands.executeCommand("workbench.view.extension.vellar-x402");
  }
}

function detectRoutes(document: vscode.TextDocument): DetectedRoute[] {
  const text = document.getText();
  const filePath = document.uri.fsPath;
  return [
    ...detectExpressFastifyRoutes(text),
    ...detectNextAppRouterRoutes(text, filePath),
    ...detectNextPagesRouterRoutes(text, filePath),
  ];
}

async function pickRoute(routes: DetectedRoute[]): Promise<DetectedRoute | undefined> {
  if (routes.length === 1) {
    // Still confirm with a quick pick rather than silently acting, so the developer
    // sees exactly what was detected before anything is written to their file.
    const only = routes[0];
    const confirmed = await vscode.window.showQuickPick(
      [{ label: only.label, detail: only.detail, route: only }],
      { placeHolder: "Confirm the route to add x402 payment to", ignoreFocusOut: true },
    );
    return confirmed?.route;
  }

  const items = routes.map((route) => ({ label: route.label, detail: route.detail, route }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select the route to add x402 payment to",
    ignoreFocusOut: true,
  });
  return picked?.route;
}

async function ensurePayToAddress(): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration("vellar-x402");
  const existing = config.get<string>("payToAddress", "").trim();
  if (existing.length > 0) return existing;

  const choice = await vscode.window.showWarningMessage(
    "Vellar x402: set your Stellar payout address (vellar-x402.payToAddress) before generating payment code.",
    "Open Settings",
  );
  if (choice === "Open Settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "vellar-x402.payToAddress");
  }
  return undefined;
}

async function promptForPrice(): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({
    title: "Price in USDC",
    prompt: "How much should this endpoint charge per request?",
    value: DEFAULT_PRICE_USDC,
    ignoreFocusOut: true,
    validateInput: validatePriceInput,
  });
  if (input === undefined) return undefined; // cancelled
  return input.trim();
}

/**
 * Thin VS Code adapter: reads the document as plain lines, delegates to the
 * framework-agnostic `computeEdits` for the actual insertion logic (unit-testable
 * without the extension host), then applies the resulting edits via the real
 * `TextEditorEdit` API so this is a genuine, undoable editor edit.
 */
async function applyRouteInjection(
  editor: vscode.TextEditor,
  route: DetectedRoute,
  config: PaymentConfig,
): Promise<void> {
  const document = editor.document;
  const lines = document.getText().split(/\r?\n/);
  const edits = computeEdits(lines, route, config);

  await editor.edit((editBuilder) => {
    for (const edit of edits) {
      applyVscodeEdit(editBuilder, edit);
    }
  });

  selectGeneratedDescription(editor);
}

/**
 * Moves the cursor to the generated `description: "...", // TODO: add the
 * actual resource description` value and selects the quoted string so the
 * developer can start typing a real description immediately, without hunting
 * for the line themselves.
 *
 * Runs after `editor.edit()` has resolved (reads the settled document, not the
 * pre-edit snapshot). Nice-to-have only: the injection already succeeded by this
 * point, so if the marker line can't be found — a generator produced a different
 * shape than expected — this does nothing rather than throwing or surfacing an
 * error over a cursor-placement detail.
 */
function selectGeneratedDescription(editor: vscode.TextEditor): void {
  const selection = findDescriptionSelection(editor.document.getText());
  if (!selection) return;

  const start = new vscode.Position(selection.line, selection.startCharacter);
  const end = new vscode.Position(selection.line, selection.endCharacter);
  editor.selection = new vscode.Selection(start, end);
  editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
}

function applyVscodeEdit(editBuilder: vscode.TextEditorEdit, edit: TextEdit): void {
  if (edit.kind === "insert") {
    editBuilder.insert(new vscode.Position(edit.line, edit.character), edit.text);
  } else {
    const start = new vscode.Position(edit.line, edit.character);
    const end = new vscode.Position(edit.line, edit.endCharacter ?? edit.character);
    editBuilder.replace(new vscode.Range(start, end), edit.text);
  }
}
