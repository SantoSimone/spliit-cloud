import { z } from 'zod'

import { categoryIdSchema } from '@spliit/domain'

export const extractExpenseInformationOutputSchema = z.object({
  /** Integer minor units of the receipt currency (`NaN` when unreadable). */
  amount: z.number().int().or(z.nan()),
  categoryId: categoryIdSchema.nullable(),
  currencyCode: z.string().nullable(),
  date: z.string().nullable(),
  title: z.string().nullable(),
  items: z.array(
    z.object({
      title: z.string(),
      /** Integer minor units of the receipt currency. */
      unitPrice: z
        .number()
        .int()
        .refine((value) => value !== 0),
      /** Integer milli-units (`1000` = 1 item). */
      quantity: z.number().int().min(1),
    }),
  ),
  /**
   * True when nothing usable came out of the receipt photo. Defaults to false
   * so older in-flight results still parse; the client shows an explicit
   * "nothing extracted" notice and keeps the photo attached for manual entry.
   */
  empty: z.boolean().default(false),
})

export const extractExpenseInformationFromAudioOutputSchema = z.object({
  transcript: z.string().nullable(),
  groupId: z.string().min(1),
  title: z.string().nullable(),
  /** Decimal major units; normalized to ledger minor units in the preview. */
  amount: z.string().nullable(),
  currencyCode: z.string().nullable(),
  date: z.string().nullable(),
  categoryId: categoryIdSchema.nullable(),
  payerParticipantId: z.string().nullable(),
  participantIds: z.array(z.string()),
  issues: z.array(
    z.enum([
      'missingTitle',
      'missingAmount',
      'invalidDate',
      'unsupportedCurrency',
    ]),
  ),
})
