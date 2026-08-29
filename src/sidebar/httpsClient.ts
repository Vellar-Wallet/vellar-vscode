import * as https from "node:https";

/**
 * The ONLY way this extension makes an outbound request. Deliberately imports
 * node:https, never node:http — there is no fallback path to accidentally reach for,
 * the module that would let you make a plaintext request is never imported anywhere
 * in this codebase. Also refuses at the call site if a URL is ever passed that
 * doesn't start with "https:", so a bug that builds the wrong string fails loudly
 * instead of silently degrading to something insecure.
 *
 * No caching here — every call is a real network request. Caching (of results, never
 * of the address that produces the request) is the DataProvider's job, one layer up.
 */
export function httpsGetJson<T>(url: string, timeoutMs = 10_000): Promise<T> {
  if (!url.startsWith("https://")) {
    return Promise.reject(new Error(`Refusing a non-HTTPS URL: ${url}`));
  }

  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { accept: "application/json" }, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new HttpStatusError(status, url, body.slice(0, 500)));
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch (err) {
            reject(new Error(`Non-JSON response from ${url}: ${(err as Error).message}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Request to ${url} timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
  });
}

/** Carries the real status/body for the output channel, kept separate from the
 *  generic user-facing message assembled in outputChannel.ts. */
export class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly bodySnippet: string,
  ) {
    super(`HTTP ${status} from ${url}`);
    this.name = "HttpStatusError";
  }
}
