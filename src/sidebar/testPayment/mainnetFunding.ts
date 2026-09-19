/**
 * Funds a fresh throwaway keypair with real XLM from the developer's own
 * configured mainnet funding wallet (see mainnetFundingWallet.ts for where
 * that secret lives and how it's configured) — the mainnet equivalent of
 * friendbot.ts's free-faucet call, which only exists on testnet. This is
 * the ONLY place in this codebase that spends real money on the
 * developer's behalf without an on-chain request FROM the developer
 * (payToAddress's flow is the reverse: money arrives, nothing is spent).
 *
 * TWO assets, two functions, in a fixed order forced by Stellar itself:
 *   fundThrowawayFromMainnetWallet() creates the account with a little XLM,
 *   the throwaway wallet then opens its own USDC trustline (only it can sign
 *   that), and sendUsdcToThrowaway() finally credits it with real USDC.
 *
 * The XLM is NOT spending money — it only satisfies protocol minimums the
 * network will not accept USDC for (account reserve, trustline reserve,
 * transaction fees). The USDC is the money actually being tested with, and
 * it comes straight from the developer's own funding wallet.
 *
 * WHY NOT BUY THE USDC ON THE DEX, as the testnet path does: on testnet the
 * throwaway wallet gets free friendbot XLM and trades it for test USDC, so a
 * bad fill costs nothing. On mainnet that same trade repeatedly failed for
 * reasons unrelated to the payment under test — a testnet-era sendMax
 * ceiling larger than the wallet's entire balance, order-book depth, and
 * slippage between quoting and submitting — and every failure burned real
 * XLM getting there. Sending USDC the developer already holds deletes that
 * whole class of failure: there is no trade, so there is nothing to slip.
 *
 * Unused XLM and USDC in the throwaway wallet are stranded when the keypair
 * is discarded at the end of runTestPayment.ts, same as unused testnet XLM
 * already is today; a real but small, predictable cost per test.
 *
 * SECURITY, same discipline as usdc.ts's own submitClassic: the funding
 * wallet's Keypair here is constructed from a secret that is NEVER logged,
 * NEVER included in a thrown Error's message, and NEVER returned from this
 * function — only a plain ok/reason result, matching usdc.ts's own
 * "never throws, always resolves to a discriminated result" contract.
 */

