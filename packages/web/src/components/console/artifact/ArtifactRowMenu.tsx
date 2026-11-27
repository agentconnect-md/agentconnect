'use client'

// A row's actions on the Artifacts page: a menu beside the row on desktop, a bottom sheet on a phone (artifacts.md §11.5).
import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { EscapeLayer } from '@/components/console/Scrim'
import { useIsMobile } from '@/lib/use-is-mobile'

export interface RowMenuItem {
  key: string
  label: string
  icon: string
  /** A link item navigates; otherwise `onSelect` runs once the menu closes. */
  href?: string
  onSelect?: () => void
  danger?: boolean
  /** Shown but not offered, with `hint` saying why. */
  disabled?: boolean
  hint?: string
}

export function ArtifactRowMenu({ title, items }: { title: string; items: RowMenuItem[] }) {
  const t = useTranslations('Artifacts.manage')
  const isMobile = useIsMobile()
  const [sheet, setSheet] = useState(false)
  const label = t('actions.menu', { title })
  const trigger = (onClick: () => void, expanded: boolean) => (
    <button
      type="button"
      className="iconbtn h-8 w-8"
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-expanded={expanded}
      data-artifact-actions=""
      onClick={onClick}
    >
      <Icon name="ellipsis" size={16} />
    </button>
  )

  if (isMobile)
    return (
      <>
        {trigger(() => setSheet(true), sheet)}
        {sheet && (
          <div className="msheet-scrim" onClick={() => setSheet(false)}>
            <EscapeLayer onEscape={() => setSheet(false)} />
            <div
              className="msheet"
              role="menu"
              aria-label={label}
              data-artifact-actions-sheet=""
              onClick={(e) => e.stopPropagation()}
            >
              <div className="msheet-handle" />
              <div className="msheet-eyebrow truncate">{title}</div>
              {items.map((item) => (
                <SheetItem key={item.key} item={item} close={() => setSheet(false)} />
              ))}
              <button type="button" className="msheet-cancel" onClick={() => setSheet(false)}>
                {t('actions.cancel')}
              </button>
              <div className="msheet-home">
                <span className="home-pill" />
              </div>
            </div>
          </div>
        )}
      </>
    )

  return (
    <AnchoredFlyout
      ariaLabel={label}
      width={260}
      estimatedHeight={items.length * 38 + 12}
      triggerClassName="flex flex-none"
      trigger={({ open, toggle }) => trigger(toggle, open)}
    >
      {({ close }) =>
        items.map((item) => {
          const cls = item.danger ? 'dmi danger' : 'dmi'
          const body = (
            <>
              <Icon name={item.icon} size={15} />
              <span className="min-w-0 flex-1">
                <span className="block">{item.label}</span>
                {item.hint ? (
                  <span className="block font-sans text-[11.5px] font-normal leading-[1.4] whitespace-normal text-(--text-tertiary)">
                    {item.hint}
                  </span>
                ) : null}
              </span>
            </>
          )
          if (item.href && !item.disabled)
            return (
              <Link
                key={item.key}
                role="menuitem"
                href={item.href}
                className={`${cls} no-underline`}
                data-action={item.key}
                onClick={() => close()}
              >
                {body}
              </Link>
            )
          return (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              aria-disabled={item.disabled}
              className={item.disabled ? `${cls} items-start cursor-default opacity-60 hover:bg-transparent` : cls}
              data-action={item.key}
              onClick={() => {
                if (item.disabled) return
                close()
                item.onSelect?.()
              }}
            >
              {body}
            </button>
          )
        })
      }
    </AnchoredFlyout>
  )
}

function SheetItem({ item, close }: { item: RowMenuItem; close: () => void }) {
  const tone = item.danger ? 'text-(--status-error)' : ''
  const body = (
    <>
      <Icon name={item.icon} size={18} color={item.danger ? 'var(--status-error)' : 'var(--text-secondary)'} />
      <span className="msheet-rowtext">
        <span className={tone}>{item.label}</span>
        {item.hint ? (
          <span className="font-sans text-[12px] font-normal leading-[1.4] text-(--text-tertiary)">{item.hint}</span>
        ) : null}
      </span>
    </>
  )
  if (item.href && !item.disabled)
    return (
      <Link role="menuitem" href={item.href} className="msheet-row" data-action={item.key} onClick={close}>
        {body}
      </Link>
    )
  return (
    <button
      type="button"
      role="menuitem"
      disabled={item.disabled}
      className={item.disabled ? 'msheet-row opacity-60' : 'msheet-row'}
      data-action={item.key}
      onClick={() => {
        if (item.disabled) return
        close()
        item.onSelect?.()
      }}
    >
      {body}
    </button>
  )
}
