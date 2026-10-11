import { env } from '../env'
import { OcrSpaceProvider } from './ocrspace'
import type { OcrProvider } from './types'

export type { OcrExtractOptions, OcrProvider, OcrResult } from './types'
export { isOcrError, OcrError } from './types'

/**
 * Configured OCR backend, or null when OCR is disabled
 * (`AI_OCR_PROVIDER=none`). Callers fall back to the vision LLM on null.
 */
export function getOcrProvider(): OcrProvider | null {
  switch (env.AI_OCR_PROVIDER) {
    case 'ocrspace':
      return new OcrSpaceProvider()
    case 'none':
      return null
    default:
      return null
  }
}
