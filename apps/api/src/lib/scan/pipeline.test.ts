import { Effect } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('ai', () => ({ generateText: vi.fn() }))
vi.mock('../ai', () => ({ getModel: vi.fn() }))
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

import type { OcrProvider } from '../ocr'
import { OcrError } from '../ocr'

const { generateText } = await import('ai')
const { getModel } = await import('../ai')
const { getOcrProvider } = await import('../ocr')
const mockedEnv = (await import('../env')).env as {
  AI_OCR_REQUIRED: boolean
}
const { scanReceiptDocument, structureDocumentText, structureOcrText } =
  await import('./pipeline')
const { isEmptyReceiptResult } = await import('./parse')

const generateTextMock = vi.mocked(generateText)
const getModelMock = vi.mocked(getModel)
const getOcrProviderMock = vi.mocked(getOcrProvider)

const groupCurrency = { currency: '$', currencyCode: 'USD' }
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

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

function fakeOcr(text: string): OcrProvider {
  return {
    name: 'fake-ocr',
    extractText: () => Effect.succeed({ text, engine: 'fake-ocr' }),
  }
}

function failingOcr(): OcrProvider {
  return {
    name: 'fake-ocr',
    extractText: () =>
      Effect.fail(new OcrError('OCR down', { retryable: true })),
  }
}

const fetchMock = vi.fn()

beforeEach(() => {
  generateTextMock.mockReset()
  getModelMock.mockReset()
  getOcrProviderMock.mockReset()
  getOcrProviderMock.mockReturnValue(null)
  mockedEnv.AI_OCR_REQUIRED = false
  getModelMock.mockResolvedValue({ id: 'test-receipt-model' } as never)
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  // Default vision-path download: image tests hit the server-side fetch for
  // embedded bytes (no per-test mock needed); document tests override the
  // first call with `mockResolvedValueOnce` for native-text content and fall
  // through to this default for the vision fallback fetch.
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      new TextEncoder().encode('fake-image-bytes').buffer as ArrayBuffer,
  })
})

