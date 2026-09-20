#!/usr/bin/env node
/**
 * Regression test for the "settlements exist but aren't indexed" note in
 * Recent Settlements and Earnings Summary.
 *
 * WHY THIS EXISTS: the explorer (vellar-explorer) and the facilitator's
 * catalog are two independent sources of settlement truth and they genuinely
 * disagree. Real mainnet settlements — verified on-chain via Horizon
 * (a2d6ee5e…, 09b24dc9…) — return `payment_not_found` from the explorer's own
 * /payments/:txHash route, while the facilitator's catalog counts them. The
 * extension's query is CORRECT (`?payTo=` is a documented param that the
 * explorer maps to `seller = ?` in SQL); the rows simply are not indexed.
 *
 * Rendering a bare "No settlements yet" in that state tells a developer they
 * have earned nothing while real USDC has been received. This test locks in
 * the distinction so a future refactor cannot quietly restore that claim.
 *
 * APPROACH: extracts the REAL webview script out of the REAL renderHtml()
 * output (no reimplementation of the render logic) and runs it against a
 * minimal DOM stub, then drives it through the same postMessage events the
 * extension host actually sends. Asserting on the produced innerHTML is what
 * ships, so this covers the string exactly as a user would see it.
 */
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const outFile = path.join(root, ".test-build", "settlements-indexing-note-entry.js");

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures += 1;
  } else {
    console.log(`  ok: ${message}`);
  }
}

/** A DOM stub covering only what the webview script touches at load time. */
function makeFakeDom() {
  const elements = new Map();
  const make = (id) => ({
    id,
    innerHTML: "",
    value: "",
    textContent: "",
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    appendChild() {},
    setAttribute() {},
    getAttribute: () => null,
    focus() {},
    closest: () => null,
  });
  return {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, make(id));
      return elements.get(id);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    body: make("body"),
    _elements: elements,
  };
}

