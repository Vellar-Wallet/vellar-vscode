/** HTTP method a detected route responds to. Uppercase, matching x402's route-config keys. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Frameworks slice one knows how to detect and inject into. */
export type Framework =
  | "express"
  | "fastify"
  | "next-app-router"
  | "next-pages-router";

/**
 * One HTTP route definition found in the active editor.
 *
 * `insertionLine` and `insertionCharacter` mark where generated code should be
 * inserted: immediately before the handler body starts executing, so the 402
 * challenge/verification runs first without replacing any existing logic.
 */
export interface DetectedRoute {
  framework: Framework;
  method: HttpMethod;
  /** Route path, e.g. "/users/:id". For Next.js this is derived from the file path. */
  routePath: string;
  /** 0-based line where the route/handler declaration starts (for the quick-pick label). */
  declarationLine: number;
  /** 0-based line where injected code should be inserted. */
  insertionLine: number;
  /** 0-based character offset on insertionLine where injected code should be inserted. */
  insertionCharacter: number;
  /** Text shown in the quick-pick, e.g. "GET /users/:id (Express)". */
  label: string;
  /** Detail line shown under the label, e.g. the raw source line. */
  detail: string;
  /** Indentation string (spaces/tabs) to prefix each injected line with, matching surroundings. */
  indent: string;
  /**
   * The app/router/fastify instance variable name at the call site (e.g. "app",
   * "router", "fastify", "server"). Used so Express's `app.use(...)` and Fastify's
   * `paymentMiddleware(instance, ...)` reference the same variable already in scope,
   * rather than assuming a fixed name. Undefined for Next.js routes (no instance).
   */
  appVarName?: string;
}

/** Answers collected from the user before code generation. */
export interface PaymentConfig {
  /** USDC price as a validated decimal string, e.g. "0.05". Never a float — precision matters. */
  priceUsdc: string;
  /** Stellar G-address from vellar-x402.payToAddress. */
  payToAddress: string;
  /** Endpoint URL used as the description default. Best-effort; editable by the developer. */
  endpointUrl: string;
  /**
   * Best-effort service name for RouteConfig.serviceName — the workspace's
   * package.json "name" field, falling back to the open file's basename when no
   * package.json is found or it has no "name" field.
   */
  serviceName: string;
}