describe('scanReceiptDocument image flow', () => {
  const imageHost = 'images.example.test'
  const image = {
    url: `https://${imageHost}/receipt.jpg`,
    contentType: 'image/jpeg',
    fileName: 'receipt.jpg',
  }
  const imageDeps = {
    fetchOptions: { allowedHosts: [imageHost] },
  } as const

  it('extracts receipt metadata and best-effort item details from JSON', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        amount: 1850,
        categoryId: 'groceries',
        currencyCode: 'USD',
        date: '2025-01-02',
        title: 'Corner Market',
        items: [
          { title: 'Apples', unitPrice: 250, quantity: 2000 },
          { title: 'Bread', unitPrice: 350, quantity: 1000 },
        ],
      }),
    })

    const result = await run(
      scanReceiptDocument(image, groupCurrency, {}, imageDeps),
    )

    expect(result).toMatchObject({
      amount: 1850,
      categoryId: 'groceries',
      currencyCode: 'USD',
      date: '2025-01-02',
      title: 'Corner Market',
      items: [
        { title: 'Apples', unitPrice: 250, quantity: 2000 },
        { title: 'Bread', unitPrice: 350, quantity: 1000 },
      ],
      empty: false,
      ocrUsed: false,
    })
  })

  it('filters malformed item entries while retaining valid items despite total mismatch', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        amount: 1000,
        currencyCode: 'USD',
        items: [
          { title: 'Valid item', unitPrice: 425, quantity: 1000 },
          { title: '   ', unitPrice: 200, quantity: 1000 },
          { title: 'Zero price', unitPrice: 0, quantity: 1000 },
          { title: 'Negative quantity', unitPrice: 200, quantity: -1000 },
          { title: 'Fractional minor price', unitPrice: 2.5, quantity: 1000 },
          { title: 'Non-integer quantity', unitPrice: 200, quantity: 1000.5 },
          { title: 'Missing price', quantity: 1000 },
          null,
        ],
      }),
    })

    const result = await run(
      scanReceiptDocument(image, groupCurrency, {}, imageDeps),
    )

    expect(result.items).toEqual([
      { title: 'Valid item', unitPrice: 425, quantity: 1000 },
    ])
  })

  it('keeps fractional milli-unit quantities from the receipt response', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        amount: 800,
        currencyCode: 'USD',
        items: [
          { title: 'Apples', unitPrice: 200, quantity: 1500 },
          { title: 'Flour', unitPrice: 200, quantity: 2500 },
        ],
      }),
    })

    const result = await run(
      scanReceiptDocument(image, groupCurrency, {}, imageDeps),
    )

    expect(result.items).toEqual([
      { title: 'Apples', unitPrice: 200, quantity: 1500 },
      { title: 'Flour', unitPrice: 200, quantity: 2500 },
    ])
  })

  it('keeps signed discount items from the receipt response', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        amount: 900,
        currencyCode: 'USD',
        items: [
          { title: 'Subtotal', unitPrice: 1000, quantity: 1000 },
          { title: 'Discount', unitPrice: -100, quantity: 1000 },
        ],
      }),
    })

    const result = await run(
      scanReceiptDocument(image, groupCurrency, {}, imageDeps),
    )

    expect(result.items).toEqual([
      { title: 'Subtotal', unitPrice: 1000, quantity: 1000 },
      { title: 'Discount', unitPrice: -100, quantity: 1000 },
    ])
  })

  it('returns no items for the legacy comma-separated response format', async () => {
    generateTextMock.mockResolvedValue({
      text: '1234,groceries,2025-01-02,USD,Corner Market',
    })

    const result = await run(
      scanReceiptDocument(image, groupCurrency, {}, imageDeps),
    )

    expect(result).toMatchObject({
      amount: 1234,
      categoryId: 'groceries',
      currencyCode: 'USD',
      date: '2025-01-02',
      title: 'Corner Market',
      items: [],
    })
  })

  it('marks empty vision results without signal', async () => {
    generateTextMock.mockResolvedValue({ text: '' })

    const result = await run(
      scanReceiptDocument(image, groupCurrency, {}, imageDeps),
    )

    expect(result.items).toEqual([])
    expect(result.amount).toBeNaN()
    expect(result.empty).toBe(true)
    expect(result.ocrUsed).toBe(false)
  })

  it('asks the model to return item names, prices, and quantities', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ amount: 1, items: [] }),
    })

    await run(scanReceiptDocument(image, groupCurrency, {}, imageDeps))

    const request = generateTextMock.mock.calls[0]?.[0] as {
      messages: Array<{
        content: Array<{ type: string; text?: string }>
      }>
    }
    const prompt = request.messages[0]?.content.find(
      (part) => part.type === 'text',
    )?.text

    expect(prompt).toMatch(/items/i)
    expect(prompt).toMatch(/unitPrice/i)
    expect(prompt).toMatch(/quantity/i)
    // Integer contract: minor-unit money, milli-unit quantities.
    expect(prompt).toMatch(/minor units/i)
    expect(prompt).toMatch(/milli-units/i)
  })

  it('uses the current AI SDK file part for receipt images', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ amount: 1, items: [] }),
    })

    await run(scanReceiptDocument(image, groupCurrency, {}, imageDeps))

    const request = generateTextMock.mock.calls[0]?.[0] as {
      messages: Array<{
        content: Array<{
          type: string
          mediaType?: string
          data?: Uint8Array
          filename?: string
        }>
      }>
    }
    // Bytes are embedded server-side so the provider never fetches the
    // storage URL itself (S3/R2 origins fail the provider's robots.txt
    // check). The full content type travels through when known.
    expect(request.messages[1]?.content).toContainEqual({
      type: 'file',
      mediaType: 'image/jpeg',
      data: new TextEncoder().encode('fake-image-bytes'),
      filename: 'receipt.jpg',
    })
  })

  it('fails fast when the vision download is refused instead of passing the URL', async () => {
    // Regression for the production "robots.txt disallows fetching this URL"
    // failure: the vision call must never hand the storage URL to the
    // provider. A refused server-side download rejects the scan (with the
    // fetch reason) and never reaches generateText.
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ amount: 1 }) })

    await expect(
      run(scanReceiptDocument(image, groupCurrency, {}, { fetchOptions: {} })),
    ).rejects.toThrow()
    expect(generateTextMock).not.toHaveBeenCalled()
  })

  it('bounds the provider call with the configured timeout and no retries', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ amount: 1, items: [] }),
    })

    await run(scanReceiptDocument(image, groupCurrency, {}, imageDeps))

    const request = generateTextMock.mock.calls[0]?.[0] as {
      maxRetries?: number
      timeout?: number
    }
    expect(request.maxRetries).toBe(0)
    expect(request.timeout).toBe(120_000)
  })

  it('includes group, locale, and past-expense context as soft hints', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ amount: 1, items: [] }),
    })

    await run(
      scanReceiptDocument(
        image,
        groupCurrency,
        {
          locale: 'es',
          groupContext: {
            name: 'Madrid Trip',
            currency: '€',
            currencyCode: 'EUR',
          },
          recentExpenses: [{ title: 'Mercadona', categoryId: 'groceries' }],
        },
        imageDeps,
      ),
    )

    const request = generateTextMock.mock.calls[0]?.[0] as {
      messages: Array<{
        content: Array<{ type: string; text?: string }>
      }>
    }
    const prompt = request.messages[0]?.content.find(
      (part) => part.type === 'text',
    )?.text

    expect(prompt).toContain('Madrid Trip')
    expect(prompt).toContain('EUR')
    expect(prompt).toContain("user's app language is Español")
    expect(prompt).toContain('"Mercadona" -> groceries')
    expect(prompt).toContain('soft hints')
  })

  it('omits category and history hints in ocrOnly mode', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ amount: 1, items: [] }),
    })

    await run(
      scanReceiptDocument(
        image,
        groupCurrency,
        {
          ocrOnly: true,
          locale: 'es',
          groupContext: {
            name: 'Madrid Trip',
            currency: '€',
            currencyCode: 'EUR',
          },
          recentExpenses: [{ title: 'Mercadona', categoryId: 'groceries' }],
        },
        imageDeps,
      ),
    )

    const request = generateTextMock.mock.calls[0]?.[0] as {
      messages: Array<{
        content: Array<{ type: string; text?: string }>
      }>
    }
    const prompt = request.messages[0]?.content.find(
      (part) => part.type === 'text',
    )?.text

    expect(prompt).not.toContain('categoryId')
    expect(prompt).not.toContain('Madrid Trip')
    expect(prompt).not.toContain('"Mercadona" -> groceries')
    expect(prompt).not.toContain('Past expenses in this group')
    // OCR-relevant hints stay: locale, group currency, line items.
    expect(prompt).toContain("user's app language is Español")
    expect(prompt).toContain('USD')
    expect(prompt).toContain('unitPrice')
    expect(prompt).toMatch(/items/i)
  })

  it('returns a null category in ocrOnly mode even when the model returns one', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        amount: 1850,
        categoryId: 'groceries',
        currencyCode: 'USD',
        date: '2025-01-02',
        title: 'Corner Market',
        items: [{ title: 'Apples', unitPrice: 250, quantity: 2000 }],
      }),
    })

    const result = await run(
      scanReceiptDocument(image, groupCurrency, { ocrOnly: true }, imageDeps),
    )

    expect(result).toMatchObject({
      amount: 1850,
      categoryId: null,
      title: 'Corner Market',
    })
  })

  it('adds a forced-translation instruction naming the language when enabled', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ amount: 1, items: [] }),
    })

    await run(
      scanReceiptDocument(
        image,
        groupCurrency,
        {
          locale: 'es',
          translateToLocale: true,
        },
        imageDeps,
      ),
    )

    const request = generateTextMock.mock.calls[0]?.[0] as {
      messages: Array<{
        content: Array<{ type: string; text?: string }>
      }>
    }
    const prompt = request.messages[0]?.content.find(
      (part) => part.type === 'text',
    )?.text

    expect(prompt).toContain('Translate the returned expense title')
    expect(prompt).toContain('Español')
    expect(prompt).toContain('every item title')
  })

  it('classifies empty results without currency signal', () => {
    expect(
      isEmptyReceiptResult({ amount: NaN, title: null, date: null, items: [] }),
    ).toBe(true)
    expect(
      isEmptyReceiptResult({
        amount: 1000,
        title: null,
        date: null,
        items: [],
      }),
    ).toBe(false)
    expect(
      isEmptyReceiptResult({
        amount: NaN,
        title: 'Corner Market',
        date: null,
        items: [],
      }),
    ).toBe(false)
  })
})

