import { CompactFieldLabel } from '@/components/console/CompactFieldLabel'
import { Toggle } from '@/components/ui'

export function CompactToggleField({
  label,
  checked,
  onChange,
  detail,
  status = checked ? 'On' : 'Off',
  disabled
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  detail: string
  status?: string
  disabled?: boolean
}) {
  return (
    <div className="fld min-w-0">
      <CompactFieldLabel label={label} detail={detail} />
      <div className="inp min-w-0 gap-3">
        <span className="truncate font-sans text-[13px] font-medium leading-normal text-(--text-secondary)">
          {status}
        </span>
        <Toggle checked={checked} disabled={disabled} onChange={onChange} ariaLabel={`${label}: ${status}`} />
      </div>
    </div>
  )
}
