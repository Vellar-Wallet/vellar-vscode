import * as fs from "fs";
import * as path from "path";

export type PackageManager = "pnpm" | "yarn" | "npm";

const LOCKFILE_BY_MANAGER: Array<{ file: string; manager: PackageManager }> = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "package-lock.json", manager: "npm" },
];

/**
 * Detects the package manager for the project containing `filePath` by walking up
 * from its directory looking for a lockfile, stopping at `workspaceRoot`
 * (inclusive) so a monorepo's root lockfile is found even when the route file
 * lives several packages deep. Defaults to npm when no lockfile is found —
 * npm's `package-lock.json` is also the fallback most projects have even when
 * unspecified, and `npm install` works everywhere `pnpm`/`yarn` would too.
 */
export function detectPackageManager(filePath: string, workspaceRoot: string | undefined): PackageManager {
  let dir = path.dirname(filePath);
  const stopAt = workspaceRoot ? path.resolve(workspaceRoot) : null;

  for (let i = 0; i < 20; i++) {
    for (const { file, manager } of LOCKFILE_BY_MANAGER) {
      if (fs.existsSync(path.join(dir, file))) return manager;
    }
    if (stopAt && path.resolve(dir) === stopAt) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  return "npm";
}

/**
 * The nearest directory containing a package.json at or above `filePath`, stopping
 * at `workspaceRoot` — where the install command should actually run. In a
 * monorepo this is the individual package's directory (e.g. services/policy-service),
 * not the repo root, so the dependency lands in the right package.json.
 */
export function findNearestPackageDir(filePath: string, workspaceRoot: string | undefined): string {
  let dir = path.dirname(filePath);
  const stopAt = workspaceRoot ? path.resolve(workspaceRoot) : null;

  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    if (stopAt && path.resolve(dir) === stopAt) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // No package.json found anywhere above the file — fall back to the file's own
  // directory rather than failing; the install command will surface its own error
  // in the terminal if this guess is wrong.
  return path.dirname(filePath);
}

const INSTALL_COMMAND_PREFIX: Record<PackageManager, string> = {
  pnpm: "pnpm add",
  yarn: "yarn add",
  npm: "npm install",
};

/** Renders the install command for the detected package manager and required packages. */
export function renderInstallCommand(manager: PackageManager, packages: string[]): string {
  return `${INSTALL_COMMAND_PREFIX[manager]} ${packages.join(" ")}`;
}
