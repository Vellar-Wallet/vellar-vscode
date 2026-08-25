export const DEFAULT_PRICE_USDC = "0.01";

/**
 * A bare decimal number: optional leading digits, optional `.` + up to 7 fractional
 * digits (USDC's on-chain precision), no sign, no exponent, no thousands separators,
 * no currency symbol — validation happens on the raw input, formatting (`$` prefix)
 * happens later at generation time.
 */
const PRICE_PATTERN = /^\d+(\.\d{1,7})?$/;

/**
 * Validates a price string for the "price in USDC" input box.
 *
 * @returns `null` when valid, or a user-facing error message VS Code's input box
 * will show inline when non-null.
 */
export function validatePriceInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "Enter a price in USDC (e.g. 0.01).";
  }
  if (!PRICE_PATTERN.test(trimmed)) {
    return "Price must be a positive number with at most 7 decimal places (e.g. 0.01, 1.5, 0.0000001).";
  }
  if (Number(trimmed) <= 0) {
    return "Price must be greater than 0.";
  }
  return null;
}
