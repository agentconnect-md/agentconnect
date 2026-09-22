'use client'

// Decisions (`/decisions`): the organization's reusable judgements. A decision asks one
// question about an incoming message; a channel decides what the answer does. The list
// is the resource's only management surface — the bindings live where they are consumed.

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { LoadingState } from '@/components/marks'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'
import { formatDateTime } from '@/i18n/format'
import { useOrgs } from '@/lib/org-context'
import { useDecisionProviders, useDecisionsPrototype } from '@/lib/decisions/provider'
import { DecisionsNotOffered } from '@/components/console/decisions/DecisionsNotOffered'
import { featureFlagEnabled } from '@/lib/feature-flags'
import type { DecisionSummary, DecisionUsage } from '@agentconnect.md/protocol/decision-api'

// Name/question lead at every width; the type moves under the name on mobile, where a
// six-track grid would leave each column unreadable.
const GRID = 'grid-cols-[minmax(0,1fr)_auto] gap-3 desktop:grid-cols-[2fr_.8fr_1.2fr_.8fr_.7fr_34px]'

const TYPE_TONE: Record<string, string> = {
  choice: 'bg-(--status-info-soft) text-(--status-info)',
  boolean: 'bg-(--brand-soft) text-(--brand-soft-text)',
  score: 'bg-(--status-paused-soft) text-(--amber-500)'
}

