'use client'

// A watched repository's issues or pull requests By decision: which member agents each answer selects (code-host-decisions.md §7).

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { useDecisionsPrototype } from '@/lib/decisions/provider'
import {
  draftConfig,
  draftFromDetail,
  routingDraftIssues,
  type RoutingDraft,
  type RoutingIssue
} from '@/lib/decisions/routing-draft'
import type { RosterAgent } from '@/lib/decisions/routing-roster'
import { useCodeHostRoutingActions } from '@/lib/decisions/code-host-routing'
import type { CodeHostRoutingDto } from '@/lib/api'
import { DecisionPicker } from '../DecisionPicker'
import { Note, routingSaveError, saveErrorText } from './RoutingFields'
import { RoutingRulesTable, fitsQuestion } from './RoutingRulesTable'

// A server issue may be rooted at the request body's `config`; the table reads config-relative paths.
const configRelative = (path: Array<string | number>) => (path[0] === 'config' ? path.slice(1) : path)

export function CodeHostDecisionModal({
  routing,
  agents,
  onClose,
  onOpenEvaluations
}: {
  /** The scope's routing read: its saved config, status and members. */
  routing: CodeHostRoutingDto
  /** The scope's members as rule targets; without a Decision, every one of them takes the event. */
  agents: RosterAgent[]
  onClose: () => void
  /** Opens the saved routing's Recent evaluations. */
  onOpenEvaluations?: () => void
}) {
  const t = useTranslations('Decisions.routing')
  const tc = useTranslations('Decisions.routing.codeHost')
  const tDecisions = useTranslations('Decisions')
  const { orgPath, myRole } = useOrgs()
  const canWrite = myRole !== 'viewer'
  const { decisions, loading } = useDecisionsPrototype()
  const { save: saveRouting } = useCodeHostRoutingActions()
  const repo = routing.repoFullName
  const family = routing.family
  const saved = routing.config
  const status = saved && routing.status && routing.status !== 'enabled' ? routing.status : null
  // Each opening edits a copy of the saved routing; nothing is kept until Save. Otherwise starts at every agent.
  const [draft, setDraft] = useState<RoutingDraft>(() =>
    saved
      ? { ...draftFromDetail({ config: saved, channelIds: [] }), enabled: true }
      : { enabled: true, decisionId: null, rules: [], otherwise: 'default_agent', channelIds: [], removals: {} }
  )
  const [helpOpen, setHelpOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<unknown>(null)
  const decision = draft.decisionId ? (decisions.find((entry) => entry.id === draft.decisionId) ?? null) : null
  const question = decision?.question ?? null
  const memberIds = useMemo(() => new Set(agents.map((agent) => agent.id)), [agents])
  const localIssues = routingDraftIssues(draft, question, { savedChannelIds: [], memberIds })
  const serverError = saveError === null ? null : routingSaveError(saveError)
  const issues: RoutingIssue[] = localIssues.length
    ? localIssues
    : serverError?.kind === 'invalid'
      ? serverError.issues.map((issue) => ({ path: configRelative(issue.path), message: issue.message }))
      : []
  const canSave = canWrite && !saving && !!decision && localIssues.length === 0

  useEffect(() => {
    if (saving) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving])
  const edit = useCallback((patch: (current: RoutingDraft) => RoutingDraft) => {
    setSaveError(null)
    setDraft(patch)
  }, [])
  const save = useCallback(async () => {
    const config = canSave ? draftConfig(draft) : null
    if (!config) return
    setSaving(true)
    setSaveError(null)
    try {
      await saveRouting(routing, config)
      onClose()
    } catch (error) {
      setSaveError(error)
    } finally {
      setSaving(false)
    }
  }, [canSave, draft, saveRouting, routing, onClose])

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
                family,
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
          {status && (
            <div
              role="status"
              className="flex items-start gap-[9px] rounded-md border border-(--amber-500) bg-(--status-paused-soft) px-[13px] py-[10px] font-sans text-[12.5px] font-normal leading-[1.55]"
            >
              <Icon
                name={status === 'access_revoked' ? 'lock' : 'triangle-alert'}
                size={14}
                className="mt-[2px] flex-none"
              />
              <span>
                {tc(`statusBody.${status}`, {
                  family,
                  decision: (saved && decisions.find((entry) => entry.id === saved.decisionId)?.name) ?? tc('hidden')
                })}
              </span>
            </div>
          )}
          <div className="fld">
            <span className="fldlbl">{t('decision.label')}</span>
            <div className="flex flex-wrap items-center gap-[9px]">
              <DecisionPicker
                decisions={decisions}
                value={draft.decisionId}
                placeholder={t('decision.select')}
                loading={loading}
                disabled={!canWrite || saving}
                triggerClassName="block w-[280px] min-w-0 max-w-full max-desktop:w-full"
                onSelect={(entry) => {
                  if (entry.id === draft.decisionId) return
                  // A rule the new question cannot answer is dropped, so a type switch starts clean.
                  edit((current) => ({
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
              disabled={!canWrite || saving}
              canWrite={canWrite}
              otherwiseLabels={{ default: tc('everyAgent') }}
              onRules={(patch) => edit((current) => ({ ...current, rules: patch(current.rules) }))}
              onOtherwise={(otherwise) => edit((current) => ({ ...current, otherwise }))}
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
              <Note icon={family === 'pull_request' ? 'git-pull-request' : 'circle-dot'}>
                {tc('evaluatedOnce', { family })}
              </Note>
              <Note icon="at-sign">{tc('mentionsSkip')}</Note>
              <Note icon="users">{tc('otherwiseEveryAgent', { family })}</Note>
            </div>
          )}

          {serverError && (
            <div
              role="alert"
              className="flex items-start gap-[9px] rounded-md border border-(--red-500) bg-(--status-error-soft) px-[13px] py-[10px] font-sans text-[12.5px] font-normal leading-[1.55]"
            >
              <Icon name="triangle-alert" size={14} className="mt-[2px] flex-none" />
              <span>{serverError.kind === 'forbidden' ? tc('forbidden') : saveErrorText(t, serverError)}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-[9px]">
            {canWrite && (
              <Button
                variant="primary"
                size="sm"
                className="max-desktop:flex-1"
                disabled={!canSave}
                onClick={() => void save()}
              >
                {saving ? t('footer.saving') : t('footer.save')}
              </Button>
            )}
            <Button variant="secondary" size="sm" className="max-desktop:flex-1" disabled={saving} onClick={onClose}>
              {canWrite ? t('footer.cancel') : tDecisions('binding.close')}
            </Button>
            {saved && onOpenEvaluations && (
              <button
                type="button"
                className="lnk ml-auto gap-[6px] text-[11.5px] font-medium max-desktop:ml-0"
                onClick={() => {
                  onClose()
                  onOpenEvaluations()
                }}
              >
                <Icon name="list-checks" size={12} />
                {t('recentEvaluations')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
