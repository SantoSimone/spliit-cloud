import {
  amountAsMinorUnits,
  getCurrency,
  getCurrencyFromGroup,
} from '@spliit/domain'

import { getLastNonEmptyLine } from '../ai-response'
import type { ParsedReceiptItem, ReceiptExtractedResult } from './types'

type ParsedReceiptAIResponse = {
  amount: number
  categoryId: string | null
  currencyCode: string | null
  date: string | null
  title: string | null
  items: ParsedReceiptItem[]
}

export type GroupCurrencyInput = {
  currency: string
  currencyCode?: string | null
}

export function parseAIAmount(value: unknown) {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return Number.NaN
  return Number(value.replace(/,/g, '').trim())
}

export function parseAIQuantity(value: unknown) {
  const quantity =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.replace(/,/g, '').trim())
        : Number.NaN
  return Number.isInteger(quantity) && quantity > 0 ? quantity : null
}

export function parseReceiptItems(value: unknown): ParsedReceiptItem[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((rawItem) => {
    if (!rawItem || typeof rawItem !== 'object') return []
    const item = rawItem as Record<string, unknown>
    const titleValue = item.title ?? item.name ?? item.description
    const title = typeof titleValue === 'string' ? titleValue.trim() : ''
    const unitPrice = parseAIAmount(
      item.unitPrice ?? item.unit_price ?? item.price ?? item.amount,
    )
    const quantity = parseAIQuantity(item.quantity ?? item.qty ?? 1)

    if (!title || !Number.isFinite(unitPrice) || unitPrice === 0 || !quantity) {
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
      amount: parseAIAmount(parsed.amount ?? parsed.total),
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
    amount: parseAIAmount(amountString),
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

export function normalizeParsedReceipt(
  parsed: ParsedReceiptAIResponse,
  groupCurrencyInput: GroupCurrencyInput,
): void {
  const groupCurrency = getCurrencyFromGroup(groupCurrencyInput)
  const receiptCurrency = parsed.currencyCode
    ? (getCurrency(parsed.currencyCode) ?? groupCurrency)
    : groupCurrency
  parsed.currencyCode = receiptCurrency.code || null
  parsed.amount = amountAsMinorUnits(parsed.amount, receiptCurrency)
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
