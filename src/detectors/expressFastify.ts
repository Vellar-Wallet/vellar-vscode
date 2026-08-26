import type { DetectedRoute, Framework, HttpMethod } from "../types";

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/**
 * Matches `app.get(...)`, `router.post(...)`, `fastify.put(...)`, `server.patch(...)`, etc.
 * Captures the receiver (app/router/fastify/server/anything), the method, and the route
 * path string (single- or double-quoted, or backtick-delimited with no interpolation).
 *
 * Deliberately excludes `.route(...)` — Fastify's config-object form — which is handled
 * separately since its method/path live inside an object literal, not as call args.
 */
const CALL_PATTERN =
  /^(?<indent>[ \t]*)(?:export\s+)?(?:const\s+\w+\s*=\s*)?(?<receiver>\w+)\.(?<method>get|post|put|patch|delete)\s*\(\s*(?<quote>['"`])(?<path>[^'"`]*)\k<quote>/i;

/** Matches Fastify's `fastify.route({ method: "GET", url: "/x", ... })` config form. */
const ROUTE_OBJECT_START = /^(?<indent>[ \t]*)(?<receiver>\w+)\.route\s*\(\s*\{/;
const ROUTE_OBJECT_METHOD = /\bmethod\s*:\s*(['"`])(?<method>[A-Za-z]+)\1/;
const ROUTE_OBJECT_URL = /\b(?:url|path)\s*:\s*(['"`])(?<path>[^'"`]*)\1/;

/**
 * Framework identity is decided by how each variable was actually constructed, not
 * by its name — `app`, `server`, and `router` are all common names for BOTH an
 * Express app and a Fastify instance (this codebase's own services name their
 * Fastify instance `app`), so guessing from the name alone misclassifies real code.
 *
 * `const app = Fastify(...)` / `const app = fastify(...)` -> fastify
 * `const app = express()` -> express
 * `const router = express.Router()` -> express
 * `const router = Router()` (destructured/imported directly) -> express
 */
const FASTIFY_CONSTRUCTOR =
  /^[ \t]*(?:export\s+)?const\s+(?<name>\w+)\s*=\s*(?:new\s+)?[Ff]astify\s*\(/;
const EXPRESS_APP_CONSTRUCTOR = /^[ \t]*(?:export\s+)?const\s+(?<name>\w+)\s*=\s*express\s*\(\s*\)/;
const EXPRESS_ROUTER_CONSTRUCTOR =
  /^[ \t]*(?:export\s+)?const\s+(?<name>\w+)\s*=\s*(?:express\.)?Router\s*\(/;

/** Which package(s) this file imports `Fastify`/`express` from — the fallback signal
 * when a call-site receiver's constructor can't be traced (e.g. it's a function
 * parameter, not a local `const`). */
function detectFileLevelFramework(lines: string[]): Framework | null {
  const hasFastifyImport = lines.some((l) => /from\s+["']fastify["']/.test(l));
  const hasExpressImport = lines.some((l) => /from\s+["']express["']/.test(l));
  if (hasFastifyImport && !hasExpressImport) return "fastify";
  if (hasExpressImport && !hasFastifyImport) return "express";
  return null; // both, or neither — ambiguous, caller must fall back further
}

/** Maps each variable name in this file to the framework it was actually constructed as. */
function buildVariableFrameworkMap(lines: string[]): Map<string, Framework> {
  const map = new Map<string, Framework>();
  for (const line of lines) {
    const fastifyMatch = FASTIFY_CONSTRUCTOR.exec(line);
    if (fastifyMatch?.groups) map.set(fastifyMatch.groups.name, "fastify");

    const expressAppMatch = EXPRESS_APP_CONSTRUCTOR.exec(line);
    if (expressAppMatch?.groups) map.set(expressAppMatch.groups.name, "express");

    const routerMatch = EXPRESS_ROUTER_CONSTRUCTOR.exec(line);
    if (routerMatch?.groups) map.set(routerMatch.groups.name, "express");
  }
  return map;
}

/**
 * Finds the character offset where the handler body begins so injected code lands
 * immediately after the opening brace/arrow of the LAST argument (the handler),
 * not the route path. Falls back to end-of-line when no opening brace is found
 * on the declaration line (multi-line handler signatures fall back to inserting
 * right after the declaration line, which is still correct and non-destructive).
 */
function findHandlerBodyInsertion(
  lines: string[],
  declarationLineIdx: number,
): { line: number; character: number } {
  // Scan forward from the declaration line for the first `{` that opens a function
  // body (heuristic: first `{` after the last `=>` or `function` keyword on the
  // line, or simply the first unmatched `{` within a few lines).
  for (let i = declarationLineIdx; i < Math.min(lines.length, declarationLineIdx + 10); i++) {
    const line = lines[i];
    const braceIdx = line.indexOf("{");
    if (braceIdx !== -1) {
      return { line: i, character: braceIdx + 1 };
    }
  }
  // No brace found nearby (unusual) — insert right after the declaration line.
  return { line: declarationLineIdx, character: lines[declarationLineIdx].length };
}

export function detectExpressFastifyRoutes(text: string): DetectedRoute[] {
  const lines = text.split(/\r?\n/);
  const routes: DetectedRoute[] = [];

  const variableFrameworks = buildVariableFrameworkMap(lines);
  const fileLevelFramework = detectFileLevelFramework(lines);

  // Resolve a receiver name to a framework: trust its own constructor if we traced
  // one, otherwise fall back to the file's single unambiguous import, otherwise
  // give up on this call site entirely rather than guess from the name.
  function resolveFramework(receiver: string): Framework | null {
    return variableFrameworks.get(receiver) ?? fileLevelFramework;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const callMatch = CALL_PATTERN.exec(line);
    if (callMatch?.groups) {
      const { indent, receiver, method, path } = callMatch.groups;
      const framework = resolveFramework(receiver);
      if (framework) {
        const insertion = findHandlerBodyInsertion(lines, i);
        routes.push({
          framework,
          method: method.toUpperCase() as HttpMethod,
          routePath: path,
          declarationLine: i,
          insertionLine: insertion.line,
          insertionCharacter: insertion.character,
          label: `${method.toUpperCase()} ${path}  (${framework === "fastify" ? "Fastify" : "Express"})`,
          detail: line.trim(),
          indent: indent + "  ",
          appVarName: receiver,
        });
      }
      continue;
    }

    const routeObjMatch = ROUTE_OBJECT_START.exec(line);
    if (routeObjMatch?.groups) {
      // `.route({...})` config form is Fastify-only — no Express equivalent exists,
      // so no framework ambiguity here regardless of the receiver's traced origin.
      // Scan the next few lines for method/url within the object literal.
      const windowEnd = Math.min(lines.length, i + 15);
      let method: string | undefined;
      let path: string | undefined;
      let objEndLine = i;
      for (let j = i; j < windowEnd; j++) {
        const methodMatch = ROUTE_OBJECT_METHOD.exec(lines[j]);
        if (methodMatch?.groups) method = methodMatch.groups.method.toUpperCase();
        const urlMatch = ROUTE_OBJECT_URL.exec(lines[j]);
        if (urlMatch?.groups) path = urlMatch.groups.path;
        if (method && path) {
          objEndLine = j;
          break;
        }
      }
      if (method && path && HTTP_METHODS.includes(method as HttpMethod)) {
        // Handler is the `handler: async (...) => { ... }` property; find its brace
        // starting the search from where method/path were found.
        const insertion = findHandlerBodyInsertion(lines, objEndLine);
        routes.push({
          framework: "fastify",
          method: method as HttpMethod,
          routePath: path,
          declarationLine: i,
          insertionLine: insertion.line,
          insertionCharacter: insertion.character,
          label: `${method} ${path}  (Fastify)`,
          detail: line.trim(),
          indent: routeObjMatch.groups.indent + "  ",
          appVarName: routeObjMatch.groups.receiver,
        });
      }
    }
  }

  return routes;
}
