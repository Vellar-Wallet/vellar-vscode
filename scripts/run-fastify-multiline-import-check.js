#!/usr/bin/env node
/**
 * Regression check for two real bugs found via manual testing against a real
 * project (services/policy-service/src/server.ts in the vela-wallet repo):
 *
 * 1. Framework misclassification: a Fastify instance named `app` (this codebase's
 *    own convention) was classified as Express, because the old detector guessed
 *    framework from the variable name instead of how it was constructed.
 * 2. Import-block corruption: a multi-line `import { a, b } from "x"` block was
 *    split apart because the old insertion-point scanner didn't track brace depth
 *    across lines, and inserted generated imports into the middle of it.
 *
 * This fixture reproduces both conditions at once — a Fastify instance named
 * `app`, with a multi-line named-import block above the route registrations.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const fixtureDir = path.join(root, "fixtures", "fastify-multiline-import");
const fixtureFile = path.join(fixtureDir, "src", "server.ts");

esbuild.buildSync({
  entryPoints: [path.join(root, "src", "testEntry.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: path.join(root, ".test-build", "testEntry.js"),
  external: ["vscode"],
});
const { detectExpressFastifyRoutes, computeEdits, applyEdits } = require(
  path.join(root, ".test-build", "testEntry.js"),
);

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`  ok: ${message}`);
}

console.log("=== Regression: Fastify named 'app' + multi-line import block ===\n");

const originalText = fs.readFileSync(fixtureFile, "utf8");

try {
  console.log("1. Scanning fixture for routes...");
  const routes = detectExpressFastifyRoutes(originalText);
  assert(routes.length === 2, `expected 2 routes detected in server.ts (registerHealth/registerMetrics live in a different file), found ${routes.length}`);

  const generate = routes.find((r) => r.routePath === "/policies/generate");
  assert(Boolean(generate), "found POST /policies/generate");
  assert(generate.framework === "fastify", `classified as fastify (Bug 1 regression check) — got "${generate.framework}"`);

  console.log("\n2. Injecting a payment gate on POST /policies/generate...");
  const config = {
    priceUsdc: "1",
    payToAddress: "GA123456789EXAMPLESTELLARADDRESSXXXXXXXXXXXXXXXXXXXXXXXXX",
    endpointUrl: "/policies/generate",
    serviceName: "@vellar/policy-service",
  };

  const lines = originalText.split(/\r?\n/);
  const edits = computeEdits(lines, generate, config);
  const injectedText = applyEdits(originalText, edits);

  console.log("\n3. Checking the multi-line import block survived intact (Bug 2 regression check)...");
  assert(
    injectedText.includes('import {\n  registerHealth,\n  registerMetrics,\n  type SpendBudget,\n} from "./service-kit";'),
    "the original multi-line import block is intact, not split apart",
  );
  assert(injectedText.includes('import { paymentMiddleware, x402ResourceServer } from "@x402/fastify";'), "Fastify imports injected (not Express)");
  assert(!injectedText.includes("@x402/express"), "no Express import leaked in (Bug 1 regression check)");
  assert(injectedText.includes("paymentMiddleware(app, x402Routes, x402Server)"), "paymentMiddleware(app, ...) call uses the detected instance name");

  console.log("\n4. Installing fixture dependencies (npm install)...");
  execSync("npm install --no-audit --no-fund", { cwd: fixtureDir, stdio: "inherit" });

  console.log("\n5. Writing injected code and running tsc...");
  fs.writeFileSync(fixtureFile, injectedText, "utf8");
  execSync("npx tsc --noEmit -p .", { cwd: fixtureDir, stdio: "inherit" });
  console.log("  ok: tsc passed with no errors");

  console.log("\n=== REGRESSION CHECK PASSED ===");
} finally {
  fs.writeFileSync(fixtureFile, originalText, "utf8");
}
