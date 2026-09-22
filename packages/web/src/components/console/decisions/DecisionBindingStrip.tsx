'use client'

// The `By decision` strip under one conversation row: the saved gate, or the editor that
// writes one. It renders only while the row's trigger IS `by decision` — the row owns that
// choice, this owns the binding the choice needs (docs/designs/decisions.md §3.1).

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { useOrgs } from '@/lib/org-context'
import {
  boundDecision,
  defaultConditionFor,
  gateIssues,
  useDecisionProviders,
  useDecisionsPrototype,
  type DecisionGateBinding
} from '@/lib/decisions/provider'
import {
  matchDecisionCondition,
  type DecisionAnswer,
  type DecisionCondition,
  type DecisionDefinition
} from '@agentconnect.md/protocol/decision'
import { DecisionConditionFields, intervalText } from './DecisionConditionFields'

/** How a saved condition reads in one line — the summary the collapsed strip prints. */
function conditionSummary(
  decision: DecisionDefinition,
  when: DecisionCondition,
  labels: { yes: string; no: string; none: string }
): string {
  if (when.type === 'boolean') {
    if (!when.values.length) return labels.none
    return when.values.map((value) => (value ? labels.yes : labels.no)).join(' or ')
  }
  if (when.type === 'score') {
    return intervalText(when, decision.question.type === 'score' ? decision.question.criteria.length : 2)
  }
  const keys = Object.keys(when.thresholds)
  if (!keys.length) return labels.none
  return keys.map((key) => `${key} ≥ ${Math.round((when.thresholds[key] ?? 0) * 100)}%`).join(', ')
}

function Note({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 font-sans text-[12px] font-normal leading-[1.55] text-(--text-tertiary)">
      <Icon name={icon} size={13} className="mt-[2px] flex-none" />
      <span>{children}</span>
    </div>
  )
}

function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
      <span>{label}</span>
      <b className="mono font-medium text-(--text-secondary)">{value}</b>
    </div>
  )
}

