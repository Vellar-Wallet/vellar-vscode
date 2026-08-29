#!/usr/bin/env node
/**
 * Fastify tsc-check pass — not the spec's acceptance test (that's Express-only,
 * see run-acceptance-test.js), but verification requested before calling slice one
 * done: detect, inject, and tsc-check the Fastify code path too.
 *
 * Writes the injected result to the fixture file ONLY for the duration of the tsc
 * check, then restores the pristine content — see run-acceptance-test.js for why.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const fixtureDir = path.join(root, "fixtures", "fastify-fresh");
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
  findDescriptionSelection,
  findFirstExtensionsTodoSelection,
  hasExistingGate,
} = require(path.join(root, ".test-build", "testEntry.js"));

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`  ok: ${message}`);
}

console.log("=== Fastify injection + tsc check ===\n");

const originalText = fs.readFileSync(fixtureFile, "utf8");

try {
  console.log("1. Scanning fixture for routes...");
  const routes = detectExpressFastifyRoutes(originalText);
  assert(routes.length === 2, `expected 2 routes detected, found ${routes.length}`);
  console.log("   detected:", routes.map((r) => `${r.method} ${r.routePath} (${r.framework})`).join(", "));

  console.log("\n2. Picking GET /weather (the .route({...}) config form), injecting...");
  const picked = routes.find((r) => r.routePath === "/weather");
  assert(Boolean(picked), "found the GET /weather route");
  assert(picked.framework === "fastify", "classified as fastify");

  const config = {
    priceUsdc: "0.02",
    payToAddress: "GA123456789EXAMPLESTELLARADDRESSXXXXXXXXXXXXXXXXXXXXXXXXX",
    endpointUrl: "/weather",
    serviceName: "fastify-fresh-fixture",
  };

  const lines = originalText.split(/\r?\n/);
  const edits = computeEdits(lines, picked, config);
  const injectedText = applyEdits(originalText, edits);

  console.log("\n3. Checking injected code structurally...");
  assert(injectedText.includes('import { paymentMiddleware, x402ResourceServer } from "@x402/fastify";'), "Fastify imports injected");
  assert(injectedText.includes("paymentMiddleware(fastify, x402Routes, x402Server)"), "paymentMiddleware(fastify, ...) call uses the detected instance name");
  assert(injectedText.includes('fastify.route({'), "original fastify.route({...}) registration is untouched");
  assert(injectedText.includes('return { forecast: "sunny", tempF: 72 };'), "original handler body is untouched");
  assert(injectedText.includes('fastify.get("/status"'), "unrelated GET /status route is untouched");

  console.log("\n3b. Verifying the double-injection guard...");
  assert(!hasExistingGate(originalText, picked), "pristine file has no existing gate for GET /weather");
  assert(hasExistingGate(injectedText, picked), "injected file is now detected as already-gated for GET /weather");
  const otherRoute = routes.find((r) => r.routePath !== "/weather");
  assert(Boolean(otherRoute), "found an unrelated route to check the guard against");
  assert(!hasExistingGate(injectedText, otherRoute), "an unrelated route is not falsely detected as gated");

  console.log("\n3c. Verifying the Bazaar discovery extension is generated...");
  assert(
    injectedText.includes('import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";'),
    "Bazaar extension imports injected",
  );
  assert(injectedText.includes(".registerExtension(bazaarResourceServerExtension);"), "bazaarResourceServerExtension registered on the server chain");
  assert(injectedText.includes("extensions: declareDiscoveryExtension({"), "Bazaar discovery extension declared on the route config");

  console.log("\n3d. Verifying the post-injection cursor selection...");
  // Same corrected pattern as run-acceptance-test.js: the extensions-block
  // TODO (inside `input`) is the active post-injection cursor placement,
  // not the description field — see EXTENSIONS_TODO_MARKER's own comment
  // in generators/shared.ts for why.
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

  // The description TODO must still be present (not removed, just no longer
  // the auto-selected one) — checked as plain text presence, explicitly NOT
  // as the active selection.
  assert(
    injectedText.includes('description: "fastify-fresh-fixture — /weather ($0.02 USDC)", // TODO: add the actual resource description'),
    "the description TODO still exists in the generated code",
  );
  const descSelection = findDescriptionSelection(injectedText);
  assert(Boolean(descSelection), "findDescriptionSelection can still find the description line (function still works, just unused post-injection)");
  assert(
    descSelection.line !== extSelection.line,
    "the description selection and the active extensions-TODO selection are on different lines — the description is present but NOT the one selected",
  );

  console.log("\n4. Installing fixture dependencies (npm install)...");
  execSync("npm install --no-audit --no-fund", { cwd: fixtureDir, stdio: "inherit" });

  console.log("\n5. Writing injected code and running tsc...");
  fs.writeFileSync(fixtureFile, injectedText, "utf8");
  execSync("npx tsc --noEmit -p .", { cwd: fixtureDir, stdio: "inherit" });
  console.log("  ok: tsc passed with no errors");

  console.log("\n=== FASTIFY CHECK PASSED ===");
} finally {
  fs.writeFileSync(fixtureFile, originalText, "utf8");
}
