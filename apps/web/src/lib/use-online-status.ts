import { useEffect, useSyncExternalStore } from 'react'

import { getDefaultConnectivityStore } from '@/lib/offline/connectivity'

export type ConnectivityStatus = 'online' | 'offline' | 'server-unreachable'

export function useConnectivityStatus(): ConnectivityStatus {
  const store = getDefaultConnectivityStore()
  useEffect(() => {
    store.start()
  }, [store])
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )
  if (
    !snapshot.browserOnline ||
    (typeof navigator !== 'undefined' && !navigator.onLine)
  )
    return 'offline'
  if (snapshot.transport === 'unreachable' || snapshot.serverFailure !== null)
    return 'server-unreachable'
  return 'online'
}

/**
 * Whether the app can currently reach the API (browser online and no recent
 * transport failure or probe-detected outage). Use for enabling queries and
 * mutations — not for choosing offline copy, where {@link useConnectivityStatus}
 * distinguishes "you are offline" from "the server is down".
 *
 * Combines `navigator.onLine` with a latch set when auth/tRPC `fetch` throws a
 * connectivity error or the health probe reports failure. Per-request HTTP
 * errors (including 5xx) never latch: the server answered.
 */
export function useOnlineStatus(): boolean {
  return useConnectivityStatus() === 'online'
}

/**
 * True when the shell is offline and this view has no in-session data. Used to
 * show an honest empty state instead of a spinner, generic error, or pretending
 * cached groups/expenses are available.
 */
export function useOfflineWithoutData(hasData: boolean): boolean {
  return useConnectivityStatus() === 'offline' && !hasData
}

/**
 * True when the browser is online but the API cannot be reached (connection
 * failures or a failing health probe) and this view has no in-session data.
 * Pair with {@link useOfflineWithoutData}: one of them is true at most, never
 * both.
 */
export function useServerUnreachableWithoutData(hasData: boolean): boolean {
  return useConnectivityStatus() === 'server-unreachable' && !hasData
}