export function DecisionBindingStrip({
  bindingKey,
  channelName,
  canWrite,
  agentName,
  padX,
  onAbandon
}: {
  /** The gate's identity: organization, owning bot, and conversation (see `gateKey`). */
  bindingKey: string
  /** The room as the console prints it, carried into the saved binding for the usage list. */
  channelName: string
  canWrite: boolean
  /** The agent this conversation dispatches to — the gate's one fixed target. */
  agentName: string
  padX: number
  /** The editor closed without a saved binding: the row drops back to its previous trigger. */
  onAbandon: () => void
}) {
  const t = useTranslations('Decisions')
  const { orgPath } = useOrgs()
  const pathname = usePathname()
  const search = useSearchParams()
  const { decisions, loading, gates, setGate, api } = useDecisionsPrototype()
  const { daemonId } = useDecisionProviders()
  const saved = gates[bindingKey] ?? null
  const savedDecision = boundDecision(decisions, saved)
  const [draft, setDraft] = useState<DecisionGateBinding | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [tryOpen, setTryOpen] = useState(false)
  const [tryText, setTryText] = useState('')
  const [tryRunning, setTryRunning] = useState(false)
  const [tryResult, setTryResult] = useState<{
    matched: boolean
    rows: Array<{ label: string; value: string }>
    unavailable: boolean
  } | null>(null)

  // A row switched to `by decision` with nothing saved opens the editor as soon as the list lands.
  useEffect(() => {
    if (draft || saved || !decisions.length) return
    const first = decisions[0]!
    setDraft({ decisionId: first.id, when: defaultConditionFor(first), channelName })
  }, [draft, saved, decisions, channelName])

  const decision = draft ? boundDecision(decisions, draft) : null
  const issues = decision ? gateIssues(decision, draft?.when ?? null) : []
  const invalidText = decision ? (issues[0]?.message ?? '') : t('binding.pickDecision')
  const words = { yes: t('condition.yes'), no: t('condition.no'), none: t('condition.noAnswer') }

  const runTry = async () => {
    if (!daemonId || !decision || !draft || !tryText.trim()) return
    setTryRunning(true)
    setTryResult(null)
    try {
      const result = await api.preview({
        decision: {
          name: decision.name,
          providerId: decision.providerId,
          model: decision.model,
          question: decision.question,
          visibility: decision.visibility,
          sharedWith: decision.sharedWith
        },
        daemonId,
        state: { history: [], currentMessage: { text: tryText } },
        consumer: { type: 'none' }
      })
      const evaluation = result.evaluation
      if (!evaluation || evaluation.status !== 'answered') {
        setTryResult({ matched: false, rows: [], unavailable: true })
        return
      }
      const answer: DecisionAnswer = evaluation.answer
      const rows =
        answer.type === 'score'
          ? [{ label: 'score', value: String(answer.value) }]
          : answer.type === 'choice'
            ? Object.entries(answer.probabilities).map(([key, value]) => ({
                label: key,
                value: `${Math.round(value * 100)}%`
              }))
            : [
                { label: words.yes, value: `${Math.round(answer.probability * 100)}%` },
                { label: words.no, value: `${Math.round((1 - answer.probability) * 100)}%` }
              ]
      setTryResult({
        matched: matchDecisionCondition(decision.question, draft.when, answer).matched,
        rows,
        unavailable: false
      })
    } catch {
      setTryResult({ matched: false, rows: [], unavailable: true })
    } finally {
      setTryRunning(false)
    }
  }

  // The trigger is `by decision` but nothing is bound yet: the editor is about to open, or
  // the list is still in flight. Either way there is no summary to print.
  if (!draft || !decision) {
    if (saved && savedDecision) {
      return (
        <div
          className="flex flex-wrap items-center gap-2 border-b border-(--border-subtle) bg-(--surface-sunken)"
          style={{ padding: `8px ${padX}px 10px ${padX + 22}px` }}
        >
          <span className="badge flex-none bg-(--brand-soft) text-(--brand-soft-text)">
            <Icon name="split" size={11} />
            {t('byDecision')}
          </span>
          <span className="mono min-w-0 truncate text-[11.5px] text-(--text-primary)">{savedDecision.name}</span>
          <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            {conditionSummary(savedDecision, saved.when, words)}
          </span>
          <span className="flex-1" />
          {canWrite && (
            <button type="button" className="lnk" onClick={() => setDraft(saved)}>
              {t('edit')}
            </button>
          )}
        </div>
      )
    }
    return (
      <div
        className="border-b border-(--border-subtle) bg-(--surface-sunken)"
        style={{ padding: `9px ${padX}px 10px ${padX + 22}px` }}
      >
        <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {loading ? t('loading') : t('binding.pickDecision')}
        </span>
      </div>
    )
  }

  const activeDraft = draft
  const activeDecision = decision
  const returnTo = `${pathname}${search.toString() ? `?${search.toString()}` : ''}`

  return (
    <div
      className="flex flex-col gap-3 border-b border-(--border-subtle) bg-(--surface-sunken)"
      style={{ padding: `12px ${padX}px 13px ${padX + 22}px` }}
    >
      <div className="fld">
        <span className="fldlbl">{t('binding.decision')}</span>
        <div className="flex flex-wrap items-center gap-[9px]">
          <AnchoredFlyout
            ariaLabel={t('binding.decision')}
            align="start"
            width={280}
            estimatedHeight={10 + decisions.length * 44}
            triggerClassName="inline-flex min-w-[220px]"
            trigger={({ open, menuId, toggle }) => (
              <button
                type="button"
                disabled={!canWrite}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? menuId : undefined}
                onClick={toggle}
                className={`inp min-h-8 w-full justify-between gap-2 text-left ${
                  canWrite ? 'cursor-pointer' : 'cursor-default opacity-60'
                }`}
              >
                <span className="font-sans text-[12.5px] font-normal leading-normal">{activeDecision.name}</span>
                <Icon name="chevron-down" size={14} color="var(--text-tertiary)" className="flex-none" />
              </button>
            )}
          >
            {({ close }) => (
              <>
                {decisions.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={entry.id === activeDraft.decisionId}
                    className={entry.id === activeDraft.decisionId ? 'fopt on' : 'fopt'}
                    onClick={() => {
                      close(true)
                      setDraft({ decisionId: entry.id, when: defaultConditionFor(entry), channelName })
                    }}
                  >
                    <span className="flex min-w-0 flex-1 flex-col items-start">
                      <span className="truncate">{entry.name}</span>
                      <span className="mono text-[11px] text-(--text-tertiary)">
                        {t(`types.${entry.question.type}`)} · {entry.model}
                      </span>
                    </span>
                  </button>
                ))}
                <div className="my-1 h-px bg-(--border-subtle)" />
                <Link
                  href={`${orgPath('/decisions/new')}?returnTo=${encodeURIComponent(returnTo)}`}
                  className="fopt no-underline"
                  onClick={() => close()}
                >
                  <Icon name="plus" size={15} color="var(--text-tertiary)" />
                  {t('createDecision')}
                </Link>
              </>
            )}
          </AnchoredFlyout>
          <Link
            href={orgPath(`/decisions/${encodeURIComponent(activeDecision.id)}`)}
            className="lnk gap-[6px] text-[11.5px] font-medium"
          >
            <Icon name="pencil" size={12} />
            {t('viewAndEdit')}
          </Link>
          <span className="mono text-[11px] text-(--text-tertiary)">
            {t(`types.${activeDecision.question.type}`)} · {activeDecision.model}
          </span>
        </div>
      </div>

      <div className="fld">
        <span className="fldlbl">{t('binding.triggerWhen')}</span>
        <DecisionConditionFields
          question={activeDecision.question}
          value={activeDraft.when}
          onChange={(when) => setDraft({ decisionId: activeDraft.decisionId, when, channelName })}
          issues={issues}
        />
      </div>

      {invalidText && (
        <div className="flex items-start gap-[9px] rounded-md border border-(--red-500) bg-(--status-error-soft) px-[13px] py-[10px] font-sans text-[12.5px] font-normal leading-[1.55]">
          <Icon name="triangle-alert" size={14} className="mt-[2px] flex-none" />
          <span>{invalidText}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-[14px]">
        <button
          type="button"
          className="lnk gap-[6px] text-[11.5px] font-medium"
          onClick={() => setHelpOpen((open) => !open)}
        >
          <Icon name={helpOpen ? 'chevron-down' : 'chevron-right'} size={12} />
          {t('binding.howThisWorks')}
        </button>
        <button
          type="button"
          className="lnk gap-[6px] text-[11.5px] font-medium"
          onClick={() => setTryOpen((open) => !open)}
        >
          <Icon name={tryOpen ? 'chevron-down' : 'chevron-right'} size={12} />
          {t('binding.tryMessage')}
        </button>
      </div>

      {helpOpen && (
        <div className="flex flex-col gap-1">
          <Note icon="messages-square">{t('binding.helpMentions')}</Note>
          <Note icon="clock">{t('binding.helpHistory')}</Note>
          <Note icon="shield-alert">{t('binding.helpUnavailable')}</Note>
        </div>
      )}

      {tryOpen && (
        <div className="flex flex-wrap items-center gap-[9px]">
          <input
            value={tryText}
            onChange={(event) => setTryText(event.target.value)}
            placeholder={t('binding.tryPlaceholder')}
            aria-label={t('binding.tryMessage')}
            className="inp h-8 min-h-0 min-w-[200px] flex-1"
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={!tryText.trim() || tryRunning || !daemonId}
            onClick={() => void runTry()}
          >
            <Icon name="play" size={14} />
            {tryRunning ? t('try.running') : t('binding.try')}
          </Button>
        </div>
      )}

      {/* Outside the `Try a message` disclosure, so collapsing it keeps the verdict on screen. */}
      {tryResult && (
        <div className="overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card)">
          <div className="flex items-center gap-[9px] border-b border-(--border-subtle) px-[12px] py-[10px]">
            <span className="min-w-0 flex-1 font-sans text-[12.5px] font-normal leading-[1.45]">{tryText}</span>
            <span
              className={`badge flex-none ${
                tryResult.unavailable
                  ? 'bg-(--status-error-soft) text-(--red-600)'
                  : tryResult.matched
                    ? 'bg-(--status-online-soft) text-(--status-online)'
                    : 'bg-(--surface-active) text-(--text-secondary)'
              }`}
            >
              {tryResult.unavailable
                ? t('try.unavailableBadge')
                : tryResult.matched
                  ? t('binding.wouldTrigger')
                  : t('binding.skipped')}
            </span>
          </div>
          <div className="flex flex-col gap-[7px] bg-(--surface-app) px-[12px] py-[11px]">
            {tryResult.unavailable ? (
              <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                {t('try.unavailableBody')}
              </span>
            ) : (
              <>
                {tryResult.rows.map((row) => (
                  <Row key={row.label} label={<span className="mono">{row.label}</span>} value={row.value} />
                ))}
                <Row
                  label={t('binding.triggerCondition')}
                  value={conditionSummary(activeDecision, activeDraft.when, words)}
                />
                <Row label={t('binding.triggers')} value={tryResult.matched ? agentName : '—'} />
              </>
            )}
            <Row label={t('model')} value={`${activeDecision.providerId} / ${activeDecision.model}`} />
          </div>
        </div>
      )}

      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={!!invalidText}
            onClick={() => {
              // Saving the repaired gate is what clears its Needs review state.
              setGate(bindingKey, { ...activeDraft, needsReview: false })
              setDraft(null)
              setTryResult(null)
            }}
          >
            {t('save')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setDraft(null)
              setTryResult(null)
              if (!saved) onAbandon()
            }}
          >
            {t('cancel')}
          </Button>
        </div>
      )}
    </div>
  )
}