export default function DecisionsView() {
  const t = useTranslations('Decisions')
  const format = useFormatter()
  const { orgPath } = useOrgs()
  const router = useRouter()
  const { decisions, loading, error, reload, api, gateUsages } = useDecisionsPrototype()
  const { providers } = useDecisionProviders()
  const [query, setQuery] = useState('')
  const [pendingDelete, setPendingDelete] = useState<{ decision: DecisionSummary; usages: DecisionUsage[] } | null>(
    null
  )
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const needle = query.trim().toLowerCase()
  const rows = needle
    ? decisions.filter((entry) => entry.name.toLowerCase().includes(needle) || entry.question.type.includes(needle))
    : decisions
  const providerName = (providerId: string) => providers.find((entry) => entry.id === providerId)?.name ?? providerId
  // A prototype gate is a real consumer of this decision, even though the mock service cannot
  // see it: it counts toward `Used by`, and it blocks deletion the same way a saved binding does.
  // The store resolves only this organization's gates, so a sibling tenant cannot block a delete.
  const gatedIn = gateUsages
  const usageCount = (entry: DecisionSummary) => entry.usageCount + gatedIn(entry.id).length
  const usageNames = (entry: DecisionSummary, mockUsages: DecisionUsage[]) => [
    ...mockUsages.map((usage) => usage.label),
    ...gatedIn(entry.id).map((usage) => usage.channelName)
  ]

  const askDelete = async (decision: DecisionSummary) => {
    setDeleteError(null)
    try {
      const detail = await api.getDecision(decision.id)
      setPendingDelete({ decision, usages: detail.usages })
    } catch (cause) {
      setPendingDelete({ decision, usages: [] })
      setDeleteError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    // The mock service has no gate bindings, so a decision our own channels gate must be
    // refused here rather than left dangling by a write the service would accept.
    if (gatedIn(pendingDelete.decision.id).length) {
      setDeleteError(t('errors.inUse'))
      return
    }
    setDeleting(true)
    setDeleteError(null)
    try {
      await api.deleteDecision(pendingDelete.decision.id)
      await reload()
      setPendingDelete(null)
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDeleting(false)
    }
  }

  const duplicate = async (decision: DecisionSummary) => {
    setBusyId(decision.id)
    try {
      await api.createDecision({
        name: t('copyName', { name: decision.name }),
        providerId: decision.providerId,
        model: decision.model,
        question: decision.question,
        visibility: decision.visibility,
        sharedWith: decision.sharedWith
      })
      await reload()
    } finally {
      setBusyId(null)
    }
  }

  if (!featureFlagEnabled('decisions')) return <DecisionsNotOffered />

  return (
    <div className="wrap max-desktop:p-4">
      <div className="mb-4 flex min-h-[34px] flex-wrap items-center gap-3">
        <p className="psub mt-0 min-w-[240px] flex-1">{t('description')}</p>
        <span className="relative inline-flex items-center">
          <Icon name="search" size={15} color="var(--text-tertiary)" className="absolute left-[10px]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            className="inp mn h-[34px] w-[210px] min-h-0 pl-[31px]"
          />
        </span>
        <Button variant="primary" size="sm" onClick={() => router.push(orgPath('/decisions/new'))}>
          <Icon name="plus" size={14} />
          {t('createDecision')}
        </Button>
      </div>

      {loading ? (
        <div className="card">
          <LoadingState size={22} padding={30} />
        </div>
      ) : error ? (
        <div className="card flex items-center justify-center gap-2 px-5 py-10 font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
          <Icon name="triangle-alert" size={16} />
          {error}
        </div>
      ) : decisions.length === 0 ? (
        <div className="card flex flex-col items-center gap-[7px] px-6 py-[44px] text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-[10px] border border-(--border-subtle) bg-(--surface-sunken)">
            <Icon name="split" size={20} color="var(--text-tertiary)" />
          </span>
          <div className="mt-[6px] font-sans text-[14px] font-semibold leading-normal">{t('emptyTitle')}</div>
          <div className="max-w-[420px] font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-tertiary)">
            {t('emptyBody')}
          </div>
          <Button
            variant="primary"
            size="sm"
            className="mt-[10px]"
            onClick={() => router.push(orgPath('/decisions/new'))}
          >
            <Icon name="plus" size={14} />
            {t('createDecision')}
          </Button>
        </div>
      ) : (
        <div className="card">
          <div className={`row h hidden desktop:grid ${GRID}`}>
            <span>{t('name')}</span>
            <span>{t('questionType')}</span>
            <span>{t('columns.providerModel')}</span>
            <span>{t('usedBy.title')}</span>
            <span>{t('columns.updated')}</span>
            <span />
          </div>
          {rows.map((entry) => (
            <div key={entry.id} className={`row ${GRID}`}>
              <Link href={orgPath(`/decisions/${encodeURIComponent(entry.id)}`)} className="min-w-0 no-underline">
                <span className="flex min-w-0 flex-col gap-[3px]">
                  <span className="truncate font-sans text-[13.5px] font-semibold leading-normal text-(--text-primary)">
                    {entry.name}
                  </span>
                  <span className="mono truncate text-[11.5px] text-(--text-tertiary)">
                    {entry.question.instructions || t('noInstructions')}
                  </span>
                  <span className="mono text-[11px] text-(--text-tertiary) desktop:hidden">
                    {t(`types.${entry.question.type}`)} · {providerName(entry.providerId)} ·{' '}
                    {t('places', { count: usageCount(entry) })}
                  </span>
                </span>
              </Link>
              <span className="hidden desktop:block">
                <span className={`badge ${TYPE_TONE[entry.question.type] ?? ''}`}>
                  {t(`types.${entry.question.type}`)}
                </span>
              </span>
              <span className="mono hidden truncate text-[12px] text-(--text-secondary) desktop:inline">
                {providerName(entry.providerId)} / {entry.model}
              </span>
              <span className="mono hidden text-[12.5px] text-(--text-secondary) desktop:inline">
                {usageCount(entry) === 0 ? '—' : t('places', { count: usageCount(entry) })}
              </span>
              <span className="mono hidden text-[11.5px] text-(--text-tertiary) desktop:inline">
                {formatDateTime(format, new Date(entry.updatedAt), { dateStyle: 'medium' })}
              </span>
              <span className="justify-self-end">
                <AnchoredFlyout
                  ariaLabel={t('rowActions', { name: entry.name })}
                  align="end"
                  width={190}
                  estimatedHeight={3 * 34 + 10}
                  trigger={({ open, menuId, toggle }) => (
                    <button
                      type="button"
                      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent text-(--text-tertiary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
                      aria-haspopup="menu"
                      aria-expanded={open}
                      aria-controls={open ? menuId : undefined}
                      aria-label={t('rowActions', { name: entry.name })}
                      onClick={toggle}
                    >
                      <Icon name="ellipsis" size={16} />
                    </button>
                  )}
                >
                  {({ close }) => (
                    <>
                      <Link
                        href={orgPath(`/decisions/${encodeURIComponent(entry.id)}`)}
                        role="menuitem"
                        className="fopt no-underline"
                        onClick={() => close()}
                      >
                        <Icon name="pencil" size={15} color="var(--text-tertiary)" />
                        {t('edit')}
                      </Link>
                      <button
                        type="button"
                        role="menuitem"
                        className="fopt"
                        disabled={busyId === entry.id}
                        onClick={() => {
                          close()
                          void duplicate(entry)
                        }}
                      >
                        <Icon name="copy" size={15} color="var(--text-tertiary)" />
                        {t('duplicate')}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="fopt text-(--red-600)"
                        onClick={() => {
                          close()
                          void askDelete(entry)
                        }}
                      >
                        <Icon name="trash" size={15} color="var(--red-600)" />
                        {t('delete')}
                      </button>
                    </>
                  )}
                </AnchoredFlyout>
              </span>
            </div>
          ))}
          {rows.length === 0 && (
            <div className="px-4 py-7 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
              {t('noMatches', { query: query.trim() })}
            </div>
          )}
        </div>
      )}

      {pendingDelete && (
        <ConfirmationDialog
          title={t('deleteTitle', { name: pendingDelete.decision.name })}
          confirmLabel={t('delete')}
          destructive
          busy={deleting}
          busyLabel={t('deleting')}
          error={deleteError}
          onClose={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        >
          {usageNames(pendingDelete.decision, pendingDelete.usages).length
            ? t('deleteBodyUsed', { names: usageNames(pendingDelete.decision, pendingDelete.usages).join(', ') })
            : t('deleteBodyUnused')}
        </ConfirmationDialog>
      )}
    </div>
  )
}
