'use client'

// The `By decision` strip under one conversation row: the saved gate and its status, or the editor that writes it (decisions.md §9.1).

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { useOrgs } from '@/lib/org-context'
import { defaultConditionFor, gateIssues, useDecisionProviders, useDecisionsPrototype } from '@/lib/decisions/provider'
import { bindingSaveError, type BindingSaveError, type GateStatus, type SavedGate } from '@/lib/decisions/binding'
import {
  matchDecisionCondition,
  type ChannelDecisionGate,
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

/** The icon each non-ready status leads its banner with. */
const STATUS_ICON: Record<Exclude<GateStatus, 'ready'>, string> = {
  pending_sync: 'clock',
  needs_review: 'triangle-alert',
  daemon_offline: 'wifi-off',
  unsupported: 'circle-arrow-up',
  access_revoked: 'lock'
}

/** Statuses that keep the condition off until someone acts, so they read as warnings. */
const WARNING_STATUS = new Set<GateStatus>(['needs_review', 'unsupported', 'access_revoked'])

function saveErrorText(t: ReturnType<typeof useTranslations<'Decisions'>>, error: BindingSaveError): string {
  if (error.kind === 'invalid') return t('binding.saveErrors.invalid')
  if (error.kind === 'invalid_request') return t('binding.saveErrors.invalidRequest', { message: error.message })
  if (error.kind === 'forbidden') return t('binding.saveErrors.forbidden')
  if (error.kind === 'decision_unavailable') return t('binding.saveErrors.decisionUnavailable')
  if (error.kind === 'unsupported') return t('binding.saveErrors.unsupported')
  return t('binding.saveErrors.failed', { message: error.message })
}

export function DecisionBindingStrip({
  bindingKey,
  canWrite,
  agentName,
  padX,
  saved,
  savedName,
  status,
  onSave
}: {
  /** The gate's identity: organization, owning bot, and conversation (see `gateKey`). */
  bindingKey: string
  canWrite: boolean
  /** The agent this conversation dispatches to — the gate's one fixed target. */
  agentName: string
  padX: number
  /** The conversation's saved gate, or null while only a draft exists. */
  saved: SavedGate | null
  /** The saved Decision's name as the channel DTO reports it; null when the viewer cannot see it. */
  savedName?: string | null
  /** The saved gate's status; null without a saved gate. */
  status: GateStatus | null
  /** Persist the gate; a rejection keeps the draft for Retry. */
  onSave: (gate: ChannelDecisionGate) => Promise<void>
}) {
  const t = useTranslations('Decisions')
  const { orgPath } = useOrgs()
  const pathname = usePathname()
  const search = useSearchParams()
  const { decisions, loading, api, reload, bindingDrafts, setBindingDraft, beginInlineCreate } = useDecisionsPrototype()
  const { daemonId } = useDecisionProviders()
  const draft = bindingDrafts[bindingKey] ?? null
  const saving = useRef(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [tryOpen, setTryOpen] = useState(false)
  const [tryText, setTryText] = useState('')
  const [tryRunning, setTryRunning] = useState(false)
  const [tryResult, setTryResult] = useState<{
    matched: boolean
    rows: Array<{ label: string; value: string }>
    unavailable: boolean
  } | null>(null)

  // A fresh draft with no Decision takes the first one once the list lands; the functional update keeps both mounted copies idempotent.
  const needsPick = draft !== null && draft.decisionId === null && !draft.explicitPick
  useEffect(() => {
    if (!needsPick || !decisions.length) return
    const first = decisions[0]!
    setBindingDraft(bindingKey, (current) =>
      current && current.decisionId === null && !current.explicitPick
        ? { ...current, decisionId: first.id, when: defaultConditionFor(first) }
        : (current ?? null)
    )
  }, [needsPick, decisions, bindingKey, setBindingDraft])

  // Closing the editor unmounts the focused control, so focus lands on the collapsed strip's Edit (or the strip itself).
  const rootRef = useRef<HTMLDivElement>(null)
  const editRef = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)
  useEffect(() => {
    if (draft || !refocus.current) return
    refocus.current = false
    const frame = requestAnimationFrame(() => (editRef.current ?? rootRef.current)?.focus())
    return () => cancelAnimationFrame(frame)
  }, [draft])
  const collapse = () => {
    refocus.current = true
    setBindingDraft(bindingKey, null)
    setTryResult(null)
  }

  const words = { yes: t('condition.yes'), no: t('condition.no'), none: t('condition.noAnswer') }
  const savedDecision = saved ? (decisions.find((entry) => entry.id === saved.decisionId) ?? null) : null
  const savedLabel = savedDecision?.name ?? savedName ?? t('binding.hiddenDecision')

  // A condition of another question type has no fields to repair, so it restarts from the Decision's default; null asks the user to choose.
  const edit = (decisionId: string | null) => {
    if (!saved) return
    if (decisionId === null) {
      setBindingDraft(bindingKey, { decisionId: null, when: null, phase: 'editing', explicitPick: true })
      return
    }
    const when =
      savedDecision && savedDecision.question.type !== saved.when.type ? defaultConditionFor(savedDecision) : saved.when
    setBindingDraft(bindingKey, { decisionId, when, phase: 'editing' })
  }

  if (!draft) {
    if (!saved) return null
    const warning = status !== null && WARNING_STATUS.has(status)
    return (
      <div
        ref={rootRef}
        tabIndex={-1}
        className="flex flex-col gap-2 border-b border-(--border-subtle) bg-(--surface-sunken) outline-none"
        style={{ padding: `8px ${padX}px 10px ${padX + 22}px` }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="badge flex-none bg-(--brand-soft) text-(--brand-soft-text)">
            <Icon name="split" size={11} />
            {t('byDecision')}
          </span>
          <span className="mono min-w-0 truncate text-[11.5px] text-(--text-primary)">{savedLabel}</span>
          {savedDecision && (
            <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
              {conditionSummary(savedDecision, saved.when, words)}
            </span>
          )}
          <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            {t('binding.activatesAgent', { agent: agentName })}
          </span>
          {status && status !== 'ready' && (
            <span
              className={`badge flex-none ${
                warning
                  ? 'bg-(--status-paused-soft) text-(--amber-500)'
                  : 'bg-(--surface-active) text-(--text-secondary)'
              }`}
            >
              {t(`binding.status.${status}`)}
            </span>
          )}
          <span className="flex-1" />
          {canWrite && (
            <button
              ref={editRef}
              type="button"
              className="lnk"
              onClick={() => edit(savedDecision ? saved.decisionId : null)}
            >
              {t('edit')}
            </button>
          )}
        </div>
        {status && status !== 'ready' && (
          <div
            role="status"
            className={
              warning
                ? 'flex flex-col gap-2 rounded-md border border-(--amber-500) bg-(--status-paused-soft) px-[13px] py-[10px] font-sans text-[12.5px] font-normal leading-[1.55]'
                : 'flex flex-col gap-2'
            }
          >
            {warning ? (
              <span className="flex items-start gap-[9px]">
                <Icon name={STATUS_ICON[status]} size={14} className="mt-[2px] flex-none" />
                <span>{t(`binding.statusBody.${status}`, { decision: savedLabel })}</span>
              </span>
            ) : (
              <Note icon={STATUS_ICON[status]}>{t(`binding.statusBody.${status}`, { decision: savedLabel })}</Note>
            )}
            {status === 'needs_review' && (
              <span className="flex flex-wrap items-center gap-[14px]">
                {canWrite && (
                  <button type="button" className="lnk" onClick={() => edit(savedDecision ? saved.decisionId : null)}>
                    {t('binding.repair')}
                  </button>
                )}
                {savedDecision && (
                  <Link href={orgPath(`/decisions/${encodeURIComponent(saved.decisionId)}`)} className="lnk">
                    {t('binding.openDecision')}
                  </Link>
                )}
              </span>
            )}
            {status === 'access_revoked' && canWrite && (
              <span className="flex flex-wrap items-center gap-[14px]">
                <button type="button" className="lnk" onClick={() => edit(null)}>
                  {t('binding.chooseAnother')}
                </button>
              </span>
            )}
          </div>
        )}
      </div>
    )
  }

  const activeDraft = draft
  const decision = activeDraft.decisionId
    ? (decisions.find((entry) => entry.id === activeDraft.decisionId) ?? null)
    : null
  const when = decision ? (activeDraft.when ?? defaultConditionFor(decision)) : null
  const localIssues = gateIssues(decision, when)
  const serverIssues = activeDraft.error?.kind === 'invalid' ? activeDraft.error.issues : []
  const issues = localIssues.length ? localIssues : serverIssues
  const invalidText = decision ? (localIssues[0]?.message ?? '') : t('binding.pickDecision')
  const busy = activeDraft.phase === 'saving'
  const returnTo = `${pathname}${search.toString() ? `?${search.toString()}` : ''}`

  // Every edit drops a failed save's error, so Save starts fresh.
  const change = (decisionId: string, next: DecisionCondition) => {
    setBindingDraft(bindingKey, { decisionId, when: next, phase: 'editing' })
  }

  const save = async () => {
    if (saving.current || busy || !decision || !when || invalidText) return
    saving.current = true
    const gate: ChannelDecisionGate = { type: 'gate', decisionId: decision.id, when }
    setBindingDraft(bindingKey, { decisionId: decision.id, when, phase: 'saving' })
    try {
      await onSave(gate)
      collapse()
    } catch (cause) {
      const error = bindingSaveError(cause)
      setBindingDraft(bindingKey, { decisionId: decision.id, when, phase: 'error', error })
      if (error.kind === 'decision_unavailable') void reload()
    } finally {
      saving.current = false
    }
  }

  const runTry = async () => {
    if (!daemonId || !decision || !when || !tryText.trim()) return
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
        matched: matchDecisionCondition(decision.question, when, answer).matched,
        rows,
        unavailable: false
      })
    } catch {
      setTryResult({ matched: false, rows: [], unavailable: true })
    } finally {
      setTryRunning(false)
    }
  }

  const retryable = activeDraft.error?.kind === 'unsupported' || activeDraft.error?.kind === 'failed'

  return (
    <div
      className="flex flex-col gap-3 border-b border-(--border-subtle) bg-(--surface-sunken)"
      style={{ padding: `12px ${padX}px 13px ${padX + 22}px` }}
    >
      <fieldset disabled={!canWrite || busy} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <div className="fld">
          <span className="fldlbl">{t('binding.decision')}</span>
          <div className="flex flex-wrap items-center gap-[9px]">
            <AnchoredFlyout
              ariaLabel={t('binding.decision')}
              align="start"
              width={280}
              estimatedHeight={10 + Math.max(1, decisions.length) * 44}
              triggerClassName="inline-flex min-w-[220px] max-desktop:w-full max-desktop:min-w-0"
              trigger={({ open, menuId, toggle }) => (
                <button
                  type="button"
                  disabled={!canWrite || busy}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  aria-controls={open ? menuId : undefined}
                  onClick={toggle}
                  className={`inp min-h-8 w-full justify-between gap-2 text-left ${
                    canWrite && !busy ? 'cursor-pointer' : 'cursor-default opacity-60'
                  }`}
                >
                  <span className="font-sans text-[12.5px] font-normal leading-normal">
                    {decision?.name ?? t('binding.selectDecision')}
                  </span>
                  <Icon name="chevron-down" size={14} color="var(--text-tertiary)" className="flex-none" />
                </button>
              )}
            >
              {({ close }) => (
                <>
                  {loading ? (
                    <div className="px-[9px] py-[7px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                      {t('loading')}
                    </div>
                  ) : decisions.length === 0 ? (
                    <div className="px-[9px] py-[7px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                      {t('binding.noDecisions')}
                    </div>
                  ) : (
                    decisions.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={entry.id === activeDraft.decisionId}
                        className={entry.id === activeDraft.decisionId ? 'fopt on' : 'fopt'}
                        onClick={() => {
                          close(true)
                          change(entry.id, defaultConditionFor(entry))
                        }}
                      >
                        <span className="flex min-w-0 flex-1 flex-col items-start">
                          <span className="truncate">{entry.name}</span>
                          <span className="mono text-[11px] text-(--text-tertiary)">
                            {t(`types.${entry.question.type}`)} · {entry.model}
                          </span>
                        </span>
                      </button>
                    ))
                  )}
                  <div className="my-1 h-px bg-(--border-subtle)" />
                  <Link
                    href={`${orgPath('/decisions/new')}?returnTo=${encodeURIComponent(returnTo)}`}
                    className="fopt no-underline"
                    onClick={() => {
                      beginInlineCreate(bindingKey)
                      close()
                    }}
                  >
                    <Icon name="plus" size={15} color="var(--text-tertiary)" />
                    {t('createDecision')}
                  </Link>
                </>
              )}
            </AnchoredFlyout>
            {decision && (
              <>
                <Link
                  href={orgPath(`/decisions/${encodeURIComponent(decision.id)}`)}
                  className="lnk gap-[6px] text-[11.5px] font-medium"
                >
                  <Icon name="pencil" size={12} />
                  {t('viewAndEdit')}
                </Link>
                <span className="mono text-[11px] text-(--text-tertiary)">
                  {t(`types.${decision.question.type}`)} · {decision.model}
                </span>
              </>
            )}
          </div>
        </div>

        {decision && when ? (
          <div className="fld">
            <span className="fldlbl">{t('binding.triggerWhen')}</span>
            <DecisionConditionFields
              question={decision.question}
              value={when}
              onChange={(next) => change(decision.id, next)}
              issues={issues}
            />
          </div>
        ) : (
          <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
            {loading ? t('loading') : decisions.length ? t('binding.pickDecision') : t('binding.noDecisions')}
          </span>
        )}

        <div className="fld">
          <span className="fldlbl">{t('binding.activates')}</span>
          <span className="mono text-[12.5px] text-(--text-primary)">{agentName}</span>
        </div>
      </fieldset>

      {decision && invalidText && (
        <div className="flex items-start gap-[9px] rounded-md border border-(--red-500) bg-(--status-error-soft) px-[13px] py-[10px] font-sans text-[12.5px] font-normal leading-[1.55]">
          <Icon name="triangle-alert" size={14} className="mt-[2px] flex-none" />
          <span>{invalidText}</span>
        </div>
      )}

      {activeDraft.phase === 'error' && activeDraft.error && (
        <div
          role="alert"
          className="flex items-start gap-[9px] rounded-md border border-(--red-500) bg-(--status-error-soft) px-[13px] py-[10px] font-sans text-[12.5px] font-normal leading-[1.55]"
        >
          <Icon name="triangle-alert" size={14} className="mt-[2px] flex-none" />
          <span>{saveErrorText(t, activeDraft.error)}</span>
        </div>
      )}

      {decision && (
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
      )}

      {decision && helpOpen && (
        <div className="flex flex-col gap-1">
          <Note icon="messages-square">{t('binding.helpMentions')}</Note>
          <Note icon="clock">{t('binding.helpHistory')}</Note>
          <Note icon="shield-alert">{t('binding.helpUnavailable')}</Note>
        </div>
      )}

      {decision && tryOpen && (
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
      {decision && when && tryResult && (
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
                <Row label={t('binding.triggerCondition')} value={conditionSummary(decision, when, words)} />
                <Row label={t('binding.triggers')} value={tryResult.matched ? agentName : '—'} />
              </>
            )}
            <Row label={t('model')} value={`${decision.providerId} / ${decision.model}`} />
          </div>
        </div>
      )}

      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            className="max-desktop:flex-1"
            disabled={!!invalidText || busy || !decision}
            onClick={() => void save()}
          >
            {busy ? t('binding.saving') : t('save')}
          </Button>
          {retryable && (
            <Button variant="secondary" size="sm" className="max-desktop:flex-1" onClick={() => void save()}>
              {t('binding.retry')}
            </Button>
          )}
          <Button variant="secondary" size="sm" className="max-desktop:flex-1" disabled={busy} onClick={collapse}>
            {t('cancel')}
          </Button>
        </div>
      )}
    </div>
  )
}
