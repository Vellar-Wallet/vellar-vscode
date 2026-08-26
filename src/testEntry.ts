/**
 * Test-only entry point bundling the framework-agnostic modules (no `vscode` import
 * anywhere in their dependency chain) so they can be exercised from a plain Node
 * script — see scripts/run-acceptance-test.js. Not part of the shipped extension
 * bundle (esbuild's entry point for that is src/extension.ts).
 */
export { detectExpressFastifyRoutes } from "./detectors/expressFastify";
export { detectNextAppRouterRoutes, detectNextPagesRouterRoutes } from "./detectors/nextjs";
export { computeEdits, applyEdits, findDescriptionSelection } from "./injector";
export { validatePriceInput, DEFAULT_PRICE_USDC } from "./priceValidation";
export { resolveServiceName } from "./serviceName";
export { hasExistingGate, gateMarkerComment } from "./gateMarker";
export { detectPackageManager, findNearestPackageDir, renderInstallCommand } from "./packageManager";
export { requiredPackagesFor } from "./requiredPackages";
