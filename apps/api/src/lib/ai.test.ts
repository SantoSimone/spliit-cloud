import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createAnthropic: vi.fn(),
  createGoogle: vi.fn(),
  createOpenAI: vi.fn(),
  createOpenAICompatible: vi.fn(),
}))

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: mocks.createAnthropic,
}))
vi.mock('@ai-sdk/google', () => ({
  createGoogle: mocks.createGoogle,
}))
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mocks.createOpenAI,
}))
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mocks.createOpenAICompatible,
}))

const GO_CHAT_URL = 'https://opencode.ai/zen/go/v1/chat/completions'
const GO_RESPONSES_URL = 'https://opencode.ai/zen/go/v1/responses'
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('isOpenCodeGoEndpoint', () => {
  it('matches Go endpoint URLs strictly', async () => {
    const { isOpenCodeGoEndpoint } = await import('./ai')
    expect(isOpenCodeGoEndpoint(GO_CHAT_URL)).toBe(true)
    expect(isOpenCodeGoEndpoint(GO_RESPONSES_URL)).toBe(true)
    expect(isOpenCodeGoEndpoint('https://opencode.ai/zen/go/v1/messages')).toBe(
      true,
    )
  })

  it('rejects non-Go URLs', async () => {
    const { isOpenCodeGoEndpoint } = await import('./ai')
    expect(isOpenCodeGoEndpoint(undefined)).toBe(false)
    expect(isOpenCodeGoEndpoint('')).toBe(false)
    expect(isOpenCodeGoEndpoint('https://api.openai.com/v1')).toBe(false)
    expect(isOpenCodeGoEndpoint('https://openrouter.ai/api/v1')).toBe(false)
    expect(isOpenCodeGoEndpoint('https://opencode.ai/zen')).toBe(false)
    expect(isOpenCodeGoEndpoint('https://opencode.ai/')).toBe(false)
    expect(isOpenCodeGoEndpoint('https://example.com/opencode')).toBe(false)
  })
})

describe('getOpenCodeGoHeaders', () => {
  it('returns a stable x-opencode-session header on the Go endpoint', async () => {
    const { env } = await import('./env')
    const { getOpenCodeGoHeaders } = await import('./ai')
    const original = env.AI_BASE_URL
    try {
      env.AI_BASE_URL = GO_CHAT_URL
      const first = getOpenCodeGoHeaders()
      const second = getOpenCodeGoHeaders()
      expect(first['x-opencode-session']).toMatch(UUID_RE)
      expect(second['x-opencode-session']).toBe(first['x-opencode-session'])
    } finally {
      env.AI_BASE_URL = original
    }
  })

  it('returns no headers off the Go endpoint', async () => {
    const { env } = await import('./env')
    const { getOpenCodeGoHeaders } = await import('./ai')
    const original = env.AI_BASE_URL
    try {
      env.AI_BASE_URL = 'https://openrouter.ai/api/v1'
      expect(getOpenCodeGoHeaders()).toEqual({})
      env.AI_BASE_URL = undefined
      expect(getOpenCodeGoHeaders()).toEqual({})
    } finally {
      env.AI_BASE_URL = original
    }
  })
})

