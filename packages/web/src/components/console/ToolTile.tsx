'use client'

// The shared tile for connectors / MCP servers and skill sources. Both the org-level
// registry cards (Tools & Skills page) and the per-agent enable-lists (agent detail →
// Tools & Skills tab) render the SAME tile — mark well, name line, a muted second line,
// and an optional footer — and differ only in the top-right ACTION: the registry cards
// put edit/delete icon buttons there, the agent cards put an enable toggle.
//
// Keep the two surfaces rendering through here rather than re-styling a copy, so a tile
// tweak lands on both at once.

import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { fetchConnectorCatalog, repoLabel, repoWebUrl } from '@/lib/api'
import { providerIconUrl } from '@/lib/connectors'
import { GithubMark } from '@/components/marks'
import { Icon } from '@/components/ui'

export function ToolTile({
  mark,
  name,
  badge,
  subtitle,
  action,
  footer,
  children,
  dimmed
}: {
  mark: ReactNode
  name: string
  /** Rendered right after the name (e.g. a skill source's pinned ref). */
  badge?: ReactNode
  /** The muted second line — an MCP server's kind, a skill source's repo. */
  subtitle: ReactNode
  /** Top-right: edit/delete on the registry cards, a Toggle on the agent cards. */
  action?: ReactNode
  /** Optional third line (access scope + added date on the registry cards). */
  footer?: ReactNode
  /** Full-bleed panel below the tile body (the agent skills card's per-skill list). */
  children?: ReactNode
  dimmed?: boolean
}) {
  return (
    <div
      // `group` so an action can reveal itself on tile hover (see the skills card's
      // expand chevron) rather than sitting there permanently.
      className={`group flex min-w-0 flex-col overflow-hidden rounded-[9px] border border-(--border-subtle) transition-[border-color,box-shadow] hover:border-(--border-strong) hover:shadow-(--shadow-xs) ${dimmed ? 'opacity-60' : ''}`}
    >
      <div className="flex min-w-0 flex-col gap-[10px] px-[14px] py-[13px]">
        <div className="flex min-w-0 items-center gap-[10px]">
          {mark}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="mono truncate text-[12.5px] font-semibold text-(--text-primary)">{name}</span>
              {badge}
            </div>
            <div className="mt-px min-w-0 truncate font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
              {subtitle}
            </div>
          </div>
          {action && <span className="flex flex-none items-center gap-px">{action}</span>}
        </div>
        {footer}
      </div>
      {children}
    </div>
  )
}

/** The 3-up tile grid both pages lay tiles out in (the agent cards are narrower ⇒ 2-up). */
export function ToolTileGrid({ columns = 3, children }: { columns?: 2 | 3; children: ReactNode }) {
  return (
    <div
      className={`grid grid-cols-1 gap-3 px-4 py-[14px] ${columns === 2 ? 'desktop:grid-cols-2' : 'desktop:grid-cols-[repeat(3,minmax(0,1fr))]'}`}
    >
      {children}
    </div>
  )
}

/** The skill-source mark: a brand-tinted book well. */
export function SkillMark() {
  return (
    <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
      <Icon name="book-open" size={16} color="var(--brand)" />
    </span>
  )
}

/**
 * The MCP mark well: an open_connector provider's catalog icon when we have one
 * (falls back to the generic plug on a missing/broken image), else the plug glyph.
 */
export function ProviderMark({ iconUrl }: { iconUrl?: string }) {
  const [broken, setBroken] = useState(false)
  return (
    <span className="flex h-[30px] w-[30px] flex-none items-center justify-center overflow-hidden rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken)">
      {!iconUrl || broken ? (
        <Icon name="plug" size={15} color="var(--text-tertiary)" />
      ) : (
        <img
          alt=""
          src={iconUrl}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="h-[15px] w-[15px] object-contain"
          onError={() => setBroken(true)}
        />
      )}
    </span>
  )
}

/**
 * service → catalog icon URL, for decorating open_connector tiles. Fetched once per
 * page (SWR dedupes across the registry and agent cards) and only when `enabled`.
 */
export function useConnectorIcons(enabled: boolean): Map<string, string> {
  const { data: catalog } = useSWR(enabled ? 'connector-catalog' : null, () => fetchConnectorCatalog(), {
    revalidateOnFocus: false
  })
  return useMemo(() => {
    const m = new Map<string, string>()
    for (const p of catalog?.providers ?? []) {
      const url = providerIconUrl(p)
      if (url) m.set(p.service, url)
    }
    return m
  }, [catalog])
}

/**
 * A skill source's second line: the repo it installs from, linked out when we can
 * resolve a web URL for it. Mirrors the MCP tile's kind line in weight and color.
 */
export function SkillSourceLine({ source, subDir }: { source: string; subDir?: string | null }) {
  const url = repoWebUrl(source)
  const full = repoLabel(source)
  const isGithub = url?.startsWith('https://github.com/') ?? false
  // A GitHub repo reads as owner/repo — drop any deeper path the source string carries.
  const label = isGithub ? full.split('/').slice(0, 2).join('/') : full
  const body = (
    <>
      <span className="imark h-[13px] w-[13px] flex-none border-0 bg-transparent">
        {isGithub ? <GithubMark color="var(--text-tertiary)" /> : <Icon name="git-branch" size={11} />}
      </span>
      <span className="min-w-0 truncate">
        {label}
        {subDir ? <span> · {subDir}</span> : null}
      </span>
    </>
  )
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${label}`}
      className="flex min-w-0 items-center gap-[5px] font-mono text-[11px] font-normal leading-normal text-(--text-tertiary) no-underline hover:text-(--text-secondary) hover:underline"
    >
      {body}
    </a>
  ) : (
    <span className="flex min-w-0 items-center gap-[5px] font-mono text-[11px] font-normal leading-normal">{body}</span>
  )
}
