'use client'

// A conversation's `By decision` gate: the in-row entry, the status strip under the row, and the rules modal that writes it (decisions.md §9.1).

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import {
  defaultConditionFor,
  emptyConditionFor,
  gateIssues,
  useDecisionsPrototype,
  type DecisionBindingDraft
} from '@/lib/decisions/provider'
import { bindingSaveError, type BindingSaveError, type GateStatus, type SavedGate } from '@/lib/decisions/binding'
import {
  decisionGateIssues,
  type ChannelDecisionGate,
  type DecisionCondition
} from '@agentconnect.md/protocol/decision'
import type { DecisionConversationRef } from '@agentconnect.md/protocol/decision-api'
import { DecisionConditionFields, conditionSummary } from './DecisionConditionFields'
import { DecisionEvaluationsDrawer } from './DecisionEvaluationsDrawer'
import { DecisionGateTry } from './DecisionGateTry'
import { DecisionChip } from './DecisionChip'
import { DecisionChainHost, useDecisionChainHost } from './DecisionChainControls'
import { GateChainFields } from './GateChainFields'
import { DecisionPicker } from './DecisionPicker'

type DecisionEntry = ReturnType<typeof useDecisionsPrototype>['decisions'][number]

/** True when a condition is missing or selects no answer, so a repair still waits on the operator. */
function selectsNothing(when: DecisionCondition | null): boolean {
  if (!when) return true
  if (when.type === 'boolean') return when.values.length === 0
  if (when.type === 'choice') return Object.keys(when.thresholds).length === 0
  return false
}

/** The draft an edit of a saved gate opens: another question type restarts empty, and no Decision asks for a pick. */
function editDraftFor(saved: SavedGate, decision: DecisionEntry | null): DecisionBindingDraft {
  if (!decision) return { decisionId: null, when: null, phase: 'editing', explicitPick: true }
  if (decision.question.type !== saved.when.type)
    return {
      ...saved,
      decisionId: decision.id,
      when: emptyConditionFor(decision),
      phase: 'editing',
      awaitingCondition: true
    }
  return { ...saved, decisionId: decision.id, when: saved.when, phase: 'editing' }
}

/** Closing the modal unmounts the focused control, so focus returns to the row's entry (`data-gate-entry`). */
function focusEntry(bindingKey: string) {
  const entry = [...document.querySelectorAll<HTMLElement>('[data-gate-entry]')].find(
    (node) => node.dataset.gateEntry === bindingKey
  )
  entry?.focus()
}

