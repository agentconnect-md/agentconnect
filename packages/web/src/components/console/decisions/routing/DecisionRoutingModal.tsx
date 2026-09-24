'use client'

// A shared bot's By decision rules, opened from one conversation row; saving routes that conversation by them (decisions.md §9.2).

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Button, Icon, Toggle } from '@/components/ui'
import { LoadingState } from '@/components/marks'
import { useOrgs } from '@/lib/org-context'
import { useDecisionsPrototype } from '@/lib/decisions/provider'
import { errorParts } from '@/lib/decisions/binding'
import {
  INITIAL_ROUTING_STATE,
  newRule,
  draftFromDetail,
  routingCanSave,
  routingDraftIssues,
  ruleNumbers,
  toSave,
  type RoutingDraftRule,
  type RoutingEvent,
  type RoutingIssue
} from '@/lib/decisions/routing-draft'
import { useRoutingRoster } from '@/lib/decisions/routing-roster'
import { DECISION_CHAIN_MAX_STEPS } from '@agentconnect.md/protocol/decision'
import { DecisionChainNav, RoutingChainContext, reachableSteps } from '../DecisionChainControls'
import { DecisionPicker } from '../DecisionPicker'
import { DecisionRoutingTry } from './DecisionRoutingTry'
import { DecisionRoutingEvaluationsDrawer } from './DecisionRoutingEvaluationsDrawer'
import { FieldIssue, Note, routingSaveError, saveErrorText } from './RoutingFields'
import { RoutingRulesTable, fitsQuestion } from './RoutingRulesTable'

/** Take one conversation out of a shared bot's routing, handing it back to @-mentions with its default agent, or `agentId`. */
export async function stopRouting(
  store: Pick<ReturnType<typeof useDecisionsPrototype>, 'api' | 'dispatchRouting'>,
  botId: string,
  channelId: string,
  agentId?: string
): Promise<void> {
  const detail = await store.api.getRouting(botId)
  if (!detail.channelIds.includes(channelId)) return
  const draft = draftFromDetail(detail)
  const body = toSave(
    {
      ...draft,
      channelIds: draft.channelIds.filter((id) => id !== channelId),
      removals: { [channelId]: { trigger: 'mention', ...(agentId ? { agentId } : {}) } }
    },
    detail.channelIds
  )
  if (!body) throw new Error('The saved routing could not be rewritten without this conversation.')
  store.dispatchRouting(botId, { type: 'SAVE_OK', detail: await store.api.saveRouting(botId, body) })
}

/** The search param an inline Create decision returns with, naming the row whose rules modal reopens. */
const RESUME_PARAM = 'decisionRouting'

/** The bot and conversation to reopen after an inline Create decision, if the URL carries one. */
export function readRoutingResume(): { botId: string; channelId: string } | null {
  if (typeof window === 'undefined') return null
  const raw = new URLSearchParams(window.location.search).get(RESUME_PARAM)
  const at = raw?.indexOf('|') ?? -1
  return raw && at > 0 ? { botId: raw.slice(0, at), channelId: raw.slice(at + 1) } : null
}

/** Drop the resume param once its row reopened, so a reload does not reopen it again. */
export function clearRoutingResume() {
  const url = new URL(window.location.href)
  url.searchParams.delete(RESUME_PARAM)
  window.history.replaceState(window.history.state, '', url)
}

