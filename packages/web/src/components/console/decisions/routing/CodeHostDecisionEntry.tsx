'use client'

// A watched repository's pull-request row control: its reviewer Decision's pill, or `+ Decision` (UI preview).

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { useOptionalDecisionsPrototype } from '@/lib/decisions/provider'
import type { RosterAgent } from '@/lib/decisions/routing-roster'
import { setCodeHostReviewDecision, useCodeHostReviewDecisions } from '@/lib/decisions/code-host-review-preview'
import { CodeHostDecisionModal } from './CodeHostDecisionModal'

export function CodeHostDecisionEntry({
  storeKey,
  repo,
  candidates,
  blocked
}: {
  storeKey: string
  repo: string
  /** The visible agents; the modal narrows them to this repository's pull-request watchers. */
  candidates: RosterAgent[]
  /** The row runs on @-mention, which picks the agent directly, so no Decision can start here. */
  blocked: boolean
}) {
  const t = useTranslations('Decisions.routing.codeHost')
  const { myRole } = useOrgs()
  const canWrite = myRole !== 'viewer'
  const decisions = useOptionalDecisionsPrototype()
  const saved = useCodeHostReviewDecisions().get(storeKey) ?? null
  const [open, setOpen] = useState(false)
  if (!decisions) return null
  const modal = open && (
    <CodeHostDecisionModal storeKey={storeKey} repo={repo} candidates={candidates} onClose={() => setOpen(false)} />
  )
  if (saved) {
    const name = decisions.decisions.find((entry) => entry.id === saved.decisionId)?.name ?? t('hidden')
    return (
      <>
        <span className="inline-flex h-[26px] max-w-full flex-none items-center overflow-hidden rounded-md border border-(--border-default) bg-(--surface-card)">
          <button
            type="button"
            title={t('pillTitle', { name })}
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
            className="inline-flex h-full min-w-0 cursor-pointer items-center gap-[6px] border-0 bg-transparent px-[7px] hover:bg-(--surface-hover)"
          >
            <Icon name="split" size={12} className="flex-none text-(--brand)" />
            <span className="mono min-w-0 max-w-[160px] truncate text-[11px] text-(--text-primary)">{name}</span>
          </button>
          {canWrite && (
            <button
              type="button"
              title={t('stop')}
              aria-label={t('stop')}
              onClick={() => setCodeHostReviewDecision(storeKey, null)}
              className="flex h-full w-[22px] flex-none cursor-pointer items-center justify-center border-0 border-l border-(--border-subtle) bg-transparent text-(--text-tertiary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
            >
              <Icon name="x" size={11} />
            </button>
          )}
        </span>
        {modal}
      </>
    )
  }
  if (!canWrite) return null
  return (
    <>
      <button
        type="button"
        title={blocked ? t('addBlocked') : t('addTitle')}
        aria-haspopup="dialog"
        disabled={blocked}
        onClick={() => setOpen(true)}
        className="inline-flex h-[26px] flex-none cursor-pointer items-center gap-1 rounded-md border border-dashed border-(--border-strong) bg-transparent pl-[6px] pr-2 font-sans text-[11px] font-medium leading-normal text-(--text-secondary) hover:border-solid hover:border-(--brand) hover:bg-(--brand-soft) hover:text-(--brand-soft-text) disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-dashed disabled:hover:border-(--border-strong) disabled:hover:bg-transparent disabled:hover:text-(--text-secondary)"
      >
        <Icon name="plus" size={11} />
        {t('add')}
      </button>
      {modal}
    </>
  )
}
