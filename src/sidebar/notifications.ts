import * as vscode from "vscode";
import type { EndpointListing, EndpointsState, SettlementEntry, SettlementsState } from "./dataProvider";
import { truncateMiddle } from "./format";

/**
 * Everything persisted for notification comparison, and NOTHING else — no
 * addresses, no balances, no amounts, per the instruction. Endpoint state is
 * keyed by resource URL (the only stable identifier My Endpoints has); settlement
 * state is a flat txHash set, since a settlement has no other stable key here
 * (see dataProvider.ts's own comment on why /payments has no resource field).
 *
 * Two INDEPENDENT `initialized` flags, not one shared flag, because endpoints
 * (60s poll) and settlements (30s poll) complete their first fetch at different,
 * uncoordinated times. A single shared flag would let whichever section polls
 * first mark the whole baseline "initialized" before the OTHER section has
 * written any baseline of its own — so that section's own first real poll would
 * then compare against an empty baseline and fire a burst of false notifications
 * for everything that already existed. Each section only starts comparing once
 * ITS OWN first poll has completed, independent of the other's timing.
 */
interface NotificationBaseline {
  endpointsInitialized: boolean;
  settlementCountByResource: Record<string, number>;
  ownershipStateByResource: Record<string, string>;
  settlementsInitialized: boolean;
  knownTxHashes: string[];
}

const GLOBAL_STATE_KEY = "vellar-x402.notificationBaseline";

const EMPTY_BASELINE: NotificationBaseline = {
  endpointsInitialized: false,
  settlementCountByResource: {},
  ownershipStateByResource: {},
  settlementsInitialized: false,
  knownTxHashes: [],
};

function readBaseline(memento: vscode.Memento): NotificationBaseline {
  return memento.get<NotificationBaseline>(GLOBAL_STATE_KEY, EMPTY_BASELINE);
}

async function writeBaseline(memento: vscode.Memento, baseline: NotificationBaseline): Promise<void> {
  await memento.update(GLOBAL_STATE_KEY, baseline);
}

/** Strips the scheme and truncates to 40 chars max — used only inside
 *  notification TEXT (the webview's own endpoint cards still show the full
 *  resource URL; that boundary is unaffected by this). "Never a full URL in a
 *  notification" taken literally: even a same-origin path can be long, so the
 *  cap applies regardless of whether the scheme-stripped remainder is already
 *  short. */
function truncateResourceForNotification(resource: string): string {
  const withoutScheme = resource.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  if (withoutScheme.length <= 40) return withoutScheme;
  return `${withoutScheme.slice(0, 40)}…`;
}

/**
 * Compares the current EndpointsState against the persisted baseline and fires
 * "first payment" / "now verified" notifications for whatever genuinely
 * transitioned, then persists the new baseline. A no-op (writes nothing, fires
 * nothing) for anything other than `{ kind: "loaded" }` — "unconfigured" is not
 * a meaningful state to diff against, and leaving the prior baseline in place
 * means a later re-configuration to the same address picks up comparisons
 * exactly where they left off rather than resetting.
 */
export async function checkEndpointNotifications(memento: vscode.Memento, state: EndpointsState): Promise<void> {
  if (state.kind !== "loaded") return;

  const baseline = readBaseline(memento);
  const wasInitialized = baseline.endpointsInitialized;
  const nextSettlementCounts: Record<string, number> = {};
  const nextOwnershipStates: Record<string, string> = {};

  for (const listing of state.listings) {
    nextSettlementCounts[listing.resource] = listing.settlements;
    nextOwnershipStates[listing.resource] = listing.ownershipState;

    // The first poll ever recorded establishes the baseline only — it must not
    // fire "first payment" for every already-settled endpoint just because
    // globalState started empty, per the instruction. Only the SECOND poll
    // onward (wasInitialized === true) compares and notifies.
    if (wasInitialized) {
      notifyIfFirstPayment(listing, baseline.settlementCountByResource[listing.resource]);
      notifyIfNewlyVerified(listing, baseline.ownershipStateByResource[listing.resource]);
    }
  }

  await writeBaseline(memento, {
    ...baseline,
    endpointsInitialized: true,
    settlementCountByResource: nextSettlementCounts,
    ownershipStateByResource: nextOwnershipStates,
  });
}

function notifyIfFirstPayment(listing: EndpointListing, previousCount: number | undefined): void {
  // Absent from the previous poll counts as 0, per the instruction — a brand
  // new listing that already has settlements > 0 the first time it's SEEN
  // (not the first time the developer's account was ever polled, which
  // `wasInitialized` already guards) still correctly fires.
  const previous = previousCount ?? 0;
  if (previous === 0 && listing.settlements > 0) {
    const truncatedUrl = truncateResourceForNotification(listing.resource);
    void vscode.window.showInformationMessage(`Your ${truncatedUrl} endpoint just earned its first payment`);
  }
}

function notifyIfNewlyVerified(listing: EndpointListing, previousState: string | undefined): void {
  const wasUnverifiedOrProven = previousState === "unverified" || previousState === "proven-unconfirmed";
  if (wasUnverifiedOrProven && listing.ownershipState === "verified") {
    const truncatedUrl = truncateResourceForNotification(listing.resource);
    void vscode.window.showInformationMessage(`Your ${truncatedUrl} endpoint is now verified in the Vellar Bazaar`);
  }
}

/**
 * Same baseline-then-compare shape as checkEndpointNotifications, applied to
 * SettlementsState. `notifyOnEveryPayment` is read fresh from the live setting
 * at call time (same "never cache a setting" rule DataProvider.getConfiguredAddress
 * already follows) — never threaded in as a captured value that could go stale.
 */
export async function checkSettlementNotifications(memento: vscode.Memento, state: SettlementsState): Promise<void> {
  if (state.kind !== "loaded") return;

  const baseline = readBaseline(memento);
  const wasInitialized = baseline.settlementsInitialized;
  const previousTxHashes = new Set(baseline.knownTxHashes);
  const notifyEnabled = vscode.workspace
    .getConfiguration("vellar-x402")
    .get<boolean>("notifyOnEveryPayment", false);

  if (wasInitialized && notifyEnabled) {
    for (const entry of state.entries) {
      if (!previousTxHashes.has(entry.txHash)) {
        notifyNewPayment(entry);
      }
    }
  }

  await writeBaseline(memento, {
    ...baseline,
    settlementsInitialized: true,
    knownTxHashes: state.entries.map((e) => e.txHash),
  });
}

function notifyNewPayment(entry: SettlementEntry): void {
  // Same first4+last4 form used everywhere else a payer address reaches a
  // display surface (see toSettlementsDisplayState in webviewProvider.ts) —
  // computed here, at the one call site that builds this notification's text,
  // never passed a full address to truncate closer to the vscode.window call.
  const truncatedPayer = truncateMiddle(entry.payer);
  void vscode.window.showInformationMessage(`New payment: ${entry.amountLabel} from ${truncatedPayer}`);
}
