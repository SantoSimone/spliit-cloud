import { getCurrency, getCurrencyFromGroup } from '@spliit/domain'

import { getLastNonEmptyLine } from '../ai-response'
import type { ParsedReceiptItem, ReceiptExtractedResult } from './types'

type ParsedReceiptAIResponse = {
  /** Integer minor units of the receipt currency (`NaN` when unreadable). */
  amount: number
  categoryId: string | null
  currencyCode: string | null
  date: string | null
  title: string | null
  /**
   * Stored units: integer minor-unit `unitPrice`, integer milli-unit
   * `quantity`.
   */
  items: ParsedReceiptItem[]
}

export type GroupCurrencyInput = {
  currency: string
  currencyCode?: string | null
}

/**
 * Integer minor-unit money straight from the model (the prompt demands
 * minor-unit integers, so decimals, symbols, and separators are invalid and
 * yield `NaN`). Internal whitespace is tolerated (`1239, 08`-style OCR joins
 * aside, the model must already have stripped those).
 */
export function parseAIMinorAmount(value: unknown) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : Number.NaN
  }
  if (typeof value !== 'string') return Number.NaN
  const text = value.replace(/\s/g, '')
  return /^-?\d+$/.test(text) && Number.isSafeInteger(Number(text))
    ? Number(text)
    : Number.NaN
}

/**
 * Stored milli-unit quantity straight from the model (`1000` = 1 item).
 * Anything that is not a positive safe integer drops the line, as before.
 */
export function parseAIStoredQuantity(value: unknown) {
  const quantity =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.replace(/\s/g, ''))
        ? Number(value.replace(/\s/g, ''))
        : Number.NaN
  return Number.isSafeInteger(quantity) && quantity >= 1 ? quantity : null
}

export function parseReceiptItems(value: unknown): ParsedReceiptItem[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((rawItem) => {
    if (!rawItem || typeof rawItem !== 'object') return []
    const item = rawItem as Record<string, unknown>
    const titleValue = item.title ?? item.name ?? item.description
    const title = typeof titleValue === 'string' ? titleValue.trim() : ''
    const unitPrice = parseAIMinorAmount(
      item.unitPrice ?? item.unit_price ?? item.price ?? item.amount,
    )
    const quantity = parseAIStoredQuantity(item.quantity ?? item.qty ?? 1000)

    if (
      !title ||
      !Number.isSafeInteger(unitPrice) ||
      unitPrice === 0 ||
      !quantity
    ) {
      return []
    }
    return [{ title, unitPrice, quantity }]
  })
}

export function parseReceiptJSONResponse(
  content: string,
): ParsedReceiptAIResponse | null {
  try {
    const jsonStart = content.indexOf('{')
    const jsonEnd = content.lastIndexOf('}')
    if (jsonStart < 0 || jsonEnd < jsonStart) return null
    const parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1)) as Record<
      string,
      unknown
    >
    return {
      amount: parseAIMinorAmount(parsed.amount ?? parsed.total),
      categoryId:
        typeof parsed.categoryId === 'string' ? parsed.categoryId.trim() : null,
      currencyCode:
        typeof parsed.currencyCode === 'string'
          ? parsed.currencyCode.trim().toUpperCase()
          : null,
      date: typeof parsed.date === 'string' ? parsed.date.trim() : null,
      title:
        typeof parsed.title === 'string'
          ? parsed.title.trim()
          : typeof parsed.merchant === 'string'
            ? parsed.merchant.trim()
            : null,
      items: parseReceiptItems(parsed.items ?? parsed.lineItems),
    }
  } catch {
    return null
  }
}

export function parseReceiptAIResponse(
  rawContent: string | null | undefined,
): ParsedReceiptAIResponse {
  if (!rawContent) {
    return {
      amount: Number.NaN,
      categoryId: null,
      currencyCode: null,
      date: null,
      title: null,
      items: [],
    }
  }

  const jsonResponse = parseReceiptJSONResponse(rawContent)
  if (jsonResponse) return jsonResponse

  const responseLine = getLastNonEmptyLine(rawContent)
  const [amountString, categoryId, date, titleOrCurrency, ...restParts] =
    responseLine.split(',')

  const maybeCurrencyCode = titleOrCurrency?.trim().toUpperCase()
  const hasCurrencyCode =
    !!maybeCurrencyCode && !!getCurrency(maybeCurrencyCode)
  const titleParts = hasCurrencyCode
    ? restParts
    : [titleOrCurrency, ...restParts]

  return {
    amount: parseAIMinorAmount(amountString),
    categoryId: categoryId?.trim() || null,
    currencyCode: hasCurrencyCode ? maybeCurrencyCode : null,
    date: date?.trim() || null,
    title: titleParts.join(',').trim() || null,
    items: [],
  }
}

/**
 * True when the parsed receipt holds nothing worth prefilling. Currency is
 * ignored: it always falls back to the group currency, so it never counts as
 * extracted signal on its own.
 */
export function isEmptyReceiptResult(result: {
  amount: number
  title: string | null
  date: string | null
  items: ParsedReceiptItem[]
}): boolean {
  return (
    Number.isNaN(result.amount) &&
    !result.title &&
    !result.date &&
    result.items.length === 0
  )
}

/**
 * Currency fallback only: the model already returns integer minor/milli units,
 * so there is no major→minor normalization left to do. The currency still falls
 * back to the group currency so downstream formatting never sees a null code.
 */
export function resolveReceiptCurrency(
  parsed: ParsedReceiptAIResponse,
  groupCurrencyInput: GroupCurrencyInput,
): void {
  const groupCurrency = getCurrencyFromGroup(groupCurrencyInput)
  const receiptCurrency = parsed.currencyCode
    ? (getCurrency(parsed.currencyCode) ?? groupCurrency)
    : groupCurrency
  parsed.currencyCode = receiptCurrency.code || null
}

export function emptyReceiptResult(
  groupCurrencyInput: GroupCurrencyInput,
  ocrUsed = true,
): ReceiptExtractedResult {
  const groupCurrency = getCurrencyFromGroup(groupCurrencyInput)
  return {
    amount: Number.NaN,
    categoryId: null,
    currencyCode: groupCurrency.code || null,
    date: null,
    title: null,
    items: [],
    empty: true,
    ocrUsed,
  }
}
