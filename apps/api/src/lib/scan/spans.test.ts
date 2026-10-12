import { Effect, Tracer } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('ai', () => ({ generateText: vi.fn() }))
vi.mock('../ai', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getReceiptModel: vi.fn(),
}))
vi.mock('../ocr', async (importOriginal) => ({
  ...(await importOriginal()),
  getOcrProvider: vi.fn(() => null),
}))
vi.mock('../env', () => ({
  env: {
    AI_RECEIPT_MODEL: 'test-receipt-model',
    AI_RECEIPT_TIMEOUT_SECONDS: 120,
    AI_OCRSPACE_TIMEOUT_SECONDS: 30,
    AI_OCR_REQUIRED: false,
  },
}))

import {
  createRequestTracing,
  withTraceSpan,
  type RequestTracing,
} from '../ai-effects/spans'
import type { OcrProvider } from '../ocr'
import { OcrError } from '../ocr'

const { generateText } = await import('ai')
const { getReceiptModel } = await import('../ai')
const { getOcrProvider } = await import('../ocr')
const mockedEnv = (await import('../env')).env as {
  AI_OCR_REQUIRED: boolean
}
const { scanReceiptDocument } = await import('./pipeline')

const generateTextMock = vi.mocked(generateText)
const getReceiptModelMock = vi.mocked(getReceiptModel)
const getOcrProviderMock = vi.mocked(getOcrProvider)

const groupCurrency = { currency: '$', currencyCode: 'USD' }

const imageHost = 'images.example.test'
const image = {
  url: `https://${imageHost}/receipt.jpg`,
  contentType: 'image/jpeg',
  fileName: 'receipt.jpg',
}
const imageDeps = {
  fetchOptions: { allowedHosts: [imageHost] },
} as const

const PDF_STREAM_TEXT =
  'BT /F1 12 Tf 10 10 Td (Corner Market Main Street Springfield) Tj ET\n' +
  'BT /F1 12 Tf 10 30 Td (Apples 2.50 Bread 3.50 Tax 1.20 Total 18.50 USD 2025-01-02) Tj ET\n'
const PDF_STREAM_LEN = new TextEncoder().encode(PDF_STREAM_TEXT).length
const MINIMAL_PDF =
  '%PDF-1.4\n' +
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
  `4 0 obj<</Length ${PDF_STREAM_LEN}>>stream\n` +
  `${PDF_STREAM_TEXT}` +
  'endstream\n' +
  'endobj\n' +
  '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
  'trailer<</Root 1 0 R>>'
const pdfHost = 'files.example.test'
const pdfSource = {
  url: `https://${pdfHost}/invoice.pdf`,
  contentType: 'application/pdf',
  fileName: 'invoice.pdf',
}

function fakeOcr(text: string): OcrProvider {
  return {
    name: 'fake-ocr',
    extractText: () => Effect.succeed({ text, engine: 'fake-ocr' }),
  }
}

const MOCK_RECEIPT_JSON = JSON.stringify({
  amount: 1850,
  currencyCode: 'USD',
  date: '2025-01-02',
  title: 'Corner Market',
  items: [{ title: 'Apples', unitPrice: 250, quantity: 2000 }],
})

function mockReceiptJson() {
  generateTextMock.mockResolvedValue({
    text: MOCK_RECEIPT_JSON,
    usage: { inputTokens: 1204, outputTokens: 310 },
  } as never)
}

/** Same composition as the procedure's `runScan`: root span + collector. */
async function runTracedScan(
  ...args: Parameters<typeof scanReceiptDocument>
): Promise<{ tracing: RequestTracing; lines: Array<string> }> {
  const tracing = createRequestTracing()
  await Effect.runPromise(
    scanReceiptDocument(...args).pipe(
      withTraceSpan('scan.receipt'),
      Effect.provideService(Tracer.Tracer, tracing.tracer),
    ),
  )
  const lines: Array<string> = []
  tracing.print({ label: 'scan' }, (line) => lines.push(line))
  return { tracing, lines }
}

function spanNames(tracing: RequestTracing): Array<string> {
  return tracing.spans.map((span) => span.name)
}

function rootAttributes(tracing: RequestTracing): Record<string, unknown> {
  return (
    tracing.spans.find((span) => span.name === 'scan.receipt')?.attributes ?? {}
  )
}

const fetchMock = vi.fn()

beforeEach(() => {
  generateTextMock.mockReset()
  getReceiptModelMock.mockReset()
  getOcrProviderMock.mockReset()
  getOcrProviderMock.mockReturnValue(null)
  mockedEnv.AI_OCR_REQUIRED = false
  getReceiptModelMock.mockResolvedValue({ id: 'test-receipt-model' } as never)
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      new TextEncoder().encode('fake-image-bytes').buffer as ArrayBuffer,
  })
})

