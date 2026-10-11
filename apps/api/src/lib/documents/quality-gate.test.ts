import { describe, expect, it } from 'vitest'

import { isUsableReceiptText } from './quality-gate'

const GOOD_RECEIPT = `
Corner Market
123 Main St, Springfield
Apples 2 x 2.50
Bread 1 x 3.50
Tax 1.20
Total 18.50 USD
2025-01-02
`

describe('isUsableReceiptText', () => {
  it('accepts a plausible receipt text', () => {
    expect(isUsableReceiptText(GOOD_RECEIPT)).toBe(true)
  })

  it('accepts receipts in non-Latin scripts', () => {
    expect(
      isUsableReceiptText(
        '东京商店中央区銀座一丁目\n商品A 500円\n商品B 1000円\n合計 1500円\n2025年1月2日ありがとうございました\n',
      ),
    ).toBe(true)
  })

  it('rejects blank and tiny texts', () => {
    expect(isUsableReceiptText('')).toBe(false)
    expect(isUsableReceiptText('   \n  ')).toBe(false)
    expect(isUsableReceiptText('Total 18.50')).toBe(false)
  })

  it('rejects text without any digit', () => {
    expect(
      isUsableReceiptText(
        'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud',
      ),
    ).toBe(false)
  })

  it('rejects garbled OCR noise', () => {
    expect(
      isUsableReceiptText(
        '### $$$ %%% ??? !!! @@@ ### $$$ %%% ??? !!! @@@ ### $$$',
      ),
    ).toBe(false)
  })
})
