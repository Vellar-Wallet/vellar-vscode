import * as vscode from "vscode";
import { httpsGetJson } from "./httpsClient";
import { formatAtomicUsdc, looksLikeStellarGAddress, truncateMiddle } from "./format";
import { checkEndpointNotifications, checkSettlementNotifications } from "./notifications";
import { logAndGenericError } from "./outputChannel";
import { PollingSource } from "./polling";

const HORIZON_TESTNET = "https://horizon-testnet.stellar.org";

// The canonical testnet USDC issuer used across the Vellar stack (facilitator,
// explorer). Matched by asset_code AND asset_issuer together — asset_code alone
// proves nothing, anyone can issue a token also called "USDC".
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC_CODE = "USDC";

// The SAME canonical USDC, but as a Soroban SAC contract ID (a C-address), not the
// classic asset issuer above (a G-address) — two different identifier kinds for
// the same underlying asset, not two different assets. Horizon's classic
// /accounts endpoint (wallet balances, above) speaks issuer+code; the
// facilitator's discovery catalog (endpoints, below) speaks SAC contract IDs,
// since settlement happens through the token contract. Confirmed against the
// live facilitator response and cross-checked against vellar-facilitator's own
// config.
const USDC_SAC_CONTRACT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

const FACILITATOR_BASE = "https://vellar-facilitator.onrender.com";

// The explorer indexes on-chain Stellar payment operations — it has no concept of
// "which HTTP resource this paid for" (that mapping only exists in the facilitator's
// request/response layer, never on-chain), confirmed by reading its own source
// (db.ts/api-types.ts have no `resource` field anywhere) and by hitting the live
// API. Recent Settlements is built against exactly what this returns: amount,
// payer, time, tx hash — no endpoint column, no cross-referencing by amount to
// guess one. See the filed vellar-explorer issue for the future fix (adding
// `resource` at settle time, where the facilitator already has it).
const EXPLORER_BASE = "https://vellar-explorer.onrender.com";
const WALLET_POLL_INTERVAL_MS = 30_000;
const ENDPOINTS_POLL_INTERVAL_MS = 60_000;
const SETTLEMENTS_POLL_INTERVAL_MS = 30_000;
const SETTLEMENTS_LIMIT = 10;

// Deliberately only three variants — "loading" and "error" belong to
// PollResult<T>.status (the outer wrapper every PollingSource produces), not here.
// fetchWalletBalance() below never returns either of those on its own: a fetch
// failure THROWS and PollingSource converts that into the outer status:"error"
// itself. Having both a WalletBalanceState error/loading AND a PollResult
// error/loading was two representations of the same thing — a real bug (caught by
// tsc when toWalletDisplayState tried to narrow away states that could never
// actually occur), not a style choice.
export type WalletBalanceState =
  | { kind: "unconfigured" }
  | { kind: "invalid-address" }
  | { kind: "loaded"; address: string; usdc: string; xlm: string };

interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
}
interface HorizonAccountResponse {
  balances: HorizonBalance[];
}

// --- My Endpoints (Step 2) -------------------------------------------------
// Field names below are taken from a live GET to /discovery/resources, read
// directly before writing this, not assumed. In particular: payTo lives inside
// each accepts[] entry, not at the top level or under trust — the original spec
// draft had that wrong, and this is the corrected shape.

interface DiscoveryAccept {
  asset: string;
  amount: string;
  payTo: string;
}
interface DiscoveryTrust {
  settlements: number; // always present and numeric — trust.ts's own wire
  // serialization defaults it with `?? 0`; never null/undefined/absent.
  lastSettled?: string; // genuinely OPTIONAL — omitted entirely (not null) when
  // a resource has never settled, per trust.ts's own conditional spread.
  ownershipState?: "verified" | "proven-unconfirmed" | "unverified";
}
interface DiscoveryItem {
  resource: string;
  accepts: DiscoveryAccept[];
  trust: DiscoveryTrust;
}
interface DiscoveryResponse {
  items: DiscoveryItem[];
}

