import { CompactToggleField } from '@/components/console/CompactToggleField'

export function SandboxField({
  checked,
  supported,
  required,
  disabled,
  disabledDetail,
  onChange
}: {
  checked: boolean
  supported: boolean
  required: boolean
  disabled?: boolean
  disabledDetail?: string
  onChange: (checked: boolean) => void
}) {
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
