export type LarkFeishuTarget = 'lark' | 'feishu'

const BRAND_LABEL: Record<LarkFeishuTarget, 'Lark' | 'Feishu'> = {
  lark: 'Lark',
  feishu: 'Feishu'
}

/**
 * One cloud's brand word. This is the REGION axis's vocabulary, not the
 * platform's: `lib/platform-labels.ts` answers for the platform id `feishu`
 * with the international brand ("Lark") on purpose, so a surface that renders
 * one row PER CLOUD cannot get its words from there. It gets them from here —
 * beside the switcher that is the region axis's host chrome — rather than
 * re-spelling them (Settings → Bots' platform tabs, audit §10.6 F14).
 */
export function larkFeishuBrand(target: LarkFeishuTarget): string {
  return BRAND_LABEL[target]
}

export default function LarkFeishuSwitcher({
  value,
  onSwitch,
  prefix,
  variant = 'platform',
  disabled = false
}: {
  value: LarkFeishuTarget
  onSwitch: (target: LarkFeishuTarget) => void
  prefix?: string
  variant?: 'login' | 'platform'
  disabled?: boolean
}) {
  const alternate: LarkFeishuTarget = value === 'lark' ? 'feishu' : 'lark'
  const activeClassName =
    variant === 'login'
      ? 'font-sans text-[14px] font-semibold leading-normal text-(--text-primary)'
      : 'font-sans text-[12px] font-semibold leading-normal text-(--text-primary)'
  // The alternate cloud rides at two-thirds of the active word — present, never competing with it.
  const alternateClassName =
    variant === 'login'
      ? 'pointer-events-auto cursor-pointer rounded-[2px] border-0 bg-transparent p-0 font-sans text-[9px] font-medium leading-normal text-(--text-tertiary) hover:text-(--brand) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand) disabled:cursor-not-allowed disabled:opacity-50'
      : 'cursor-pointer rounded-[2px] border-0 bg-transparent p-0 font-sans text-[8px] font-medium leading-normal text-(--text-tertiary) hover:text-(--brand) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand) disabled:cursor-not-allowed disabled:opacity-50'

  return (
    <span className="inline-flex items-baseline whitespace-nowrap">
      <span className={activeClassName}>
        {prefix}
        {BRAND_LABEL[value]}
      </span>
      {/* The slash hugs both words: spaced out, the label reached the install tile's edge. */}
      <span
        aria-hidden="true"
        className={`mx-[1px] font-sans font-normal leading-normal text-(--text-tertiary) ${variant === 'login' ? 'text-[9px]' : 'text-[8px]'}`}
      >
        /
      </span>
      <button
        type="button"
        disabled={disabled}
        aria-label={`Switch to ${BRAND_LABEL[alternate]}`}
        className={alternateClassName}
        onClick={(event) => {
          event.stopPropagation()
          onSwitch(alternate)
        }}
      >
        {BRAND_LABEL[alternate]}
      </button>
    </span>
  )
}
