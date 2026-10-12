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
  return `Amounts are integer minor units of the receipt currency (${groupCurrency.decimal_digits} minor digits per major unit, so 47.00 is 4700 in a 2-digit currency); quantities are integer milli-units (1000 = 1 item).`
}

/**
 * Line-item rules shared by every prompt: items routinely span adjacent lines
 * (title, quantity × unit price, and line total in any order), and weighed
 * produce carries fractional quantities.
 */
function buildItemsLine(): string {
  return "Extract the purchased line items so that they add up to the grand total, which includes everything the customer pays — items, taxes, fees, and deposits. The total is the check on your work. When the receipt offers no clear item breakdown (tickets, slips, confirmations, bills), return an empty items array rather than forcing uncertain lines. Join details split across adjacent lines (title, quantity, price, and total can print in any order or on separate lines); never emit a bare quantity or price line as its own item. If two lines look like the same item, keep both as separate items with identical title and price, preferring the version that reads as a correct word in the receipt's language and lets the items add up to the grand total. For each item return its display title and whatever you can read — unitPrice with quantity, lineTotal with quantity, or lineTotal alone; we derive the missing value. Preserve explicit discounts as negative line items. Exclude subtotals, totals, payment details, and unreadable lines — omit a line entirely when its title or total cannot be read. Exclude a tax or fee line only if the remaining items still sum to the grand total; if the items fall short, keep it as an item. Drop deposit and fee lines marked as already included in the prices. Each printed total belongs to at most one item. Return an empty items array when no line items can be identified."
}

/**
 * OCR-only caution: on that path the model never sees the receipt image, only
 * provider text, so it must distrust the digits and reconcile arithmetically.
 * Vision prompts get the shorter visual caution instead; native document text
 * needs neither.
 */
function buildOcrCautionLine(): string {
  return 'The OCR text misreads digits and inserts spaces inside numbers: strip those before converting to minor units. When readings compete, prefer the one where quantity × unitPrice matches the printed line total and the items add up to the grand total; drop the rest.'
}

function buildVisionCautionLine(): string {
  return 'Read digits carefully; drop uncertain lines instead of guessing.'
}

/**
 * Merchant title rule shared by every prompt: clean name with branch, plus the
 * service period only when the document states one the payment covers (utility
 * bill, pass, rent, subscription) — never from the issue date alone.
 */
function buildTitleLine(): string {
  return 'Title is the merchant name (with branch when shown); reconstruct it when garbled instead of copying the garble. If the document states a billing or validity period the payment covers, append it as `Merchant - Month YYYY`; otherwise merchant name alone.'
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
  const itemShape =
    'items: Array<{ title: string, unitPrice?: number, quantity?: number, lineTotal?: number }>'
  const shapeLine =
    'amount, unitPrice and lineTotal are integer minor units; quantity is integer milli-units; date is yyyy-mm-dd or "" when unreadable; title is "" when not a receipt.'
  const fieldsLine = ocrOnly
    ? `Return exactly one JSON object of this shape (integers only — no decimals, symbols, or separators): { amount: number | null, currencyCode: string, date: string, title: string, ${itemShape} }. ${shapeLine} Do not explain.`
    : `Return exactly one JSON object of this shape (integers only — no decimals, symbols, or separators): { amount: number | null, categoryId: string, currencyCode: string, date: string, title: string, ${itemShape} }. ${shapeLine} Do not explain.`

  return `
    This ${input.noun} contains a receipt. If it is not a receipt, return null amount, empty strings, and empty items.
    ${taskLine}
    Use the final amount charged, including tax and service charges when visible. If no grand total is visible, return amount as null — never estimate it, and never return 0.
    ${buildTitleLine()}
    ${buildUnitsLine(groupCurrency)}
    Return currencyCode as the ISO 4217 code printed or implied by the receipt (language, merchant, address, tax labels, or phone). Only return an empty string when no inference is possible.
    Return the date as yyyy-mm-dd; empty string when unreadable — never infer it.
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
    Use the final amount charged, including tax and service charges when visible. If no grand total is visible, return amount as null — never estimate it, and never return 0.
    ${buildTitleLine()}
    ${buildUnitsLine(groupCurrency)}
    Return currencyCode as the ISO 4217 code printed or implied by the text (language, merchant, address, tax labels, or phone). Only return an empty string when no inference is possible.
    Return the date as yyyy-mm-dd; empty string when unreadable — never infer it.
    ${localeHint}
    ${translationDirective}
    ${currentExpenseSection}
    The receipt text is the source of truth. Do not invent values that are not supported by it; leave unreadable fields as empty strings. If the text is not a receipt, return null amount, empty strings, and empty items.
    ${ocrCautionLine}
    ${buildItemsLine()}
    The group's currency is ${groupCurrency.code || groupCurrency.symbol}; use the receipt total as written and do not convert currencies.
    Return exactly one JSON object of this shape (integers only — no decimals, symbols, or separators): { amount: number | null, currencyCode: string, date: string, title: string, items: Array<{ title: string, unitPrice?: number, quantity?: number, lineTotal?: number }> }. amount, unitPrice and lineTotal are integer minor units; quantity is integer milli-units; date is yyyy-mm-dd or "" when unreadable; title is "" when not a receipt. Do not explain.
    Receipt text:
    ${input.documentText}`
}
