/**
 * Storage and configuration for the developer's OWN mainnet funding wallet —
 * a real, developer-controlled Stellar keypair whose real XLM funds the
 * throwaway buyer side of each mainnet test payment (see runTestPayment.ts's
 * own comment on why a throwaway buyer needs funding at all, and
 * fundThrowawayFromMainnetWallet.ts for the actual funding transaction).
 *
 * SECURITY: the secret key lives ONLY in vscode.SecretStorage
 * (context.secrets) — VS Code's built-in encrypted-at-rest credential store,
 * backed by the OS keychain (Keychain on macOS, Credential Manager on
 * Windows, libsecret on Linux). It is NEVER written to a vellar-x402.*
 * setting — settings.json is plaintext on disk, readable by any process on
 * the machine, and can be synced to the cloud via VS Code Settings Sync or
 * accidentally committed to a repo. This is the first SecretStorage usage
 * in this codebase — every other credential-shaped value here
 * (payToAddress) is a real Stellar G-address (public, not sensitive); this
 * is the first genuinely secret value the extension ever handles.
 *
 * This is a real, developer-funded wallet, not the extension's own treasury
 * — the developer configures and tops it up themselves (see the configure
 * command's own confirmation message), same "developer owns their own
 * identity/funds" model payToAddress already established.
 */

import * as vscode from "vscode";
import { Keypair } from "@stellar/stellar-sdk";

/** The one key this feature ever stores under, in this extension's own
 *  isolated SecretStorage namespace (VS Code scopes SecretStorage per
 *  extension already — no collision risk with any other extension's own
 *  secrets, even if they happened to choose the same key string). */
const MAINNET_FUNDING_SECRET_KEY = "vellar-x402.mainnetFundingWalletSecret";

/** Never throws — returns undefined if nothing is configured yet, exactly
 *  like DataProvider.getConfiguredAddress()'s own "unconfigured" contract,
 *  so callers (runTestPayment.ts) can produce the same clear
 *  "not configured yet" error shape they already do for other missing
 *  prerequisites. Always re-reads SecretStorage live — never cached on any
 *  object — same rule every other config/secret read in this codebase
 *  follows (see getConfiguredNetwork/getConfiguredAddress's own comments). */
export async function getMainnetFundingSecret(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const raw = await secrets.get(MAINNET_FUNDING_SECRET_KEY);
  return raw && raw.trim().length > 0 ? raw.trim() : undefined;
}

/**
 * The "Vellar: Configure mainnet test wallet" command. Prompts for the
 * secret key (masked input), validates it actually parses as a real Stellar
 * secret BEFORE storing anything (Keypair.fromSecret throws on a malformed
 * value — caught here and turned into a clear error message, never a raw
 * SDK exception shown to the developer), stores it, then shows the DERIVED
 * PUBLIC key back — the only way the developer can confirm they entered the
 * key they meant to without ever re-displaying the secret itself, and a
 * natural prompt to actually go fund that address before running a mainnet
 * test payment.
 */
export async function configureMainnetTestWalletCommand(secrets: vscode.SecretStorage): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: "Mainnet test wallet secret key",
    prompt:
      "Paste the secret key (starts with S) of a Stellar wallet YOU control and will fund with a small amount " +
      "of real XLM. This wallet pays for the throwaway buyer side of every mainnet test payment.",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  });
  if (input === undefined) return; // cancelled

  const trimmed = input.trim();
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(trimmed);
  } catch {
    void vscode.window.showErrorMessage(
      "That doesn't look like a valid Stellar secret key — it should start with \"S\" and be 56 characters long.",
    );
    return;
  }

  await secrets.store(MAINNET_FUNDING_SECRET_KEY, trimmed);

  void vscode.window.showInformationMessage(
    `Mainnet test wallet configured: ${keypair.publicKey()}. Fund this address with a small amount of real ` +
      "XLM (a few dollars' worth is plenty) before running a mainnet test payment — every test payment sends " +
      "3 XLM from it to a fresh throwaway buyer wallet.",
  );
}

/** Removes the configured secret entirely — no command wired to this yet
 *  (not asked for), but exported so a future "forget this wallet" command,
 *  or a test, can reach it without duplicating the raw secrets.delete call
 *  and its own key constant. */
export async function clearMainnetFundingSecret(secrets: vscode.SecretStorage): Promise<void> {
  await secrets.delete(MAINNET_FUNDING_SECRET_KEY);
}