describe('structureDocumentText', () => {
  it('structures text with a text-only call and no category', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        amount: 1850,
        categoryId: 'groceries',
        currencyCode: 'USD',
        date: '2025-01-02',
        title: 'Corner Market',
        items: [{ title: 'Apples', unitPrice: 250, quantity: 2000 }],
      }),
    })

    const result = await run(
      structureDocumentText(
        'Corner Market\nApples 2 x 2.50\nTotal 18.50',
        groupCurrency,
      ),
    )

    expect(result).toMatchObject({
      amount: 1850,
      categoryId: null,
      currencyCode: 'USD',
      date: '2025-01-02',
      title: 'Corner Market',
      empty: false,
      ocrUsed: true,
    })
    const request = generateTextMock.mock.calls[0]?.[0] as {
      prompt?: string
      temperature?: number
    }
    expect(request.prompt).toContain('Corner Market')
    expect(request.temperature).toBe(0.1)
  })

  it('skips the LLM call entirely when the text is blank', async () => {
    const result = await run(structureDocumentText('   \n  ', groupCurrency))

    expect(generateTextMock).not.toHaveBeenCalled()
    expect(result.empty).toBe(true)
    expect(result.ocrUsed).toBe(true)
    expect(result.amount).toBeNaN()
    expect(result.currencyCode).toBe('USD')
  })

  it('frames native text as document text and OCR text as OCR output', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ amount: 1, items: [] }),
    })

    await run(structureDocumentText('Corner Market Total 18.50', groupCurrency))
    const nativeRequest = generateTextMock.mock.calls[0]?.[0] as {
      prompt?: string
    }
    expect(nativeRequest.prompt).toContain('extracted from a receipt document')
    expect(nativeRequest.prompt).not.toContain('misread characters')

    generateTextMock.mockClear()
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ amount: 1, items: [] }),
    })

    await run(structureOcrText('Corner Market Total 18.50', groupCurrency))
    const ocrRequest = generateTextMock.mock.calls[0]?.[0] as {
      prompt?: string
    }
    expect(ocrRequest.prompt).toContain('extracted from a receipt by OCR')
    expect(ocrRequest.prompt).toContain('misread characters')
    // OCR-only caution: digit confusion with arithmetic reconciliation.
    expect(ocrRequest.prompt).toContain('0/8')
    expect(ocrRequest.prompt).toContain(
      'quantity × minor-unit unitPrice ÷ 1000',
    )
  })
})

