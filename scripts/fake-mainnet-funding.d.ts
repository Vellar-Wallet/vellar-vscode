export function fundThrowawayFromMainnetWallet(
  secret: string,
  publicKey: string,
  network: string,
): Promise<{ ok: true } | { ok: false; reason: string }>;
export const _test: {
  readonly calls: { secret: string; publicKey: string; network: string }[];
  readonly callCount: number;
  reset(): void;
};
