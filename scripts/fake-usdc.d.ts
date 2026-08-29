export function openUsdcTrustline(keypair: unknown): Promise<{ ok: boolean; reason?: string }>;
export function buyUsdc(keypair: unknown, targetAmountAtomic: string): Promise<{ ok: boolean; reason?: string }>;
