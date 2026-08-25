import * as fs from "fs";
import * as path from "path";

/**
 * Best-effort service name for RouteConfig.serviceName: walks up from `filePath`
 * looking for the nearest package.json with a "name" field, stopping at
 * `workspaceRoot` (inclusive). Falls back to the open file's basename (without
 * extension) when no package.json is found or it has no usable "name".
 */
export function resolveServiceName(filePath: string, workspaceRoot: string | undefined): string {
  let dir = path.dirname(filePath);
  const stopAt = workspaceRoot ? path.resolve(workspaceRoot) : null;

  // Bound the walk so a file opened outside any workspace can't spin forever.
  for (let i = 0; i < 20; i++) {
    const candidate = path.join(dir, "package.json");
    const name = tryReadPackageName(candidate);
    if (name) return name;

    if (stopAt && path.resolve(dir) === stopAt) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  return path.basename(filePath).replace(/\.(ts|tsx|js|jsx|mjs)$/, "");
}

function tryReadPackageName(packageJsonPath: string): string | null {
  try {
    if (!fs.existsSync(packageJsonPath)) return null;
    const raw = fs.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    if (typeof parsed.name === "string" && parsed.name.trim().length > 0) {
      return parsed.name.trim();
    }
    return null;
  } catch {
    // Unreadable or malformed package.json — fall through to the basename fallback
    // rather than failing the whole command over a best-effort metadata field.
    return null;
  }
}