describe('purpose model resolution', () => {
  const PURPOSE_KEYS = [
    'AI_PROVIDER',
    'AI_API_KEY',
    'AI_BASE_URL',
    'AI_RECEIPT_PROVIDER',
    'AI_RECEIPT_API_KEY',
    'AI_RECEIPT_BASE_URL',
    'AI_CATEGORY_PROVIDER',
    'AI_CATEGORY_API_KEY',
    'AI_CATEGORY_BASE_URL',
    'AI_VOICE_PROVIDER',
    'AI_VOICE_API_KEY',
    'AI_VOICE_BASE_URL',
    'AI_VOICE_MODEL',
    'AI_RECEIPT_MODEL',
    'AI_CATEGORY_MODEL',
  ] as const

  const saved = new Map<string, unknown>()

  const BASELINE = {
    AI_PROVIDER: 'openai-compatible',
    AI_API_KEY: 'test-key',
    AI_BASE_URL: 'https://example.com/v1',
    AI_RECEIPT_PROVIDER: undefined,
    AI_RECEIPT_API_KEY: undefined,
    AI_RECEIPT_BASE_URL: undefined,
    AI_CATEGORY_PROVIDER: undefined,
    AI_CATEGORY_API_KEY: undefined,
    AI_CATEGORY_BASE_URL: undefined,
    AI_VOICE_PROVIDER: undefined,
    AI_VOICE_API_KEY: undefined,
    AI_VOICE_BASE_URL: undefined,
    AI_VOICE_MODEL: 'test-voice-model',
    AI_RECEIPT_MODEL: 'gpt-5-nano',
    AI_CATEGORY_MODEL: 'gpt-5-nano',
  } as const

  async function setEnv(values: Record<string, unknown>) {
    const { env } = await import('./env')
    Object.assign(env, values)
  }

  /** Fresh module registry with the baseline env re-applied. */
  async function freshBaseline() {
    vi.resetModules()
    Object.values(mocks).forEach((fn) => fn.mockReset())
    await setEnv({ ...BASELINE })
  }

  function mockFactory(
    provider: 'anthropic' | 'google' | 'openai' | 'openai-compatible',
  ) {
    if (provider === 'openai') {
      const chat = vi.fn((id: string) => ({ id }))
      const responses = vi.fn((id: string) => ({ id }))
      mocks.createOpenAI.mockReturnValue({ chat, responses })
      return { chat, responses }
    }
    const factory =
      provider === 'anthropic'
        ? mocks.createAnthropic
        : provider === 'google'
          ? mocks.createGoogle
          : mocks.createOpenAICompatible
    const fn = vi.fn((id: string) => ({ id }))
    factory.mockReturnValue(fn)
    return { fn }
  }

  function factoryArgs(
    provider: 'anthropic' | 'google' | 'openai' | 'openai-compatible',
  ) {
    const factory =
      provider === 'anthropic'
        ? mocks.createAnthropic
        : provider === 'google'
          ? mocks.createGoogle
          : provider === 'openai'
            ? mocks.createOpenAI
            : mocks.createOpenAICompatible
    return factory.mock.calls[0]?.[0] as
      | { apiKey?: unknown; baseURL?: unknown; headers?: unknown }
      | undefined
  }

  beforeEach(async () => {
    const { env } = await import('./env')
    if (saved.size === 0) {
      for (const key of PURPOSE_KEYS) {
        saved.set(key, (env as Record<string, unknown>)[key])
      }
    }
    Object.values(mocks).forEach((fn) => fn.mockReset())
    await setEnv({ ...BASELINE })
  })

  afterEach(async () => {
    const { env } = await import('./env')
    for (const key of PURPOSE_KEYS) {
      ;(env as Record<string, unknown>)[key] = saved.get(key)
    }
  })

  it('resolves each purpose from the shared config when overrides are absent', async () => {
    for (const provider of [
      'anthropic',
      'google',
      'openai',
      'openai-compatible',
    ] as const) {
      await freshBaseline()
      await setEnv({
        AI_PROVIDER: provider,
        AI_BASE_URL: 'https://example.com/v1',
      })
      mockFactory(provider)
      const ai = await import('./ai')
      const model = await ai.getReceiptModel()
      expect(model).toEqual({ id: 'gpt-5-nano' })
      expect(factoryArgs(provider)).toMatchObject({
        apiKey: 'test-key',
        baseURL: 'https://example.com/v1',
      })
    }
  })

  it('prefers the per-purpose provider, endpoint, and key over the shared config', async () => {
    await freshBaseline()
    await setEnv({
      AI_PROVIDER: 'openai',
      AI_API_KEY: 'global-key',
      AI_BASE_URL: 'https://api.openai.com/v1',
      AI_RECEIPT_PROVIDER: 'openai-compatible',
      AI_RECEIPT_API_KEY: 'receipt-key',
      AI_RECEIPT_BASE_URL: GO_CHAT_URL,
    })
    mockFactory('openai-compatible')
    mockFactory('openai')
    const { getReceiptModel } = await import('./ai')
    const model = await getReceiptModel()
    expect(mocks.createOpenAICompatible).toHaveBeenCalledTimes(1)
    expect(mocks.createOpenAI).not.toHaveBeenCalled()
    expect(factoryArgs('openai-compatible')).toMatchObject({
      apiKey: 'receipt-key',
      baseURL: GO_CHAT_URL,
      headers: { 'x-opencode-session': expect.stringMatching(UUID_RE) },
    })
    expect(model).toEqual({ id: 'gpt-5-nano' })
  })

  it('sends the Go session header per resolved endpoint, not per global URL', async () => {
    await freshBaseline()
    await setEnv({
      AI_PROVIDER: 'openai-compatible',
      AI_BASE_URL: 'https://openrouter.ai/api/v1',
      AI_RECEIPT_BASE_URL: GO_CHAT_URL,
    })
    mockFactory('openai-compatible')
    const { getReceiptModel, getCategoryModel } = await import('./ai')
    await getReceiptModel()
    await getCategoryModel()
    const [receiptArgs, categoryArgs] =
      mocks.createOpenAICompatible.mock.calls.map(
        ([arg]) => arg as { headers?: Record<string, string> },
      )
    // Separate clients per distinct endpoint: the receipt client carries the
    // Go session header while the shared-config category client does not.
    expect(receiptArgs?.headers?.['x-opencode-session']).toMatch(UUID_RE)
    expect(categoryArgs?.headers ?? {}).toEqual({})
  })

  it('passes empty headers off the Go endpoint', async () => {
    await freshBaseline()
    mockFactory('openai-compatible')
    const { getReceiptModel } = await import('./ai')
    await getReceiptModel()
    expect(factoryArgs('openai-compatible')?.headers).toEqual({})
  })
})

