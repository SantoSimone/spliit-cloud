import { Effect } from 'effect'
import { strFromU8, unzipSync } from 'fflate'
import mammoth from 'mammoth'
import { extractText } from 'unpdf'

import { DocumentParseError } from '../ai-effects/errors'
import type { DocumentKind } from './types'
import { NATIVE_TEXT_MAX_PAGES } from './types'
function parseError(contentType: string, reason: string): DocumentParseError {
  return new DocumentParseError({ contentType, reason })
}

/**
 * PDF text-layer extraction (pure JS via `unpdf`, no native toolchain). Reads
 * per-page text so the page cap is enforceable, then joins the first pages.
 * Scanned-image PDFs yield ~empty text here and route to OCR/vision.
 */
export const extractPdfText = Effect.fnUntraced(function* (
  bytes: Uint8Array,
  options: { maxPages?: number } = {},
): Effect.fn.Return<string, DocumentParseError> {
  const maxPages = options.maxPages ?? NATIVE_TEXT_MAX_PAGES
  const { text: pages } = yield* Effect.tryPromise({
    try: () => extractText(bytes, { mergePages: false }),
    catch: () => parseError('application/pdf', 'PDF text extraction failed'),
  })
  return pages.slice(0, maxPages).join('\n')
})

/** DOCX raw text via `mammoth` (zip + Word XML, pure JS). */
export const extractDocxText = Effect.fnUntraced(function* (
  bytes: Uint8Array,
): Effect.fn.Return<string, DocumentParseError> {
  const docxType =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  // Bound archive inflation before handing the buffer to mammoth/jszip, which
  // fully materializes entries: a small compressed upload could otherwise
  // expand to hundreds of MB in memory.
  yield* Effect.try({
    try: () => assertDocxArchiveBounds(bytes),
    catch: (cause) =>
      cause instanceof DocumentParseError
        ? cause
        : parseError(docxType, 'DOCX text extraction failed'),
  })
  const { value } = yield* Effect.tryPromise({
    try: () =>
      mammoth.extractRawText({
        buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      }),
    catch: () => parseError(docxType, 'DOCX text extraction failed'),
  })
  return value
})

/**
 * Total uncompressed cap for `.docx` archives. Receipt documents are small text
 * payloads; this only rejects hostile or non-receipt archives.
 */
export const DOCX_MAX_TOTAL_UNCOMPRESSED_BYTES = 32 * 1024 * 1024

/** Per-entry uncompressed cap for `.docx` archives. */
export const DOCX_MAX_ENTRY_UNCOMPRESSED_BYTES = 16 * 1024 * 1024

const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_CENTRAL_HEADER_SIGNATURE = 0x02014b50
const ZIP64_SIZE_SENTINEL = 0xffffffff

/**
 * Reject archives whose central-directory uncompressed sizes exceed the caps
 * without decompressing anything. Unparseable buffers (not a zip) pass through
 * so mammoth still produces the standard typed parse failure.
 */
export function assertDocxArchiveBounds(bytes: Uint8Array): void {
  const docxType =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  const over = (reason: string) =>
    new DocumentParseError({ contentType: docxType, reason })
  if (bytes.length < 22) return
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The end-of-central-directory record lives in the last 22 + 64 KiB bytes
  // (its 2-byte comment-length field bounds the trailing comment).
  const windowStart = Math.max(0, bytes.length - (22 + 65535))
  let eocdAt = -1
  for (let at = bytes.length - 22; at >= windowStart; at -= 1) {
    if (view.getUint32(at, true) === ZIP_EOCD_SIGNATURE) {
      eocdAt = at
      break
    }
  }
  if (eocdAt < 0) return
  const entryCount = view.getUint16(eocdAt + 10, true)
  const centralOffset = view.getUint32(eocdAt + 16, true)
  if (centralOffset >= bytes.length) return
  let pos = centralOffset
  let total = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (pos + 46 > bytes.length) return
    if (view.getUint32(pos, true) !== ZIP_CENTRAL_HEADER_SIGNATURE) return
    const uncompressedSize = view.getUint32(pos + 24, true)
    const fileNameLength = view.getUint16(pos + 28, true)
    const extraLength = view.getUint16(pos + 30, true)
    const commentLength = view.getUint16(pos + 32, true)
    if (
      uncompressedSize === ZIP64_SIZE_SENTINEL ||
      uncompressedSize > DOCX_MAX_ENTRY_UNCOMPRESSED_BYTES
    ) {
      throw over('DOCX archive entry exceeds the decompression limit')
    }
    total += uncompressedSize
    if (total > DOCX_MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw over('DOCX archive exceeds the decompression limit')
    }
    pos += 46 + fileNameLength + extraLength + commentLength
  }
}

