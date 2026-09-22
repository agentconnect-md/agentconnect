import { CompactToggleField } from '@/components/console/CompactToggleField'
import { useTranslations } from 'next-intl'

/**
 * The OS-sandbox toggle: a private HOME and a workspace-confined runtime, on the machine the
 * agent is placed on.
 *
 * It renders nothing for a CLUSTER placement. A cluster runtime is isolated by its own pod, so
 * the in-process SRT mechanism is deliberately off there (`daemon.ts` — it stays off even on a
 * host that supports it) and the member advertises neither `sandbox` nor `sandbox-required`.
 * Read literally that made the field say "Unavailable" about the one placement whose isolation
 * is strongest — a disabled control answering a question the operator cannot ask and should not
 * have to un-learn. On a real machine the row stays, "Unavailable" included: there it is true,
 * and why an agent is unconfined is worth reading.
 */
export function SandboxField({
  checked,
  supported,
  required,
  unavailable,
  disabled,
  disabledDetail,
  clusterPlacement = false,
  onChange
}: {
  checked: boolean
  supported: boolean
  required: boolean
  /** Why a sandbox the computer HAS cannot be provided right now — a different answer from having none. */
  unavailable?: string | null
  disabled?: boolean
  disabledDetail?: string
  /** The selected placement is the cluster/pool, whose isolation is the pod, not this toggle. */
  clusterPlacement?: boolean
  onChange: (checked: boolean) => void
}) {
  const t = useTranslations('Common.sandbox')
  if (clusterPlacement) return null
  // A broken sandbox is not a missing one: the setting stands, and sessions are refused until it is fixed.
  const down = supported && !!unavailable
  const status = down
    ? t('unavailable')
    : required
      ? t('required')
      : !supported
        ? t('unavailable')
        : checked
          ? t('on')
          : t('off')
  const detail = down
    ? t('downDetail', { reason: unavailable })
    : required
      ? t('requiredDetail')
      : !supported
        ? t('unavailableDetail')
        : disabled && disabledDetail
          ? disabledDetail
          : checked
            ? t('enabledDetail')
            : t('disabledDetail')

  return (
    <CompactToggleField
      label={t('label')}
      checked={checked}
      disabled={disabled || required || !supported}
      onChange={onChange}
      status={status}
      detail={detail}
    />
  )
}
