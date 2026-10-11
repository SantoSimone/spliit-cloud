import { ToastAction } from '@/components/ui/toast'
import { reloadForUpgrade } from '@/lib/client-upgrade'

/**
 * Refresh action for the stale-client upgrade toast (JSX lives here so the
 * hooks file can stay `.ts`).
 */
export function UpgradeToastAction({ label }: { label: string }) {
  return (
    <ToastAction altText={label} onClick={() => void reloadForUpgrade()}>
      {label}
    </ToastAction>
  )
}
