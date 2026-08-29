import * as vscode from "vscode";

/**
 * Single "Vellar x402" output channel for the whole extension. This is the ONLY place
 * a raw error, request URL, or response body may be written — never into a notification,
 * a TreeItem label, or any other UI surface a user reads by default. See
 * `logAndGenericError` below, the one function that is allowed to bridge the two.
 */
let channel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel("Vellar x402");
  return channel;
}

/**
 * Logs the real error (with enough context to actually debug it) to the output channel,
 * and returns the one generic, safe-to-display string every caller should show the user
 * instead. Centralized so no call site has to remember the "never leak the raw error"
 * rule on its own — there is exactly one path to a user-visible error message.
 */
export function logAndGenericError(context: string, error: unknown): string {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  getOutputChannel().appendLine(`[${new Date().toISOString()}] ${context}\n${detail}`);
  return "Could not load data — check your connection.";
}
