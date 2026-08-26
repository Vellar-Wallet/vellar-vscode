import type { Framework } from "./types";

/** npm package names injected code actually imports from, per framework — single
 * source of truth so the install-command button can never drift from what each
 * generator in generators/*.ts really emits. */
const COMMON_PACKAGES = ["@x402/core", "@x402/stellar"];

const FRAMEWORK_PACKAGES: Record<Exclude<Framework, "next-pages-router">, string[]> = {
  express: [...COMMON_PACKAGES, "@x402/express"],
  fastify: [...COMMON_PACKAGES, "@x402/fastify"],
  "next-app-router": [...COMMON_PACKAGES, "@x402/next"],
};

/** Required packages for a framework that actually receives injected code.
 * Pages Router never injects (see generators/nextPagesRouter.ts), so it has no
 * required-packages entry — callers should never reach this for that framework. */
export function requiredPackagesFor(framework: Exclude<Framework, "next-pages-router">): string[] {
  return FRAMEWORK_PACKAGES[framework];
}
