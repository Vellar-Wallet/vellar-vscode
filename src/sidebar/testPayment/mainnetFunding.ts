/**
 * Funds a fresh throwaway keypair with real XLM from the developer's own
 * configured mainnet funding wallet (see mainnetFundingWallet.ts for where
 * that secret lives and how it's configured) — the mainnet equivalent of
 * friendbot.ts's free-faucet call, which only exists on testnet. This is
 * the ONLY place in this codebase that spends real money on the
 * developer's behalf without an on-chain request FROM the developer
 * (payToAddress's flow is the reverse: money arrives, nothing is spent).
 *
 * 3 XLM per test payment, fixed — not computed from the endpoint's price —
 * deliberately: a live XLM/USDC price lookup would add a real dependency
 * (another DEX round trip) to an already high-risk flow for marginal
 * precision gain. 3 XLM comfortably covers the throwaway wallet's own
 * account reserve (~1 XLM), its USDC trustline reserve (~0.5 XLM), the DEX
 * purchase's own fee/slippage, and the final x402 payment's transaction fee,
 * with headroom — unused XLM in the throwaway wallet is stranded when the
 * keypair is discarded at the end of runTestPayment.ts, same as unused
 * testnet XLM already is today; a real but small, predictable cost per test.
 *
 * SECURITY, same discipline as usdc.ts's own submitClassic: the funding
 * wallet's Keypair here is constructed from a secret that is NEVER logged,
 * NEVER included in a thrown Error's message, and NEVER returned from this
 * function — only a plain ok/reason result, matching usdc.ts's own
 * "never throws, always resolves to a discriminated result" contract.
 */

import { Horizon, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "../../types";
import {
  HORIZON_URL_BY_NETWORK,
  PASSPHRASE_BY_NETWORK,
  HORIZON_FETCH_TIMEOUT_MS,
  HORIZON_SUBMIT_TIMEOUT_MS,
  withTimeout,
} from "./usdc";

/** Fixed XLM amount sent to the throwaway wallet per mainnet test payment —
 *  see this file's own header comment for why fixed, not computed. */
export const MAINNET_FUNDING_XLM_AMOUNT = "3";

const SUBMIT_TIMEOUT_SECONDS = 35;

export type FundThrowawayResult = { ok: true } | { ok: false; reason: string };

/**
 * Sends MAINNET_FUNDING_XLM_AMOUNT XLM from the funding wallet
 * (`fundingWalletSecret`) to `throwawayPublicKey`. Never throws — same
 * discriminated-result contract as usdc.ts's openUsdcTrustline/buyUsdc, so
 * the caller (runTestPayment.ts) can degrade/report a clean failure without
 * an unhandled rejection anywhere in the test-payment flow.
 *
 * `network` is always "stellar:pubnet" in practice (runTestPayment.ts only
 * ever calls this on the mainnet path) but is threaded through explicitly
 * rather than hardcoded, matching every other network-keyed function in
 * this codebase (openUsdcTrustline, buyUsdc, runPaymentFlow) — never a
 * silent assumption baked into one call site.
 */
export async function fundThrowawayFromMainnetWallet(
  fundingWalletSecret: string,
  throwawayPublicKey: string,
  network: StellarNetwork,
): Promise<FundThrowawayResult> {
  let fundingKeypair: Keypair;
  try {
    fundingKeypair = Keypair.fromSecret(fundingWalletSecret);
  } catch {
    // Should be unreachable in practice — mainnetFundingWallet.ts's own
    // configure command already validates this before ever storing it — but
    // a stored secret could theoretically be corrupted by something outside
    // this extension's control (manual SecretStorage tampering), so this is
    // a real check, not just a comment.
    return { ok: false, reason: "the configured mainnet funding wallet's secret key is invalid" };
  }

  const horizon = new Horizon.Server(HORIZON_URL_BY_NETWORK[network]);

  try {
    const account = await withTimeout(
      horizon.loadAccount(fundingKeypair.publicKey()),
      HORIZON_FETCH_TIMEOUT_MS,
      "mainnet funding: loadAccount",
    );
    // REAL BUG, FOUND AND FIXED: this used to use Operation.payment, which
    // fails with op_no_destination against a brand-new keypair. On Stellar a
    // `payment` can only credit an account that ALREADY EXISTS on the ledger;
    // the throwaway wallet was generated moments ago and has never been
    // touched, so it does not. Creating it requires `createAccount`, which is
    // precisely what friendbot does on testnet — which is why the testnet
    // path always worked and mainnet always failed at this exact step with a
    // generic "funding transaction failed".
    //
    // startingBalance (not `amount`) is createAccount's own field name for
    // the XLM the new account is born holding. It must be at least the base
    // reserve (1 XLM on mainnet: 2 entries x 0.5) or the operation fails with
    // op_low_reserve; MAINNET_FUNDING_XLM_AMOUNT is comfortably above that
    // and is also sized to cover the trustline reserve and fees the
    // throwaway wallet needs next (see this file's own header comment).
    const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE_BY_NETWORK[network] })
      .addOperation(
        Operation.createAccount({
          destination: throwawayPublicKey,
          startingBalance: MAINNET_FUNDING_XLM_AMOUNT,
        }),
      )
      .setTimeout(SUBMIT_TIMEOUT_SECONDS)
      .build();
    tx.sign(fundingKeypair);

    const sent = await withTimeout(
      horizon.submitTransaction(tx),
      HORIZON_SUBMIT_TIMEOUT_MS,
      "mainnet funding: submitTransaction",
    );
    if (!sent.successful) {
      return { ok: false, reason: "funding transaction did not settle" };
    }
    return { ok: true };
  } catch (err) {
    // Unlike usdc.ts's submitClassic (which swallows the raw error entirely,
    // since it has no access to the output channel), this DOES surface a
    // short, non-raw reason distinguishing the most actionable failure
    // (insufficient balance) from a generic one — a developer whose funding
    // wallet has run dry needs to know THAT specifically, not just "funding
    // failed," since the fix (send it more XLM) is different from any other
    // failure mode here. Still never the raw SDK error object/message
    // itself — logAndGenericError in runTestPayment.ts's catch block is the
    // one place a raw error is allowed to surface, same rule as everywhere
    // else in this flow.
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes("underfunded") || message.toLowerCase().includes("insufficient")) {
      return { ok: false, reason: "the configured mainnet funding wallet doesn't have enough XLM" };
    }

    // Horizon puts the ACTIONABLE detail in extras.result_codes, never in
    // err.message (which is only ever "Transaction submission failed. Server
    // responded: 400 Bad Request"). Surfacing those codes is what turns an
    // opaque "funding transaction failed" into something diagnosable without
    // reproducing the transaction by hand — which is exactly what the
    // op_no_destination bug above cost before this existed. These are short,
    // enumerated protocol codes (op_no_destination, tx_insufficient_balance,
    // op_low_reserve, ...), not raw SDK internals, and carry nothing about
    // the funding wallet's secret.
    const codes = (err as { response?: { data?: { extras?: { result_codes?: Record<string, unknown> } } } })?.response
      ?.data?.extras?.result_codes;
    if (codes) {
      const tx = typeof codes.transaction === "string" ? codes.transaction : undefined;
      const ops = Array.isArray(codes.operations) ? codes.operations.join(", ") : undefined;
      const detail = [tx, ops].filter(Boolean).join(" / ");
      if (detail) return { ok: false, reason: `funding transaction failed (${detail})` };
    }
    return { ok: false, reason: "funding transaction failed" };
  }
}