describe('scan tracing', () => {
  it('profiles the vision route with fetch, vision, and token attributes', async () => {
    mockReceiptJson()
    const { tracing, lines } = await runTracedScan(
      image,
      groupCurrency,
      {},
      imageDeps,
    )

    expect(spanNames(tracing)).toEqual([
      'scan.fetch',
      'scan.vision',
      'scan.receipt',
    ])
    expect(rootAttributes(tracing)).toMatchObject({
      'scan.document.kind': 'image',
      'scan.extraction': 'vision',
    })
    const vision = tracing.spans.find((span) => span.name === 'scan.vision')
    expect(vision?.attributes).toMatchObject({
      'llm.model': 'test-receipt-model',
      'scan.vision.kind': 'image',
      'scan.vision.mode': 'joint',
      'scan.vision.history': false,
      'llm.usage.input_tokens': 1204,
      'llm.usage.output_tokens': 310,
    })
    expect(vision?.error).toBeNull()
    expect(
      tracing.spans.find((span) => span.name === 'scan.fetch')?.attributes,
    ).toMatchObject({ 'scan.fetch.bytes': 16 })
    expect(lines[0]).toMatch(/^\[scan\] .*$/)
    expect(lines.join('\n')).toContain('scan.vision')
  })

  it('profiles the OCR route with ocr and structure steps, no vision', async () => {
    mockReceiptJson()
    const { tracing } = await runTracedScan(
      image,
      groupCurrency,
      {},
      {
        ocr: fakeOcr('Corner Market\nTotal 18.50'),
        fetchOptions: { allowedHosts: [imageHost] },
      },
    )

    expect(spanNames(tracing)).toEqual([
      'scan.ocr',
      'scan.structure',
      'scan.receipt',
    ])
    expect(rootAttributes(tracing)['scan.extraction']).toBe('ocr')
    expect(
      tracing.spans.find((span) => span.name === 'scan.ocr')?.attributes,
    ).toMatchObject({
      'scan.ocr.provider': 'fake-ocr',
      'scan.ocr.strict': false,
      'scan.ocr.chars': 25,
    })
    expect(
      tracing.spans.find((span) => span.name === 'scan.structure')?.attributes,
    ).toMatchObject({
      'scan.structure.origin': 'ocr',
      'llm.usage.input_tokens': 1204,
      'scan.structure.raw_chars': MOCK_RECEIPT_JSON.length,
    })
  })

  it('marks the OCR failure and vision-fallback extraction on degraded OCR', async () => {
    mockReceiptJson()
    const ocr: OcrProvider = {
      name: 'fake-ocr',
      extractText: () =>
        Effect.fail(new OcrError('OCR down', { retryable: true })),
    }
    const { tracing, lines } = await runTracedScan(
      image,
      groupCurrency,
      {},
      {
        ocr,
        fetchOptions: { allowedHosts: [imageHost] },
      },
    )

    expect(spanNames(tracing)).toEqual([
      'scan.ocr',
      'scan.fetch',
      'scan.vision',
      'scan.receipt',
    ])
    expect(rootAttributes(tracing)['scan.extraction']).toBe('vision-fallback')
    expect(
      tracing.spans.find((span) => span.name === 'scan.ocr')?.attributes,
    ).toMatchObject({
      'scan.ocr.failed': true,
      'scan.ocr.error': 'OcrError: OCR down',
    })
    // The OCR step itself recovered (degraded to vision), so it has no error.
    expect(
      tracing.spans.find((span) => span.name === 'scan.ocr')?.error,
    ).toBeNull()
    expect(lines.join('\n')).toContain('scan.vision')
  })

  it('profiles the native-text route with extract and structure steps', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        new TextEncoder().encode(MINIMAL_PDF).buffer as ArrayBuffer,
    })
    mockReceiptJson()
    const { tracing } = await runTracedScan(
      pdfSource,
      groupCurrency,
      {},
      {
        ocr: fakeOcr('should not be used'),
        fetchOptions: { allowedHosts: [pdfHost] },
      },
    )

    expect(spanNames(tracing)).toEqual([
      'scan.extract',
      'scan.structure',
      'scan.receipt',
    ])
    expect(rootAttributes(tracing)).toMatchObject({
      'scan.document.kind': 'pdf',
      'scan.extraction': 'text',
    })
    expect(
      tracing.spans.find((span) => span.name === 'scan.structure')?.attributes,
    ).toMatchObject({ 'scan.structure.origin': 'document' })
  })

  it('records only the root span for unsupported documents', async () => {
    const { tracing, lines } = await runTracedScan(
      {
        url: 'https://files.example.test/sheet.xlsx',
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileName: 'sheet.xlsx',
      },
      groupCurrency,
      {},
      {},
    )

    expect(spanNames(tracing)).toEqual(['scan.receipt'])
    expect(rootAttributes(tracing)).toMatchObject({
      'scan.document.kind': 'unsupported',
      'scan.extraction': 'unsupported',
    })
    expect(generateTextMock).not.toHaveBeenCalled()
    expect(lines).toHaveLength(2)
  })
})
