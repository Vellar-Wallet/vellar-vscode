#!/usr/bin/env node
/**
 * Unit-style checks for detectPackageManager / findNearestPackageDir /
 * renderInstallCommand / requiredPackagesFor — the "Install dependencies" button
 * added after manual testing surfaced that a static "npm install" suggestion is
 * wrong for a pnpm monorepo (this repo's own layout: root pnpm-lock.yaml, the
 * route file several directories deep inside services/policy-service).
 *
 * Builds a throwaway directory tree under the OS temp dir to exercise the real
 * filesystem-walking logic, rather than mocking fs.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");

esbuild.buildSync({
  entryPoints: [path.join(root, "src", "testEntry.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: path.join(root, ".test-build", "testEntry.js"),
  external: ["vscode"],
});
const { detectPackageManager, findNearestPackageDir, renderInstallCommand, requiredPackagesFor } = require(
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

console.log("=== Package manager detection checks ===\n");

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vellar-x402-pm-test-"));

try {
  // Scenario 1: pnpm monorepo — lockfile at the workspace root, route file deep
  // inside a sub-package that has its OWN package.json but no lockfile of its own.
  // Mirrors services/policy-service/src/server.ts in the real vela-wallet repo.
  const monorepoRoot = path.join(workDir, "monorepo");
  const pkgDir = path.join(monorepoRoot, "services", "policy-service");
  const srcDir = path.join(pkgDir, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(monorepoRoot, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@vellar/policy-service" }));
  const routeFile = path.join(srcDir, "server.ts");
  fs.writeFileSync(routeFile, "// route file\n");

  console.log("1. pnpm monorepo — lockfile at root, package.json several levels down...");
  assert(
    detectPackageManager(routeFile, monorepoRoot) === "pnpm",
    "detects pnpm from the root pnpm-lock.yaml even though the route file is several directories deep",
  );
  assert(
    findNearestPackageDir(routeFile, monorepoRoot) === pkgDir,
    "finds the SUB-PACKAGE's directory (services/policy-service), not the monorepo root — so `pnpm add` lands in the right package.json",
  );
  assert(
    renderInstallCommand("pnpm", requiredPackagesFor("fastify")) === "pnpm add @x402/core @x402/stellar @x402/fastify",
    "renders the correct pnpm add command with fastify's required packages",
  );

  // Scenario 2: plain npm project, single package.json at the root, file directly inside.
  const npmRoot = path.join(workDir, "npm-project");
  const npmSrcDir = path.join(npmRoot, "src");
  fs.mkdirSync(npmSrcDir, { recursive: true });
  fs.writeFileSync(path.join(npmRoot, "package-lock.json"), "{}");
  fs.writeFileSync(path.join(npmRoot, "package.json"), JSON.stringify({ name: "my-app" }));
  const npmRouteFile = path.join(npmSrcDir, "index.ts");
  fs.writeFileSync(npmRouteFile, "// route file\n");

  console.log("\n2. Plain npm project...");
  assert(detectPackageManager(npmRouteFile, npmRoot) === "npm", "detects npm from package-lock.json");
  assert(findNearestPackageDir(npmRouteFile, npmRoot) === npmRoot, "finds the root package.json directory");
  assert(
    renderInstallCommand("npm", requiredPackagesFor("express")) === "npm install @x402/core @x402/stellar @x402/express",
    "renders the correct npm install command with express's required packages",
  );

  // Scenario 3: yarn project.
  const yarnRoot = path.join(workDir, "yarn-project");
  fs.mkdirSync(yarnRoot, { recursive: true });
  fs.writeFileSync(path.join(yarnRoot, "yarn.lock"), "");
  fs.writeFileSync(path.join(yarnRoot, "package.json"), JSON.stringify({ name: "my-app" }));
  const yarnRouteFile = path.join(yarnRoot, "route.ts");
  fs.writeFileSync(yarnRouteFile, "// route file\n");

  console.log("\n3. Yarn project...");
  assert(detectPackageManager(yarnRouteFile, yarnRoot) === "yarn", "detects yarn from yarn.lock");
  assert(
    renderInstallCommand("yarn", requiredPackagesFor("next-app-router")) === "yarn add @x402/core @x402/stellar @x402/next",
    "renders the correct yarn add command with next-app-router's required packages",
  );

  // Scenario 4: no lockfile anywhere findable — falls back to npm rather than throwing.
  const bareRoot = path.join(workDir, "bare-project");
  fs.mkdirSync(bareRoot, { recursive: true });
  const bareRouteFile = path.join(bareRoot, "route.ts");
  fs.writeFileSync(bareRouteFile, "// route file\n");

  console.log("\n4. No lockfile found anywhere...");
  assert(detectPackageManager(bareRouteFile, bareRoot) === "npm", "falls back to npm rather than throwing or returning undefined");

  console.log("\n=== PACKAGE MANAGER CHECKS PASSED ===");
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}
