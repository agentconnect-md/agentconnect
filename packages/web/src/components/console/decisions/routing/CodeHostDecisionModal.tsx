'use client'

// A watched repository's pull-request reviewers By decision: which agents a PR's answer selects (UI preview, kept in this tab).

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { useDecisionsPrototype } from '@/lib/decisions/provider'
import { routingDraftIssues, type RoutingDraftRule } from '@/lib/decisions/routing-draft'
import type { RosterAgent } from '@/lib/decisions/routing-roster'
import {
  setCodeHostReviewDecision,
  useCodeHostReviewDecisions,
  type CodeHostReviewDecision
} from '@/lib/decisions/code-host-review-preview'
import { DecisionPicker } from '../DecisionPicker'
import { Note } from './RoutingFields'
import { RoutingRulesTable, fitsQuestion } from './RoutingRulesTable'

export function CodeHostDecisionModal({
  storeKey,
  repo,
  agents,
  onClose
}: {
  /** The preview store's key for this repository (`codeHostReviewKey`). */
  storeKey: string
  /** The repository as its row reads. */
  repo: string
  /** The agents a PR can go to; without a Decision, every one of them reviews it. */
  agents: RosterAgent[]
  onClose: () => void
}) {
  const t = useTranslations('Decisions.routing')
  const tc = useTranslations('Decisions.routing.codeHost')
  const tDecisions = useTranslations('Decisions')
  const { orgPath, myRole } = useOrgs()
  const canWrite = myRole !== 'viewer'
  const { decisions, loading } = useDecisionsPrototype()
  const saved = useCodeHostReviewDecisions().get(storeKey) ?? null
  // Each opening edits a copy of the stored Decision; nothing is kept until Save.
  const [draft, setDraft] = useState<{
    decisionId: string | null
    rules: RoutingDraftRule[]
    otherwise: 'default_agent' | 'skip'
  }>(() => (saved ? structuredClone(saved) : { decisionId: null, rules: [], otherwise: 'default_agent' }))
  const [helpOpen, setHelpOpen] = useState(false)
  const decision = draft.decisionId ? (decisions.find((entry) => entry.id === draft.decisionId) ?? null) : null
  const question = decision?.question ?? null
  const memberIds = useMemo(() => new Set(agents.map((agent) => agent.id)), [agents])
  const issues = routingDraftIssues({ ...draft, enabled: true, channelIds: [], removals: {} }, question, {
    savedChannelIds: [],
    memberIds
  })
  const canSave = canWrite && !!decision && issues.length === 0

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  const save = useCallback(() => {
    if (!canSave || !draft.decisionId) return
    const next: CodeHostReviewDecision = {
      decisionId: draft.decisionId,
      rules: draft.rules,
      otherwise: draft.otherwise
    }
    setCodeHostReviewDecision(storeKey, next)
    onClose()
  }, [canSave, draft, storeKey, onClose])

  return createPortal(
    <div className="scrim" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${repo} · ${tDecisions('binding.rulesTitleBare')}`}
        className="modal max-w-[760px]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modalhead">
          <Icon name="split" size={16} className="flex-none text-(--text-tertiary)" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-sans text-[16px] font-semibold leading-normal">
              {tDecisions.rich('binding.rulesTitle', {
                channel: repo,
                name: (chunks) => <span className="mono">{chunks}</span>
              })}
            </span>
            <span className="mt-[2px] block truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
              {tc.rich('subtitle', {
                agents: agents.map((agent) => agent.name).join(', '),
                name: (chunks) => <span className="mono text-(--text-secondary)">{chunks}</span>
              })}
            </span>
          </span>
          <button type="button" className="iconbtn" aria-label={t('footer.cancel')} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody flex flex-col gap-3">
          <Note icon="flask-conical">{tc('preview')}</Note>
          <div className="fld">
            <span className="fldlbl">{t('decision.label')}</span>
            <div className="flex flex-wrap items-center gap-[9px]">
              <DecisionPicker
                decisions={decisions}
                value={draft.decisionId}
                placeholder={t('decision.select')}
                loading={loading}
                disabled={!canWrite}
                triggerClassName="block w-[280px] min-w-0 max-w-full max-desktop:w-full"
                onSelect={(entry) => {
                  if (entry.id === draft.decisionId) return
                  // A rule the new question cannot answer is dropped, so a type switch starts clean.
                  setDraft((current) => ({
                    ...current,
                    decisionId: entry.id,
                    rules: current.rules.filter((rule) => fitsQuestion(rule.when, entry.question))
                  }))
                }}
                create={{ href: orgPath('/decisions/new'), newTab: true }}
              />
              {decision && (
                <>
                  <Link
                    href={orgPath(`/decisions/${encodeURIComponent(decision.id)}`)}
                    className="lnk gap-[6px] text-[11.5px] font-medium"
                  >
                    <Icon name="pencil" size={12} />
                    {tDecisions('viewAndEdit')}
                  </Link>
                  <span className="mono text-[11px] text-(--text-tertiary)">
                    {t('decision.summary', {
                      type: tDecisions(`types.${decision.question.type}`),
                      model: decision.model
                    })}
                  </span>
                </>
              )}
            </div>
          </div>

          {question && (
            <RoutingRulesTable
              question={question}
              rules={draft.rules}
              otherwise={draft.otherwise}
              agents={agents}
              issues={issues}
              disabled={!canWrite}
              canWrite={canWrite}
              otherwiseLabels={{ default: tc('everyAgent') }}
              onRules={(patch) => setDraft((current) => ({ ...current, rules: patch(current.rules) }))}
              onOtherwise={(otherwise) => setDraft((current) => ({ ...current, otherwise }))}
              onRefresh={() => {}}
            />
          )}

          {decision && (
            <button
              type="button"
              className="lnk self-start gap-[6px] text-[11.5px] font-medium"
              aria-expanded={helpOpen}
              onClick={() => setHelpOpen((open) => !open)}
            >
              <Icon name={helpOpen ? 'chevron-down' : 'chevron-right'} size={12} />
              {tDecisions('binding.howThisWorks')}
            </button>
          )}
          {decision && helpOpen && (
            <div className="flex flex-col gap-1">
              <Note icon="git-pull-request">{tc('evaluatedOnce')}</Note>
              <Note icon="at-sign">{tc('mentionsSkip')}</Note>
              <Note icon="users">{tc('otherwiseEveryAgent')}</Note>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-[9px]">
            {canWrite && (
              <Button variant="primary" size="sm" className="max-desktop:flex-1" disabled={!canSave} onClick={save}>
                {t('footer.save')}
              </Button>
            )}
            <Button variant="secondary" size="sm" className="max-desktop:flex-1" onClick={onClose}>
              {canWrite ? t('footer.cancel') : tDecisions('binding.close')}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
