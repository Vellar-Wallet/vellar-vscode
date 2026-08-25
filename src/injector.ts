import { renderExpressAppUse, renderExpressImports, renderExpressSetupBlock } from "./generators/express";
import { renderFastifyImports, renderFastifyRegisterCall, renderFastifySetupBlock } from "./generators/fastify";
import {
  implName,
  renderNextAppRouterImports,
  renderNextAppRouterSetupBlock,
  renderNextAppRouterWrapExport,
} from "./generators/nextAppRouter";
import type { DetectedRoute, PaymentConfig } from "./types";

/**
 * One text edit expressed as plain (0-based line, character) coordinates against the
 * ORIGINAL, pre-edit document — mirrors how `vscode.TextEditorEdit` resolves multiple
 * inserts/replaces made within one `editor.edit()` callback. Kept framework-agnostic
 * (no `vscode` import) so injection logic is unit-testable without the extension host.
 */
export interface TextEdit {
  kind: "insert" | "replace";
  line: number;
  /** Character offset for "insert"; start-of-range character for "replace". */
  character: number;
  /** For "replace": end character on the same line (single-line replace only — this
   * extension only ever replaces whole declaration lines, never spans multiple). */
  endCharacter?: number;
  text: string;
}

/** Inserts text after the last top-of-file import statement, or at line 0 if none. */
export function findImportInsertionLine(lines: string[]): number {
  let lastImportLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*import\s/.test(line) || /^\s*const\s+\w+\s*=\s*require\(/.test(line)) {
      lastImportLine = i;
    } else if (lastImportLine !== -1 && line.trim().length === 0) {
      continue; // allow blank lines between imports
    } else if (lastImportLine !== -1) {
      break; // first non-import, non-blank line after imports found
    }
  }
  return lastImportLine + 1;
}

function indentBlock(block: string, indent: string): string {
  return block
    .split("\n")
    .map((line) => (line.length > 0 ? indent + line : line))
    .join("\n");
}

interface FrameworkTexts {
  imports: string;
  setupBlock: string;
  registerCall: string;
}

function computeExpressOrFastifyEdits(
  lines: string[],
  route: DetectedRoute,
  texts: FrameworkTexts,
): TextEdit[] {
  const edits: TextEdit[] = [];

  const importLine = findImportInsertionLine(lines);
  edits.push({ kind: "insert", line: importLine, character: 0, text: texts.imports + "\n\n" });

  const declarationIndent = lines[route.declarationLine].match(/^[ \t]*/)?.[0] ?? "";
  const block =
    indentBlock(texts.setupBlock, declarationIndent) + "\n" + declarationIndent + texts.registerCall + "\n";
  edits.push({ kind: "insert", line: route.declarationLine, character: 0, text: block });

  return edits;
}

export function computeExpressEdits(lines: string[], route: DetectedRoute, config: PaymentConfig): TextEdit[] {
  return computeExpressOrFastifyEdits(lines, route, {
    imports: renderExpressImports(),
    setupBlock: renderExpressSetupBlock(route, config),
    registerCall: renderExpressAppUse(),
  });
}

export function computeFastifyEdits(lines: string[], route: DetectedRoute, config: PaymentConfig): TextEdit[] {
  return computeExpressOrFastifyEdits(lines, route, {
    imports: renderFastifyImports(),
    setupBlock: renderFastifySetupBlock(route, config),
    registerCall: renderFastifyRegisterCall(route.appVarName ?? "fastify"),
  });
}

/**
 * Rewrites `export async function GET(` -> `async function GET_impl(` (drops the
 * `export`, since the wrapped `withX402(...)` export takes over that role), and
 * `export const GET =` -> `const GET_impl =` for the const-handler form.
 */
function renameExportToImpl(declarationLine: string, method: string): string | null {
  const fnPattern = new RegExp(`^(\\s*)export\\s+(async\\s+)?function\\s+${method}\\b`);
  const fnMatch = fnPattern.exec(declarationLine);
  if (fnMatch) {
    return declarationLine.replace(fnPattern, `${fnMatch[1]}${fnMatch[2] ?? ""}function ${implName(method)}`);
  }

  const constPattern = new RegExp(`^(\\s*)export\\s+const\\s+${method}\\b`);
  const constMatch = constPattern.exec(declarationLine);
  if (constMatch) {
    return declarationLine.replace(constPattern, `${constMatch[1]}const ${implName(method)}`);
  }

  return null;
}

