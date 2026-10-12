import { describe, expect, it } from 'vitest'

import {
  formatQuantity,
  isLegacyMajorQuantityItem,
  isValidMajorQuantity,
  lineAmountMinorFromMajor,
  lineAmountMinorFromStored,
  QUANTITY_SCALE,
  quantityFromStored,
  quantityToStored,
} from './quantity'

describe('quantity', () => {
  it('exposes a scale of 1000', () => {
    expect(QUANTITY_SCALE).toBe(1000)
  })

  it('accepts whole and fractional major quantities up to 3 decimals', () => {
    expect(isValidMajorQuantity(1)).toBe(true)
    expect(isValidMajorQuantity(2)).toBe(true)
    expect(isValidMajorQuantity(1.5)).toBe(true)
    expect(isValidMajorQuantity(0.5)).toBe(true)
    expect(isValidMajorQuantity(2.375)).toBe(true)
  })

  it('rejects non-positive, non-finite, and over-precise quantities', () => {
    expect(isValidMajorQuantity(0)).toBe(false)
    expect(isValidMajorQuantity(-1.5)).toBe(false)
    expect(isValidMajorQuantity(Number.NaN)).toBe(false)
    expect(isValidMajorQuantity(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isValidMajorQuantity(1.0001)).toBe(false)
    expect(isValidMajorQuantity('1.5')).toBe(false)
    expect(isValidMajorQuantity(null)).toBe(false)
  })

  it('round-trips major and stored quantities', () => {
    expect(quantityToStored(2)).toBe(2000)
    expect(quantityToStored(1.5)).toBe(1500)
    expect(quantityToStored(0.5)).toBe(500)
    expect(quantityFromStored(2000)).toBe(2)
    expect(quantityFromStored(1500)).toBe(1.5)
    expect(quantityFromStored(quantityToStored(2.375))).toBe(2.375)
  })

  it('formats whole quantities without decimals', () => {
    expect(formatQuantity(2)).toBe('2')
    expect(formatQuantity(1.5)).toBe('1.5')
  })

  it('computes identical line amounts from major and stored quantities', () => {
    // 1.5 × $2.50 = $3.75.
    expect(lineAmountMinorFromMajor(250, 1.5)).toBe(375)
    expect(lineAmountMinorFromStored(250, 1500)).toBe(375)
    // Whole quantities match the legacy unitPrice * quantity formula.
    expect(lineAmountMinorFromMajor(1000, 3)).toBe(3000)
    expect(lineAmountMinorFromStored(1000, 3000)).toBe(3000)
  })

  it('rounds fractional line amounts once to minor units', () => {
    // 2.375 × $19.99 = $47.47625 → $47.48.
    expect(lineAmountMinorFromMajor(1999, 2.375)).toBe(4748)
    expect(lineAmountMinorFromStored(1999, 2375)).toBe(4748)
  })

  it('agrees on .5 boundaries via exact integer arithmetic', () => {
    // True value 101.5 → half-up 102. A float multiply (100 * 1.015) sits
    // just below the boundary and would round to 101; both helpers must
    // return the exact 102.
    expect(lineAmountMinorFromMajor(100, 1.015)).toBe(102)
    expect(lineAmountMinorFromStored(100, 1015)).toBe(102)
    expect(lineAmountMinorFromMajor(300, 1.005)).toBe(302)
    expect(lineAmountMinorFromStored(300, 1005)).toBe(302)
  })

  it('rounds negative .5 boundaries away from zero', () => {
    // Mirror of the positive case: true value -101.5 must round to -102,
    // not toward +Inf (-101).
    expect(lineAmountMinorFromStored(-100, 1015)).toBe(-102)
    expect(lineAmountMinorFromStored(100, -1015)).toBe(-102)
    expect(lineAmountMinorFromStored(0, 1015)).toBe(0)
  })

  it('identifies legacy whole-unit payloads without false positives', () => {
    // Old client: 2 whole units with the legacy amount formula.
    expect(
      isLegacyMajorQuantityItem({
        unitPrice: 1000,
        quantity: 2,
        amount: 2000,
      }),
    ).toBe(true)
    // New client: stored milli-units with the scaled amount.
    expect(
      isLegacyMajorQuantityItem({
        unitPrice: 1000,
        quantity: 2000,
        amount: 1000,
      }),
    ).toBe(false)
    // New client fractional: 1500 milli with the rounded amount.
    expect(
      isLegacyMajorQuantityItem({
        unitPrice: 250,
        quantity: 1500,
        amount: 375,
      }),
    ).toBe(false)
    // Garbage amounts are plain amountSum cases, not upgrade signals.
    expect(
      isLegacyMajorQuantityItem({
        unitPrice: 1000,
        quantity: 2000,
        amount: 1234,
      }),
    ).toBe(false)
  })
})
