import type { GroupContext, RecentExpense } from '../ai/context'

export type ParsedReceiptItem = {
  title: string
  unitPrice: number
  quantity: number
}

export type ReceiptAIContext = {
  recentExpenses?: RecentExpense[]
  locale?: string
  groupContext?: GroupContext
  translateToLocale?: boolean
  /**
   * OCR-only mode: skip the category list plus group/history hints so the
   * vision prompt stays small and the LLM acts purely as OCR. The caller
   * categorizes the extracted title separately via the decision model. Category
   * output is always null in this mode.
   */
  ocrOnly?: boolean
}

export type ReceiptCurrentExpenseHints = {
  title?: string
  amount?: number
  date?: string
  currencyCode?: string
  categoryId?: string
  items?: Array<{ title: string; unitPrice: number; quantity: number }>
}

export type ReceiptExtractedResult = {
  amount: number
  categoryId: string | null
  currencyCode: string | null
  date: string | null
  title: string | null
  items: ParsedReceiptItem[]
  /**
   * True when nothing usable came out of the receipt (no amount, title, date,
   * or items). Callers surface an explicit "nothing extracted" notice instead
   * of silently prefilling, while still keeping the document attached for
   * manual entry.
   */
  empty: boolean
  /**
   * True when the result came from a structured-text path (dedicated OCR
   * provider or native document text) rather than the joint vision call. The
   * category is always null on this path; the caller runs the separate
   * suggestion step.
   */
  ocrUsed: boolean
}
