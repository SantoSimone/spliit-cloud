import { CLIENT_UPGRADE_REQUIRED_ISSUE } from '@spliit/domain'

type ZodErrorShape = {
  formErrors?: unknown
  fieldErrors?: Record<string, unknown>
}

/**
 * True when a tRPC mutation error carries the stale-client quantity signal: the
 * sender wrote whole-unit quantities with the legacy amount formula, so the
 * write was rejected and the user must refresh to the milli-unit client before
 * retrying. Scans `data.zodError` (tRPC input-validation shape) and falls back
 * to a serialized scan so minified or re-wrapped errors still match.
 */
export function isClientUpgradeRequiredError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const data = (error as { data?: unknown }).data
  if (data && typeof data === 'object') {
    const zodError = (data as { zodError?: unknown }).zodError
    if (zodError && typeof zodError === 'object') {
      const { formErrors, fieldErrors } = zodError as ZodErrorShape
      const haystacks: unknown[] = [
        formErrors,
        ...Object.values(fieldErrors ?? {}),
      ]
      if (
        haystacks.some((entry) =>
          (Array.isArray(entry) ? entry : [entry]).some(
            (message) =>
              typeof message === 'string' &&
              message.includes(CLIENT_UPGRADE_REQUIRED_ISSUE),
          ),
        )
      ) {
        return true
      }
    }
  }
  try {
    return JSON.stringify(data ?? error).includes(CLIENT_UPGRADE_REQUIRED_ISSUE)
  } catch {
    return false
  }
}

/**
 * Nudge the service worker to pick up a deployed update, then reload into the
 * new client.
 */
export async function reloadForUpgrade(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration()
    await registration?.update()
  } catch {
    // Reload anyway: the fresh document re-triggers the update check.
  }
  window.location.reload()
}