export interface EndpointListing {
  resource: string;
  /** Already formatted for display — "0.10 USDC" when the accept's asset is the
   *  canonical USDC SAC, otherwise the raw atomic amount next to a truncated
   *  asset id (never assumed to be 7-decimal USDC when we don't actually know
   *  the asset's decimals). */
  priceLabel: string;
  ownershipState: "verified" | "proven-unconfirmed" | "unverified" | "unknown";
  settlements: number;
  /** undefined means genuinely never settled — see DiscoveryTrust.lastSettled. */
  lastSettled: string | undefined;
  /** Raw accepts[0] fields, kept alongside priceLabel (not parsed back out of
   *  it) for Step 6's test-payment flow: it needs the real atomic amount to
   *  compute a 5x funding target, and the real payTo to assert against
   *  before ever firing a payment — parsing either out of a formatted
   *  display string would be exactly the fragile round-trip
   *  formatSettlementAmount's own comment already avoids elsewhere.
   *  Undefined only if the discovery item's accepts array was genuinely
   *  empty (formatPrice's own "—" fallback case) — the Test button is
   *  disabled in that case, see webviewProvider.ts. */
  payTo: string | undefined;
  amount: string | undefined;
  asset: string | undefined;
}

export type EndpointsState = { kind: "unconfigured" } | { kind: "loaded"; listings: EndpointListing[] };

// --- Recent Settlements (Step 3) -------------------------------------------
// Data source: GET {EXPLORER_BASE}/payments?payTo={address}&limit=10 — confirmed
// live against the real Render-hosted API before writing this. Field names below
// are taken directly from that response, read from vellar-explorer's own
// db.ts/api-types.ts and cross-checked against a real call, not assumed:
//   { items: [{ txHash, ledger, closedAt, buyer, seller, sponsor, amount,
//               assetContract, assetSymbol, feeBumped, scheme, facilitator }],
//     pagination: { nextCursor, limit } }
// Confirmed sorted newest-first by closedAt already — no client-side sort needed.
// There is deliberately no `resource` field consumed here: it doesn't exist in
// this response (see EXPLORER_BASE's comment above) and this section does not
// attempt to reconstruct or guess it.

interface ExplorerPayment {
  txHash: string;
  closedAt: string;
  buyer: string;
  amount: string;
  assetSymbol: string | null;
}
interface ExplorerPaymentListResponse {
  items: ExplorerPayment[];
}

export interface SettlementEntry {
  txHash: string;
  /** Already formatted — "0.10 USDC" when assetSymbol is genuinely "USDC" from the
   *  explorer's own on-chain symbol() resolution, otherwise the raw amount next to
   *  the (possibly null) symbol, never assumed to be USDC. Same "never mislabel"
   *  rule as EndpointListing.priceLabel above, applied to a different data source. */
  amountLabel: string;
  /** Raw atomic amount string and the explorer's own assetSymbol claim, kept
   *  alongside amountLabel (not parsed back out of it) specifically so
   *  computeEarnings() below can sum true USDC entries correctly — parsing a
   *  formatted display string back into a number is exactly the kind of fragile
   *  round-trip this avoids by keeping the source values around. */
  rawAmount: string;
  assetSymbol: string | null;
  /** Full payer address — truncated only at the display layer (webviewProvider),
   *  same pattern as WalletBalanceState.address, never truncated this early so a
   *  future consumer of this field isn't stuck with an already-lossy value. Also
   *  why unique-payer counting (computeEarnings below) happens here, against
   *  these full addresses, and not in the webview against already-truncated
   *  ones — two different payers could in principle share a first4+last4. */
  payer: string;
  closedAt: string;
}
export type SettlementsState = { kind: "unconfigured" } | { kind: "loaded"; entries: SettlementEntry[] };

// --- Earnings Summary (Step 4) ----------------------------------------------
// Deliberately NOT a fifth PollingSource: this is a pure function of the
// SettlementEntry[] Step 3 already fetched, computed fresh each time
// settlements update rather than polled on its own cadence — a separate
// poller here would mean a second, independently-timed copy of state that
// could show a different set of entries than what Recent Settlements is
// currently displaying. "Derived from what fetchSettlements() already
// returns" taken literally: no new network call, no new poll interval, and
// definitionally never able to drift from the settlements section above it.
//
// The one bound honestly reflected in EarningsSummary.basedOnCount /
// PollingSource<SettlementsState>'s hardcoded limit=10: these are only correct
// within the last 10 settlements. "Total" and "this week" are not actually
// all-time or all-week sums, and the UI says so explicitly rather than
// implying a completeness the data doesn't have.

