import { CompactFieldLabel } from '@/components/console/CompactFieldLabel'
import { OutputModeHelp } from '@/components/console/OutputModeHelp'
import { OUTPUT_MODE_OPTIONS, type OutputMode } from '@/lib/output-mode'

export function OutputModeField({
  value,
  onChange,
  showFooter,
  onShowFooterChange,
  className
}: {
  value: OutputMode | ''
  onChange: (mode: OutputMode) => void
  showFooter: boolean
  onShowFooterChange: (show: boolean) => void
  className?: string
}) {
  return (
    <div
      className={
        className
          ? `grid grid-cols-1 gap-[14px] desktop:grid-cols-[minmax(0,1fr)_auto] desktop:items-end ${className}`
          : 'grid grid-cols-1 gap-[14px] desktop:grid-cols-[minmax(0,1fr)_auto] desktop:items-end'
      }
    >
      <div className="fld min-w-0">
        <div className="flex items-center gap-[6px]">
          <span className="fldlbl">Output mode</span>
          <OutputModeHelp activeMode={value} />
        </div>
        <div className="pillbar self-start">
          {OUTPUT_MODE_OPTIONS.map((mode) => (
            <button
              key={mode.key}
              type="button"
              className={value === mode.key ? 'pill on px-[10px] py-1 text-[12px]' : 'pill px-[10px] py-1 text-[12px]'}
              onClick={() => onChange(mode.key)}
              aria-pressed={value === mode.key}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </div>
      <div className="fld min-w-0 desktop:items-end">
        <CompactFieldLabel
          label="Show footer"
          tooltipAlign="right"
          detail={
            showFooter ? 'Replies show the agent, runtime, model, and session links.' : 'No footer is added to replies.'
          }
        />
        <div className="pillbar self-start desktop:self-end">
          <button
            type="button"
            className={showFooter ? 'pill on px-[10px] py-1 text-[12px]' : 'pill px-[10px] py-1 text-[12px]'}
            onClick={() => onShowFooterChange(true)}
            aria-pressed={showFooter}
          >
            On
          </button>
          <button
            type="button"
            className={showFooter ? 'pill px-[10px] py-1 text-[12px]' : 'pill on px-[10px] py-1 text-[12px]'}
            onClick={() => onShowFooterChange(false)}
            aria-pressed={!showFooter}
          >
            Off
          </button>
        </div>
      </div>
    </div>
  )
}
