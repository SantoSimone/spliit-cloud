/**
 * Quality gate for natively extracted document text ("reasonably good" check).
 *
 * Decides whether extracted text goes straight to the structuring LLM or the
 * document falls back to the image flow (OCR/vision). Deliberately dumb and
 * locale-agnostic: minimum length, a digit somewhere (receipts have amounts),
 * and a plausible alphanumeric density. The structuring LLM still returns
 * `empty: true` on garbage, which the client renders as
 * manual-with-attachment.
 */

export const MIN_USABLE_TEXT_CHARS = 50

/** Minimum share of alphanumeric characters (whitespace excluded). */
export const MIN_USABLE_TEXT_DENSITY = 0.3

/**
 * Letters and digits across Latin, CJK, and Hangul scripts — traveling users
 * scan receipts outside their locale, so East Asian text must pass too.
 */
const SIGNAL_PATTERN =
  /[A-Za-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g

export function isUsableReceiptText(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < MIN_USABLE_TEXT_CHARS) return false
  if (!/\d/.test(trimmed)) return false
  const compact = trimmed.replace(/\s/g, '')
  if (compact.length === 0) return false
  const signal = compact.match(SIGNAL_PATTERN)?.length ?? 0
  return signal / compact.length >= MIN_USABLE_TEXT_DENSITY
}