export interface EarningsSummary {
  totalUsdcLabel: string;
  todayUsdcLabel: string;
  thisWeekUsdcLabel: string;
  uniquePayers: number;
  /** Always SETTLEMENTS_LIMIT today, but derived from entries.length rather than
   *  the constant directly — if the developer genuinely has fewer than 10
   *  settlements ever, the note should say so honestly ("your 3 most recent"),
   *  not claim a window of 10 that was never actually filled. */
  basedOnCount: number;
}

/**
 * Sums only entries whose assetSymbol is exactly "USDC" (same rule as
 * formatSettlementAmount — the explorer's claim, matched exactly, never
 * assumed) using BigInt atomic-unit addition, never float addition of
 * already-formatted decimal strings, then formats once at the end. A
 * non-USDC entry contributes zero to every USDC total here, same as it
 * would to a real earnings figure — it isn't fungible with USDC and folding
 * its raw atomic amount into a USDC sum would be a real correctness bug
 * (a "1" of some other asset added to a USDC total means nothing).
 */
function sumUsdcAtomic(entries: readonly SettlementEntry[]): bigint {
  let total = 0n;
  for (const entry of entries) {
    if (entry.assetSymbol !== "USDC") continue;
    try {
      total += BigInt(entry.rawAmount);
    } catch {
      // Malformed amount from the explorer — skip rather than crash or throw
      // off the whole sum with a NaN-equivalent.
    }
  }
  return total;
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Local-timezone Monday 00:00:00 for the week containing `reference` — via
 *  Date's own local-timezone component accessors (getDay/getFullYear/etc.),
 *  never a hardcoded UTC offset, so this is correct for whatever timezone the
 *  developer's machine is actually set to, per the instruction. getDay()'s
 *  Sunday-is-0 convention is handled explicitly so Sunday still resolves back
 *  to the Monday that started ITS week, not the upcoming one. */
function startOfLocalWeek(reference: Date): Date {
  const day = reference.getDay(); // 0 = Sunday .. 6 = Saturday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  return new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() + diffToMonday);
}

export function computeEarnings(entries: readonly SettlementEntry[], now: Date = new Date()): EarningsSummary {
  const weekStart = startOfLocalWeek(now);
  // weekEnd is exclusive, one week after weekStart — a lower bound alone
  // (closedAt >= weekStart) would also match a date from a LATER week, since
  // it's chronologically after this week's Monday too. Caught by testing an
  // entry dated the FOLLOWING Monday against a Sunday `now`: it wrongly passed
  // a >= -only check. Not reachable through the real data flow today (a
  // settlement's closedAt can't be in the future), but computeEarnings is a
  // general function, not one only ever called with past-dated entries, so the
  // range is closed properly rather than relying on that assumption holding.
  const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7);
  const todayEntries = entries.filter((e) => isSameLocalDay(new Date(e.closedAt), now));
  const weekEntries = entries.filter((e) => {
    const closedAt = new Date(e.closedAt);
    return closedAt >= weekStart && closedAt < weekEnd;
  });
  const uniquePayers = new Set(entries.map((e) => e.payer)).size;

  return {
    totalUsdcLabel: `${formatAtomicUsdc(sumUsdcAtomic(entries).toString())} USDC`,
    todayUsdcLabel: `${formatAtomicUsdc(sumUsdcAtomic(todayEntries).toString())} USDC`,
    thisWeekUsdcLabel: `${formatAtomicUsdc(sumUsdcAtomic(weekEntries).toString())} USDC`,
    uniquePayers,
    basedOnCount: entries.length,
  };
}

/**
 * Shared source of live data for the whole sidebar. Owns one PollingSource per
 * section (wallet balance today; endpoints, settlements, etc. join the same pattern
 * in later steps) and the one rule that applies to all of them: the developer's real
 * payToAddress is read fresh from settings on every fetch, never stored on this
 * class between polls. What IS cached is the fetched RESULT (that's the whole point
 * of a poller — something to show between ticks), never the identity that produced it.
 */
