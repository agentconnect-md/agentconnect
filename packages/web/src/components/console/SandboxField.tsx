import { CompactToggleField } from '@/components/console/CompactToggleField'

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
  disabled,
  disabledDetail,
  clusterPlacement = false,
  onChange
}: {
  checked: boolean
  supported: boolean
  required: boolean
  disabled?: boolean
  disabledDetail?: string
  /** The selected placement is the cluster/pool, whose isolation is the pod, not this toggle. */
  clusterPlacement?: boolean
  onChange: (checked: boolean) => void
}) {
  if (clusterPlacement) return null
  const status = required ? 'Required' : !supported ? 'Unavailable' : checked ? 'On' : 'Off'
  const detail = required
    ? 'Sandboxing is required on the selected computer. The runtime uses a private HOME and is confined to its workspace.'
    : !supported
      ? 'Sandboxing is not available for the current selection, so the runtime uses its normal environment.'
      : disabled && disabledDetail
        ? disabledDetail
        : checked
          ? 'The runtime runs in an OS sandbox with a private HOME and is confined to its workspace.'
          : 'The runtime uses the selected computer environment without OS sandbox isolation.'

  return (
    <CompactToggleField
      label="Run in sandbox"
      checked={checked}
      disabled={disabled || required || !supported}
      onChange={onChange}
      status={status}
      detail={detail}
    />
  )
}