async function main() {
  // Bundle webviewProvider so its renderHtml() can be called for real, with
  // "vscode" aliased to the same stub the other harnesses in this repo use.
  await esbuild.build({
    entryPoints: [path.join(__dirname, "settlements-indexing-note-entry.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: outFile,
    logLevel: "silent",
    plugins: [
      {
        name: "stub-vscode",
        setup(build) {
          build.onResolve({ filter: /^vscode$/ }, () => ({
            path: path.join(__dirname, "vscode-test-stub.js"),
          }));
          build.onResolve({ filter: /\.\/httpsClient$/ }, () => ({
            path: path.join(__dirname, "fake-https-client.js"),
          }));
        },
      },
    ],
  });

  const { extractWebviewScript } = require(outFile);
  const script = extractWebviewScript();
  assert(typeof script === "string" && script.length > 0, "the webview script was extracted from the real renderHtml() output");

  // Run the real script with a stubbed global surface.
  const document = makeFakeDom();
  const listeners = [];
  const sandbox = {
    document,
    window: {
      addEventListener: (type, cb) => {
        if (type === "message") listeners.push(cb);
      },
    },
    acquireVsCodeApi: () => ({ postMessage() {}, getState: () => undefined, setState() {} }),
    console: { log() {}, error() {}, warn() {} },
  };
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = sandbox.window.addEventListener;

  const vm = require("vm");
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { timeout: 5000 });

  assert(listeners.length > 0, "the webview script registered a message listener");
  const send = (data) => listeners.forEach((cb) => cb({ data }));

  const settlementsRoot = document.getElementById("settlements-root");
  const earningsRoot = document.getElementById("earnings-root");

  const emptySettlements = {
    status: "ready",
    data: { kind: "loaded", entries: [], nextCursor: undefined },
  };
  const emptyEarnings = {
    status: "ready",
    data: { kind: "loaded", summary: { basedOnCount: 0 } },
  };

  // --- Case 1: genuinely nothing. Catalog agrees there are no settlements. --
  send({ type: "network", network: "stellar:pubnet" });
  send({
    type: "endpoints",
    state: { status: "ready", data: { kind: "loaded", listings: [] } },
  });
  send({ type: "settlements", state: emptySettlements, pagination: undefined });
  send({ type: "earnings", state: emptyEarnings });

  assert(
    settlementsRoot.innerHTML.includes("No settlements yet"),
    "with a catalog total of 0, Recent Settlements still says 'No settlements yet'",
  );
  assert(
    earningsRoot.innerHTML.includes("No settlements yet"),
    "with a catalog total of 0, Earnings Summary still says 'No settlements yet'",
  );

  // --- Case 2: the real bug. Catalog counts settlements, explorer has none. -
  send({
    type: "endpoints",
    state: {
      status: "ready",
      data: {
        kind: "loaded",
        listings: [
          { resource: "https://a.test/x", priceLabel: "0.50 USDC", ownershipState: "unverified", settlements: 290, lastSettled: null, method: "POST" },
          { resource: "https://b.test/y", priceLabel: "0.10 USDC", ownershipState: "unverified", settlements: 1, lastSettled: null, method: undefined },
        ],
      },
    },
  });

  const html = settlementsRoot.innerHTML;
  assert(!html.includes("No settlements yet"), "the misleading 'No settlements yet' is NOT shown when the catalog counts settlements");
  assert(html.includes("291"), `the note reports the catalog's summed total (291), got: ${html.slice(0, 200)}`);
  assert(html.includes("confirmed on-chain"), "the note states the settlements are confirmed on-chain");
  assert(
    /vellar-facilitator\.onrender\.com\/discovery\/resources\?network=stellar%3Apubnet/.test(html),
    "the note links to the facilitator catalog for the CURRENT network",
  );
  assert(
    !/delay|shortly|soon|will appear/i.test(html),
    "the note does not promise the settlements will appear later — a 15h-old settlement was observed still missing",
  );
  assert(
    earningsRoot.innerHTML.includes("cannot be totalled"),
    "Earnings Summary explains it cannot total, rather than implying 0.00 earned",
  );

  // --- Case 3: message order must not matter. ------------------------------
  // The host posts endpoints/settlements/earnings independently; whichever
  // lands first must not win. Rebuild with settlements arriving LAST.
  const doc2 = makeFakeDom();
  const listeners2 = [];
  const sandbox2 = {
    document: doc2,
    window: { addEventListener: (t, cb) => t === "message" && listeners2.push(cb) },
    acquireVsCodeApi: () => ({ postMessage() {}, getState: () => undefined, setState() {} }),
    console: { log() {}, error() {}, warn() {} },
  };
  sandbox2.globalThis = sandbox2;
  sandbox2.addEventListener = sandbox2.window.addEventListener;
  vm.createContext(sandbox2);
  vm.runInContext(script, sandbox2, { timeout: 5000 });
  const send2 = (data) => listeners2.forEach((cb) => cb({ data }));

  send2({ type: "network", network: "stellar:pubnet" });
  send2({ type: "settlements", state: emptySettlements, pagination: undefined });
  send2({
    type: "endpoints",
    state: { status: "ready", data: { kind: "loaded", listings: [{ resource: "https://a.test/x", priceLabel: "0.50 USDC", ownershipState: "unverified", settlements: 7, lastSettled: null, method: undefined }] } },
  });

  assert(
    doc2.getElementById("settlements-root").innerHTML.includes("7"),
    "a LATER endpoints message re-renders the settlements note (message order does not matter)",
  );

  // --- Case 4: the link follows the network toggle. ------------------------
  send({ type: "network", network: "stellar:testnet" });
  send({ type: "settlements", state: emptySettlements, pagination: undefined });
  assert(
    settlementsRoot.innerHTML.includes("stellar%3Atestnet"),
    "after toggling to testnet, the catalog link points at the testnet catalog",
  );

  if (failures > 0) {
    console.error(`\n=== SETTLEMENTS INDEXING NOTE CHECK FAILED (${failures}) ===`);
    process.exit(1);
  }
  console.log("=== SETTLEMENTS INDEXING NOTE CHECK PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
