/**
 * Format-only check: 56 chars, starts with "G" (a classic Stellar account, matching
 * "Your Stellar G-address" in the setting's own description — a C-address contract
 * account is deliberately out of scope here), base32 alphabet only. This is NOT a
 * StrKey checksum verification — a string can pass this and still not decode to a
 * real address. Good enough to avoid firing a doomed Horizon request or showing a
 * raw parse error; not a substitute for real StrKey validation if that's ever needed
 * elsewhere.
 */
const BASE32_ALPHABET = /^[A-Z2-7]+$/;

export function looksLikeStellarGAddress(value: string): boolean {
  return value.length === 56 && value[0] === "G" && BASE32_ALPHABET.test(value);
}

/**
 * Format-only check for the "Test a URL" manual-entry field (see My
 * Endpoints' empty state) — https:// always allowed, plus http://
 * specifically for localhost/127.0.0.1 (any port), since testing an
 * endpoint you're actively developing locally, before it's deployed
 * anywhere reachable over HTTPS, is exactly the case this entry point
 * exists for. Any other http:// host is rejected — a manual URL is
 * user-typed input, not something the extension already vouched for the
 * way a catalog listing's resource field is, so it gets its own explicit
 * scheme check here rather than inheriting httpsClient.ts's HTTPS-only rule
 * (which is about THIS extension's own outbound calls to Horizon/the
 * facilitator/the explorer, a different thing from what resource a
 * developer is allowed to test-pay).
 */
export function looksLikeTestableResourceUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:") {
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  }
  return false;
}

/**
 * First 4 + last 4 characters, per every "never show the full address" requirement
 * across this feature. Anything shorter than 12 chars (shouldn't happen for a real
 * Stellar address or tx hash, but never trust that blindly) is returned unmodified
 * rather than producing a nonsensical truncation.
 */
export function truncateMiddle(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** "2 minutes ago" style relative time, from an ISO-8601 timestamp. No dependency
 *  pulled in for something this small. */
export function relativeTime(isoTimestamp: string, now: Date = new Date()): string {
  const then = new Date(isoTimestamp).getTime();
  const diffSeconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (diffSeconds < 60) return "just now";
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
}

/**
 * Formats an already-decimal amount string for display — this is what Horizon's
 * classic /accounts balance field is (e.g. "98.4336000"), NOT atomic units. No
 * scaling happens here, only comma-grouping.
 *
 * This function used to be named formatStroopsAsUsdc and was reused, wrongly, for
 * the facilitator's genuinely-atomic accepts[].amount values in Step 2 — which
 * surfaced "1,000,000.00 USDC" for what is actually 0.10 USDC when checked
 * against live data. It happened to look correct for wallet balances (Horizon's
 * format needs no conversion) and was silently wrong the moment it was reused for
 * a value that does. See formatAtomicUsdc below for the one that actually
 * converts — two names for two different input conventions, not a style choice.
 */
export function formatDecimalAmount(rawAmount: string | number): string {
  const n = typeof rawAmount === "string" ? parseFloat(rawAmount) : rawAmount;
  if (!Number.isFinite(n)) return "0.00";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 7 });
}

// USDC's atomic unit convention on Stellar is 7 decimals — confirmed against
// live data: the facilitator's own accepts[].amount of "1000000" is the real,
// observed price for an endpoint charging $0.10, and 1_000_000 atomic units
// with 7 decimals is exactly 0.1 — the padStart(8, "0")/slice(-7) split below
// encodes that same 7-decimal placement directly, string-wise.
export function formatAtomicUsdc(rawAtomicAmount: string): string {
  let atomic: bigint;
  try {
    atomic = BigInt(rawAtomicAmount);
  } catch {
    return "0.00";
  }
  // String-built, not float division — a real amount can exceed
  // Number.MAX_SAFE_INTEGER in atomic units well before it's an unusual price,
  // and BigInt / BigInt then Number(...) would silently reintroduce the exact
  // floating-point imprecision this function exists to avoid.
  const negative = atomic < 0n;
  const digits = (negative ? -atomic : atomic).toString().padStart(8, "0"); // >= 1 whole + 7 fraction digits
  const whole = digits.slice(0, -7).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(-7).replace(/0+$/, "").padEnd(2, "0"); // at least 2 places, trim trailing zeros above that
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${withCommas}.${fraction}`;
}
