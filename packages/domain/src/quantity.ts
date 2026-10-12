/**
 * Fractional item quantities, stored as scaled integers.
 *
 * Money stays integer minor units; quantities follow the same philosophy: the
 * database and API carry milli-units (`Int`, `1500` = 1.5 items) while human
 * entry (form inputs, assistant calls, CSV imports) speaks major decimal units
 * with at most {@link QUANTITY_MAX_DECIMALS} decimals. Conversion happens
 * exactly once per boundary through the helpers below — never inline `* 1000` /
 * `/ 1000` at call sites.
 */

/** Stored units per whole item. `1500` stored = `1.5` items. */
export const QUANTITY_SCALE = 1000

/** Maximum accepted decimals of a major-unit quantity (weights, volumes). */
export const QUANTITY_MAX_DECIMALS = 3

const SCALE_EPSILON = 1e-6

/**
 * True for a valid major-unit quantity: finite, greater than zero, and at most
 * {@link QUANTITY_MAX_DECIMALS} decimals. Whole numbers always pass, so
 * existing integer quantities are unaffected.
 */
export function isValidMajorQuantity(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return false
  }
  const scaled = value * QUANTITY_SCALE
  return Math.abs(scaled - Math.round(scaled)) < SCALE_EPSILON
}

/** Major units (1.5) → stored milli-units (1500). */
export function quantityToStored(quantityMajor: number): number {
  return Math.round(quantityMajor * QUANTITY_SCALE)
}

/** Stored milli-units (1500) → major units (1.5). */
export function quantityFromStored(quantityStored: number): number {
  return quantityStored / QUANTITY_SCALE
}

/** Display form of a major-unit quantity: whole by default (`2`, not `2`). */
export function formatQuantity(quantityMajor: number): string {
  return String(quantityMajor)
}

/**
 * Line amount in minor units from a minor-unit price and a major-unit quantity.
 * Routes through the stored path so the multiply stays in exact integer
 * arithmetic: a float `unitPriceMinor * quantityMajor` can sit just below a
 * `.5` boundary (e.g. `100 * 1.015`) and round the wrong way, while the integer
 * path rounds the true value. Single rounding point for the form/save path.
 */
export function lineAmountMinorFromMajor(
  unitPriceMinor: number,
  quantityMajor: number,
): number {
  return lineAmountMinorFromStored(
    unitPriceMinor,
    quantityToStored(quantityMajor),
  )
}

/**
 * Line amount in minor units from a minor-unit price and a stored milli-unit
 * quantity. The multiply-then-divide order keeps integer arithmetic exact
 * before the single rounding.
 */
export function lineAmountMinorFromStored(
  unitPriceMinor: number,
  quantityStored: number,
): number {
  const value = (unitPriceMinor * quantityStored) / QUANTITY_SCALE
  // Round half away from zero so negative .5 boundaries mirror positive
  // ones (Math.round ties toward +Inf: -101.5 -> -101, +101.5 -> 102).
  // Math.sign(0) is 0, so zero stays zero.
  return Math.sign(value) * Math.round(Math.abs(value))
}

/**
 * Machine signal (never displayed; the client maps it to a refresh prompt) for
 * payloads written by a pre-milli-unit client: the amount matches the legacy
 * whole-unit formula exactly while the stored formula disagrees. The two
 * formulas can never coincide for valid nonzero inputs, so a match
 * deterministically identifies an outdated sender — never a guess.
 */
export const CLIENT_UPGRADE_REQUIRED_ISSUE = 'clientUpgradeRequired'

export function isLegacyMajorQuantityItem(item: {
  unitPrice: number
  quantity: number
  amount: number
}): boolean {
  const { unitPrice, quantity, amount } = item
  if (
    !Number.isSafeInteger(unitPrice) ||
    !Number.isSafeInteger(quantity) ||
    !Number.isSafeInteger(amount)
  ) {
    return false
  }
  if (quantity <= 0 || unitPrice === 0) return false
  const majorAmount = unitPrice * quantity
  if (!Number.isSafeInteger(majorAmount)) return false
  return (
    amount === majorAmount &&
    amount !== lineAmountMinorFromStored(unitPrice, quantity)
  )
}