import { Asset, Horizon, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "../../types";
import {
  HORIZON_URL_BY_NETWORK,
  PASSPHRASE_BY_NETWORK,
  HORIZON_FETCH_TIMEOUT_MS,
  HORIZON_SUBMIT_TIMEOUT_MS,
  USDC_ISSUER_BY_NETWORK,
  atomicToDecimalString,
  withTimeout,
} from "./usdc";

/**
 * XLM sent to the throwaway wallet per mainnet test payment. This no longer
 * buys anything — it only covers Stellar's own protocol requirements, which
 * cannot be paid in USDC:
 *   - 1.0 XLM base reserve, to make the account exist at all
 *   - 0.5 XLM subentry reserve for its USDC trustline
 *   - transaction fees for the trustline and the x402 payment
 *
 * 1.6 is the practical floor: 1.5 of it is RESERVE that Stellar locks and
 * never lets the account spend, leaving ~0.1 for fees (which actually cost
 * ~0.00001 each — the 1000000-stroop fee set on these transactions is a
 * maximum we're willing to pay, not the charge). Lowering this further hits
 * op_low_reserve; the 1.5 is protocol, not policy, and cannot be tuned away.
 * Raise it only if a wallet ever needs a second subentry.
 *
 * This was 6 back when the throwaway wallet had to BUY its USDC on the DEX
 * with this XLM. It no longer does: the funding wallet sends real USDC
 * directly (see MAINNET_FUNDING_USDC_BUFFER below), which removes the DEX
 * purchase from the mainnet path entirely — along with its slippage, its
 * order-book dependency, and the class of failure where a correctly funded
 * wallet still could not complete a trade.
 */
export const MAINNET_FUNDING_XLM_AMOUNT = "1.6";

/**
 * How much USDC to send, as a multiple of the endpoint's own price: 20%
 * over, so a payment isn't rejected for being a fraction short if the
 * endpoint's quoted amount and the settled amount differ slightly.
 *
 * Integer math on 7-decimal atomic amounts (multiply then divide, so the
 * truncation costs at most 1 atomic unit = 0.0000001 USDC).
 */
export const USDC_BUFFER_NUMERATOR = 12n;
export const USDC_BUFFER_DENOMINATOR = 10n;

const SUBMIT_TIMEOUT_SECONDS = 35;

export type FundThrowawayResult = { ok: true } | { ok: false; reason: string };

/**
 * Creates `throwawayPublicKey` with MAINNET_FUNDING_XLM_AMOUNT XLM. Never
 * throws — same discriminated-result contract as usdc.ts's
 * openUsdcTrustline/buyUsdc, so the caller (runTestPayment.ts) can
 * degrade/report a clean failure without an unhandled rejection anywhere in
 * the test-payment flow.
 *
 * This is deliberately SEPARATE from sendUsdcToThrowaway below, and must run
 * first, because Stellar's own ordering forces three steps that cannot be
 * collapsed into one transaction:
 *   1. this function creates the account (only the FUNDING wallet can sign)
 *   2. the throwaway wallet opens its own USDC trustline (only IT can sign —
 *      see runTestPayment.ts's call to openUsdcTrustline between the two)
 *   3. sendUsdcToThrowaway credits it (funding wallet signs again; would
 *      fail with op_no_trust if attempted before step 2)
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

    // No Horizon result_codes means this was NOT a protocol rejection — a
    // timeout, a DNS/TLS failure, or an SDK-level error. Falling through to
    // a bare "funding transaction failed" here threw away the only
    // information that could distinguish those, which cost two rounds of
    // live reproduction to work around. err.message is a short SDK/network
    // string (e.g. "mainnet funding: submitTransaction timed out after
    // 60000ms"), carries nothing about the funding wallet's secret, and is
    // exactly what a developer needs to see.
    return { ok: false, reason: `funding transaction failed: ${message}` };
  }
}

/**
 * Sends USDC from the funding wallet to a throwaway wallet that has ALREADY
 * been created and has ALREADY opened its USDC trustline. Never throws, same
 * discriminated-result contract as everything else in this flow.
 *
 * This replaces the mainnet DEX purchase entirely. Previously the throwaway
 * wallet was given XLM and had to buy its own USDC via
 * pathPaymentStrictReceive, which failed repeatedly for reasons that had
 * nothing to do with the payment being tested: a testnet-era sendMax ceiling
 * that exceeded the wallet's whole balance, order-book depth, and slippage
 * between quote and submit. Sending USDC that the developer already holds
 * removes all of it — there is no trade, so there is nothing to slip.
 *
 * `amountAtomic` is a 7-decimal atomic string (the same convention the rest
 * of this flow uses); it is converted to the decimal string Horizon's
 * classic payment operation expects.
 */
export async function sendUsdcToThrowaway(
  fundingWalletSecret: string,
  throwawayPublicKey: string,
  amountAtomic: string,
  network: StellarNetwork,
): Promise<FundThrowawayResult> {
  if (!/^\d+$/.test(amountAtomic) || BigInt(amountAtomic) <= 0n) {
    return { ok: false, reason: "invalid USDC funding amount" };
  }

  let fundingKeypair: Keypair;
  try {
    fundingKeypair = Keypair.fromSecret(fundingWalletSecret);
  } catch {
    return { ok: false, reason: "the configured mainnet funding wallet's secret key is invalid" };
  }

  const horizon = new Horizon.Server(HORIZON_URL_BY_NETWORK[network]);
  const asset = new Asset("USDC", USDC_ISSUER_BY_NETWORK[network]);

  try {
    const account = await withTimeout(
      horizon.loadAccount(fundingKeypair.publicKey()),
      HORIZON_FETCH_TIMEOUT_MS,
      "mainnet USDC funding: loadAccount",
    );
    const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE_BY_NETWORK[network] })
      .addOperation(
        Operation.payment({
          destination: throwawayPublicKey,
          asset,
          amount: atomicToDecimalString(BigInt(amountAtomic)),
        }),
      )
      .setTimeout(SUBMIT_TIMEOUT_SECONDS)
      .build();
    tx.sign(fundingKeypair);

    const sent = await withTimeout(
      horizon.submitTransaction(tx),
      HORIZON_SUBMIT_TIMEOUT_MS,
      "mainnet USDC funding: submitTransaction",
    );
    if (!sent.successful) return { ok: false, reason: "USDC funding transaction did not settle" };
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const codes = (err as { response?: { data?: { extras?: { result_codes?: Record<string, unknown> } } } })?.response
      ?.data?.extras?.result_codes;
    if (codes) {
      const ops = Array.isArray(codes.operations) ? codes.operations.join(", ") : "";
      // op_underfunded here means the FUNDING wallet is out of USDC
      // specifically (not XLM) — a distinct, actionable state worth naming,
      // since the fix is "convert or send more USDC", not "send more XLM".
      if (ops.includes("op_underfunded")) {
        return { ok: false, reason: "the configured mainnet funding wallet doesn't have enough USDC" };
      }
      if (ops.includes("op_no_trust")) {
        return { ok: false, reason: "the throwaway wallet has no USDC trustline yet" };
      }
      const tx = typeof codes.transaction === "string" ? codes.transaction : undefined;
      const detail = [tx, ops].filter(Boolean).join(" / ");
      if (detail) return { ok: false, reason: `USDC funding failed (${detail})` };
    }
    return { ok: false, reason: `USDC funding failed: ${message}` };
  }
}
