import { describe, expect, it, vi } from 'vitest'

import { CLIENT_UPGRADE_REQUIRED_ISSUE } from '@spliit/domain'

import {
  isClientUpgradeRequiredError,
  reloadForUpgrade,
} from './client-upgrade'

describe('isClientUpgradeRequiredError', () => {
  it('matches the signal in tRPC zodError field errors', () => {
    expect(
      isClientUpgradeRequiredError({
        data: {
          code: 'BAD_REQUEST',
          zodError: {
            formErrors: [],
            fieldErrors: {
              'expense.items.0.quantity': [CLIENT_UPGRADE_REQUIRED_ISSUE],
            },
          },
        },
      }),
    ).toBe(true)
  })

  it('ignores ordinary validation errors', () => {
    expect(
      isClientUpgradeRequiredError({
        data: {
          code: 'BAD_REQUEST',
          zodError: { formErrors: [], fieldErrors: { amount: ['amountSum'] } },
        },
      }),
    ).toBe(false)
    expect(isClientUpgradeRequiredError({ data: { code: 'CONFLICT' } })).toBe(
      false,
    )
    expect(isClientUpgradeRequiredError(null)).toBe(false)
    expect(isClientUpgradeRequiredError(new Error('boom'))).toBe(false)
  })
})

describe('reloadForUpgrade', () => {
  it('kicks the service worker update before reloading', async () => {
    const update = vi.fn().mockResolvedValue(true)
    const reload = vi.fn()
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: vi.fn().mockResolvedValue({ update }) },
    })
    vi.stubGlobal('window', { location: { reload } })

    await reloadForUpgrade()
    expect(update).toHaveBeenCalled()
    expect(reload).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
