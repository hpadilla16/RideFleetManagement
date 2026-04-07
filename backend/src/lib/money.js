/**
 * Round a numeric value to 2 decimal places, coercing null/undefined to 0.
 * Single source of truth for monetary rounding across all modules.
 */
export function money(value) {
  return Number(Number(value || 0).toFixed(2));
}
