import { randomUUID } from 'node:crypto'

import { env, type Env } from './env'

export type AiPurpose = 'receipt' | 'category' | 'voice'

type ResolvedAiConfig = {
  provider: Env['AI_PROVIDER']
  apiKey: string | undefined
  baseURL: string | undefined
  model: string | undefined
}

/**
 * Resolve the wire config for one AI purpose. Provider, endpoint, and key each
 * fall back to the shared `AI_PROVIDER` / `AI_BASE_URL` / `AI_API_KEY` when the
 * per-purpose override is unset, so a single-provider setup keeps working
 * untouched while mixed setups (e.g. a gateway serving `/responses` for one
 * model and `/chat/completions` for another) can point each purpose at the
 * matching wire for its provider dialect.
 */
function resolveAiConfig(purpose: AiPurpose): ResolvedAiConfig {
  switch (purpose) {
    case 'receipt':
      return {
        provider: env.AI_RECEIPT_PROVIDER ?? env.AI_PROVIDER,
        apiKey: env.AI_RECEIPT_API_KEY ?? env.AI_API_KEY,
        baseURL: env.AI_RECEIPT_BASE_URL ?? env.AI_BASE_URL,
        model: env.AI_RECEIPT_MODEL,
      }
    case 'category':
      return {
        provider: env.AI_CATEGORY_PROVIDER ?? env.AI_PROVIDER,
        apiKey: env.AI_CATEGORY_API_KEY ?? env.AI_API_KEY,
        baseURL: env.AI_CATEGORY_BASE_URL ?? env.AI_BASE_URL,
        model: env.AI_CATEGORY_MODEL,
      }
    case 'voice':
      return {
        provider: env.AI_VOICE_PROVIDER ?? env.AI_PROVIDER,
        apiKey: env.AI_VOICE_API_KEY ?? env.AI_API_KEY,
        baseURL: env.AI_VOICE_BASE_URL ?? env.AI_BASE_URL,
        model: env.AI_VOICE_MODEL,
      }
  }
}

/**
 * Resolve the portable reasoning effort for one AI purpose. The per-purpose
 * override wins, then the shared `AI_REASONING`; when both are unset the result
 * is `undefined` so callers omit the parameter and the provider decides (safest
 * for models without reasoning support).
 */
export function resolveAiReasoning(purpose: AiPurpose) {
  switch (purpose) {
    case 'receipt':
      return env.AI_RECEIPT_REASONING ?? env.AI_REASONING
    case 'category':
      return env.AI_CATEGORY_REASONING ?? env.AI_REASONING
    case 'voice':
      return env.AI_VOICE_REASONING ?? env.AI_REASONING
  }
}

// Stable per-process session ID for the OpenCode Go endpoint
// (https://opencode.ai/docs/go/#where-can-i-use-it). Go rejects requests
// missing `x-opencode-session` because they cannot be routed efficiently.
const openCodeSessionId = randomUUID()

export function isOpenCodeGoEndpoint(baseURL?: string): boolean {
  return !!baseURL && baseURL.includes('opencode.ai/zen/go')
}

export function getOpenCodeGoHeaders(
  baseURL: string | undefined = env.AI_BASE_URL,
): Record<string, string> {
  return isOpenCodeGoEndpoint(baseURL)
    ? { 'x-opencode-session': openCodeSessionId }
    : {}
}

// Provider clients cached per resolved wire config: purposes sharing the
// same provider/endpoint/key reuse one instance, while mixed setups get one
// client per distinct config (a single cached `openai-compatible` instance
// can no longer cover multiple base URLs).
const clientCache = new Map<string, unknown>()

function cacheKey(config: Omit<ResolvedAiConfig, 'model'>): string {
  return `${config.provider}|${config.baseURL ?? ''}|${config.apiKey ?? ''}`
}

function cachedClient<T>(key: string, create: () => T): T {
  let client = clientCache.get(key) as T | undefined
  client ??= create()
  clientCache.set(key, client)
  return client
}

async function getPurposeModel(purpose: AiPurpose, chatApi = false) {
  const config = resolveAiConfig(purpose)
  const headers = getOpenCodeGoHeaders(config.baseURL)
  const key = `${cacheKey(config)}|${chatApi ? 'chat' : 'default'}`
  switch (config.provider) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic')
      const client = cachedClient(key, () =>
        createAnthropic({
          apiKey: config.apiKey,
          baseURL: config.baseURL,
          headers,
        }),
      )
      return client(config.model!)
    }
    case 'google': {
      const { createGoogle } = await import('@ai-sdk/google')
      const client = cachedClient(key, () =>
        createGoogle({
          apiKey: config.apiKey,
          baseURL: config.baseURL,
          headers,
        }),
      )
      return client(config.model!)
    }
    case 'openai-compatible': {
      const { createOpenAICompatible } =
        await import('@ai-sdk/openai-compatible')
      const client = cachedClient(key, () =>
        createOpenAICompatible({
          name: 'configured-ai-provider',
          apiKey: config.apiKey,
          baseURL: config.baseURL ?? 'https://api.openai.com/v1',
          headers,
        }),
      )
      return client(config.model!)
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai')
      const client = cachedClient(key, () =>
        createOpenAI({
          apiKey: config.apiKey,
          baseURL: config.baseURL,
          headers,
        }),
      )
      return chatApi
        ? client.chat(config.model!)
        : client.responses(config.model!)
    }
  }
}

/** Text/vision model for receipt extraction (structure + vision calls). */
export async function getReceiptModel() {
  return getPurposeModel('receipt')
}

/** Text model for title → category verdicts. */
export async function getCategoryModel() {
  return getPurposeModel('category')
}

/**
 * Audio-input (voice) model. The OpenAI Responses API prompt converter rejects
 * audio file parts (`file part media type audio/wav`). Chat Completions maps
 * them to `input_audio` instead, so the voice expense path must go through
 * `openai.chat` when the resolved dialect is `openai`. Other dialects share the
 * text-path client.
 */
export async function getVoiceModel() {
  if ((env.AI_VOICE_PROVIDER ?? env.AI_PROVIDER) !== 'openai') {
    return getPurposeModel('voice')
  }
  return getPurposeModel('voice', true)
}
