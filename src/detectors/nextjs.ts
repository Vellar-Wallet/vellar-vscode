import * as path from "path";
import type { DetectedRoute, HttpMethod } from "../types";

const APP_ROUTER_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/**
 * Matches `export async function GET(...)`, `export function POST(...)`, and the
 * `export const GET = async (...) => {` handler-as-const form used by the App Router.
 */
const APP_ROUTER_FN_PATTERN =
  /^(?<indent>[ \t]*)export\s+(?:async\s+)?function\s+(?<method>GET|POST|PUT|PATCH|DELETE)\s*\(/;
const APP_ROUTER_CONST_PATTERN =
  /^(?<indent>[ \t]*)export\s+const\s+(?<method>GET|POST|PUT|PATCH|DELETE)\s*[:=]/;

/** Pages Router: `export default function handler(req, res) { ... }` or the arrow-fn form. */
const PAGES_ROUTER_DEFAULT_FN =
  /^(?<indent>[ \t]*)export\s+default\s+(?:async\s+)?function\s*\w*\s*\((?<params>[^)]*)\)/;
const PAGES_ROUTER_DEFAULT_ARROW =
  /^(?<indent>[ \t]*)export\s+default\s+(?:async\s*)?\((?<params>[^)]*)\)\s*(?::\s*[^=]+)?=>/;

/** True when the parameter list looks like `(req, res)` — the Pages Router API-handler shape. */
function looksLikeReqRes(params: string): boolean {
  const names = params
    .split(",")
    .map((p) => p.trim().split(":")[0].trim())
    .filter(Boolean);
  return names.length >= 2 && /^req/i.test(names[0]) && /^res/i.test(names[1]);
}

function findBraceInsertion(
  lines: string[],
  startLine: number,
): { line: number; character: number } {
  for (let i = startLine; i < Math.min(lines.length, startLine + 10); i++) {
    const braceIdx = lines[i].indexOf("{");
    if (braceIdx !== -1) {
      return { line: i, character: braceIdx + 1 };
    }
  }
  return { line: startLine, character: lines[startLine].length };
}

/**
 * Derives the route path App/Pages Router would serve this file under, from its
 * file path relative to the nearest `app/` or `pages/` directory. Best-effort —
 * used only for the quick-pick label and the Bazaar `endpointUrl` default, both
 * of which the developer can see and edit before anything is injected.
 */
function deriveRoutePath(filePath: string): string {
  const normalized = filePath.split(path.sep).join("/");
  const appMatch = normalized.match(/\/app\/(.*)\/route\.(ts|tsx|js|jsx|mjs)$/);
  if (appMatch) {
    return "/" + appMatch[1].replace(/\/\(.*?\)/g, ""); // strip route groups like (marketing)
  }
  const pagesApiMatch = normalized.match(/\/pages\/api\/(.*)\.(ts|tsx|js|jsx|mjs)$/);
  if (pagesApiMatch) {
    return "/api/" + pagesApiMatch[1].replace(/\/index$/, "");
  }
  return "/" + path.basename(filePath).replace(/\.(ts|tsx|js|jsx|mjs)$/, "");
}

export function detectNextAppRouterRoutes(text: string, filePath: string): DetectedRoute[] {
  const lines = text.split(/\r?\n/);
  const routes: DetectedRoute[] = [];
  const routePath = deriveRoutePath(filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fnMatch = APP_ROUTER_FN_PATTERN.exec(line);
    const constMatch = APP_ROUTER_CONST_PATTERN.exec(line);
    const match = fnMatch ?? constMatch;
    if (!match?.groups) continue;

    const method = match.groups.method as HttpMethod;
    if (!APP_ROUTER_METHODS.includes(method)) continue;

    const insertion = findBraceInsertion(lines, i);
    routes.push({
      framework: "next-app-router",
      method,
      routePath,
      declarationLine: i,
      insertionLine: insertion.line,
      insertionCharacter: insertion.character,
      label: `${method} ${routePath}  (Next.js App Router)`,
      detail: line.trim(),
      indent: match.groups.indent + "  ",
    });
  }

  return routes;
}

export function detectNextPagesRouterRoutes(text: string, filePath: string): DetectedRoute[] {
  if (!/\/pages\//.test(filePath.split(path.sep).join("/"))) return [];

  const lines = text.split(/\r?\n/);
  const routePath = deriveRoutePath(filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fnMatch = PAGES_ROUTER_DEFAULT_FN.exec(line);
    const arrowMatch = PAGES_ROUTER_DEFAULT_ARROW.exec(line);
    const match = fnMatch ?? arrowMatch;
    if (!match?.groups) continue;
    if (!looksLikeReqRes(match.groups.params)) continue;

    const insertion = findBraceInsertion(lines, i);
    return [
      {
        framework: "next-pages-router",
        method: "GET", // Pages API handlers dispatch on req.method internally; not method-specific.
        routePath,
        declarationLine: i,
        insertionLine: insertion.line,
        insertionCharacter: insertion.character,
        label: `ALL ${routePath}  (Next.js Pages Router)`,
        detail: line.trim(),
        indent: match.groups.indent + "  ",
      },
    ];
  }

  return [];
}
