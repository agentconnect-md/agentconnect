'use client'

// Manage reusable judgments; consumers own their bindings.

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { LoadingState } from '@/components/marks'
import { formatDateTime } from '@/i18n/format'
import { useOrgs } from '@/lib/org-context'
import { DECISION_EXAMPLES, type DecisionExample } from '@/lib/decisions/examples'
import { useDecisionProviders, useDecisionsPrototype } from '@/lib/decisions/provider'
import { DECISION_PROVIDER_PROFILES } from '@agentconnect.md/protocol/decision'
import type { DecisionSummary } from '@agentconnect.md/protocol/decision-api'

// Name and question lead at every width.
const GRID = 'grid-cols-1 gap-3 desktop:grid-cols-[2fr_.8fr_1.2fr_.8fr_.7fr]'
const EXAMPLE_GRID = 'grid-cols-[minmax(0,1fr)_auto] gap-3 desktop:grid-cols-[minmax(0,2.4fr)_.8fr_1.2fr_auto]'

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
        <DecisionExamples writable={writable} />
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

function DecisionExamples({ writable }: { writable: boolean }) {
  const t = useTranslations('Decisions')
  const { orgPath } = useOrgs()
  const router = useRouter()
  const { api, reload } = useDecisionsPrototype()
  const { providers } = useDecisionProviders()
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const answers = (example: DecisionExample) => {
    const question = example.question
    if (question.type === 'boolean') return [t('condition.yes'), t('condition.no')]
    if (question.type === 'score') return question.criteria.map((_, level) => String(level))
    return Object.keys(question.criteria)
  }

  // Shipped models let the examples save before any daemon is connected, as the editor does.
  const addAll = async () => {
    const provider = providers[0] ?? DECISION_PROVIDER_PROFILES[0]
    if (!provider || adding) return
    setAdding(true)
    setError(null)
    try {
      for (const example of DECISION_EXAMPLES) {
        await api.createDecision({
          name: example.name,
          providerId: provider.id,
          model: provider.models[0]?.id ?? '',
          question: example.question,
          visibility: 'org',
          sharedWith: []
        })
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      await reload()
      setAdding(false)
    }
  }

  return (
    <div className="card">
      <div className="flex flex-wrap items-center gap-3 px-5 py-4">
        <div className="min-w-[220px] flex-1">
          <div className="font-sans text-[14px] font-semibold leading-normal">{t('emptyTitle')}</div>
          <div className="mt-[3px] font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-tertiary)">
            {t('emptyBody')}
          </div>
        </div>
        <Button variant="secondary" size="sm" disabled={!writable || adding} onClick={() => void addAll()}>
          <Icon name="copy-plus" size={14} />
          {adding ? t('examples.adding') : t('examples.addAll')}
        </Button>
      </div>
      {error && (
        <div className="mx-5 mb-3 flex items-start gap-[9px] rounded-md border border-(--red-500) bg-(--status-error-soft) px-[13px] py-[10px] font-sans text-[12.5px] font-normal leading-[1.55]">
          <Icon name="triangle-alert" size={14} className="mt-[2px] flex-none" />
          <span>{error}</span>
        </div>
      )}
      <div className={`row h hidden desktop:grid ${EXAMPLE_GRID}`}>
        <span>{t('examples.columns.example')}</span>
        <span>{t('questionType')}</span>
        <span>{t('examples.columns.answers')}</span>
        <span />
      </div>
      {DECISION_EXAMPLES.map((example) => (
        <div key={example.id} className={`row items-center ${EXAMPLE_GRID}`}>
          <span className="flex min-w-0 flex-col gap-[3px]">
            <span className="font-sans text-[13.5px] font-semibold leading-normal text-(--text-primary)">
              {example.name}
            </span>
            <span className="mono text-[11.5px] text-(--text-tertiary)">{example.question.instructions}</span>
            <span className="mt-[3px] flex items-start gap-[6px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-secondary)">
              <Icon name="lightbulb" size={13} className="mt-[2px] flex-none" color="var(--text-tertiary)" />
              {t(`examples.hints.${example.id}`)}
            </span>
          </span>
          <span className="hidden desktop:block">
            <span className={`badge ${TYPE_TONE[example.question.type] ?? ''}`}>
              {t(`types.${example.question.type}`)}
            </span>
          </span>
          <span className="mono hidden truncate text-[12px] text-(--text-secondary) desktop:inline">
            {answers(example).join(' · ')}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="text-(--brand)"
            disabled={!writable || adding}
            ariaLabel={t('examples.addLabel', { name: example.name })}
            onClick={() => router.push(orgPath(`/decisions/new?example=${encodeURIComponent(example.id)}`))}
          >
            <Icon name="plus" size={14} />
            {t('examples.add')}
          </Button>
        </div>
      ))}
    </div>
  )
}
