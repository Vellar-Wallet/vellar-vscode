#!/usr/bin/env node
/**
 * Acceptance test harness for slice one.
 *
 * Exercises the real detection + injection logic (src/detectors, src/injector,
 * src/generators) — the same code the extension calls — against the Express
 * fixture in fixtures/express-fresh, without needing the VS Code extension host.
 * Mirrors the spec's acceptance test: three routes, pick one, price 0.05, inject,
 * assert no syntax errors, assert tsc passes.
 *
 * Writes the injected result to fixtures/express-fresh/src/index.ts ONLY for the
 * duration of the tsc check, then restores the original (git-tracked, pristine)
 * content — so the fixture stays reusable and `git status` stays clean after a run.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const fixtureDir = path.join(root, "fixtures", "express-fresh");
const fixtureFile = path.join(fixtureDir, "src", "index.ts");

esbuild.buildSync({
  entryPoints: [path.join(root, "src", "testEntry.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: path.join(root, ".test-build", "testEntry.js"),
  external: ["vscode"],
});

const {
  detectExpressFastifyRoutes,
  computeEdits,
  applyEdits,
  validatePriceInput,
  hasExistingGate,
  findDescriptionSelection,
  findFirstExtensionsTodoSelection,
} = require(path.join(root, ".test-build", "testEntry.js"));

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`  ok: ${message}`);
}

console.log("=== Vellar x402 — slice one acceptance test ===\n");

const originalText = fs.readFileSync(fixtureFile, "utf8");

try {
  console.log("1. Scanning fixture for routes...");
  const routes = detectExpressFastifyRoutes(originalText);
  assert(routes.length === 3, `expected 3 routes detected, found ${routes.length}`);
  console.log("   detected:", routes.map((r) => `${r.method} ${r.routePath}`).join(", "));

  console.log("\n2. Validating price input...");
  assert(validatePriceInput("0.05") === null, '"0.05" is accepted as valid');
  assert(validatePriceInput("-1") !== null, '"-1" is rejected');
  assert(validatePriceInput("0.00000001") !== null, "8 decimal places is rejected (USDC max is 7)");
  assert(validatePriceInput("0.0000001") === null, "7 decimal places is accepted");
  assert(validatePriceInput("abc") !== null, '"abc" is rejected');
  assert(validatePriceInput("0") !== null, '"0" is rejected (must be positive)');

  console.log("\n3. Picking GET /weather, price 0.05, injecting...");
  const picked = routes.find((r) => r.routePath === "/weather" && r.method === "GET");
  assert(Boolean(picked), "found the GET /weather route to pick");

  const config = {
    priceUsdc: "0.05",
    payToAddress: "GA123456789EXAMPLESTELLARADDRESSXXXXXXXXXXXXXXXXXXXXXXXXX",
    endpointUrl: "/weather",
    serviceName: "express-fresh-fixture",
  };

  const lines = originalText.split(/\r?\n/);
  const edits = computeEdits(lines, picked, config);
  assert(edits.length > 0, "computeEdits produced edits");

  const injectedText = applyEdits(originalText, edits);

  console.log("\n3b. Verifying the double-injection guard...");
  assert(!hasExistingGate(originalText, picked), "pristine file has no existing gate for GET /weather");
  assert(hasExistingGate(injectedText, picked), "injected file is now detected as already-gated for GET /weather");
  assert(!hasExistingGate(injectedText, routes.find((r) => r.routePath === "/users/:id")), "an unrelated route is not falsely detected as gated");

  console.log("\n4. Checking injected code structurally...");
  assert(injectedText.includes('import { paymentMiddleware, x402ResourceServer } from "@x402/express";'), "Express imports injected");
  assert(injectedText.includes('import { ExactStellarScheme } from "@x402/stellar/exact/server";'), "ExactStellarScheme import injected");
  assert(injectedText.includes('import { HTTPFacilitatorClient } from "@x402/core/server";'), "HTTPFacilitatorClient import injected");
  assert(
    injectedText.includes('import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";'),
    "Bazaar extension imports injected",
  );
  assert(injectedText.includes("https://vellar-facilitator.onrender.com"), "facilitator URL injected");
  assert(injectedText.includes(config.payToAddress), "payToAddress injected");
  assert(injectedText.includes('price: "$0.05"'), "price injected as dollar-string");
  assert(injectedText.includes('"stellar:testnet" as const'), "network injected with literal type preserved");
  assert(injectedText.includes('serviceName: "express-fresh-fixture",'), "serviceName injected");
  assert(injectedText.includes('tags: ["api", "x402"],'), "tags injected");
  assert(injectedText.includes(".registerExtension(bazaarResourceServerExtension);"), "bazaarResourceServerExtension registered on the server chain");
  assert(injectedText.includes("extensions: declareDiscoveryExtension({"), "Bazaar discovery extension declared on the route config");
  assert(injectedText.includes("app.use(paymentMiddleware(x402Routes, x402Server))"), "app.use(paymentMiddleware(...)) injected");
  assert(injectedText.includes('app.get("/weather"'), "original /weather handler registration is untouched");
  assert(injectedText.includes('res.json({ forecast: "sunny", tempF: 72 });'), "original handler body is untouched");
  assert(injectedText.includes('app.post("/reports"'), "unrelated POST /reports route is untouched");
  assert(injectedText.includes('app.get("/users/:id"'), "unrelated GET /users/:id route is untouched");

  console.log("\n4b. Verifying the post-injection cursor selection...");
  // The extensions-block TODO (inside `input`) is now the active
  // post-injection cursor placement — it replaced the description
  // selection as the auto-selected TODO, per the instruction: the
  // description TODO is still generated, just no longer auto-selected.
  const extSelection = findFirstExtensionsTodoSelection(injectedText);
  assert(Boolean(extSelection), "findFirstExtensionsTodoSelection finds the generated extensions TODO line");
  const injectedLines = injectedText.split(/\r?\n/);
  const extLineText = injectedLines[extSelection.line];
  assert(
    extLineText.includes("// TODO: example values for this endpoint's query/body"),
    "the found line is actually the extensions input TODO placeholder line",
  );
  const extSelectedValue = extLineText.slice(extSelection.startCharacter, extSelection.endCharacter);
  assert(
    extSelectedValue === "example values for this endpoint's query/body",
    `selection covers exactly the TODO's descriptive text, got "${extSelectedValue}"`,
  );

  // The description TODO must still be present in the generated code (it's
  // not removed, just no longer the auto-selected one) — checked as plain
  // text presence, explicitly NOT as the active selection.
  assert(
    injectedText.includes('description: "express-fresh-fixture — /weather ($0.05 USDC)", // TODO: add the actual resource description'),
    "the description TODO still exists in the generated code",
  );
  const descSelection = findDescriptionSelection(injectedText);
  assert(Boolean(descSelection), "findDescriptionSelection can still find the description line (function still works, just unused post-injection)");
  assert(
    descSelection.line !== extSelection.line,
    "the description selection and the active extensions-TODO selection are on different lines — the description is present but NOT the one selected",
  );

  console.log("\n5. Installing fixture dependencies (npm install)...");
  execSync("npm install --no-audit --no-fund", { cwd: fixtureDir, stdio: "inherit" });

  console.log("\n6. Writing injected code and running tsc...");
  fs.writeFileSync(fixtureFile, injectedText, "utf8");
  execSync("npx tsc --noEmit -p .", { cwd: fixtureDir, stdio: "inherit" });
  console.log("  ok: tsc passed with no errors");

  console.log("\n=== ACCEPTANCE TEST PASSED ===");
} finally {
  // Always restore the pristine fixture, pass or fail, so a re-run starts clean
  // and `git status` never shows an injected fixture as a dirty tracked file.
  fs.writeFileSync(fixtureFile, originalText, "utf8");
}