export class DataProvider implements vscode.Disposable {
  private readonly walletSource: PollingSource<WalletBalanceState>;
  private readonly endpointsSource: PollingSource<EndpointsState>;
  private readonly settlementsSource: PollingSource<SettlementsState>;

  /** globalState is the ONLY place notification baselines persist (see
   *  notifications.ts) — DataProvider just owns the wiring that feeds each
   *  poll's fresh result into the comparator, it never reads or writes the
   *  baseline itself. */
  constructor(private readonly globalState: vscode.Memento) {
    this.walletSource = new PollingSource<WalletBalanceState>(
      WALLET_POLL_INTERVAL_MS,
      () => this.fetchWalletBalance(),
      (err) => logAndGenericError("wallet balance fetch failed", err),
    );
    this.endpointsSource = new PollingSource<EndpointsState>(
      ENDPOINTS_POLL_INTERVAL_MS,
      () => this.fetchEndpoints(),
      (err) => logAndGenericError("endpoint catalog fetch failed", err),
    );
    this.settlementsSource = new PollingSource<SettlementsState>(
      SETTLEMENTS_POLL_INTERVAL_MS,
      () => this.fetchSettlements(),
      (err) => logAndGenericError("settlement history fetch failed", err),
    );

    // Notification comparison runs off the SAME onDidUpdate events
    // webviewProvider.ts subscribes to, independently — this is a second,
    // unrelated listener on each source, not a replacement for how the
    // webview gets its own updates. Only `status: "ok"` results are worth
    // comparing; a "loading"/"error" tick has no new EndpointsState/
    // SettlementsState to diff against, so those are skipped entirely
    // instead of being treated as "no listings"/"no entries" (which would
    // incorrectly look like a mass removal on a transient fetch error).
    this.endpointsSource.onDidUpdate((result) => {
      if (result.status === "ok") void checkEndpointNotifications(this.globalState, result.data);
    });
    this.settlementsSource.onDidUpdate((result) => {
      if (result.status === "ok") void checkSettlementNotifications(this.globalState, result.data);
    });
  }

  get wallet(): PollingSource<WalletBalanceState> {
    return this.walletSource;
  }

  get endpoints(): PollingSource<EndpointsState> {
    return this.endpointsSource;
  }

  get settlements(): PollingSource<SettlementsState> {
    return this.settlementsSource;
  }

