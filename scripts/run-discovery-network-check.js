#!/usr/bin/env node
/**
 * Committed, CI-run acceptance check for the discovery network-matching fix:
 * fetchEndpoints() now (1) sends ?network= to the facilitator's
 * /discovery/resources, and (2) selects the accepts[] ENTRY whose own
 * `network` field matches the configured network, rather than always
 * reading accepts[0] — see dataProvider.ts's own "REAL BUG, FOUND AND
 * FIXED" comment on fetchEndpoints for why accepts[0] alone was wrong for a
 * genuinely dual-network resource.
 *
 * Uses fake-https-client-dual-network.js (a purpose-built fixture, kept
 * separate from fake-https-client.js so this doesn't perturb any of that
 * fixture's own existing consumers — see its own header comment), so this
 * exercises the real DataProvider/fetchEndpoints logic against a resource
 * whose accepts[] carries two genuinely different network entries, proving
 * the selection follows the network setting rather than a fixed index.
 *
 * No live network call anywhere in this script.
 */
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const outFile = path.join(root, ".test-build", "discovery-network-entry.js");

async function main() {
  console.log("=== discovery network-matching check (committed) ===\n");

  await esbuild.build({
    entryPoints: [path.join(__dirname, "discovery-network-entry.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: outFile,
    alias: { vscode: path.join(__dirname, "vscode-test-stub.js") },
    plugins: [
      {
        name: "fake-https-client-dual-network",
        setup(build) {
          build.onResolve({ filter: /^\.\/httpsClient$/ }, (args) => {
            if (args.importer.endsWith(path.join("sidebar", "dataProvider.ts"))) {
              return { path: path.join(__dirname, "fake-https-client-dual-network.js") };
            }
            return undefined;
          });
        },
      },
    ],
  });

  const { runDiscoveryNetworkChecks } = require(outFile);
  await runDiscoveryNetworkChecks();

  console.log("\n=== DISCOVERY NETWORK-MATCHING CHECK PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
