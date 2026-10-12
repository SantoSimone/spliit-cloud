import { describe, expect, it, vi } from 'vitest'

import type * as SpansModule from './ai-effects/spans'

vi.mock('ai', () => ({
  Output: { json: vi.fn(() => ({ type: 'json' })) },
  generateText: vi.fn(),
}))
vi.mock('./ai', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getVoiceModel: vi.fn(async () => ({ modelId: 'test' })),
}))

const tracingState = vi.hoisted(() => ({
  current: null as null | {
    spans: Array<{ name: string; attributes: Record<string, unknown> }>
  },
}))

vi.mock('./ai-effects/spans', async (importOriginal) => {
  const actual = await importOriginal<SpansModule>()
  return {
    ...actual,
    createRequestTracing: () => {
      const tracing = actual.createRequestTracing()
      tracingState.current = tracing
      return tracing
    },
  }
})
vi.stubEnv('AI_VOICE_MODEL', 'test-voice-model')

const { generateText } = await import('ai')
const { buildAudioExpensePromptForTest, extractExpenseInformationFromAudio } =
  await import('./audio-expense')

const generateTextMock = vi.mocked(generateText)

const group = {
  id: 'group-1',
  name: 'Trip',
  currency: '$',
  currencyCode: 'USD',
}

describe('audio expense extraction', () => {
  it('includes current-group context without asking the model to choose a destination', () => {
    const prompt = buildAudioExpensePromptForTest({
      audioDataUrl: 'data:audio/wav;base64,AAAA',
      locale: 'en-US',
      group,
      participants: [{ id: 'p-1', name: 'Alex' }],
    })

    expect(prompt).toContain('"name":"Trip"')
    expect(prompt).toContain('"currencyCode":"USD"')
    expect(prompt).toContain('Alex')
    expect(prompt).not.toContain(group.id)
    expect(prompt).toContain('Do not ask for, infer, or return a group ID')
    expect(prompt).toContain('normal writing system and orthography')
  })

  it('normalizes a known-group response and creates typed issues', async () => {
    generateTextMock.mockResolvedValue({
      output: {
        transcript: 'Ajoutez une pizza pour dix euros',
        title: 'Pizza',
        amount: '10',
        currencyCode: 'EUR',
        date: '2026-01-01',
        categoryId: 'food-and-drink',
        payerParticipantId: 'p-1',
        participantIds: ['p-1', 'p-1', 'unknown'],
        languageCode: 'fr',
        languageConfidence: 'high',
      },
    } as never)

    const result = await extractExpenseInformationFromAudio({
      audioDataUrl: 'data:audio/wav;base64,AAAA',
      group,
      participants: [{ id: 'p-1', name: 'Alex' }],
    })

    expect(result).toMatchObject({
      groupId: group.id,
      title: 'Pizza',
      amount: '10',
      currencyCode: 'EUR',
      payerParticipantId: 'p-1',
      participantIds: ['p-1'],
      issues: [],
    })
  })

  it('keeps valid fields when the model returns malformed optional values', async () => {
    generateTextMock.mockResolvedValue({
      output: {
        title: 'Coffee',
        amount: '4.5',
        participantIds: null,
        languageConfidence: 'very-high',
      },
    } as never)

    const result = await extractExpenseInformationFromAudio({
      audioDataUrl: 'data:audio/wav;base64,AAAA',
      group,
      participants: [],
    })

    expect(result).toMatchObject({
      title: 'Coffee',
      amount: '4.5',
      issues: [],
    })
  })

  it('preserves an unsupported spoken currency for the full form', async () => {
    generateTextMock.mockResolvedValue({
      output: {
        title: 'Coffee',
        amount: '4.5',
        currencyCode: 'XYZ',
      },
    } as never)

    const result = await extractExpenseInformationFromAudio({
      audioDataUrl: 'data:audio/wav;base64,AAAA',
      group,
      participants: [],
    })

    expect(result.currencyCode).toBe('XYZ')
    expect(result.issues).toEqual(['unsupportedCurrency'])
  })

  it('routes voice extraction through the audio-capable chat model client', async () => {
    const { getVoiceModel } = await import('./ai')
    generateTextMock.mockResolvedValue({ output: {} } as never)

    await extractExpenseInformationFromAudio({
      audioDataUrl: 'data:audio/wav;base64,AAAA',
      group,
      participants: [],
    })

    expect(vi.mocked(getVoiceModel)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(getVoiceModel)).toHaveBeenCalledWith()
  })

  it('omits reasoning when unconfigured and passes through the configured effort', async () => {
    const { env } = await import('./env')
    const input = {
      audioDataUrl: 'data:audio/wav;base64,AAAA',
      group,
      participants: [],
    }
    type ReasoningRequest = { reasoning?: unknown }
    const reasoningOf = () =>
      generateTextMock.mock.calls[0]?.[0] as ReasoningRequest
    generateTextMock.mockResolvedValue({ output: {} } as never)

    await extractExpenseInformationFromAudio(input)
    expect(reasoningOf().reasoning).toBeUndefined()

    generateTextMock.mockClear()
    const original = env.AI_REASONING
    env.AI_REASONING = 'low'
    try {
      await extractExpenseInformationFromAudio(input)
      expect(reasoningOf().reasoning).toBe('low')
    } finally {
      env.AI_REASONING = original
    }
  })

  it('bounds the provider call with the configured timeout and no retries', async () => {
    generateTextMock.mockResolvedValue({ output: {} } as never)

    await extractExpenseInformationFromAudio({
      audioDataUrl: 'data:audio/wav;base64,AAAA',
      group,
      participants: [],
    })

    const request = generateTextMock.mock.calls[0]?.[0] as {
      maxRetries?: number
      timeout?: number
    }
    expect(request.maxRetries).toBe(0)
    expect(request.timeout).toBe(120_000)
  })
})

describe('voice extraction tracing', () => {
  it('profiles the transcription step with model and token attributes', async () => {
    tracingState.current = null
    generateTextMock.mockResolvedValue({
      output: {
        title: 'Apples',
        amount: '2.5',
        currencyCode: 'USD',
        date: '2025-01-02',
      },
      usage: { inputTokens: 900, outputTokens: 120 },
    } as never)

    const result = await extractExpenseInformationFromAudio({
      audioDataUrl: 'data:audio/wav;base64,AAAA',
      group,
      participants: [],
    })

    expect(result.title).toBe('Apples')
    const spans = tracingState.current?.spans ?? []
    expect(spans.map((span) => span.name)).toEqual([
      'voice.transcribe-structure',
      'voice.expense',
    ])
    expect(
      spans.find((span) => span.name === 'voice.transcribe-structure')
        ?.attributes,
    ).toMatchObject({
      'llm.model': 'test-voice-model',
      'llm.usage.input_tokens': 900,
      'llm.usage.output_tokens': 120,
    })
  })
})
