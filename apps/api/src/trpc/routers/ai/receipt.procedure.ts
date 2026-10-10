import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { categoryIdSchema } from '@spliit/domain'

import { getRecentExpenseContext } from '../../../lib/ai/context'
import { isTimeoutError } from '../../../lib/ai/timeout'
import { suggestExpenseCategory } from '../../../lib/api/expenses/suggest-category'
import { env } from '../../../lib/env'
import { extractExpenseInformationFromImage } from '../../../lib/receipt-actions'
import {
  enforceAiRequestLimit,
  loadGroupMutationContext,
  protectedProcedure,
} from '../../init'
import { extractExpenseInformationOutputSchema } from '../../outputs/ai'

export const extractExpenseInformationFromImageProcedure = protectedProcedure
  .input(
    z.object({
      imageUrl: z.url(),
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
    // the LLM engine keeps the single joint vision call below.
    const useSeparateCategorization =
      env.AI_CATEGORY_ENGINE === 'system-one' &&
      env.PUBLIC_ENABLE_CATEGORY_EXTRACT
    const context = useSeparateCategorization
      ? undefined
      : await getRecentExpenseContext(input.groupId)
    enforceAiRequestLimit(
      ctx.auth.user.id,
      'ai.extractExpenseInformationFromImage',
      ctx.resHeaders,
    )

    let result: Awaited<ReturnType<typeof extractExpenseInformationFromImage>>
    try {
      result = await extractExpenseInformationFromImage(
        input.imageUrl,
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
              recentExpenses: context!.expenses,
              groupContext: context!.group,
              locale: input.locale,
              translateToLocale: input.translateToLocale,
              currentExpense: input.currentExpense,
            },
      )
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new TRPCError({
          code: 'TIMEOUT',
          message: `Receipt scanning failed due to timeout after ${env.AI_RECEIPT_TIMEOUT_SECONDS}s`,
        })
      }
      throw error
    }

    let categoryId: string | null = result.categoryId
    if (useSeparateCategorization && result.title) {
      // Best-effort: OCR data is complete without a category, so a failed
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
    }
  })
