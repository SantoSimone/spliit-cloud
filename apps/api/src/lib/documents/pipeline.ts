import { Effect } from 'effect'

import { classifyDocument } from './classify'
import { extractNativeText, nativeKindFor } from './extractors'
import { fetchDocumentBytes } from './fetch'
import { isUsableReceiptText } from './quality-gate'
import type { DocumentSource } from './types'
import { NATIVE_TEXT_MAX_CHARS } from './types'

/** Outcome of the native-text routing step. Never fails — see below. */
export type UsableDocumentText =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'none' }

/**
 * Try native text extraction for a document (PDF text layer, docx, odt,
 * txt/csv). Images skip this step (`none` — they route to OCR/vision directly);
 * unsupported documents skip it too (manual-with-attachment).
 *
 * Infallible by design: fetch, parse, and gate failures all collapse to `{
 * kind: 'none' }`, letting the caller fall back without branching on failure
 * modes. Explicit routing value, not a silent catch-and-ignore — every collapse
 * point is this function, and it is unit-tested.
 */
export const extractUsableDocumentTextWithBytes = Effect.fnUntraced(function* (
  source: DocumentSource,
  options: {
    maxChars?: number
    maxBytes?: number
    maxPages?: number
    allowedHosts?: string[]
  } = {},
): Effect.fn.Return<
  { readonly result: UsableDocumentText; readonly bytes?: Uint8Array },
  never
> {
  const kind = classifyDocument(source)
  const nativeKind = nativeKindFor(kind, source.contentType, source.fileName)
  if (nativeKind === 'none') return { result: { kind: 'none' } as const }

  const maxChars = options.maxChars ?? NATIVE_TEXT_MAX_CHARS
  // Fetch once: the bytes are returned alongside the outcome so the scan
  // pipeline can reuse them for the vision fallback instead of downloading
  // the same document a second time. A failed fetch carries no bytes, so the
  // fallback still fetches (and fails) exactly as before.
  const fetched = yield* fetchDocumentBytes(source.url, {
    maxBytes: options.maxBytes,
    allowedHosts: options.allowedHosts,
  }).pipe(Effect.orElseSucceed(() => null))
  if (fetched === null) return { result: { kind: 'none' } as const }
  // Snapshot before extraction: PDF parsing (pdfjs via unpdf) neuters the
  // input buffer, so the bytes handed back for vision reuse must be an
  // independent copy.
  const bytes = fetched.slice()
  const text = yield* extractNativeText(
    nativeKind,
    fetched,
    source.contentType,
    {
      maxPages: options.maxPages,
    },
  ).pipe(
    Effect.map((full) => full.slice(0, maxChars)),
    Effect.orElseSucceed(() => null),
  )
  if (text === null || !isUsableReceiptText(text)) {
    return { result: { kind: 'none' } as const, bytes }
  }
  return { result: { kind: 'text', text } as const, bytes }
})

export const extractUsableDocumentText = Effect.fnUntraced(function* (
  source: DocumentSource,
  options: {
    maxChars?: number
    maxBytes?: number
    maxPages?: number
    allowedHosts?: string[]
  } = {},
): Effect.fn.Return<UsableDocumentText, never> {
  const { result } = yield* extractUsableDocumentTextWithBytes(source, options)
  return result
})