describe('getVoiceModel audio routing', () => {
  async function freshVoiceBaseline() {
    vi.resetModules()
    Object.values(mocks).forEach((fn) => fn.mockReset())
    const { env } = await import('./env')
    Object.assign(env, {
      AI_PROVIDER: 'openai-compatible',
      AI_VOICE_PROVIDER: undefined,
      AI_VOICE_BASE_URL: undefined,
      AI_VOICE_API_KEY: undefined,
      AI_BASE_URL: 'https://example.com/v1',
      AI_API_KEY: 'test-key',
      AI_VOICE_MODEL: 'test-voice-model',
    })
  }

  beforeEach(async () => {
    await freshVoiceBaseline()
  })

  afterEach(async () => {
    const { env } = await import('./env')
    env.AI_PROVIDER = 'openai'
    env.AI_BASE_URL = undefined
    env.AI_API_KEY = undefined
    env.AI_VOICE_PROVIDER = undefined
    env.AI_VOICE_MODEL = undefined as never
  })

  it('routes the openai dialect through chat completions so audio file parts map to input_audio', async () => {
    await freshVoiceBaseline()
    const { env } = await import('./env')
    const chat = vi.fn((id: string) => ({ id }))
    const responses = vi.fn((id: string) => ({ id }))
    mocks.createOpenAI.mockReturnValue({ chat, responses })
    env.AI_PROVIDER = 'openai'
    env.AI_BASE_URL = 'https://api.openai.com/v1'
    const { getVoiceModel } = await import('./ai')
    const model = await getVoiceModel()
    expect(chat).toHaveBeenCalledTimes(1)
    expect(chat).toHaveBeenCalledWith('test-voice-model')
    expect(responses).not.toHaveBeenCalled()
    expect(model).toEqual({ id: 'test-voice-model' })
  })

  it('delegates non-openai dialects to the shared text-path client', async () => {
    for (const provider of [
      'anthropic',
      'google',
      'openai-compatible',
    ] as const) {
      await freshVoiceBaseline()
      const { env } = await import('./env')
      const factory =
        provider === 'anthropic'
          ? mocks.createAnthropic
          : provider === 'google'
            ? mocks.createGoogle
            : mocks.createOpenAICompatible
      factory.mockReturnValue((id: string) => ({ id }))
      env.AI_PROVIDER = provider
      const { getVoiceModel } = await import('./ai')
      const model = await getVoiceModel()
      expect(factory).toHaveBeenCalledTimes(1)
      expect(model).toEqual({ id: 'test-voice-model' })
    }
  })

  it('honors a per-purpose voice provider override', async () => {
    await freshVoiceBaseline()
    const { env } = await import('./env')
    mocks.createAnthropic.mockReturnValue((id: string) => ({ id }))
    env.AI_PROVIDER = 'openai'
    env.AI_VOICE_PROVIDER = 'anthropic'
    env.AI_BASE_URL = 'https://api.openai.com/v1'
    const { getVoiceModel } = await import('./ai')
    const model = await getVoiceModel()
    expect(mocks.createAnthropic).toHaveBeenCalledTimes(1)
    expect(mocks.createOpenAI).not.toHaveBeenCalled()
    expect(model).toEqual({ id: 'test-voice-model' })
  })
})

describe('resolveAiReasoning', () => {
  it('omits reasoning when neither the purpose nor the shared value is set', async () => {
    const { env } = await import('./env')
    const { resolveAiReasoning } = await import('./ai')
    const savedReasoning = env.AI_REASONING
    const savedReceipt = env.AI_RECEIPT_REASONING
    const savedCategory = env.AI_CATEGORY_REASONING
    const savedVoice = env.AI_VOICE_REASONING
    try {
      env.AI_REASONING = undefined
      env.AI_RECEIPT_REASONING = undefined
      env.AI_CATEGORY_REASONING = undefined
      env.AI_VOICE_REASONING = undefined
      expect(resolveAiReasoning('receipt')).toBeUndefined()
      expect(resolveAiReasoning('category')).toBeUndefined()
      expect(resolveAiReasoning('voice')).toBeUndefined()
    } finally {
      env.AI_REASONING = savedReasoning
      env.AI_RECEIPT_REASONING = savedReceipt
      env.AI_CATEGORY_REASONING = savedCategory
      env.AI_VOICE_REASONING = savedVoice
    }
  })

  it('falls back to the shared value and prefers the per-purpose override', async () => {
    const { env } = await import('./env')
    const { resolveAiReasoning } = await import('./ai')
    const savedReasoning = env.AI_REASONING
    const savedReceipt = env.AI_RECEIPT_REASONING
    try {
      env.AI_REASONING = 'low'
      env.AI_RECEIPT_REASONING = undefined
      expect(resolveAiReasoning('receipt')).toBe('low')
      expect(resolveAiReasoning('category')).toBe('low')
      env.AI_RECEIPT_REASONING = 'high'
      expect(resolveAiReasoning('receipt')).toBe('high')
      expect(resolveAiReasoning('category')).toBe('low')
    } finally {
      env.AI_REASONING = savedReasoning
      env.AI_RECEIPT_REASONING = savedReceipt
    }
  })
})
