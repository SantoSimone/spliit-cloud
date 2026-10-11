import { Effect } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../env', () => ({
  env: {
    AI_OCRSPACE_API_KEY: 'test-ocr-key',
  },
}))

const { OcrSpaceProvider } = await import('./ocrspace')
const { OcrError } = await import('./types')

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe('OcrSpaceProvider', () => {
  it('POSTs Engine 2 with language autodetect and returns the parsed text', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        ParsedResults: [{ ParsedText: 'Corner Market\r\nTotal 18.50' }],
        OCRExitCode: 1,
        IsErroredOnProcessing: false,
      }),
    )

    const result = await run(
      new OcrSpaceProvider().extractText('https://example.com/receipt.jpg', {
        timeoutMs: 30_000,
      }),
    )

    expect(result).toEqual({
      text: 'Corner Market\r\nTotal 18.50',
      engine: 'ocrspace-2',
    })
    const [endpoint, init] = fetchMock.mock.calls[0] as [
      string,
      { method?: string; headers?: Record<string, string>; body?: FormData },
    ]
    expect(endpoint).toBe('https://api.ocr.space/parse/image')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ apikey: 'test-ocr-key' })
    const form = init.body as FormData
    expect(form.get('OCREngine')).toBe('2')
    expect(form.get('language')).toBe('auto')
    expect(form.get('url')).toBe('https://example.com/receipt.jpg')
    expect(form.get('isOverlayRequired')).toBe('false')
    expect(form.get('isTable')).toBe('true')
    expect(form.get('filetype')).toBeNull()
  })

  it('sends filetype PDF for pdf documents', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        ParsedResults: [{ ParsedText: 'Invoice' }],
        OCRExitCode: 1,
        IsErroredOnProcessing: false,
      }),
    )

    await run(
      new OcrSpaceProvider().extractText('https://example.com/invoice.pdf', {
        timeoutMs: 30_000,
        contentType: 'application/pdf',
      }),
    )

    const [, init] = fetchMock.mock.calls[0] as [string, { body?: FormData }]
    expect((init.body as FormData).get('filetype')).toBe('PDF')
  })

  it('sends filetype PDF from the file-name fallback for generic content types', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        ParsedResults: [{ ParsedText: 'Invoice' }],
        OCRExitCode: 1,
        IsErroredOnProcessing: false,
      }),
    )

    await run(
      new OcrSpaceProvider().extractText('https://example.com/9f3a1c', {
        timeoutMs: 30_000,
        contentType: 'application/octet-stream',
        fileName: 'invoice.pdf',
      }),
    )

    const [, fallbackInit] = fetchMock.mock.calls[0] as [
      string,
      { body?: FormData },
    ]
    expect((fallbackInit.body as FormData).get('filetype')).toBe('PDF')
  })

  it('joins multi-page PDF results', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        ParsedResults: [
          { ParsedText: 'Page one' },
          { ParsedText: '' },
          { ParsedText: 'Page three' },
        ],
        OCRExitCode: 1,
        IsErroredOnProcessing: false,
      }),
    )

    const result = await run(
      new OcrSpaceProvider().extractText('https://example.com/scan.pdf', {
        timeoutMs: 30_000,
        contentType: 'application/pdf',
      }),
    )

    expect(result.text).toBe('Page one\nPage three')
  })

  it('returns empty text when nothing readable was found', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        ParsedResults: [{ ParsedText: '' }],
        OCRExitCode: 1,
        IsErroredOnProcessing: false,
      }),
    )

    const result = await run(
      new OcrSpaceProvider().extractText('https://example.com/blank.jpg', {
        timeoutMs: 30_000,
      }),
    )

    expect(result.text).toBe('')
  })

  it('marks quota errors as retryable so callers can fall back to vision', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        IsErroredOnProcessing: true,
        ErrorMessage: ['Max number of resouces exceeded. Limit 500 per day.'],
      }),
    )

    const error = await run(
      new OcrSpaceProvider()
        .extractText('https://example.com/receipt.jpg', {
          timeoutMs: 30_000,
        })
        .pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(OcrError)
    expect((error as InstanceType<typeof OcrError>).retryable).toBe(true)
  })

  it('marks per-file parse errors as non-retryable', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        ParsedResults: [{ ErrorMessage: 'File not found' }],
        IsErroredOnProcessing: false,
      }),
    )

    const error = await run(
      new OcrSpaceProvider()
        .extractText('https://example.com/missing.jpg', {
          timeoutMs: 30_000,
        })
        .pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(OcrError)
    expect((error as InstanceType<typeof OcrError>).retryable).toBe(false)
  })

  it('marks HTTP 429 as retryable and HTTP 401 as permanent', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'too many requests',
    })
    const rateLimited = await run(
      new OcrSpaceProvider()
        .extractText('https://example.com/receipt.jpg', {
          timeoutMs: 30_000,
        })
        .pipe(Effect.flip),
    )
    expect((rateLimited as InstanceType<typeof OcrError>).retryable).toBe(true)

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    })
    const unauthorized = await run(
      new OcrSpaceProvider()
        .extractText('https://example.com/receipt.jpg', {
          timeoutMs: 30_000,
        })
        .pipe(Effect.flip),
    )
    expect(unauthorized).toBeInstanceOf(OcrError)
    expect((unauthorized as InstanceType<typeof OcrError>).retryable).toBe(
      false,
    )
  })

  it('wraps network failures as retryable errors', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))

    const error = await run(
      new OcrSpaceProvider()
        .extractText('https://example.com/receipt.jpg', {
          timeoutMs: 30_000,
        })
        .pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(OcrError)
    expect((error as InstanceType<typeof OcrError>).retryable).toBe(true)
  })
})
