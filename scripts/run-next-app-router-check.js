#!/usr/bin/env node
/**
 * Next.js App Router tsc-check pass — detect, inject, and tsc-check withX402
 * wrapping against a real route.ts fixture.
 *
 * Writes the injected result to the fixture file ONLY for the duration of the tsc
 * check, then restores the pristine content — see run-acceptance-test.js for why.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const fixtureDir = path.join(root, "fixtures", "next-app-router-fresh");
const fixtureFile = path.join(fixtureDir, "app", "api", "weather", "route.ts");

esbuild.buildSync({
  entryPoints: [path.join(root, "src", "testEntry.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: path.join(root, ".test-build", "testEntry.js"),
  external: ["vscode"],
});
const { detectNextAppRouterRoutes, computeEdits, applyEdits } = require(
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

console.log("=== Next.js App Router injection + tsc check ===\n");

const originalText = fs.readFileSync(fixtureFile, "utf8");

try {
  console.log("1. Scanning fixture for routes...");
  const routes = detectNextAppRouterRoutes(originalText, fixtureFile);
  assert(routes.length === 1, `expected 1 route detected, found ${routes.length}`);
  console.log("   detected:", routes.map((r) => `${r.method} ${r.routePath}`).join(", "));

  console.log("\n2. Injecting withX402 wrapping...");
  const picked = routes[0];

  const config = {
    priceUsdc: "0.03",
    payToAddress: "GA123456789EXAMPLESTELLARADDRESSXXXXXXXXXXXXXXXXXXXXXXXXX",
    endpointUrl: "/api/weather",
    serviceName: "next-app-router-fresh-fixture",
  };

  const lines = originalText.split(/\r?\n/);
  const edits = computeEdits(lines, picked, config);
  const injectedText = applyEdits(originalText, edits);

  console.log("\n3. Checking injected code structurally...");
  assert(injectedText.includes('import { withX402, x402ResourceServer } from "@x402/next";'), "@x402/next imports injected");
  assert(injectedText.includes("async function GET_impl(request: NextRequest): Promise<NextResponse> {"), "original GET renamed to GET_impl, signature preserved");
  assert(injectedText.includes("export const GET = withX402(GET_impl, x402RouteConfig, x402Server);"), "export const GET = withX402(...) appended");
  assert(injectedText.includes('return NextResponse.json({ forecast: "sunny", tempF: 72 });'), "original handler body is untouched");
  assert(!injectedText.includes("export async function GET("), "no leftover duplicate export of GET");

  console.log("\n4. Installing fixture dependencies (npm install)...");
  execSync("npm install --no-audit --no-fund", { cwd: fixtureDir, stdio: "inherit" });

  console.log("\n5. Writing injected code and running tsc...");
  fs.writeFileSync(fixtureFile, injectedText, "utf8");
  execSync("npx tsc --noEmit -p .", { cwd: fixtureDir, stdio: "inherit" });
  console.log("  ok: tsc passed with no errors");

  console.log("\n=== NEXT.JS APP ROUTER CHECK PASSED ===");
} finally {
  fs.writeFileSync(fixtureFile, originalText, "utf8");
}
