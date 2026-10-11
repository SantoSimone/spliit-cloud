import type { DocumentKind, DocumentSource } from './types'

const IMAGE_MIME_PREFIX = 'image/'

const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.heic',
  '.heif',
])

/** MIME types with a natively extractable text layer (v1 scope). */
const TEXT_DOCUMENT_MIME_TYPES = new Set([
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
])

const TEXT_DOCUMENT_EXTENSIONS = new Set(['.txt', '.csv', '.docx', '.odt'])

function normalizeContentType(contentType: string | null | undefined) {
  return contentType?.toLowerCase().split(';', 1)[0].trim() ?? ''
}

function extensionOf(fileName: string | null | undefined) {
  if (!fileName) return ''
  const dot = fileName.lastIndexOf('.')
  return dot < 0 ? '' : fileName.slice(dot).toLowerCase()
}

/**
 * Classify a receipt file into its processing route. Content type wins;
 * `application/octet-stream` and missing types fall back to the file extension
 * (mirrors `isSupportedExpenseDocumentUpload` in domain).
 */
export function classifyDocument(
  source: Pick<DocumentSource, 'contentType' | 'fileName'>,
): DocumentKind {
  const contentType = normalizeContentType(source.contentType)
  const extension = extensionOf(source.fileName)
  const typed = contentType !== '' && contentType !== 'application/octet-stream'

  if (
    (typed && contentType.startsWith(IMAGE_MIME_PREFIX)) ||
    IMAGE_EXTENSIONS.has(extension)
  ) {
    return 'image'
  }
  if ((typed && contentType === 'application/pdf') || extension === '.pdf') {
    return 'pdf'
  }
  if (
    (typed && TEXT_DOCUMENT_MIME_TYPES.has(contentType)) ||
    TEXT_DOCUMENT_EXTENSIONS.has(extension)
  ) {
    return 'text-document'
  }
  return 'unsupported'
}