  /** Always re-reads the live setting — never a field on this class, never a
   *  parameter threaded in from a previous cycle. This is the one function every
   *  other piece of the sidebar should call to learn the address; nothing should
   *  hold onto its return value past the current operation. */
  static getConfiguredAddress(): string | undefined {
    const raw = vscode.workspace.getConfiguration("vellar-x402").get<string>("payToAddress", "");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private async fetchWalletBalance(): Promise<WalletBalanceState> {
    const address = DataProvider.getConfiguredAddress();
    if (!address) return { kind: "unconfigured" };
    if (!looksLikeStellarGAddress(address)) return { kind: "invalid-address" };

    // Horizon 404s an account that has never been funded on testnet — a real,
    // common case (a freshly generated address before its first friendbot call),
    // not a fault. Treated as zero balances rather than routed through the
    // generic error path, since it isn't an error, it's an accurate answer.
    let account: HorizonAccountResponse;
    try {
      account = await httpsGetJson<HorizonAccountResponse>(
        `${HORIZON_TESTNET}/accounts/${encodeURIComponent(address)}`,
      );
    } catch (err) {
      if (isNotFound(err)) return { kind: "loaded", address, usdc: "0.00", xlm: "0.00" };
      throw err;
    }

    const xlm = account.balances.find((b) => b.asset_type === "native")?.balance ?? "0";
    const usdc =
      account.balances.find(
        (b) => b.asset_code === USDC_CODE && b.asset_issuer === USDC_ISSUER,
      )?.balance ?? "0";

    return { kind: "loaded", address, usdc, xlm };
  }

  private async fetchEndpoints(): Promise<EndpointsState> {
    // Read live, same rule as the wallet fetch above — never a cached/stored
    // address, re-checked on every poll tick.
    const address = DataProvider.getConfiguredAddress();
    if (!address) return { kind: "unconfigured" };

    const response = await httpsGetJson<DiscoveryResponse>(`${FACILITATOR_BASE}/discovery/resources?limit=100`);

    const listings: EndpointListing[] = response.items
      // Match if ANY accepted payment option's payTo is the developer's address —
      // not accepts[0], the array can (even if it rarely does today) hold more
      // than one option. Exact, case-sensitive string comparison: Stellar
      // addresses are case-sensitive, this is deliberately not
      // .toLowerCase()'d anywhere.
      .filter((item) => item.accepts.some((accept) => accept.payTo === address))
      .map((item) => ({
        resource: item.resource,
        priceLabel: formatPrice(item.accepts[0]),
        ownershipState: item.trust.ownershipState ?? "unknown",
        settlements: item.trust.settlements,
        lastSettled: item.trust.lastSettled,
        // Raw, unformatted — see EndpointListing's own doc comment for why
        // these travel alongside priceLabel instead of being re-derived from
        // it later. accepts[0] specifically (matching formatPrice's own
        // choice above) — a real limitation if a resource ever offers more
        // than one accept option, flagged there already, not new here.
        payTo: item.accepts[0]?.payTo,
        amount: item.accepts[0]?.amount,
        asset: item.accepts[0]?.asset,
      }));

    return { kind: "loaded", listings };
  }

  private async fetchSettlements(): Promise<SettlementsState> {
    const address = DataProvider.getConfiguredAddress();
    if (!address) return { kind: "unconfigured" };

    // payTo filters server-side to this address's own settlements — the explorer
    // does the same "seller === address" match dataProvider does for endpoints,
    // just on-chain rather than in the discovery catalog. One call, already
    // sorted newest-first (confirmed against live data), no client-side sort.
    const response = await httpsGetJson<ExplorerPaymentListResponse>(
      `${EXPLORER_BASE}/payments?payTo=${encodeURIComponent(address)}&limit=${SETTLEMENTS_LIMIT}`,
    );

    const entries: SettlementEntry[] = response.items.map((item) => ({
      txHash: item.txHash,
      amountLabel: formatSettlementAmount(item.amount, item.assetSymbol),
      rawAmount: item.amount,
      assetSymbol: item.assetSymbol,
      payer: item.buyer,
      closedAt: item.closedAt,
    }));

    return { kind: "loaded", entries };
  }

  dispose(): void {
    this.walletSource.dispose();
    this.endpointsSource.dispose();
    this.settlementsSource.dispose();
  }
}

/**
 * Only labels an amount "USDC" when the accept's asset is genuinely the
 * canonical USDC SAC — matched exactly, never inferred from a name or a
 * hopeful default. For any other asset, the atomic amount is shown raw,
 * unscaled, next to the truncated contract id: we don't know that asset's
 * decimals from this response, and dividing by 10^7 (correct for USDC) could
 * silently show a wrong number for a token that isn't.
 */
function formatPrice(accept: DiscoveryAccept | undefined): string {
  if (!accept) return "—";
  if (accept.asset === USDC_SAC_CONTRACT) {
    return `${formatAtomicUsdc(accept.amount)} USDC`;
  }
  return `${accept.amount} (${truncateMiddle(accept.asset)})`;
}

/**
 * The explorer already resolves assetSymbol server-side against the real on-chain
 * symbol() call (see EXPLORER_BASE's comment) — but "the explorer says USDC" is
 * still an external claim, not proof, so this only labels an amount USDC when
 * assetSymbol is exactly "USDC", scaling with formatAtomicUsdc (7-decimal atomic,
 * confirmed live: "1000000" for a $0.10 settlement). Anything else (a different
 * symbol, or null when the token isn't a standard SEP-41) shows the raw atomic
 * amount, UNSCALED, next to whatever symbol string the explorer did return (or
 * "unknown asset" for null) — same rule as formatPrice's non-USDC branch above:
 * this response gives no decimals figure for a non-USDC asset, so no scaling
 * function (atomic-7 or plain decimal) can be applied to it without guessing.
 */
function formatSettlementAmount(rawAmount: string, assetSymbol: string | null): string {
  if (assetSymbol === "USDC") return `${formatAtomicUsdc(rawAmount)} USDC`;
  return `${rawAmount} ${assetSymbol ?? "unknown asset"}`;
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.name === "HttpStatusError" && (err as { status?: number }).status === 404;
}
