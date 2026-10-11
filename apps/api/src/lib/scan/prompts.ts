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
 * behavior + prompt assertions), so all paths compose the same shared blocks
 * below and only vary two axes: the source framing (`image` vs `document` noun
 * for vision, `ocr` vs native `document` text for structuring) and the category
 * mode (joint vision keeps the category list plus group/history hints; every
 * other path leaves categorization to the decision model).
 *
 * Integer contract: amount and unitPrice are integer minor units of the receipt
 * currency, quantity is integer milli-units (1000 = 1 item). The parser accepts
 * nothing else, so the units block is repeated verbatim in every prompt.
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

/**
 * Integer money/quantity contract shared by every prompt. Amount and unitPrice
 * are integer minor units of the receipt currency; quantity is integer
 * milli-units (1000 = 1 item). The parser rejects anything else.
 */
function buildUnitsLine(groupCurrency: { decimal_digits: number }): string {
  return `Return amount and every unitPrice as integer minor units of the receipt currency (${groupCurrency.decimal_digits} minor digits per major unit, so 47.00 is 4700 in a 2-digit currency). Return every quantity as integer milli-units (1000 = 1 item, 495 = 0.495 items, 2000 = 2 items). No decimals, symbols, or separators in any number.`
}

/**
 * Line-item rules shared by every prompt: items routinely span adjacent lines
 * (title, quantity × unit price, and line total in any order), and weighed
 * produce carries fractional quantities.
 */
function buildItemsLine(): string {
  return 'Make a best-effort attempt to extract the purchased receipt line items. Join details split across adjacent lines (title, quantity × unit price, and line total may print in any order or on separate lines); never emit a bare quantity or price line as its own item. For each clearly readable item, return its display title, signed non-zero unitPrice, and positive quantity; preserve explicit discounts or credits as negative line items. If only the line total is readable, compute the minor-unit unitPrice as line total × 1000 ÷ milli-unit quantity (quantity is thousandths, so 1500 = 1.5 items). Exclude taxes, service charges, subtotals, totals, payment details, and unreadable or uncertain lines. Return an empty items array when no line items can be identified.'
}

/**
 * OCR-only caution: on that path the model never sees the receipt image, only
 * provider text, so it must distrust the digits and reconcile arithmetically.
 * Vision prompts get the shorter visual caution instead; native document text
 * needs neither.
 */
function buildOcrCautionLine(): string {
  return 'The OCR text misreads digits (0/8/6/9, 1/7, 5/6), inserts spaces inside numbers (1239, 08), and leaves trailing tax letters (47,00 Б): strip those before converting to minor units. When readings compete, prefer the one where milli-unit quantity × minor-unit unitPrice ÷ 1000 matches the printed line total and items plus tax match the grand total; drop lines that cannot be reconciled instead of guessing.'
}

function buildVisionCautionLine(): string {
  return 'Read digits carefully (0/8 and 1/7 look alike at receipt resolution); drop uncertain lines instead of guessing.'
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
    ? `\nCurrent form values are soft hints only, in major units (decimal prices, whole-or-fractional quantities). Re-check them against the receipt and still return integer minor/milli units:\n${JSON.stringify(input.currentExpense)}`
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
    ? 'Return exactly one JSON object with these fields: amount (integer), currencyCode (string), date (string), title (string), and items (array of objects with title (string), unitPrice (integer), and quantity (integer)). Do not explain.'
    : 'Return exactly one JSON object with these fields: amount (integer), categoryId (string), currencyCode (string), date (string), title (string), and items (array of objects with title (string), unitPrice (integer), and quantity (integer)). Do not explain.'

  return `
    This ${input.noun} contains a receipt.
    ${taskLine}
    Use the final amount charged, including tax and service charges when visible.
    ${buildUnitsLine(groupCurrency)}
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
    ${buildVisionCautionLine()}
    ${buildItemsLine()}
    The group's currency is ${groupCurrency.code || groupCurrency.symbol}; use the receipt total as written and do not convert currencies.
    ${fieldsLine}`
}

export type StructurePromptInput = {
  /**
   * `ocr` for provider OCR output (the model never sees the image, so the
   * prompt carries the OCR digit-misread caution), `document` for natively
   * extracted file text. The caution and the source framing are the only
   * differences; the units and item instructions are shared.
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
    ? `\nCurrent form values are soft hints only, in major units (decimal prices, whole-or-fractional quantities). Re-check them against the receipt text and still return integer minor/milli units:\n${JSON.stringify(input.currentExpense)}`
    : ''
  const sourceLine =
    input.origin === 'ocr'
      ? 'The following text was extracted from a receipt by OCR. It may contain misread characters and line breaks in odd places.'
      : 'The following text was extracted from a receipt document. It may contain line breaks in odd places.'
  const ocrCautionLine = input.origin === 'ocr' ? buildOcrCautionLine() : ''

  return `
    ${sourceLine}
    Extract the receipt total, receipt currency, receipt date, and merchant/title.
    Use the final amount charged, including tax and service charges when visible.
    ${buildUnitsLine(groupCurrency)}
    Return currencyCode as the ISO 4217 code printed or implied by the text.
    If the currency is not printed clearly, infer it from receipt language, merchant name, address, tax labels, phone number, country/city hints, and any other local clues.
    If those clues strongly indicate a country, use that country's normal currency.
    Only return an empty string when there is no reasonable currency inference.
    Return the date as yyyy-mm-dd. If the date is unreadable, return an empty string.
    ${localeHint}
    ${translationDirective}
    ${currentExpenseSection}
    The receipt text is the source of truth. Do not invent values that are not supported by it; leave unreadable fields as empty strings.
    ${ocrCautionLine}
    ${buildItemsLine()}
    The group's currency is ${groupCurrency.code || groupCurrency.symbol}; use the receipt total as written and do not convert currencies.
    Return exactly one JSON object with these fields: amount (integer), currencyCode (string), date (string), title (string), and items (array of objects with title (string), unitPrice (integer), and quantity (integer)). Do not explain.
    Receipt text:
    ${input.documentText}`
}
