'use client'

// Manage reusable judgments; consumers own their bindings.

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { LoadingState } from '@/components/marks'
import { formatDateTime } from '@/i18n/format'
import { useOrgs } from '@/lib/org-context'
import { useDecisionProviders, useDecisionsPrototype } from '@/lib/decisions/provider'
import type { DecisionSummary } from '@agentconnect.md/protocol/decision-api'

// Name and question lead at every width.
const GRID = 'grid-cols-1 gap-3 desktop:grid-cols-[2fr_.8fr_1.2fr_.8fr_.7fr]'

const TYPE_TONE: Record<string, string> = {
  choice: 'bg-(--status-info-soft) text-(--status-info)',
  boolean: 'bg-(--brand-soft) text-(--brand-soft-text)',
  score: 'bg-(--status-paused-soft) text-(--amber-500)'
}

export default function DecisionsView() {
  const { activeOrg } = useOrgs()
  return <DecisionsList key={activeOrg?.id ?? ''} />
}

function DecisionsList() {
  const t = useTranslations('Decisions')
  const format = useFormatter()
  const { orgPath, myRole } = useOrgs()
  const writable = myRole !== 'viewer'
  const router = useRouter()
  const { decisions, loading, error, gateUsages } = useDecisionsPrototype()
  const { providers } = useDecisionProviders()
  const providerName = (providerId: string) => providers.find((entry) => entry.id === providerId)?.name ?? providerId
  const usageCount = (entry: DecisionSummary) => entry.usageCount + gateUsages(entry.id).length

  return (
    <div className="wrap max-desktop:p-4">
      <div className="mb-4 flex min-h-[34px] flex-wrap items-center gap-3">
        <p className="psub mt-0 min-w-[240px] flex-1">{t('description')}</p>
        <Button variant="primary" size="sm" disabled={!writable} onClick={() => router.push(orgPath('/decisions/new'))}>
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
            disabled={!writable}
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
          </div>
          {decisions.map((entry) => (
            <Link
              key={entry.id}
              href={orgPath(`/decisions/${encodeURIComponent(entry.id)}`)}
              className={`row click ${GRID}`}
            >
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
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
