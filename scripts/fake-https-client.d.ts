export const TEST_ADDRESS: string;
export const TEST_PAYER: string;
export function httpsGetJson<T>(url: string): Promise<T>;
export class HttpStatusError extends Error {
  status: number;
  url: string;
  bodySnippet: string;
}
