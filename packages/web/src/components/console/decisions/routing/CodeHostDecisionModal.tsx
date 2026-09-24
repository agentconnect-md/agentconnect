'use client'

// A watched repository's issues or change requests By decision: which member agents each answer selects (code-host-decisions.md §7).

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
import { codeHostRoutingSubject, useCodeHostRoutingActions } from '@/lib/decisions/code-host-routing'
import type { CodeHostRoutingDto } from '@/lib/api'
import { DecisionChainHost, useDecisionChainHost } from '../DecisionChainControls'
import { RoutingChainFields } from './RoutingChainFields'
import { Note, routingSaveError, saveErrorText } from './RoutingFields'

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
  const subject = codeHostRoutingSubject(routing)
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
  const localIssues = routingDraftIssues(draft, question, {
    savedChannelIds: [],
    memberIds,
    questions: new Map(decisions.map((d) => [d.id, d.question]))
  })
  const serverError = saveError === null ? null : routingSaveError(saveError)
  const issues: RoutingIssue[] = localIssues.length
    ? localIssues
    : serverError?.kind === 'invalid'
      ? serverError.issues.map((issue) => ({ path: configRelative(issue.path), message: issue.message }))
      : []
  const canSave = canWrite && !saving && !!decision && localIssues.length === 0

  const chain = useDecisionChainHost()
  const { leave } = chain
  useEffect(() => {
    if (saving) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !leave(false) && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving, leave])
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
                subject,
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
                  subject,
                  decision: (saved && decisions.find((entry) => entry.id === saved.decisionId)?.name) ?? tc('hidden')
                })}
              </span>
            </div>
          )}
          <DecisionChainHost value={chain.host}>
            <RoutingChainFields
              draft={draft}
              edit={edit}
              decisions={decisions}
              loading={loading}
              agents={agents}
              issues={issues}
              disabled={!canWrite || saving}
              canWrite={canWrite}
              otherwiseLabels={{ default: tc('everyAgent') }}
              onRefresh={() => {}}
              create={() => ({ href: orgPath('/decisions/new'), newTab: true })}
            />
          </DecisionChainHost>

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
              <Note icon={subject === 'issues' ? 'circle-dot' : 'git-pull-request'}>
                {tc('evaluatedOnce', { subject })}
              </Note>
              <Note icon="at-sign">{tc('mentionsSkip')}</Note>
              <Note icon="users">{tc('otherwiseEveryAgent', { subject })}</Note>
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
                disabled={chain.depth ? saving : !canSave}
                onClick={() => leave(true) || void save()}
              >
                {saving ? t('footer.saving') : t('footer.save')}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              className="max-desktop:flex-1"
              disabled={saving}
              onClick={() => leave(false) || onClose()}
            >
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