describe('scanReceiptDocument document flow', () => {
  const pdfHost = 'files.example.test'
  const pdfSource = {
    url: `https://${pdfHost}/invoice.pdf`,
    contentType: 'application/pdf',
    fileName: 'invoice.pdf',
  }

  function mockPdfDownload() {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        new TextEncoder().encode(MINIMAL_PDF).buffer as ArrayBuffer,
    })
  }

  it('structures native PDF text without OCR or vision calls', async () => {
    mockPdfDownload()
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        amount: 1850,
        currencyCode: 'USD',
        date: '2025-01-02',
        title: 'Corner Market',
        items: [{ title: 'Apples', unitPrice: 250, quantity: 2000 }],
      }),
    })

    const result = await run(
      scanReceiptDocument(
        pdfSource,
        groupCurrency,
        {},
        {
          ocr: fakeOcr('should not be used'),
          fetchOptions: { allowedHosts: [pdfHost] },
        },
      ),
    )

    expect(result).toMatchObject({
      amount: 1850,
      title: 'Corner Market',
      categoryId: null,
      ocrUsed: true,
      empty: false,
    })
    // Text-only structuring: no file part in the LLM request.
    const request = generateTextMock.mock.calls[0]?.[0] as {
      messages?: unknown
      prompt?: string
    }
    expect(request.messages).toBeUndefined()
    expect(request.prompt).toContain('Corner Market')
  })

  it('falls back to the OCR provider for scanned-image PDFs', async () => {
    // Native extraction finds no text layer (blank PDF text).
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode('no pdf here').buffer,
    })
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        amount: 1850,
        currencyCode: 'USD',
        date: '2025-01-02',
        title: 'Corner Market',
        items: [],
      }),
    })
    const ocr = fakeOcr('Corner Market\nTotal 18.50')
    const extractSpy = vi.spyOn(ocr, 'extractText')

    const result = await run(
      scanReceiptDocument(
        pdfSource,
        groupCurrency,
        {},
        {
          ocr,
          fetchOptions: { allowedHosts: [pdfHost] },
        },
      ),
    )

    expect(result).toMatchObject({
      title: 'Corner Market',
      ocrUsed: true,
    })
    expect(extractSpy).toHaveBeenCalledWith(
      pdfSource.url,
      expect.objectContaining({ timeoutMs: 30_000 }),
    )
  })

  it('falls back to vision with a PDF file part when OCR fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode('no pdf here').buffer,
    })
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        amount: 1000,
        categoryId: 'groceries',
        currencyCode: 'USD',
        date: '2025-01-02',
        title: 'Fallback Market',
        items: [],
      }),
    })

    const result = await run(
      scanReceiptDocument(
        pdfSource,
        groupCurrency,
        {},
        {
          ocr: failingOcr(),
          fetchOptions: { allowedHosts: [pdfHost] },
        },
      ),
    )

    expect(result).toMatchObject({
      title: 'Fallback Market',
      categoryId: 'groceries',
      ocrUsed: false,
    })
    const request = generateTextMock.mock.calls[0]?.[0] as {
      messages: Array<{
        content: Array<{
          type: string
          mediaType?: string
          data?: Uint8Array
          filename?: string
        }>
      }>
    }
    expect(request.messages[1]?.content).toContainEqual({
      type: 'file',
      mediaType: 'application/pdf',
      data: new TextEncoder().encode('fake-image-bytes'),
      filename: 'invoice.pdf',
    })
  })

  it('throws instead of falling back when AI_OCR_REQUIRED is set', async () => {
    mockedEnv.AI_OCR_REQUIRED = true
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode('no pdf here').buffer,
    })

    await expect(
      run(
        scanReceiptDocument(
          pdfSource,
          groupCurrency,
          {},
          {
            ocr: failingOcr(),
            fetchOptions: { allowedHosts: [pdfHost] },
          },
        ),
      ),
    ).rejects.toThrow('OCR down')
    expect(generateTextMock).not.toHaveBeenCalled()
  })

  it('returns an empty result for text documents without usable text', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        new TextEncoder().encode('### $$$ %%%').buffer as ArrayBuffer,
    })

    const result = await run(
      scanReceiptDocument(
        {
          url: `https://${pdfHost}/notes.txt`,
          contentType: 'text/plain',
          fileName: 'notes.txt',
        },
        groupCurrency,
        {},
        {
          ocr: fakeOcr('should not be used'),
          fetchOptions: { allowedHosts: [pdfHost] },
        },
      ),
    )

    expect(result.empty).toBe(true)
    expect(result.ocrUsed).toBe(false)
    expect(generateTextMock).not.toHaveBeenCalled()
  })

  it('skips AI entirely for unsupported documents', async () => {
    const result = await run(
      scanReceiptDocument(
        {
          url: `https://${pdfHost}/legacy.doc`,
          contentType: 'application/msword',
          fileName: 'legacy.doc',
        },
        groupCurrency,
      ),
    )

    expect(result.empty).toBe(true)
    expect(generateTextMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
