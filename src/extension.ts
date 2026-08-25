import * as vscode from "vscode";
import { detectExpressFastifyRoutes } from "./detectors/expressFastify";
import { detectNextAppRouterRoutes, detectNextPagesRouterRoutes } from "./detectors/nextjs";
import { hasExistingGate } from "./gateMarker";
import { computeEdits, type TextEdit } from "./injector";
import { PAGES_ROUTER_GUIDANCE } from "./generators/nextPagesRouter";
import { DEFAULT_PRICE_USDC, validatePriceInput } from "./priceValidation";
import { resolveServiceName } from "./serviceName";
import type { DetectedRoute, PaymentConfig } from "./types";

const SUPPORTED_LANGUAGES = new Set(["javascript", "typescript", "javascriptreact", "typescriptreact"]);

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand("vellar-x402.addPayment", () => addPaymentCommand());
  context.subscriptions.push(disposable);
}

export function deactivate(): void {
  // No background state to tear down.
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
  vscode.window.showInformationMessage(
    `Vellar x402: added a $${priceUsdc} USDC payment gate to ${picked.method} ${picked.routePath}. ` +
      "Run npm install @x402/stellar @x402/core (plus the framework package) and review the TODOs.",
  );
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
