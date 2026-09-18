export const TEST_ADDRESS_TESTNET_PAYTO: string;
export const TEST_ADDRESS_PUBNET_PAYTO: string;
export function httpsGetJson<T>(url: string): Promise<T>;
export class HttpStatusError extends Error {
  status: number;
  url: string;
  bodySnippet: string;
}