/** Finds the (line, character) right after the matching closing brace of the function starting at declLine. */
function findFunctionEnd(lines: string[], declLine: number): { line: number; character: number } {
  let depth = 0;
  let started = false;
  for (let i = declLine; i < lines.length; i++) {
    const text = lines[i];
    for (const ch of text) {
      if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (started && depth === 0) {
      return { line: i, character: lines[i].length };
    }
  }
  const lastLine = lines.length - 1;
  return { line: lastLine, character: lines[lastLine].length };
}

export function computeNextAppRouterEdits(
  lines: string[],
  route: DetectedRoute,
  config: PaymentConfig,
): TextEdit[] {
  const edits: TextEdit[] = [];

  const importLine = findImportInsertionLine(lines);
  edits.push({
    kind: "insert",
    line: importLine,
    character: 0,
    text: renderNextAppRouterImports() + "\n\n",
  });

  edits.push({
    kind: "insert",
    line: route.declarationLine,
    character: 0,
    text: renderNextAppRouterSetupBlock(route, config) + "\n",
  });

  const declarationText = lines[route.declarationLine];
  const renamed = renameExportToImpl(declarationText, route.method);
  if (renamed) {
    edits.push({
      kind: "replace",
      line: route.declarationLine,
      character: 0,
      endCharacter: declarationText.length,
      text: renamed,
    });
  }

  const insertionPoint = findFunctionEnd(lines, route.declarationLine);
  edits.push({
    kind: "insert",
    line: insertionPoint.line,
    character: insertionPoint.character,
    text: "\n" + renderNextAppRouterWrapExport(route.method) + "\n",
  });

  return edits;
}

export function computeEdits(lines: string[], route: DetectedRoute, config: PaymentConfig): TextEdit[] {
  switch (route.framework) {
    case "express":
      return computeExpressEdits(lines, route, config);
    case "fastify":
      return computeFastifyEdits(lines, route, config);
    case "next-app-router":
      return computeNextAppRouterEdits(lines, route, config);
    case "next-pages-router":
      return []; // Handled by guidance message before this is ever called.
  }
}

/**
 * Applies a set of `TextEdit`s (all expressed in original-document coordinates) to
 * `originalText`, the same way `vscode.TextEditorEdit` would within one
 * `editor.edit()` callback. Used both by the real extension's VS Code adapter and
 * directly by tests/fixture scripts, so both exercise identical merge logic.
 */
export function applyEdits(originalText: string, edits: TextEdit[]): string {
  const lines = originalText.split(/\r?\n/);

  // Group edits by line, apply within a line right-to-left by character so earlier
  // character offsets on the same line stay valid, then rebuild lines top-to-bottom
  // inserting/replacing whole lines. Because every edit here is anchored to a single
  // original line (insert-at-start-of-line, or replace within one line), we can
  // process line-insertions independently of same-line replacements.
  const byLine = new Map<number, TextEdit[]>();
  for (const edit of edits) {
    const list = byLine.get(edit.line) ?? [];
    list.push(edit);
    byLine.set(edit.line, list);
  }

  const resultLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineEdits = (byLine.get(i) ?? []).slice().sort((a, b) => a.character - b.character);
    let line = lines[i];
    let prefix = "";
    let suffix = "";

    for (const edit of lineEdits) {
      if (edit.kind === "insert" && edit.character === 0) {
        // Insert-before-line-content: becomes its own line(s) prepended.
        prefix += edit.text;
      } else if (edit.kind === "insert" && edit.character === line.length) {
        // Insert-after-line-content: becomes its own line(s) appended.
        suffix += edit.text;
      } else if (edit.kind === "replace" && edit.character === 0 && edit.endCharacter === line.length) {
        // Whole-line replace.
        line = edit.text;
      } else if (edit.kind === "insert") {
        line = line.slice(0, edit.character) + edit.text + line.slice(edit.character);
      } else {
        line = line.slice(0, edit.character) + edit.text + line.slice(edit.endCharacter ?? edit.character);
      }
    }

    resultLines.push(prefix + line + suffix);
  }

  return resultLines.join("\n");
}
