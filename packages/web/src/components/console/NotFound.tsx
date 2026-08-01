'use client'

import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Icon } from '@/components/ui'
import { useSearchOpen } from './search-open'

// The console's unified not-found notice. One anatomy for every missing resource
// (agent / session / schedule / daemon) and for an unknown route: a brand-soft
// icon well badged with `search-x`, a mono `404 · KIND` eyebrow, a title, a calm
// one-line explanation with the id/path in a mono chip, then a primary "back to
// the list" action, an optional recovery action, and a "Search" affordance (⌘K
// on desktop). Rendered inside the detail views' `.card`, so it inherits the
// surrounding `wrap`/loading gate.
//
// Design: "Not Found Pages.dc.html" (claude.ai/design) — a single pattern applied
// across resources, calm tone, states a plausible reason.
export function NotFound({
  icon,
  kind,
  title,
  pre,
  chip,
  post,
  actionLabel,
  actionHref,
  secondaryAction,
  searchLabel = 'Search',
  showSearch = true
}: {
  /** Lucide icon for the well (e.g. `bot-off`, `server-off`, `compass`). */
  icon: string
  /** Eyebrow noun rendered as `404 · {kind}` (e.g. `AGENT`, `PAGE`). */
  kind: string
  /** Bold line (e.g. "Agent not found"). */
  title: string
  /** Copy before the mono chip (e.g. "No agent "). */
  pre?: ReactNode
  /** The id/path shown in a mono chip (omit for copy with no reference). */
  chip?: string
  /** Copy after the chip (e.g. " in this organization. It may have been deleted."). */
  post?: ReactNode
  /** Primary button label (e.g. "Back to agents"). */
  actionLabel: string
  /** Resolved href for the primary action (caller applies `orgPath`). */
  actionHref: string
  /** Optional recovery action shown beside/below the primary action. */
  secondaryAction?: { label: string; href: string; icon?: string }
  /** Mobile secondary button label (e.g. "Search agents"); desktop reads "Search". */
  searchLabel?: string
  /** Show the Search affordance. Off for the bare root 404, which renders outside
   *  the shell where global search isn't mounted. */
  showSearch?: boolean
}) {
  const router = useRouter()
  const openSearch = useSearchOpen()

  return (
    <div className="card flex flex-col items-center justify-center px-6 py-14 text-center">
      {/* Icon well + search-x badge */}
      <span className="relative flex h-[52px] w-[52px] items-center justify-center rounded-lg border border-(--brand-soft-border) bg-(--brand-soft)">
        <Icon name={icon} size={23} color="var(--brand)" />
        <span className="absolute -bottom-[7px] -right-[7px] flex h-[22px] w-[22px] items-center justify-center rounded-full border border-(--border-default) bg-(--surface-card) shadow-(--shadow-xs)">
          <Icon name="search-x" size={12} color="var(--text-secondary)" />
        </span>
      </span>

      <div className="mono mt-[18px] text-[10.5px] font-semibold uppercase leading-normal tracking-[.08em] text-(--brand)">
        404 · {kind}
      </div>
      <div className="mt-[5px] font-sans text-[15px] font-semibold leading-normal text-(--text-primary)">{title}</div>
      <div className="mt-[6px] max-w-[420px] font-sans text-[13px] font-normal leading-[1.6] text-(--text-secondary)">
        {pre}
        {chip !== undefined && (
          <span className="mono mx-[2px] rounded-xs border border-(--border-subtle) bg-(--surface-sunken) px-[6px] py-px text-[12px] text-(--text-primary)">
            {chip}
          </span>
        )}
        {post}
      </div>

      {/* Desktop actions: inline primary, optional recovery, and ghost "Search ⌘K" */}
      <div className="mt-5 hidden items-center gap-2 desktop:flex">
        <Button size="sm" onClick={() => router.push(actionHref)}>
          {actionLabel}
        </Button>
        {secondaryAction ? (
          <Button variant="secondary" size="sm" onClick={() => router.push(secondaryAction.href)}>
            {secondaryAction.icon ? <Icon name={secondaryAction.icon} size={14} /> : null}
            {secondaryAction.label}
          </Button>
        ) : null}
        {showSearch && (
          <Button variant="ghost" size="sm" onClick={openSearch}>
            <span className="inline-flex items-center gap-[7px]">
              Search
              <span className="mono rounded-xs border border-(--border-default) bg-(--surface-card) px-[5px] py-px text-[10.5px] font-medium leading-normal text-(--text-tertiary)">
                ⌘K
              </span>
            </span>
          </Button>
        )}
      </div>

      {/* Mobile actions: full-width stacked buttons with leading icons */}
      <div className="mt-5 flex w-full max-w-[360px] flex-col gap-[9px] desktop:hidden">
        <Button size="md" className="h-11 w-full text-[14px]" onClick={() => router.push(actionHref)}>
          <Icon name="arrow-left" size={15} />
          {actionLabel}
        </Button>
        {secondaryAction ? (
          <Button
            variant="secondary"
            size="md"
            className="h-11 w-full text-[14px]"
            onClick={() => router.push(secondaryAction.href)}
          >
            {secondaryAction.icon ? <Icon name={secondaryAction.icon} size={15} /> : null}
            {secondaryAction.label}
          </Button>
        ) : null}
        {showSearch && (
          <Button variant="secondary" size="md" className="h-11 w-full text-[14px]" onClick={openSearch}>
            <Icon name="search" size={15} />
            {searchLabel}
          </Button>
        )}
      </div>
    </div>
  )
}
