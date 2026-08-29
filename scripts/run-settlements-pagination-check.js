#!/usr/bin/env node
/**
 * Regression test for Recent Settlements pagination (VellarSidebarProvider's
 * settlementsCursorStack/handleSettlementsPollUpdate/goToSettlementsPage —
 * see webviewProvider.ts's own doc comments on that state). Covers exactly
 * the four cases called out when this feature was built:
 *
 *   1. Next fetches page 2 with the right cursor
 *   2. Prev returns to page 1 without a fetch
 *   3. hasNext/hasPrev compute correctly at all four page1/page2 x
 *      hasNextCursor/no-nextCursor boundary combinations
 *   4. The new-data diff snaps back to page 1 only when the top txHash
 *      actually changes, not on every poll tick
 *
 * Drives the REAL VellarSidebarProvider/DataProvider through their genuine
 * public entry points (resolveWebviewView + the onDidReceiveMessage callback
 * it registers, exactly as a real webview click would invoke it) — not by
 * reaching into private methods — using a controllable fake httpsGetJson
 * (fake-https-client-paginated.js) so each case can queue exactly the
 * /payments response(s) it needs, offline and deterministically. No live
 * network call anywhere in this script, matching this repo's other
 * acceptance scripts.
 *
 * Every case's harness is torn down in a `finally`, not just at the end of
 * a successful run — DataProvider owns three PollingSources with real
 * setInterval timers (started synchronously in VellarSidebarProvider's own
 * constructor), and an assertion throwing before dispose() is reached would
 * otherwise leave those timers running and the process hanging instead of
 * exiting, on top of failing the assertion itself.
 */
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const outFile = path.join(root, ".test-build", "settlements-pagination-entry.js");

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`  ok: ${message}`);
}

async function withHarness(createHarness, initialPage1Response, run) {
  const harness = createHarness(initialPage1Response);
  try {
    await run(harness);
  } finally {
    harness.dispose();
  }
}