const ODT_PARAGRAPH_PATTERN = /<text:p[^>]*>([\s\S]*?)<\/text:p>/g
const XML_TAG_PATTERN = /<[^>]+>/g

/**
 * Total uncompressed cap for ODT `content.xml`, mirroring the DOCX per-entry
 * budget (`DOCX_MAX_ENTRY_UNCOMPRESSED_BYTES`). Receipt documents are small
 * text payloads; this only rejects hostile or non-receipt archives. Checked
 * post-inflate, pre-parse so a hostile archive cannot expand memory unbounded.
 */
export const ODT_MAX_CONTENT_XML_BYTES = 16 * 1024 * 1024

/**
 * Decode the five predefined XML entities. ODT paragraphs are read with a
 * tag-stripping regex (not a real XML parser), so `&amp;` etc. would otherwise
 * leak into the extracted text. `&amp;` decodes last so `&amp;lt;` yields
 * `&lt;`, not `<` (single-level decode).
 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * ODT raw text: unzip `content.xml` (via the already-present `fflate`) and read
 * paragraphs.
 */
export const extractOdtText = Effect.fnUntraced(function* (
  bytes: Uint8Array,
): Effect.fn.Return<string, DocumentParseError> {
  const contentType = 'application/vnd.oasis.opendocument.text'
  const fail = () => parseError(contentType, 'ODT text extraction failed')
  // Decompress content.xml only: entries (e.g. embedded images) stay packed
  // so a hostile archive cannot expand memory pre-truncation.
  const files = yield* Effect.try({
    try: () =>
      unzipSync(bytes, { filter: (file) => file.name === 'content.xml' }),
    catch: fail,
  })
  const xml = files['content.xml']
  if (!xml) return yield* fail()
  if (xml.byteLength > ODT_MAX_CONTENT_XML_BYTES) {
    return yield* Effect.fail(
      parseError(
        contentType,
        'ODT content.xml exceeds the decompression limit',
      ),
    )
  }
  const xmlText = yield* Effect.try({
    try: () => strFromU8(xml),
    catch: fail,
  })
  const paragraphs: string[] = []
  for (const match of xmlText.matchAll(ODT_PARAGRAPH_PATTERN)) {
    const paragraph = decodeXmlEntities(
      match[1]?.replace(XML_TAG_PATTERN, '') ?? '',
    ).trim()
    if (paragraph) paragraphs.push(paragraph)
  }
  return paragraphs.join('\n')
})

/** Plain text / CSV: decode as UTF-8, no parsing (the LLM reads raw CSV fine). */
export const extractPlainText = Effect.fnUntraced(function* (
  bytes: Uint8Array,
): Effect.fn.Return<string, DocumentParseError> {
  return yield* Effect.try({
    try: () => new TextDecoder('utf-8', { fatal: false }).decode(bytes),
    catch: () => parseError('text/plain', 'Text decoding failed'),
  })
})

/**
 * Dispatch native extraction by document kind. `none` always fails; the
 * pipeline never calls it with that kind (defensive failure, not a route).
 */
export function extractNativeText(
  kind: ExtractNativeKind,
  bytes: Uint8Array,
  sourceContentType?: string | null,
  options: { maxPages?: number } = {},
): Effect.Effect<string, DocumentParseError> {
  switch (kind) {
    case 'pdf':
      return extractPdfText(bytes, { maxPages: options.maxPages })
    case 'docx':
      return extractDocxText(bytes)
    case 'odt':
      return extractOdtText(bytes)
    case 'plain':
      return extractPlainText(bytes)
    default:
      return Effect.fail(
        parseError(
          sourceContentType || 'unknown',
          'No native text extraction for this document kind',
        ),
      )
  }
}

/** Native-text sub-kind, resolved from kind + content type by the pipeline. */
export type ExtractNativeKind = 'pdf' | 'docx' | 'odt' | 'plain' | 'none'

/**
 * Resolve which native extractor handles a classified document. `none` means
 * the caller should not attempt native extraction (images route to OCR/vision
 * directly; unsupported documents skip AI entirely).
 */
export function nativeKindFor(
  kind: DocumentKind,
  contentType?: string | null,
  fileName?: string | null,
): ExtractNativeKind {
  if (kind === 'pdf') return 'pdf'
  if (kind !== 'text-document') return 'none'
  const normalized = contentType?.toLowerCase().split(';', 1)[0].trim() ?? ''
  const name = fileName?.toLowerCase() ?? ''
  if (
    normalized ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.endsWith('.docx')
  ) {
    return 'docx'
  }
  if (
    normalized === 'application/vnd.oasis.opendocument.text' ||
    name.endsWith('.odt')
  ) {
    return 'odt'
  }
  return 'plain'
}
