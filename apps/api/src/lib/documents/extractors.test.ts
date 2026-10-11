import { Effect } from 'effect'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import {
  extractDocxText,
  extractNativeText,
  extractOdtText,
  extractPdfText,
  extractPlainText,
  nativeKindFor,
} from './extractors'

const MINIMAL_PDF =
  '%PDF-1.4\n' +
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
  '4 0 obj<</Length 60>>stream\n' +
  'BT /F1 12 Tf 10 10 Td (Corner Market Total 18.50) Tj ET\n' +
  'endstream\n' +
  'endobj\n' +
  '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
  'trailer<</Root 1 0 R>>'

function minimalDocx(text: string): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    'word/document.xml': strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ),
  })
}

function minimalOdt(lines: string[]): Uint8Array {
  const paragraphs = lines
    .map((line) => `<text:p text:style-name="P">${line}</text:p>`)
    .join('')
  return zipSync({
    mimetype: strToU8('application/vnd.oasis.opendocument.text'),
    'content.xml': strToU8(
      `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text>${paragraphs}</office:text></office:body></office:document-content>`,
    ),
  })
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe('nativeKindFor', () => {
  it('resolves pdf, docx, odt, and plain kinds', () => {
    expect(nativeKindFor('pdf', 'application/pdf', 'a.pdf')).toBe('pdf')
    expect(
      nativeKindFor(
        'text-document',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'a.docx',
      ),
    ).toBe('docx')
    expect(
      nativeKindFor(
        'text-document',
        'application/vnd.oasis.opendocument.text',
        'a.odt',
      ),
    ).toBe('odt')
    expect(nativeKindFor('text-document', 'text/plain', 'a.txt')).toBe('plain')
    expect(nativeKindFor('text-document', 'text/csv', 'a.csv')).toBe('plain')
  })

  it('returns none for image and unsupported kinds', () => {
    expect(nativeKindFor('image', 'image/jpeg', 'a.jpg')).toBe('none')
    expect(nativeKindFor('unsupported', 'application/msword', 'a.doc')).toBe(
      'none',
    )
  })
})

describe('extractPdfText', () => {
  it('reads the text layer of a real PDF', async () => {
    const text = await run(
      extractPdfText(new TextEncoder().encode(MINIMAL_PDF)),
    )
    expect(text).toContain('Corner Market Total 18.50')
  })

  it('fails typed on garbage bytes', async () => {
    const error = await run(
      extractPdfText(new TextEncoder().encode('not a pdf at all')).pipe(
        Effect.flip,
      ),
    )
    expect(error._tag).toBe('DocumentParseError')
  })
})

describe('extractDocxText', () => {
  it('reads a real docx built in-test', async () => {
    const text = await run(
      extractDocxText(minimalDocx('Corner Market Total 18.50')),
    )
    expect(text).toContain('Corner Market Total 18.50')
  })

  it('fails typed on garbage bytes', async () => {
    const error = await run(
      extractDocxText(new TextEncoder().encode('not a zip')).pipe(Effect.flip),
    )
    expect(error._tag).toBe('DocumentParseError')
  })

  it('rejects archives exceeding the decompression limit without inflating them', async () => {
    // A single highly-compressible entry over the per-entry cap: tiny on the
    // wire, but mammoth/jszip would fully materialize it without the
    // central-directory pre-check.
    const bomb = zipSync({
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      'word/document.xml': strToU8(
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>',
      ),
      'word/media/padding.bin': new Uint8Array(20 * 1024 * 1024),
    })
    const error = await run(extractDocxText(bomb).pipe(Effect.flip))
    expect(error._tag).toBe('DocumentParseError')
    expect(error.reason).toContain('decompression limit')
  })
})

describe('extractOdtText', () => {
  it('reads paragraphs from a real odt built in-test', async () => {
    const text = await run(
      extractOdtText(minimalOdt(['Corner Market', 'Total 18.50'])),
    )
    expect(text).toContain('Corner Market')
    expect(text).toContain('Total 18.50')
  })

  it('fails typed when content.xml is missing', async () => {
    const error = await run(
      extractOdtText(zipSync({ 'other.xml': strToU8('<xml/>') })).pipe(
        Effect.flip,
      ),
    )
    expect(error._tag).toBe('DocumentParseError')
  })
})

describe('extractPlainText', () => {
  it('decodes txt and csv bytes as-is', async () => {
    expect(
      await run(
        extractPlainText(new TextEncoder().encode('Corner Market,18.50')),
      ),
    ).toBe('Corner Market,18.50')
  })
})

describe('extractNativeText', () => {
  it('dispatches by kind and fails on none', async () => {
    expect(
      await run(
        extractNativeText(
          'plain',
          new TextEncoder().encode('hello 123'),
          'text/plain',
        ),
      ),
    ).toBe('hello 123')
    const error = await run(
      extractNativeText('none', new Uint8Array(), 'image/jpeg').pipe(
        Effect.flip,
      ),
    )
    expect(error._tag).toBe('DocumentParseError')
  })
})