async function main() {
  console.log("=== Settlements pagination check (committed) ===\n");
  const startedAt = Date.now();

  await esbuild.build({
    entryPoints: [path.join(__dirname, "settlements-pagination-entry.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: outFile,
    alias: { vscode: path.join(__dirname, "vscode-test-stub.js") },
    plugins: [
      {
        name: "fake-https-client-paginated",
        setup(build) {
          // Same scoped-to-importer discipline as run-postmessage-leak-check.js's
          // own plugin — only dataProvider.ts's own "./httpsClient" import is
          // redirected, nothing else.
          build.onResolve({ filter: /^\.\/httpsClient$/ }, (args) => {
            if (args.importer.endsWith(path.join("sidebar", "dataProvider.ts"))) {
              return { path: path.join(__dirname, "fake-https-client-paginated.js") };
            }
            return undefined;
          });
        },
      },
    ],
  });

  const { createHarness, makePayment, paymentsFake } = require(outFile);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // --- Case 1: Next fetches page 2 with the right cursor ------------------
  console.log("1. Next fetches page 2 with the right cursor...");
  const nextCursorFromPage1 = "opaque-cursor-to-page-2";
  await withHarness(
    createHarness,
    { items: [makePayment("tx-page1-a", "2026-08-29T10:00:00.000Z")], pagination: { nextCursor: nextCursorFromPage1, limit: 10 } },
    async (harness) => {
      await harness.waitForInitialLoad();
      const afterPage1 = harness.postedSettlementsMessages.at(-1);
      assert(afterPage1.state.data.kind === "loaded", "page 1 loaded successfully before clicking Next");
      assert(afterPage1.state.data.entries[0].txHash === "tx-page1-a", "page 1 shows the page-1 entry");
      assert(afterPage1.pagination.hasNext === true, "page 1's own pagination correctly reports hasNext");

      paymentsFake.queuePaymentsResponse({
        items: [makePayment("tx-page2-a", "2026-08-29T09:00:00.000Z")],
        pagination: { nextCursor: null, limit: 10 },
      });

      harness.sendMessageFromWebview({ type: "settlementsPage", direction: "next" });
      // goToSettlementsPage's fetch is async — its own first action is posting
      // a synchronous "loading" message, then it awaits the fetch, so one
      // more macrotask turn is needed for the real page-2 message.
      await wait(100);

      assert(paymentsFake.paymentsCalls.length === 2, `exactly 2 /payments calls were made total, got ${paymentsFake.paymentsCalls.length}`);
      const secondCallUrl = paymentsFake.paymentsCalls[1];
      assert(
        secondCallUrl.includes(`cursor=${encodeURIComponent(nextCursorFromPage1)}`),
        `the second /payments call used page 1's real nextCursor as its cursor param, got: ${secondCallUrl}`,
      );

      const afterNext = harness.postedSettlementsMessages.at(-1);
      assert(afterNext.state.data.kind === "loaded", "page 2 loaded successfully");
      assert(afterNext.state.data.entries[0].txHash === "tx-page2-a", "page 2 shows the page-2 entry, not page 1's");
      assert(afterNext.pagination.page === 2, "pagination.page reports 2 while on page 2");
    },
  );

  // --- Case 2: Prev returns to page 1 without a fetch ----------------------
  console.log("\n2. Prev returns to page 1 without a fetch...");
  await withHarness(
    createHarness,
    { items: [makePayment("tx-p2case-page1", "2026-08-29T10:00:00.000Z")], pagination: { nextCursor: "cursor-to-page-2", limit: 10 } },
    async (harness) => {
      await harness.waitForInitialLoad();

      paymentsFake.queuePaymentsResponse({
        items: [makePayment("tx-p2case-page2", "2026-08-29T09:00:00.000Z")],
        pagination: { nextCursor: null, limit: 10 },
      });
      harness.sendMessageFromWebview({ type: "settlementsPage", direction: "next" });
      await wait(100);

      const callsBeforePrev = paymentsFake.paymentsCalls.length;
      assert(callsBeforePrev === 2, "sanity check: exactly 2 calls made before Prev (page 1's initial load + page 2's Next fetch)");

      harness.sendMessageFromWebview({ type: "settlementsPage", direction: "prev" });
      await wait(100);

      assert(
        paymentsFake.paymentsCalls.length === callsBeforePrev,
        `Prev made NO additional /payments call — still ${callsBeforePrev}, got ${paymentsFake.paymentsCalls.length}`,
      );

      const afterPrev = harness.postedSettlementsMessages.at(-1);
      assert(afterPrev.state.data.kind === "loaded", "page 1 data is shown again after Prev");
      assert(
        afterPrev.state.data.entries[0].txHash === "tx-p2case-page1",
        "the restored page 1 is the REAL original page-1 entry (from the poller's own current state), not refetched",
      );
      assert(afterPrev.pagination.page === 1, "pagination.page reports 1 again after Prev");
    },
  );

  // --- Case 3: hasNext/hasPrev boundaries -----------------------------------
  console.log("\n3. hasNext/hasPrev compute correctly at boundaries...");

  await withHarness(
    createHarness,
    { items: [makePayment("tx-b1", "2026-08-29T10:00:00.000Z")], pagination: { nextCursor: null, limit: 10 } },
    async (harness) => {
      await harness.waitForInitialLoad();
      const msg = harness.postedSettlementsMessages.at(-1);
      assert(msg.pagination.hasPrev === false, "page 1, no nextCursor: hasPrev is false");
      assert(msg.pagination.hasNext === false, "page 1, no nextCursor: hasNext is false");
    },
  );

  await withHarness(
    createHarness,
    { items: [makePayment("tx-b2", "2026-08-29T10:00:00.000Z")], pagination: { nextCursor: "cursor-b2", limit: 10 } },
    async (harness) => {
      await harness.waitForInitialLoad();
      const msg = harness.postedSettlementsMessages.at(-1);
      assert(msg.pagination.hasPrev === false, "page 1, with nextCursor: hasPrev is false");
      assert(msg.pagination.hasNext === true, "page 1, with nextCursor: hasNext is true");
    },
  );

  await withHarness(
    createHarness,
    { items: [makePayment("tx-b3-page1", "2026-08-29T10:00:00.000Z")], pagination: { nextCursor: "cursor-b3", limit: 10 } },
    async (harness) => {
      await harness.waitForInitialLoad();
      paymentsFake.queuePaymentsResponse({
        items: [makePayment("tx-b3-page2", "2026-08-29T09:00:00.000Z")],
        pagination: { nextCursor: null, limit: 10 },
      });
      harness.sendMessageFromWebview({ type: "settlementsPage", direction: "next" });
      await wait(100);
      const msg = harness.postedSettlementsMessages.at(-1);
      assert(msg.pagination.hasPrev === true, "page 2, no nextCursor: hasPrev is true");
      assert(msg.pagination.hasNext === false, "page 2, no nextCursor: hasNext is false");
    },
  );

  await withHarness(
    createHarness,
    { items: [makePayment("tx-b4-page1", "2026-08-29T10:00:00.000Z")], pagination: { nextCursor: "cursor-b4-to-page2", limit: 10 } },
    async (harness) => {
      await harness.waitForInitialLoad();
      paymentsFake.queuePaymentsResponse({
        items: [makePayment("tx-b4-page2", "2026-08-29T09:00:00.000Z")],
        pagination: { nextCursor: "cursor-b4-to-page3", limit: 10 },
      });
      harness.sendMessageFromWebview({ type: "settlementsPage", direction: "next" });
      await wait(100);
      const msg = harness.postedSettlementsMessages.at(-1);
      assert(msg.pagination.hasPrev === true, "page 2, with nextCursor: hasPrev is true");
      assert(msg.pagination.hasNext === true, "page 2, with nextCursor: hasNext is true");
    },
  );

  // --- Case 4: new-data diff only snaps back on a genuine change -----------
  console.log("\n4. New-data diff snaps back to page 1 only when the top txHash changes...");

  // 4a. Same top txHash on the next poll tick: no snap-back — asserted via
  // the poll's own page-1 data simply being reposted unchanged (still page
  // 1, still the same entry), not by absence of a message (page 1's own
  // poll always reposts on every tick, changed or not — see
  // handleSettlementsPollUpdate's own doc comment on why).
  await withHarness(
    createHarness,
    { items: [makePayment("tx-unchanged", "2026-08-29T10:00:00.000Z")], pagination: { nextCursor: null, limit: 10 } },
    async (harness) => {
      await harness.waitForInitialLoad();

      const messagesBeforeTick = harness.postedSettlementsMessages.length;
      paymentsFake.queuePaymentsResponse({
        items: [makePayment("tx-unchanged", "2026-08-29T10:00:00.000Z")],
        pagination: { nextCursor: null, limit: 10 },
      });
      await harness.simulateNextPollTick();

      const afterTick = harness.postedSettlementsMessages.at(-1);
      assert(
        harness.postedSettlementsMessages.length > messagesBeforeTick,
        "the poll tick with an unchanged top txHash still re-posts settlements (page 1 always reflects the latest poll)",
      );
      assert(afterTick.pagination.page === 1, "still reports page 1 after an unchanged-top-txHash poll tick");
      assert(afterTick.state.data.entries[0].txHash === "tx-unchanged", "the unchanged entry is still what's shown");
    },
  );

  // 4b. Different top txHash while parked on page 2: snaps back to page 1.
  await withHarness(
    createHarness,
    { items: [makePayment("tx-original-top", "2026-08-29T10:00:00.000Z")], pagination: { nextCursor: "cursor-to-page-2-case4b", limit: 10 } },
    async (harness) => {
      await harness.waitForInitialLoad();

      paymentsFake.queuePaymentsResponse({
        items: [makePayment("tx-page2-case4b", "2026-08-29T09:00:00.000Z")],
        pagination: { nextCursor: null, limit: 10 },
      });
      harness.sendMessageFromWebview({ type: "settlementsPage", direction: "next" });
      await wait(100);

      const onPage2 = harness.postedSettlementsMessages.at(-1);
      assert(onPage2.pagination.page === 2, "sanity check: genuinely on page 2 before the new-settlement poll tick");

      paymentsFake.queuePaymentsResponse({
        items: [makePayment("tx-genuinely-new", "2026-08-29T11:00:00.000Z")],
        pagination: { nextCursor: "cursor-to-page-2-case4b", limit: 10 },
      });
      await harness.simulateNextPollTick();

      const afterNewTick = harness.postedSettlementsMessages.at(-1);
      assert(afterNewTick.pagination.page === 1, "snapped back to page 1 once a genuinely new top txHash arrived while on page 2");
      assert(
        afterNewTick.state.data.entries[0].txHash === "tx-genuinely-new",
        "page 1's newest entry is the genuinely new settlement, not the stale page-2 view",
      );
    },
  );

  const elapsed = Date.now() - startedAt;
  assert(elapsed < 5000, `total test time (${elapsed}ms) is under the required 5000ms`);

  console.log("\n=== SETTLEMENTS PAGINATION CHECK PASSED ===");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Every harness disposes its own DataProvider (stopping all three
    // PollingSource timers) in withHarness's own finally above — this is a
    // last-resort belt-and-suspenders exit, not a sign anything is expected
    // to still be running here. Explicit rather than relying on the process
    // to notice there's nothing left keeping the event loop alive, since a
    // bug in a future edit to this file (a harness constructed outside
    // withHarness, say) would otherwise hang CI silently instead of failing
    // loudly.
    process.exit(process.exitCode ?? 0);
  });
