import {
  DEFAULT_CATEGORIES,
  formatCategoryForAIPrompt,
  getCurrencyFromGroup,
} from '@spliit/domain'

import type { GroupContext, RecentExpense } from '../ai/context'
import {
  buildGroupContextSection,
  buildLocaleHint,
  buildRecentExpensesSection,
  buildTranslationDirective,
} from '../ai/prompt'
import type { GroupCurrencyInput } from './parse'
import type { ReceiptCurrentExpenseHints } from './types'

/**
 * Prompt builders for receipt extraction. The wording is load-bearing (model
 * behavior + prompt assertions), so builders only parametrize the document noun
 * (`image` for photos, `document` for PDFs/office files) and the text origin
 * (`ocr` vs native `document` text) — never the instructions.
 */

export type VisionPromptInput = {
  /** `image` for photos, `document` for PDFs. */
  noun: 'image' | 'document'
  groupCurrencyInput: GroupCurrencyInput
  ocrOnly: boolean
  locale?: string
  translateToLocale?: boolean
  groupContext?: GroupContext
  recentExpenses?: RecentExpense[]
  currentExpense?: ReceiptCurrentExpenseHints
}

export function buildVisionPrompt(input: VisionPromptInput): string {
  const categories = DEFAULT_CATEGORIES
  const groupCurrency = getCurrencyFromGroup(input.groupCurrencyInput)
  const ocrOnly = input.ocrOnly
  // OCR-only mode drops the category list plus group/history hints: the
  // decision model gets that signal separately from the extracted title.
  const groupSection = ocrOnly
    ? ''
    : buildGroupContextSection(input.groupContext)
  const localeHint = buildLocaleHint(input.locale)
  const translationDirective = buildTranslationDirective(
    input.locale,
    input.translateToLocale,
  )
  const recentSection = ocrOnly
    ? ''
    : buildRecentExpensesSection(input.recentExpenses ?? [])
  const currentExpenseSection = input.currentExpense
    ? `\nCurrent form values are soft hints only. Re-check them against the receipt and improve or replace them when the ${input.noun} supports it:\n${JSON.stringify(input.currentExpense)}`
    : ''
  const taskLine = ocrOnly
    ? 'Extract the receipt total, receipt currency, receipt date, and merchant/title.'
    : 'Extract the receipt total, best category ID, receipt currency, receipt date, and merchant/title.'
  const categoryLine = ocrOnly
    ? ''
    : `Return the categoryId from this allowed list only: ${categories.map((category) => formatCategoryForAIPrompt(category)).join(', ')}.`
  const hintsLine = ocrOnly
    ? `The receipt ${input.noun} is the source of truth.`
    : `Use the group context and past-expense examples only as soft hints for currency, merchant/title, and category; the receipt ${input.noun} is the source of truth. Do not copy an example's amount, date, or items.`
  const fieldsLine = ocrOnly
    ? 'Return exactly one JSON object with these fields: amount (number), currencyCode (string), date (string), title (string), and items (array of objects with title (string), unitPrice (number), and quantity (integer)). Do not explain.'
    : 'Return exactly one JSON object with these fields: amount (number), categoryId (string), currencyCode (string), date (string), title (string), and items (array of objects with title (string), unitPrice (number), and quantity (integer)). Do not explain.'

  return `
    This ${input.noun} contains a receipt.
    ${taskLine}
    Use the final amount charged, including tax and service charges when visible.
    Return the amount as a plain number without currency symbols or thousands separators.
    Return currencyCode as the ISO 4217 code printed or implied by the receipt.
    If the currency is not printed clearly, infer it from receipt language, merchant name, address, tax labels, phone number, country/city hints, and any other local clues.
    If those clues strongly indicate a country, use that country's normal currency.
    Only return an empty string when there is no reasonable currency inference.
    Return the date as yyyy-mm-dd. If the date is unreadable, return an empty string.
    ${categoryLine}
    ${groupSection}
    ${localeHint}
    ${translationDirective}
    ${recentSection}
    ${currentExpenseSection}
    ${hintsLine}
    Make a best-effort attempt to extract the purchased receipt line items. For each clearly readable item, return its display title, signed non-zero unit price in the receipt currency, and positive integer quantity. Preserve explicit discounts or credits as negative line items; exclude taxes, service charges, subtotals, totals, payment details, and unreadable or uncertain lines. Return an empty items array when no line items can be identified.
    The group's currency is ${groupCurrency.code || groupCurrency.symbol}; use the receipt total as written and do not convert currencies.
    ${fieldsLine}`
}

export type StructurePromptInput = {
  /**
   * `ocr` for provider OCR output, `document` for natively extracted file text.
   * Only the source framing differs; the instructions are identical.
   */
  origin: 'ocr' | 'document'
  documentText: string
  groupCurrencyInput: GroupCurrencyInput
  locale?: string
  translateToLocale?: boolean
  currentExpense?: ReceiptCurrentExpenseHints
}

export function buildStructurePrompt(input: StructurePromptInput): string {
  const groupCurrency = getCurrencyFromGroup(input.groupCurrencyInput)
  const localeHint = buildLocaleHint(input.locale)
  const translationDirective = buildTranslationDirective(
    input.locale,
    input.translateToLocale,
  )
  const currentExpenseSection = input.currentExpense
    ? `\nCurrent form values are soft hints only. Re-check them against the receipt text and improve or replace them when the text supports it:\n${JSON.stringify(input.currentExpense)}`
    : ''
  const sourceLine =
    input.origin === 'ocr'
      ? 'The following text was extracted from a receipt by OCR. It may contain misread characters and line breaks in odd places.'
      : 'The following text was extracted from a receipt document. It may contain line breaks in odd places.'

  return `
    ${sourceLine}
    Extract the receipt total, receipt currency, receipt date, and merchant/title.
    Use the final amount charged, including tax and service charges when visible.
    Return the amount as a plain number without currency symbols or thousands separators.
    Return currencyCode as the ISO 4217 code printed or implied by the text.
    If the currency is not printed clearly, infer it from receipt language, merchant name, address, tax labels, phone number, country/city hints, and any other local clues.
    If those clues strongly indicate a country, use that country's normal currency.
    Only return an empty string when there is no reasonable currency inference.
    Return the date as yyyy-mm-dd. If the date is unreadable, return an empty string.
    ${localeHint}
    ${translationDirective}
    ${currentExpenseSection}
    The receipt text is the source of truth. Do not invent values that are not supported by it; leave unreadable fields as empty strings.
    Make a best-effort attempt to extract the purchased receipt line items. For each clearly readable item, return its display title, signed non-zero unit price in the receipt currency, and positive integer quantity. Preserve explicit discounts or credits as negative line items; exclude taxes, service charges, subtotals, totals, payment details, and unreadable or uncertain lines. Return an empty items array when no line items can be identified.
    The group's currency is ${groupCurrency.code || groupCurrency.symbol}; use the receipt total as written and do not convert currencies.
    Return exactly one JSON object with these fields: amount (number), currencyCode (string), date (string), title (string), and items (array of objects with title (string), unitPrice (number), and quantity (integer)). Do not explain.
    Receipt text:
    ${input.documentText}`
}
