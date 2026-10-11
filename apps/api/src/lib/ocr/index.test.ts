import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as envModule from '../env'

const envState = vi.hoisted(() => ({
  AI_OCR_PROVIDER: 'none' as 'none' | 'ocrspace',
  AI_OCRSPACE_API_KEY: 'test-ocr-key',
}))

vi.mock('../env', async (importOriginal) => {
  const actual = await (importOriginal as () => Promise<typeof envModule>)()
  const mockedEnv = { ...actual.env }
  for (const key of Object.keys(envState) as (keyof typeof envState)[]) {
    Object.defineProperty(mockedEnv, key, {
      enumerable: true,
      configurable: true,
      get: () => envState[key],
    })
  }
  return {
    ...actual,
    env: mockedEnv,
  }
})

const { getOcrProvider } = await import('./index')

beforeEach(() => {
  envState.AI_OCR_PROVIDER = 'none'
})

describe('getOcrProvider', () => {
  it('returns null when OCR is disabled', () => {
    expect(getOcrProvider()).toBeNull()
  })

  it('returns the OCR.space adapter when configured', () => {
    envState.AI_OCR_PROVIDER = 'ocrspace'
    expect(getOcrProvider()?.name).toBe('ocrspace')
  })
})
