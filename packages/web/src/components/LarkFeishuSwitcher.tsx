export type LarkFeishuTarget = 'lark' | 'feishu'

const BRAND_LABEL: Record<LarkFeishuTarget, 'Lark' | 'Feishu'> = {
  lark: 'Lark',
  feishu: 'Feishu'
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
      : 'font-sans text-[13px] font-semibold leading-normal text-(--text-primary)'
  const alternateClassName =
    variant === 'login'
      ? 'pointer-events-auto ml-[5px] cursor-pointer rounded-[2px] border-0 bg-transparent p-0 font-sans text-[12px] font-medium leading-normal text-(--text-tertiary) hover:text-(--brand) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand) disabled:cursor-not-allowed disabled:opacity-50'
      : 'ml-1 cursor-pointer rounded-[2px] border-0 bg-transparent p-0 font-sans text-[11px] font-medium leading-normal text-(--text-tertiary) hover:text-(--brand) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand) disabled:cursor-not-allowed disabled:opacity-50'

  return (
    <span className="inline-flex items-baseline whitespace-nowrap">
      <span className={activeClassName}>
        {prefix}
        {BRAND_LABEL[value]}
      </span>
      <span
        aria-hidden="true"
        className="ml-[6px] font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)"
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
