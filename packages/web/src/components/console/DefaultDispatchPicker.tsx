'use client'

// Per-conversation default dispatch for a SHARED bot — who takes its unmatched messages.
// Picking one PATCHes the conversation's explicit owner (`setChannelAgent`). Shared by the
// org Bots roster and the agent page's Linear rows, so the two cannot drift apart.
// The menu is an <AnchoredFlyout>: the agent page wraps each integration card in
// `overflow-hidden`, which cut an in-row menu after its first option, and the flyout also
// flips above the trigger near the bottom of the viewport instead of running off it.

import { useState } from 'react'
import { Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { AgentIconView } from '@/components/marks'
import { useOrgs } from '@/lib/org-context'
import type { AgentIcon } from '@/lib/agent-icon'
import { useTranslations } from 'next-intl'

/** One candidate owner — an agent the bot is installed on. */
export interface DefaultDispatchOption {
  id: string
  name: string
  model: string
  runtime: string
  icon?: AgentIcon | null
}

/** A conversation's By decision routing: the routed Decision's name when routing owns it, and how to edit or stop it. */
export interface DispatchRouting {
  name: string | null
  active: boolean
  canStop: boolean
  onOpen: () => void
  /** Leave routing for plain dispatch, handing the row to `agentId` when one was picked. */
  onStop: (agentId?: string) => void
}

const MENU_WIDTH = 240
const MENU_HEADER_HEIGHT = 34
const MENU_ROW_HEIGHT = 34

/** The bot's By decision routing for one row: the routed Decision to edit or stop, or `+ Decision` to route the row. */
export function RoutingEntry({
  name,
  canStop,
  onOpen,
  onStop
}: {
  name: string | null
  canStop: boolean
  onOpen: () => void
  onStop: () => void
}) {
  const t = useTranslations('Integrations.channelList.dispatch')
  const { myRole } = useOrgs()
  if (name !== null) {
    return (
      <span className="inline-flex h-7 max-w-full items-center overflow-hidden rounded-md border border-(--brand) bg-(--brand-soft)">
        <button
          type="button"
          onClick={onOpen}
          title={t('editRouting')}
          aria-haspopup="dialog"
          className="inline-flex h-full min-w-0 cursor-pointer items-center gap-[6px] border-0 bg-transparent px-2"
        >
          <Icon name="split" size={13} className="flex-none text-(--brand)" />
          <span className="mono min-w-0 truncate text-[11.5px] text-(--text-primary)">{name}</span>
          <Icon name="pencil" size={11} className="flex-none text-(--text-tertiary)" />
        </button>
        {canStop && myRole !== 'viewer' && (
          <button
            type="button"
            onClick={onStop}
            title={t('stop')}
            aria-label={t('stop')}
            className="flex h-full w-6 flex-none cursor-pointer items-center justify-center border-0 border-l border-(--border-subtle) bg-transparent text-(--text-tertiary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
          >
            <Icon name="x" size={12} />
          </button>
        )}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      title={t('addTitle')}
      aria-haspopup="dialog"
      className="inline-flex h-7 cursor-pointer items-center gap-[5px] rounded-md border border-dashed border-(--border-strong) bg-transparent pl-[7px] pr-[9px] font-sans text-[11.5px] font-medium leading-normal text-(--text-secondary) hover:border-solid hover:border-(--brand) hover:bg-(--brand-soft) hover:text-(--brand-soft-text)"
    >
      <Icon name="plus" size={12} />
      {t('add')}
    </button>
  )
}

export function DefaultDispatchPicker({
  options,
  activeId,
  disabled,
  routing,
  onPick
}: {
  options: DefaultDispatchOption[]
  activeId: string | null
  disabled: boolean
  /** The row's By decision routing; absent where the platform or bot offers none. */
  routing?: DispatchRouting
  onPick: (agentId: string) => Promise<void>
}) {
  const t = useTranslations('Common.defaultDispatch')
  const tDispatch = useTranslations('Integrations.channelList.dispatch')
  const [saving, setSaving] = useState(false)
  const active = options.find((o) => o.id === activeId) ?? options[0]
  const routed = routing?.active === true
  const routingName = routing?.name ?? tDispatch('routingFallback')
  const pick = (id: string) => {
    if (disabled || saving) return
    // Under routing, picking an agent leaves the decision for plain dispatch to that agent.
    if (routed) return routing!.onStop(id)
    if (id === active?.id) return
    setSaving(true)
    onPick(id).finally(() => setSaving(false))
  }
  const heading =
    'px-[9px] pb-[5px] pt-[6px] font-sans text-[10.5px] font-semibold uppercase leading-normal tracking-[0.08em] text-(--text-tertiary)'
  return (
    <span className="justify-self-end" onClick={(e) => e.stopPropagation()}>
      <AnchoredFlyout
        ariaLabel={t('label')}
        align="end"
        width={MENU_WIDTH}
        estimatedHeight={MENU_HEADER_HEIGHT + options.length * MENU_ROW_HEIGHT + (routing ? 80 : 0)}
        trigger={({ open, menuId, toggle }) => (
          <button
            type="button"
            onClick={() => !disabled && toggle()}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            title={
              routed
                ? tDispatch('routedButton', { name: routingName })
                : t('title', { name: active?.name ?? t('none') })
            }
            className={`flex items-center gap-2 rounded-[7px] border-0 bg-transparent px-[5px] py-1 hover:bg-(--surface-hover) ${
              disabled ? 'cursor-default' : 'cursor-pointer'
            } ${saving ? 'opacity-60' : ''}`}
          >
            {routed ? (
              <>
                <Icon name="split" size={14} className="flex-none text-(--brand)" />
                <span className="mono max-w-[180px] truncate text-[12.5px] text-(--text-primary)">{routingName}</span>
              </>
            ) : (
              <>
                <span className="av h-5 w-5 rounded-[5px]">
                  <AgentIconView icon={active?.icon} runtime={active?.runtime ?? ''} size={20} />
                </span>
                <span className="mono max-w-[180px] truncate text-[12.5px] text-(--text-primary)">
                  {active?.name ?? t('unknown')}
                </span>
              </>
            )}
            <Icon name="chevron-down" size={13} color="var(--text-tertiary)" />
          </button>
        )}
      >
        {({ close }) => (
          <>
            {/* A decision owns the row while routed, so no agent reads as chosen until one is picked. */}
            <div className={heading}>{routing ? tDispatch('sendTo') : t('label')}</div>
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  close(true)
                  pick(o.id)
                }}
                className="flex w-full cursor-pointer items-center gap-[9px] rounded-[6px] border-0 bg-transparent px-[9px] py-[6px] text-left hover:bg-(--surface-hover)"
              >
                <span className="av h-[22px] w-[22px] flex-none rounded-[6px]">
                  <AgentIconView icon={o.icon} runtime={o.runtime} size={22} />
                </span>
                <span className="mono min-w-0 flex-1 truncate text-[12.5px] text-(--text-primary)">{o.name}</span>
                <Icon
                  name="check"
                  size={13}
                  color={o.id === active?.id && !routed ? 'var(--brand)' : 'transparent'}
                  className="flex-none"
                />
              </button>
            ))}
            {routing && (
              <>
                <div className="my-1 h-px bg-(--border-subtle)" />
                <div className={heading}>{tDispatch('orDecision')}</div>
                <div className="px-[9px] pb-[6px] pt-[2px]">
                  <RoutingEntry
                    name={routed ? routingName : null}
                    canStop={routing.canStop}
                    onOpen={() => {
                      close()
                      routing.onOpen()
                    }}
                    onStop={() => {
                      close()
                      routing.onStop()
                    }}
                  />
                </div>
              </>
            )}
          </>
        )}
      </AnchoredFlyout>
    </span>
  )
}
