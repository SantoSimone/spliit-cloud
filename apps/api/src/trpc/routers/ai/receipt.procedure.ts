import { TRPCError } from '@trpc/server'
import { Effect } from 'effect'
import { z } from 'zod'

import { categoryIdSchema } from '@spliit/domain'

import { getRecentExpenseContext } from '../../../lib/ai/context'
import { isTimeoutError } from '../../../lib/ai/timeout'
import { suggestExpenseCategory } from '../../../lib/api/expenses/suggest-category'
import type { DocumentSource } from '../../../lib/documents/types'
import { env } from '../../../lib/env'
import { getOcrProvider, isOcrError } from '../../../lib/ocr'
import { scanReceiptDocument } from '../../../lib/scan/pipeline'
import type { ReceiptExtractedResult } from '../../../lib/scan/types'
import {
  enforceAiRequestLimit,
  loadGroupMutationContext,
  protectedProcedure,
} from '../../init'
import { extractExpenseInformationOutputSchema } from '../../outputs/ai'

export const extractExpenseInformationFromImageProcedure = protectedProcedure
  .input(
    z.object({
      documentUrl: z.url(),
      contentType: z.string().nullish(),
      fileName: z.string().nullish(),
      currency: z.string(),
      currencyCode: z.string().nullish(),
      groupId: z.string().min(1),
      locale: z.string().optional(),
      translateToLocale: z.boolean().optional().default(false),
      currentExpense: z
        .object({
          title: z.string().optional(),
          amount: z.number().optional(),
          date: z.string().optional(),
          currencyCode: z.string().optional(),
          categoryId: z.string().optional(),
          items: z
            .array(
              z.object({
                title: z.string(),
                unitPrice: z.number(),
                quantity: z.number(),
              }),
            )
            .optional(),
        })
        .optional()
        .describe(
          'Existing expense fields to refine the extraction (optional context for the AI).',
        ),
    }),
  )
  .output(extractExpenseInformationOutputSchema)
  .mutation(async ({ input, ctx }) => {
    if (!env.PUBLIC_ENABLE_RECEIPT_EXTRACT) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Receipt extraction is disabled',
      })
    }
    await loadGroupMutationContext({
      groupId: input.groupId,
      accountId: ctx.auth.user.id,
    })
    // Fast path: OCR-only vision call (no expense history in the prompt),
    // then the System One decision model categorizes the extracted title plus
    // receipt line items. Only when the decision-model engine is configured;
    // the LLM engine keeps the single joint vision call below. A dedicated
    // OCR provider (`AI_OCR_PROVIDER`) always takes the separate path: its
    // structuring step returns no category, so `suggestExpenseCategory` (which
    // itself picks the configured engine) fills it in. Native document text
    // (PDF text layer, office files) behaves like the OCR path: structured
    // text with no category, suggest step fills it in.
    const useSeparateCategorization =
      env.AI_CATEGORY_ENGINE === 'system-one' &&
      env.PUBLIC_ENABLE_CATEGORY_EXTRACT
    const ocrConfigured = getOcrProvider() !== null
    const context =
      useSeparateCategorization || ocrConfigured
        ? undefined
        : await getRecentExpenseContext(input.groupId)
    enforceAiRequestLimit(
      ctx.auth.user.id,
      'ai.extractExpenseInformationFromImage',
      ctx.resHeaders,
    )

    const source: DocumentSource = {
      url: input.documentUrl,
      contentType: input.contentType,
      fileName: input.fileName,
    }
    let result: Awaited<ReturnType<typeof runScan>>
    try {
      result = await runScan(
        source,
        {
          currency: input.currency,
          currencyCode: input.currencyCode,
        },
        useSeparateCategorization
          ? {
              ocrOnly: true,
              locale: input.locale,
              translateToLocale: input.translateToLocale,
              currentExpense: input.currentExpense,
            }
          : {
              // `context` is undefined on the dedicated OCR path (no history
              // needed there); the vision fallback then runs without history
              // hints, which is an acceptable degradation for that rare path.
              recentExpenses: context?.expenses ?? [],
              groupContext: context?.group,
              locale: input.locale,
              translateToLocale: input.translateToLocale,
              currentExpense: input.currentExpense,
            },
      )
    } catch (error) {
      if (isTimeoutError(error)) {
        // Name the stage that timed out: the dedicated OCR step has its own
        // (shorter) budget, everything else uses the receipt model budget.
        const seconds = isOcrError(error)
          ? env.AI_OCRSPACE_TIMEOUT_SECONDS
          : env.AI_RECEIPT_TIMEOUT_SECONDS
        throw new TRPCError({
          code: 'TIMEOUT',
          message: `Receipt scanning failed due to timeout after ${seconds}s`,
        })
      }
      throw error
    }

    let categoryId: string | null = result.categoryId
    // Structured-text paths (dedicated OCR, native document text) never
    // return a category (same as `ocrOnly` vision mode), so they always go
    // through the separate suggestion step when category extraction is on —
    // regardless of the configured engine or whether an OCR provider is set.
    const separateCategorization =
      useSeparateCategorization ||
      (result.ocrUsed && env.PUBLIC_ENABLE_CATEGORY_EXTRACT)
    if (separateCategorization && result.title) {
      // Best-effort: text data is complete without a category, so a failed
      // suggestion degrades to null instead of failing the whole scan.
      try {
        const suggestion = await suggestExpenseCategory({
          groupId: input.groupId,
          title: result.title,
          locale: input.locale,
          allowAi: true,
          receiptItems: result.items.map((item) => item.title),
          receiptCurrencyCode: result.currencyCode,
        })
        categoryId = suggestion.categoryId
      } catch {
        categoryId = null
      }
    }
    const category = categoryIdSchema.safeParse(categoryId)
    return {
      ...result,
      categoryId: category.success ? category.data : null,
      empty: result.empty ?? false,
    }
  })

/**
 * Single Effect entry point for the scan. The pipeline composes document
 * ingestion, OCR/vision routing, and LLM calls; the procedure stays a thin tRPC
 * boundary (auth, limits, error mapping, categorization merge).
 */
async function runScan(
  ...args: Parameters<typeof scanReceiptDocument>
): Promise<ReceiptExtractedResult> {
  return Effect.runPromise(scanReceiptDocument(...args))
}