export function DecisionRoutingModal({
  botId,
  channelId,
  channelName,
  resume = false,
  onClose
}: {
  botId: string
  channelId: string
  /** The conversation as its row reads. */
  channelName: string
  /** Reopened after an inline Create decision: keep the draft it returned to instead of starting from the saved routing. */
  resume?: boolean
  onClose: () => void
}) {
  const t = useTranslations('Decisions.routing')
  const tm = useTranslations('Decisions.routing.modal')
  const tDecisions = useTranslations('Decisions')
  const { orgPath, myRole } = useOrgs()
  const canWrite = myRole !== 'viewer'
  const pathname = usePathname()
  const search = useSearchParams()
  const { api, orgId, decisions, loading, reload, routingDrafts, routingKeyFor, dispatchRouting, beginInlineCreate } =
    useDecisionsPrototype()
  const roster = useRoutingRoster(botId)
  const state = routingDrafts[routingKeyFor(botId)] ?? INITIAL_ROUTING_STATE
  const dispatch = useCallback((event: RoutingEvent) => dispatchRouting(botId, event), [botId, dispatchRouting])
  const [stepPath, setStepPath] = useState<string[]>([])
  const [helpOpen, setHelpOpen] = useState(false)
  const [tryOpen, setTryOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const saving = useRef(false)
  const { data, error, mutate } = useSWR(orgId && botId ? ['decision-routing', api.mode, orgId, botId] : null, () =>
    api.getRouting(botId)
  )
  // The routing draft is bot-wide, so each opening starts from the saved state rather than another row's leftovers.
  const [fresh, setFresh] = useState(false)
  useEffect(() => {
    if (!data) return
    if (fresh) dispatch({ type: 'LOADED', detail: data })
    else {
      dispatch(resume && state.draft ? { type: 'LOADED', detail: data } : { type: 'RESET', detail: data })
      setFresh(true)
    }
  }, [data, fresh, dispatch])
  useEffect(() => {
    if (error) dispatch({ type: 'LOAD_FAIL', error })
  }, [error, dispatch])
  // Opening from a row puts that conversation in scope, so Save routes it; Cancel drops the addition with every other edit.
  const draft = fresh ? state.draft : null
  const inScope = draft?.channelIds.includes(channelId) ?? false
  useEffect(() => {
    if (draft && !inScope) dispatch({ type: 'ADD_CHANNEL', channelId })
  }, [draft, inScope, channelId, dispatch])

  const busy = state.phase === 'saving'
  const close = useCallback(() => {
    if (state.saved && state.phase !== 'saving') dispatch({ type: 'RESET', detail: state.saved })
    onClose()
  }, [state.saved, state.phase, dispatch, onClose])
  useEffect(() => {
    if (busy || historyOpen) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && close()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, historyOpen, close])

  const activeId = stepPath.at(-1)
  const activeStep = draft?.steps?.find((step) => step.id === activeId)
  const currentStep = activeStep ?? draft
  const rootDecision = decisions.find((entry) => entry.id === draft?.decisionId) ?? null
  const decision = decisions.find((entry) => entry.id === currentStep?.decisionId) ?? null
  const question = decision?.question ?? null
  const memberIds = useMemo(() => new Set(roster.agents.map((agent) => agent.id)), [roster.agents])
  const saved = state.saved
  const savedChannelIds = saved?.channelIds ?? []
  const localIssues = draft
    ? routingDraftIssues(draft, rootDecision?.question ?? null, {
        savedChannelIds,
        memberIds,
        questions: new Map(decisions.map((d) => [d.id, d.question]))
      })
    : []
  const serverError = state.phase === 'save_error' ? routingSaveError(state.error) : null
  const issues: RoutingIssue[] = localIssues.length
    ? localIssues
    : serverError?.kind === 'invalid'
      ? serverError.issues.map((issue) => ({ path: issue.path, message: issue.message }))
      : []
  const canSave = routingCanSave(state, localIssues, canWrite)
  const disabled = !canWrite || busy
  // Inline Create decision returns here with the row named, so its modal reopens on the same draft.
  const returnParams = new URLSearchParams(search.toString())
  returnParams.set(RESUME_PARAM, `${botId}|${channelId}`)
  const returnTo = `${pathname}?${returnParams.toString()}`
  const botName = roster.bot?.name ?? botId
  const botSettings = orgPath(`/integrations?bot=${encodeURIComponent(botId)}`)
  const names = new Map(roster.channels.map((channel) => [channel.channelId, channel.name]))
  const nameOf = (id: string) => names.get(id) ?? saved?.channels.find((c) => c.channelId === id)?.name ?? id
  const others = (draft?.channelIds ?? []).filter((id) => id !== channelId)

  const submit = async (body: ReturnType<typeof toSave>, retry = false) => {
    if (!body || saving.current) return
    saving.current = true
    dispatch(retry ? { type: 'RETRY' } : { type: 'SAVE_START', body })
    try {
      const detail = await api.saveRouting(botId, body)
      dispatch({ type: 'SAVE_OK', detail })
      void mutate(detail, { revalidate: false })
      roster.refresh()
      onClose()
    } catch (cause) {
      dispatch({ type: 'SAVE_FAIL', error: cause })
      if (routingSaveError(cause).kind === 'decision_missing') void reload()
    } finally {
      saving.current = false
    }
  }
  // A refusal (400) or a field issue would fail the same way again, so only transient failures offer Retry.
  const retryable =
    serverError !== null &&
    serverError.kind !== 'invalid' &&
    serverError.kind !== 'refused' &&
    state.lastAttempt !== null

  const edit = (patch: (rules: RoutingDraftRule[]) => RoutingDraftRule[]) =>
    dispatch({
      type: 'EDIT',
      patch: (current) =>
        activeStep
          ? {
              ...current,
              steps: current.steps?.map((step) =>
                step.id === activeStep.id ? { ...step, rules: patch(step.rules) } : step
              )
            }
          : { ...current, rules: patch(current.rules) }
    })
  const header = (
    <div className="modalhead">
      <Icon name="split" size={16} className="flex-none text-(--text-tertiary)" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-sans text-[16px] font-semibold leading-normal">
          {tDecisions.rich('binding.rulesTitle', {
            channel: channelName,
            name: (chunks) => <span className="mono">{chunks}</span>
          })}
        </span>
        <span className="mt-[2px] block truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {tm.rich('subtitle', {
            bot: botName,
            agents: roster.agents.map((agent) => agent.name).join(', '),
            name: (chunks) => <span className="mono text-(--text-secondary)">{chunks}</span>
          })}
        </span>
      </span>
      <button type="button" className="iconbtn" aria-label={t('footer.cancel')} disabled={busy} onClick={close}>
        <Icon name="x" size={16} />
      </button>
    </div>
  )

  let body: ReactNode
  if (state.phase !== 'load_error' && (roster.loading || !draft)) body = <LoadingState size={22} padding={30} />
  else if (state.phase === 'load_error' || !draft)
    body = (
      <div className="flex flex-col items-center gap-3 py-6 text-center font-sans text-[13px] text-(--text-tertiary)">
        <span>{t('loadError', { message: errorParts(state.error)?.message ?? String(state.error ?? '') })}</span>
        <Button variant="secondary" size="sm" onClick={() => void mutate()}>
          {t('retryLoad')}
        </Button>
      </div>
    )
  else {
    const paused = saved?.config?.enabled === false
    const readiness = saved?.config && !paused ? saved.readiness.status : null
    body = (
      <div className="flex flex-col gap-3">
        {!canWrite && <Note icon="lock">{t('readOnly')}</Note>}
        {/* The bot's whole routing pauses and resumes here; a paused one delivers nothing in its channels. */}
        <div className="flex items-start gap-3 rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[10px]">
          <Toggle
            checked={draft.enabled}
            disabled={disabled}
            ariaLabel={tm('enabled')}
            onChange={(enabled) => dispatch({ type: 'EDIT', patch: { enabled } })}
          />
          <span className="flex min-w-0 flex-col gap-[2px]">
            <span className="font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary)">
              {draft.enabled ? tm('enabled') : tm('pausedLabel')}
            </span>
            <span className="font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
              {paused && !draft.enabled ? tm('pausedHint') : tm('pauseHint')}
            </span>
          </span>
        </div>
        {readiness && readiness !== 'ready' && (
          <Note icon={readiness === 'daemon_offline' ? 'wifi-off' : 'triangle-alert'}>
            <b className="font-semibold text-(--text-secondary)">{t(`status.${readiness}`)}</b>
            {readiness === 'needs_review' && <> — {t('banner.needsReview')}</>}
          </Note>
        )}
        {!savedChannelIds.includes(channelId) && <Note icon="info">{tm('unsaved')}</Note>}
        {others.length > 0 && <Note icon="users">{tm('alsoApplies', { names: others.map(nameOf).join(', ') })}</Note>}

        {stepPath.length > 0 && (
          <DecisionChainNav
            path={[
              { id: '', name: rootDecision?.name ?? tDecisions('chain.first') },
              ...stepPath.map((id) => ({
                id,
                name:
                  decisions.find((d) => d.id === draft.steps?.find((s) => s.id === id)?.decisionId)?.name ??
                  tDecisions('chain.missing')
              }))
            ]}
            onBack={(index) => setStepPath(stepPath.slice(0, index))}
          />
        )}
        <div className="fld">
          <span className="fldlbl">{t('decision.label')}</span>
          <div className="flex flex-wrap items-center gap-[9px]">
            <DecisionPicker
              decisions={decisions}
              value={currentStep?.decisionId ?? null}
              placeholder={draft.decisionId ? t('decision.hidden') : t('decision.select')}
              loading={loading}
              disabled={disabled}
              triggerClassName="block w-[280px] min-w-0 max-w-full max-desktop:w-full"
              onSelect={(entry) => {
                if (entry.id === currentStep?.decisionId) return
                const next = decisions.find((item) => item.id === entry.id)
                // A rule whose condition the new question cannot answer is dropped, so a type switch starts clean.
                dispatch({
                  type: 'EDIT',
                  patch: (current) =>
                    activeStep
                      ? {
                          ...current,
                          steps: current.steps?.map((step) =>
                            step.id === activeStep.id
                              ? {
                                  ...step,
                                  decisionId: entry.id,
                                  rules: next ? step.rules.filter((rule) => fitsQuestion(rule.when, next.question)) : []
                                }
                              : step
                          )
                        }
                      : {
                          ...current,
                          decisionId: entry.id,
                          rules: next ? current.rules.filter((rule) => fitsQuestion(rule.when, next.question)) : []
                        }
                })
              }}
              create={{
                href: `${orgPath('/decisions/new')}?returnTo=${encodeURIComponent(returnTo)}`,
                onClick: () => beginInlineCreate({ kind: 'routing', botId })
              }}
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
          {issues.some((issue) => issue.code === 'decision_required') && (
            <FieldIssue>{t('decision.required')}</FieldIssue>
          )}
        </div>

        {question && (
          <RoutingChainContext.Provider
            value={{
              decisions,
              steps: draft.steps ?? [],
              canAdd:
                reachableSteps<{ rules: RoutingDraftRule[] }>(draft, draft.steps ?? [], (step) =>
                  step.rules.flatMap((rule) => (rule.action.type === 'decision' ? [rule.action.nextStepId] : []))
                ).length <
                DECISION_CHAIN_MAX_STEPS - 1,
              open: (id) => setStepPath([...stepPath, id]),
              add: (entry) => {
                const id = crypto.randomUUID()
                dispatch({
                  type: 'EDIT',
                  patch: (current) => ({
                    ...current,
                    steps: [
                      ...(current.steps ?? []),
                      { id, decisionId: entry.id, rules: [newRule(entry.question, [])] }
                    ]
                  })
                })
                setStepPath([...stepPath, id])
                return id
              }
            }}
          >
            <RoutingRulesTable
              question={question}
              rules={currentStep?.rules ?? []}
              otherwise={draft.otherwise}
              agents={roster.agents}
              issues={
                activeStep
                  ? issues
                      .filter(
                        (issue) => issue.path[0] === 'steps' && issue.path[1] === draft.steps?.indexOf(activeStep)
                      )
                      .map((issue) => ({ ...issue, path: issue.path.slice(2) }))
                  : issues
              }
              disabled={disabled}
              canWrite={canWrite}
              onRules={edit}
              onOtherwise={(otherwise) => dispatch({ type: 'EDIT', patch: { otherwise } })}
              onRefresh={roster.refresh}
            />
          </RoutingChainContext.Provider>
        )}

        {decision && (
          <div className="flex flex-wrap items-center gap-[14px]">
            <button
              type="button"
              className="lnk gap-[6px] text-[11.5px] font-medium"
              aria-expanded={helpOpen}
              onClick={() => setHelpOpen((open) => !open)}
            >
              <Icon name={helpOpen ? 'chevron-down' : 'chevron-right'} size={12} />
              {tDecisions('binding.howThisWorks')}
            </button>
            {canWrite && (
              <button
                type="button"
                className="lnk gap-[6px] text-[11.5px] font-medium"
                aria-expanded={tryOpen}
                onClick={() => setTryOpen((open) => !open)}
              >
                <Icon name={tryOpen ? 'chevron-down' : 'chevron-right'} size={12} />
                {tDecisions('binding.tryMessage')}
              </button>
            )}
          </div>
        )}
        {decision && helpOpen && (
          <div className="flex flex-col gap-1">
            <Note icon="messages-square">{t('notes.mentions')}</Note>
            <Note icon="git-branch">{t('notes.constrained')}</Note>
            <Note icon="clock">{t('notes.history')}</Note>
          </div>
        )}
        {rootDecision && canWrite && tryOpen && (
          <DecisionRoutingTry botId={botId} draft={draft} decision={rootDecision!} roster={roster} open={tryOpen} />
        )}

        {serverError && (
          <div
            role="alert"
            className="flex items-start gap-[9px] rounded-md border border-(--red-500) bg-(--status-error-soft) px-[13px] py-[10px] font-sans text-[12.5px] font-normal leading-[1.55]"
          >
            <Icon name="triangle-alert" size={14} className="mt-[2px] flex-none" />
            <span>{saveErrorText(t, serverError)}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-[9px]">
          {canWrite &&
            (retryable ? (
              <Button
                variant="primary"
                size="sm"
                className="max-desktop:flex-1"
                disabled={busy}
                onClick={() => void submit(state.lastAttempt, true)}
              >
                {t('footer.retry')}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                className="max-desktop:flex-1"
                disabled={!canSave}
                onClick={() => void submit(toSave(draft, savedChannelIds))}
              >
                {busy ? t('footer.saving') : t('footer.save')}
              </Button>
            ))}
          <Button variant="secondary" size="sm" className="max-desktop:flex-1" disabled={busy} onClick={close}>
            {canWrite ? t('footer.cancel') : tDecisions('binding.close')}
          </Button>
          {saved?.config && (
            <button
              type="button"
              className="lnk gap-[6px] text-[11.5px] font-medium"
              aria-haspopup="dialog"
              onClick={() => setHistoryOpen(true)}
            >
              <Icon name="rotate-ccw-clock" size={12} />
              {t('recentEvaluations')}
            </button>
          )}
          <span className="flex-1" />
          <Link href={botSettings} className="lnk text-[11.5px] font-medium">
            {tm('openBot')}
          </Link>
        </div>
      </div>
    )
  }

  const savedDecision = saved?.config
    ? (decisions.find((entry) => entry.id === saved.config!.decisionId) ?? null)
    : null
  return createPortal(
    <>
      <div className="scrim" onClick={busy ? undefined : close}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${channelName} · ${tDecisions('binding.rulesTitleBare')}`}
          className="modal max-w-[760px]"
          onClick={(event) => event.stopPropagation()}
        >
          {header}
          <div className="modalbody">{body}</div>
        </div>
      </div>
      {historyOpen && (
        <DecisionRoutingEvaluationsDrawer
          botId={botId}
          botName={botName}
          channels={(saved?.channels ?? []).map((channel) => ({
            channelId: channel.channelId,
            name: nameOf(channel.channelId)
          }))}
          agentNames={new Map(roster.agents.map((agent) => [agent.id, agent.name]))}
          ruleNumbers={ruleNumbers(savedDecision?.question ?? null, saved?.config?.rules ?? [])}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </>,
    document.body
  )
}
