/**
 * Fund a fresh testnet keypair via friendbot. Ported from
 * vellar-playground/lib/stellar.ts's fundWithFriendbot — same 10s timeout,
 * same "throw on any non-2xx/network-error/timeout" contract.
 *
 * HTTPS only, per the spec — the URL is a literal "https://" string, there is
 * no environment override and no fallback to plain http:// anywhere in this
 * file, matching httpsClient.ts's own "no node:http import anywhere" rule
 * elsewhere in this codebase.
 */

const FRIENDBOT_URL = "https://friendbot.stellar.org/";
const FRIENDBOT_TIMEOUT_MS = 10_000;

/** Throws a plain Error (never the raw fetch/network error re-thrown as-is)
 *  on any non-2xx response, network error, or timeout — callers should treat
 *  all three identically: a fresh, unfunded key, discarded, no retry. */
export async function fundWithFriendbot(publicKey: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`, {
      signal: AbortSignal.timeout(FRIENDBOT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`friendbot request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`friendbot returned HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}