function Note({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 font-sans text-[12px] font-normal leading-[1.55] text-(--text-tertiary)">
      <Icon name={icon} size={13} className="mt-[2px] flex-none" />
      <span>{children}</span>
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

/** The row's By decision control: the saved gate as a pill that opens its rules, or `+ Decision` to start one. */
export function DecisionGateEntry({
  bindingKey,
  saved,
  savedName,
  canWrite: writable,
  offer,
  disabled = false,
  onStop
}: {
  bindingKey: string
  saved: SavedGate | null
  /** The saved Decision's name as the channel DTO reports it; null when the viewer cannot see it. */
  savedName?: string | null
  canWrite: boolean
  /** Whether a new gate can start here; a saved one always shows. */
  offer: boolean
  disabled?: boolean
  /** Leave By decision for the row's plain trigger. */
  onStop: () => void | Promise<void>
}) {
  const t = useTranslations('Decisions')
  const { myRole } = useOrgs()
  const canWrite = writable && myRole !== 'viewer'
  const { decisions, bindingDrafts, setBindingDraft } = useDecisionsPrototype()
  const [stopping, setStopping] = useState(false)
  const draft = bindingDrafts[bindingKey]
  if (saved) {
    const decision = decisions.find((entry) => entry.id === saved.decisionId) ?? null
    const label = decision?.name ?? savedName ?? t('binding.hiddenDecision')
    const words = { yes: t('condition.yes'), no: t('condition.no'), none: t('condition.noAnswer') }
    const summary = decision ? conditionSummary(decision.question, saved.when, words) : ''
    const stop = () => {
      if (stopping) return
      setStopping(true)
      void Promise.resolve(onStop()).finally(() => setStopping(false))
    }
    return (
      <DecisionChip
        name={label}
        label={`${t('binding.editRules')}: ${label}`}
        title={summary ? `${t('binding.editRules')} · ${summary}` : t('binding.editRules')}
        disabled={disabled}
        openProps={{ 'data-gate-entry': bindingKey }}
        onOpen={() => {
          if (!draft) setBindingDraft(bindingKey, editDraftFor(saved, decision))
        }}
        remove={canWrite ? { label: t('binding.stop'), onClick: stop, busy: stopping } : undefined}
      />
    )
  }
  if (!offer || !canWrite) return null
  return (
    <DecisionChip
      name={null}
      label={t('binding.add')}
      title={t('binding.addTitle')}
      disabled={disabled}
      openProps={{ 'data-gate-entry': bindingKey }}
      onOpen={() =>
        setBindingDraft(bindingKey, (current) => current ?? { decisionId: null, when: null, phase: 'editing' })
      }
    />
  )
}

export function DecisionBindingStrip({
  bindingKey,
  conversation,
  canWrite: writable,
  agentName,
  channelName,
  padX,
  saved,
  savedName,
  status,
  onSave
}: {
  /** The gate's identity: organization, owning bot, and conversation (see `gateKey`). */
  bindingKey: string
  /** The live conversation Try and Recent evaluations read; null where none is addressable. */
  conversation: DecisionConversationRef | null
  canWrite: boolean
  /** The agent this conversation dispatches to — the gate's one fixed target. */
  agentName: string
  /** The conversation as its row reads, for the modal title and the Recent evaluations subtitle. */
  channelName?: string
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
  const { orgPath, myRole } = useOrgs()
  // Viewers read the gate and its Recent evaluations; editing and Try need write access.
  const canWrite = writable && myRole !== 'viewer'
  const pathname = usePathname()
  const search = useSearchParams()
  const { decisions, loading, reload, bindingDrafts, setBindingDraft, beginInlineCreate } = useDecisionsPrototype()
  const draft = bindingDrafts[bindingKey] ?? null
  const saving = useRef(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [tryOpen, setTryOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

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

  const busy = draft?.phase === 'saving'
  const collapse = useCallback(() => {
    setBindingDraft(bindingKey, null)
    requestAnimationFrame(() => focusEntry(bindingKey))
  }, [bindingKey, setBindingDraft])
  const open = draft !== null
  const chain = useDecisionChainHost()
  const { leave } = chain
  useEffect(() => {
    if (!open || busy || historyOpen) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !leave(false) && collapse()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, busy, historyOpen, collapse, leave])

  const historyLink = conversation && saved && (
    <button
      type="button"
      className="lnk gap-[6px] text-[11.5px] font-medium"
      aria-haspopup="dialog"
      onClick={() => setHistoryOpen(true)}
    >
      <Icon name="rotate-ccw-clock" size={12} />
      {t('evaluations.toggle')}
    </button>
  )
  const historyDrawer = conversation && historyOpen && (
    <DecisionEvaluationsDrawer
      conversation={conversation}
      {...(channelName ? { channelName } : {})}
      {...(agentName ? { agentName } : {})}
      onClose={() => setHistoryOpen(false)}
    />
  )

  const savedDecision = saved ? (decisions.find((entry) => entry.id === saved.decisionId) ?? null) : null
  const savedLabel = savedDecision?.name ?? savedName ?? t('binding.hiddenDecision')
  const edit = (pickAnother: boolean) => {
    if (saved) setBindingDraft(bindingKey, editDraftFor(saved, pickAnother ? null : savedDecision))
  }

  if (!draft) {
    // A ready gate reads from the row's pill alone; any other status explains itself under the row.
    if (!saved || !status || status === 'ready') return null
    const warning = WARNING_STATUS.has(status)
    return (
      <div
        role="status"
        className="flex flex-col gap-2 border-b border-(--border-subtle) bg-(--surface-sunken)"
        style={{ padding: `8px ${padX}px 10px ${padX + 22}px` }}
      >
        <span className="flex flex-wrap items-center gap-2">
          <span
            className={`badge flex-none ${
              warning ? 'bg-(--status-paused-soft) text-(--amber-500)' : 'bg-(--surface-active) text-(--text-secondary)'
            }`}
          >
            {t(`binding.status.${status}`)}
          </span>
          <span className="mono min-w-0 truncate text-[11.5px] text-(--text-primary)">{savedLabel}</span>
        </span>
        {warning ? (
          <span className="flex items-start gap-[9px] rounded-md border border-(--amber-500) bg-(--status-paused-soft) px-[13px] py-[10px] font-sans text-[12.5px] font-normal leading-[1.55]">
            <Icon name={STATUS_ICON[status]} size={14} className="mt-[2px] flex-none" />
            <span>{t(`binding.statusBody.${status}`, { decision: savedLabel })}</span>
          </span>
        ) : (
          <Note icon={STATUS_ICON[status]}>{t(`binding.statusBody.${status}`, { decision: savedLabel })}</Note>
        )}
        {status === 'needs_review' && (
          <span className="flex flex-wrap items-center gap-[14px]">
            {canWrite && (
              <button type="button" className="lnk" onClick={() => edit(false)}>
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
            <button type="button" className="lnk" onClick={() => edit(true)}>
              {t('binding.chooseAnother')}
            </button>
          </span>
        )}
      </div>
    )
  }

  const activeDraft = draft
  const decision = activeDraft.decisionId
    ? (decisions.find((entry) => entry.id === activeDraft.decisionId) ?? null)
    : null
  const awaiting = decision !== null && activeDraft.awaitingCondition === true && selectsNothing(activeDraft.when)
  const when = decision ? (activeDraft.when ?? (awaiting ? null : defaultConditionFor(decision))) : null
  const gate: ChannelDecisionGate | null =
    decision && when
      ? {
          type: 'gate',
          decisionId: decision.id,
          when,
          ...(draft.steps?.length ? { steps: draft.steps } : {}),
          ...(draft.nextStepId ? { nextStepId: draft.nextStepId } : {}),
          ...(draft.elseStepId ? { elseStepId: draft.elseStepId } : {})
        }
      : null
  const localIssues =
    gate && decision
      ? decisionGateIssues(decision.question, gate, new Map(decisions.map((d) => [d.id, d.question])))
      : gateIssues(decision, when)
  const serverIssues = activeDraft.error?.kind === 'invalid' ? activeDraft.error.issues : []
  const issues = localIssues.length ? localIssues : serverIssues
  const invalidText = decision
    ? awaiting
      ? t('binding.chooseCondition')
      : (localIssues[0]?.message ?? '')
    : t('binding.pickDecision')
  const returnTo = `${pathname}${search.toString() ? `?${search.toString()}` : ''}`

  // Every edit drops a failed save's error; a repair keeps waiting on the same Decision so un-toggling disables Save again.
  const change = (decisionId: string, next: DecisionCondition) => {
    const awaitingCondition = activeDraft.awaitingCondition === true && decisionId === activeDraft.decisionId
    setBindingDraft(bindingKey, {
      ...(decisionId === activeDraft.decisionId
        ? { steps: activeDraft.steps, nextStepId: activeDraft.nextStepId, elseStepId: activeDraft.elseStepId }
        : {}),
      decisionId,
      when: next,
      phase: 'editing',
      ...(awaitingCondition && { awaitingCondition })
    })
  }

  const save = async () => {
    if (saving.current || busy || !decision || !when || !gate || invalidText) return
    saving.current = true
    setBindingDraft(bindingKey, { ...activeDraft, decisionId: decision.id, when, phase: 'saving' })
    try {
      await onSave(gate)
      collapse()
    } catch (cause) {
      const error = bindingSaveError(cause)
      setBindingDraft(bindingKey, { ...activeDraft, decisionId: decision.id, when, phase: 'error', error })
      if (error.kind === 'decision_unavailable') void reload()
    } finally {
      saving.current = false
    }
  }

  const retryable = activeDraft.error?.kind === 'unsupported' || activeDraft.error?.kind === 'failed'
  const dialogLabel = channelName ? `${channelName} · ${t('binding.rulesTitleBare')}` : t('binding.rulesTitleBare')

  return createPortal(
    <>
      <div className="scrim" onClick={busy ? undefined : collapse}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label={dialogLabel}
          className="modal max-w-[720px]"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="modalhead">
            <Icon name="split" size={16} className="flex-none text-(--text-tertiary)" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-sans text-[16px] font-semibold leading-normal">
                {channelName
                  ? t.rich('binding.rulesTitle', {
                      channel: channelName,
                      name: (chunks) => <span className="mono">{chunks}</span>
                    })
                  : t('binding.rulesTitleBare')}
              </span>
              {agentName && (
                <span className="mt-[2px] block font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  {t.rich('binding.rulesSubtitle', {
                    agent: agentName,
                    name: (chunks) => <span className="mono text-(--text-secondary)">{chunks}</span>
                  })}
                </span>
              )}
            </span>
            <button type="button" className="iconbtn" aria-label={t('cancel')} disabled={busy} onClick={collapse}>
              <Icon name="x" size={16} />
            </button>
          </div>
          <div className="modalbody flex flex-col gap-3">
            <fieldset disabled={!canWrite || busy} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
              <div className="fld">
                <span className="fldlbl">{t('binding.decision')}</span>
                <div className="flex flex-wrap items-center gap-[9px]">
                  <DecisionPicker
                    decisions={decisions}
                    value={activeDraft.decisionId}
                    loading={loading}
                    disabled={!canWrite || busy}
                    triggerClassName="block w-[280px] min-w-0 max-w-full max-desktop:w-full"
                    // Re-picking the current Decision keeps the draft, so a repair is never reseeded with defaults.
                    onSelect={(entry) => {
                      if (entry.id !== activeDraft.decisionId) change(entry.id, defaultConditionFor(entry))
                    }}
                    create={{
                      href: `${orgPath('/decisions/new')}?returnTo=${encodeURIComponent(returnTo)}`,
                      onClick: () => beginInlineCreate(bindingKey)
                    }}
                  />
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
              ) : decision ? (
                <div className="fld">
                  <span className="fldlbl">{t('binding.triggerWhen')}</span>
                  <span className="flex flex-wrap items-center gap-[9px]">
                    <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                      {t('binding.noInterval')}
                    </span>
                    <button
                      type="button"
                      className="lnk text-[11.5px] font-medium"
                      onClick={() => change(decision.id, defaultConditionFor(decision))}
                    >
                      {t('binding.setInterval')}
                    </button>
                  </span>
                </div>
              ) : (
                <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  {loading ? t('loading') : decisions.length ? t('binding.pickDecision') : t('binding.noDecisions')}
                </span>
              )}
              {gate && (
                <DecisionChainHost value={chain.host}>
                  <GateChainFields
                    value={gate}
                    decisions={decisions}
                    disabled={!canWrite || busy}
                    onChange={(next) =>
                      setBindingDraft(bindingKey, {
                        decisionId: next.decisionId,
                        when: next.when,
                        steps: next.steps,
                        nextStepId: next.nextStepId,
                        elseStepId: next.elseStepId,
                        phase: 'editing'
                      })
                    }
                  />
                </DecisionChainHost>
              )}
            </fieldset>

            {awaiting && <Note icon="info">{invalidText}</Note>}

            {decision && invalidText && !awaiting && (
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
                  aria-expanded={helpOpen}
                  onClick={() => setHelpOpen((value) => !value)}
                >
                  <Icon name={helpOpen ? 'chevron-down' : 'chevron-right'} size={12} />
                  {t('binding.howThisWorks')}
                </button>
                {conversation && canWrite && (
                  <button
                    type="button"
                    className="lnk gap-[6px] text-[11.5px] font-medium"
                    aria-expanded={tryOpen}
                    onClick={() => setTryOpen((value) => !value)}
                  >
                    <Icon name={tryOpen ? 'chevron-down' : 'chevron-right'} size={12} />
                    {t('binding.tryMessage')}
                  </button>
                )}
              </div>
            )}

            {decision && helpOpen && (
              <div className="flex flex-col gap-1">
                <Note icon="messages-square">{t('binding.helpMentions')}</Note>
                <Note icon="clock">{t('binding.helpHistory')}</Note>
                <Note icon="shield-alert">{t('binding.helpUnavailable')}</Note>
              </div>
            )}

            {decision && when && conversation && canWrite && (
              <DecisionGateTry
                conversation={conversation}
                decision={decision}
                when={when}
                binding={gate ?? undefined}
                agentName={agentName}
                open={tryOpen}
              />
            )}

            <div className="flex flex-wrap items-center gap-[9px]">
              {canWrite && (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    className="max-desktop:flex-1"
                    disabled={chain.depth ? busy : !!invalidText || busy || !decision}
                    onClick={() => leave(true) || void save()}
                  >
                    {busy ? t('binding.saving') : t('save')}
                  </Button>
                  {retryable && (
                    <Button variant="secondary" size="sm" className="max-desktop:flex-1" onClick={() => void save()}>
                      {t('binding.retry')}
                    </Button>
                  )}
                </>
              )}
              <Button
                variant="secondary"
                size="sm"
                className="max-desktop:flex-1"
                disabled={busy}
                onClick={() => leave(false) || collapse()}
              >
                {canWrite ? t('cancel') : t('binding.close')}
              </Button>
              {historyLink}
            </div>
          </div>
        </div>
      </div>
      {historyDrawer}
    </>,
    document.body
  )
}
