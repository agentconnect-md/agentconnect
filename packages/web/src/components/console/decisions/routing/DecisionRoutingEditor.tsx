'use client'

// Shared Bot → Configuration → Routing: Enabled, Decision, Channels, Rules, Otherwise, and the footer (decisions.md §9.2).

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Icon, Toggle } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { AgentIconView } from '@/components/marks'
import { useOrgs } from '@/lib/org-context'
import { useDecisionsPrototype } from '@/lib/decisions/provider'
import { errorParts } from '@/lib/decisions/binding'
import {
  displayOrder,
  newRule,
  routingCanSave,
  routingDirty,
  routingDraftIssues,
  ruleIssues,
  scoreGaps,
  toSave,
  type RemovalTrigger,
  type RoutingDraftRule,
  type RoutingEditorState,
  type RoutingEvent,
  type RoutingIssue
} from '@/lib/decisions/routing-draft'
import type { RosterAgent, RoutingRoster } from '@/lib/decisions/routing-roster'
import type { DecisionDefinition, DecisionQuestion, DecisionValidationIssue } from '@agentconnect.md/protocol/decision'
import { DecisionConditionFields, intervalText } from '../DecisionConditionFields'

type T = ReturnType<typeof useTranslations<'Decisions.routing'>>

/** Why a routing save failed, in the terms the footer renders. */
export type RoutingSaveError =
  | { kind: 'invalid'; issues: DecisionValidationIssue[] }
  | { kind: 'forbidden' }
  | { kind: 'decision_missing' }
  | { kind: 'unsupported' }
  | { kind: 'conflict'; message: string }
  | { kind: 'failed'; message: string }

export function routingSaveError(cause: unknown): RoutingSaveError {
  const parts = errorParts(cause)
  if (!parts) return { kind: 'failed', message: cause instanceof Error ? cause.message : String(cause) }
  const issues = Array.isArray(parts.body.issues) ? (parts.body.issues as DecisionValidationIssue[]) : []
  if (parts.status === 400)
    return issues.length ? { kind: 'invalid', issues } : { kind: 'failed', message: parts.message }
  if (parts.status === 403) return { kind: 'forbidden' }
  if (parts.status === 404 && parts.code === 'DECISION_NOT_FOUND') return { kind: 'decision_missing' }
  if (parts.status === 409 && parts.code === 'DECISION_UNSUPPORTED_CONSUMER') return { kind: 'unsupported' }
  if (parts.status === 409) return { kind: 'conflict', message: parts.message }
  return { kind: 'failed', message: parts.message }
}

function saveErrorText(t: T, error: RoutingSaveError): string {
  if (error.kind === 'invalid') return t('saveError.invalid')
  if (error.kind === 'forbidden') return t('saveError.forbidden')
  if (error.kind === 'decision_missing') return t('saveError.decisionMissing')
  if (error.kind === 'unsupported') return t('saveError.unsupported')
  if (error.kind === 'conflict') return t('saveError.conflict', { message: error.message })
  return t('saveError.failed', { message: error.message })
}

function issueText(t: T, issue: RoutingIssue): string {
  if (issue.code === 'decision_required') return t('decision.required')
  if (issue.code === 'target_required') return t('action.targetRequired')
  if (issue.code === 'target_removed') return t('action.targetRemovedHint')
  if (issue.code === 'condition_required') return t('decision.typeChanged')
  if (issue.code === 'trigger_required') return t('removal.triggerRequired', { channel: String(issue.path[1] ?? '') })
  return issue.message ?? ''
}

function FieldIssue({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-[7px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--red-600)">
      <Icon name="triangle-alert" size={12} className="mt-[2px] flex-none" />
      <span>{children}</span>
    </div>
  )
}

function Note({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 font-sans text-[12px] font-normal leading-[1.55] text-(--text-tertiary)">
      <Icon name={icon} size={13} className="mt-[2px] flex-none" />
      <span>{children}</span>
    </div>
  )
}

/** One labelled region of the form; the label is the region's accessible name. */
function Region({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-2 border-b border-(--border-subtle) px-4 py-[14px] last:border-b-0"
    >
      <h3 id={id} className="m-0 font-sans text-[12px] font-semibold leading-normal text-(--text-secondary)">
        {label}
      </h3>
      {children}
    </section>
  )
}

/** A same-bot agent picker showing each agent's identity and availability. */
function AgentPicker({
  agents,
  value,
  label,
  placeholder,
  hiddenLabel,
  disabled,
  onChange
}: {
  agents: RosterAgent[]
  value: string | null
  label: string
  placeholder: string
  hiddenLabel: string
  disabled: boolean
  onChange: (agentId: string) => void
}) {
  const selected = value ? agents.find((agent) => agent.id === value) : undefined
  return (
    <AnchoredFlyout
      ariaLabel={label}
      align="start"
      width={260}
      estimatedHeight={10 + Math.max(1, agents.length) * 36}
      triggerClassName="inline-flex min-w-[200px] max-desktop:w-full max-desktop:min-w-0"
      trigger={({ open, menuId, toggle }) => (
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={toggle}
          className={`inp min-h-8 w-full justify-between gap-2 text-left ${disabled ? 'cursor-default opacity-60' : 'cursor-pointer'}`}
        >
          <span className="flex min-w-0 items-center gap-2 font-sans text-[12.5px] font-normal leading-normal">
            {selected && <AgentIconView icon={selected.icon} runtime={selected.runtime} size={16} />}
            <span className="truncate">{selected ? selected.name : value ? hiddenLabel : placeholder}</span>
          </span>
          <Icon name="chevron-down" size={14} color="var(--text-tertiary)" className="flex-none" />
        </button>
      )}
    >
      {({ close }) =>
        agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            role="menuitemradio"
            aria-checked={agent.id === value}
            className={agent.id === value ? 'fopt on' : 'fopt'}
            onClick={() => {
              close(true)
              onChange(agent.id)
            }}
          >
            <AgentIconView icon={agent.icon} runtime={agent.runtime} size={16} />
            <span className="min-w-0 flex-1 truncate">{agent.name}</span>
            <span
              className={`h-[7px] w-[7px] flex-none rounded-full ${agent.available ? 'bg-(--status-online)' : 'bg-(--gray-300)'}`}
              aria-hidden="true"
            />
          </button>
        ))
      }
    </AnchoredFlyout>
  )
}

function RuleRow({
  t,
  number,
  rule,
  question,
  issues,
  agents,
  disabled,
  onChange,
  onRemove,
  onRefresh
}: {
  t: T
  number: number
  rule: RoutingDraftRule
  question: DecisionQuestion | null
  issues: RoutingIssue[]
  agents: RosterAgent[]
  disabled: boolean
  onChange: (rule: RoutingDraftRule) => void
  onRemove: () => void
  onRefresh: () => void
}) {
  const whenIssues = issues
    .filter((issue) => issue.path[2] === 'when' && !issue.code)
    .map((issue) => ({ path: issue.path.slice(3), message: issue.message ?? '' }))
  const actionIssue = issues.find((issue) => issue.path[2] === 'action')
  const conditionMissing = issues.some((issue) => issue.code === 'condition_required')
  const targetId = rule.action.type === 'agent' ? rule.action.agentId : null
  const target = targetId ? agents.find((agent) => agent.id === targetId) : undefined
  const invalid = issues.length > 0
  return (
    <li
      data-testid="routing-rule"
      aria-label={t('rules.number', { number })}
      className={`grid grid-cols-1 gap-3 rounded-lg border bg-(--surface-card) p-3 desktop:grid-cols-[36px_minmax(0,1.3fr)_minmax(0,1fr)_32px] desktop:items-start desktop:rounded-none desktop:border-0 desktop:border-b desktop:border-(--border-subtle) desktop:bg-transparent desktop:px-0 desktop:py-3 ${
        invalid ? 'border-(--red-500)' : 'border-(--border-subtle)'
      }`}
    >
      <span className="flex items-center justify-between font-mono text-[12px] font-semibold leading-normal text-(--text-secondary) desktop:pt-1">
        {number}
        <button
          type="button"
          className="iconbtn h-7 w-7 desktop:hidden"
          title={t('rules.remove', { number })}
          aria-label={t('rules.remove', { number })}
          disabled={disabled}
          onClick={onRemove}
        >
          <Icon name="trash" size={13} />
        </button>
      </span>
      <div className="flex min-w-0 flex-col gap-[6px]">
        <span className="font-sans text-[11px] font-medium leading-normal text-(--text-tertiary)">
          {t('rules.when')}
        </span>
        {question && rule.when && rule.when.type === question.type ? (
          <DecisionConditionFields
            question={question}
            value={rule.when}
            onChange={(when) => onChange({ ...rule, when })}
            issues={whenIssues}
          />
        ) : (
          <FieldIssue>{conditionMissing || rule.when ? t('decision.typeChanged') : t('decision.required')}</FieldIssue>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-[6px]">
        <span className="font-sans text-[11px] font-medium leading-normal text-(--text-tertiary)">
          {t('rules.then')}
        </span>
        <select
          className="inp h-8 min-h-0"
          aria-label={t('action.label', { number })}
          value={rule.action.type}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...rule,
              action:
                event.target.value === 'skip'
                  ? { type: 'skip' }
                  : { type: 'agent', agentId: rule.action.type === 'agent' ? rule.action.agentId : null }
            })
          }
        >
          <option value="agent">{t('action.route')}</option>
          <option value="skip">{t('action.skip')}</option>
        </select>
        {rule.action.type === 'agent' && (
          <AgentPicker
            agents={agents}
            value={rule.action.agentId}
            label={t('action.agent', { number })}
            placeholder={t('action.selectAgent')}
            hiddenLabel={t('action.targetRemoved')}
            disabled={disabled}
            onChange={(agentId) => onChange({ ...rule, action: { type: 'agent', agentId } })}
          />
        )}
        {actionIssue && <FieldIssue>{issueText(t, actionIssue)}</FieldIssue>}
        {target && !target.available && (
          <span className="flex flex-wrap items-center gap-[6px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--amber-500)">
            <Icon name="wifi-off" size={12} />
            <b className="font-semibold">{t('action.targetUnavailable')}</b>
            <span className="text-(--text-tertiary)">{t('action.targetUnavailableHint')}</span>
            <button type="button" className="lnk" onClick={onRefresh}>
              {t('action.refresh')}
            </button>
          </span>
        )}
      </div>
      <span className="hidden justify-end desktop:flex">
        <button
          type="button"
          className="iconbtn h-7 w-7"
          title={t('rules.remove', { number })}
          aria-label={t('rules.remove', { number })}
          disabled={disabled}
          onClick={onRemove}
        >
          <Icon name="trash" size={13} />
        </button>
      </span>
    </li>
  )
}

export function DecisionRoutingEditor({
  botId,
  state,
  dispatch,
  roster,
  canWrite,
  testing,
  onToggleTest
}: {
  botId: string
  state: RoutingEditorState
  dispatch: (event: RoutingEvent) => void
  roster: RoutingRoster
  canWrite: boolean
  testing: boolean
  onToggleTest: () => void
}) {
  const t = useTranslations('Decisions.routing')
  const tDecisions = useTranslations('Decisions')
  const { orgPath } = useOrgs()
  const pathname = usePathname()
  const search = useSearchParams()
  const { api, decisions, loading, beginInlineCreate, reload } = useDecisionsPrototype()
  const [query, setQuery] = useState('')
  const saving = useRef(false)
  const draft = state.draft
  const saved = state.saved
  const decision: DecisionDefinition | null = draft?.decisionId
    ? (decisions.find((entry) => entry.id === draft.decisionId) ?? null)
    : null
  const question = decision?.question ?? null
  const memberIds = useMemo(() => new Set(roster.agents.map((agent) => agent.id)), [roster.agents])
  const savedChannelIds = saved?.channelIds ?? []
  const localIssues = draft ? routingDraftIssues(draft, question, { savedChannelIds, memberIds }) : []
  const serverError = state.phase === 'save_error' ? routingSaveError(state.error) : null
  const issues: RoutingIssue[] = localIssues.length
    ? localIssues
    : serverError?.kind === 'invalid'
      ? serverError.issues.map((issue) => ({ path: issue.path, message: issue.message }))
      : []
  const busy = state.phase === 'saving'
  const disabled = !canWrite || busy
  const dirty = routingDirty(state)
  const canSave = routingCanSave(state, localIssues, canWrite)
  const returnTo = `${pathname}${search.toString() ? `?${search.toString()}` : ''}`
  if (!draft) return null

  const names = new Map(roster.channels.map((channel) => [channel.channelId, channel.name]))
  const channelName = (id: string) => names.get(id) ?? saved?.channels.find((c) => c.channelId === id)?.name ?? id
  const groupChannels = roster.channels.filter((channel) => channel.kind !== 'im')
  const filtered = groupChannels.filter((channel) => channel.name.toLowerCase().includes(query.trim().toLowerCase()))
  const removed = savedChannelIds.filter((id) => !draft.channelIds.includes(id))
  const order = displayOrder(question, draft.rules)
  const gaps = scoreGaps(question, draft.rules)
  const settings = orgPath(`/integrations?bot=${encodeURIComponent(botId)}`)
  const defaultFor = (channelId: string) => {
    const described = saved?.channels.find((c) => c.channelId === channelId)?.defaultAgent
    const id = described?.id ?? roster.channels.find((c) => c.channelId === channelId)?.defaultAgentId ?? null
    if (!id) return null
    return described?.name ?? roster.agents.find((agent) => agent.id === id)?.name ?? t('action.hiddenAgent')
  }

  const submit = async (body: ReturnType<typeof toSave>, retry = false) => {
    if (!body || saving.current) return
    saving.current = true
    dispatch(retry ? { type: 'RETRY' } : { type: 'SAVE_START', body })
    try {
      dispatch({ type: 'SAVE_OK', detail: await api.saveRouting(botId, body) })
    } catch (cause) {
      dispatch({ type: 'SAVE_FAIL', error: cause })
      if (routingSaveError(cause).kind === 'decision_missing') void reload()
    } finally {
      saving.current = false
    }
  }
  const save = () => void submit(toSave(draft, savedChannelIds))
  const retry = () => void submit(state.lastAttempt, true)
  const retryable = serverError !== null && serverError.kind !== 'invalid' && state.lastAttempt !== null

  const status = busy
    ? t('footer.saving')
    : state.phase === 'saved'
      ? t('footer.saved')
      : !saved?.config
        ? t('footer.newDraft')
        : dirty
          ? localIssues.length
            ? t('footer.invalid')
            : t('footer.unsaved')
          : ''

  return (
    <div className="card flex flex-col p-0" data-testid="routing-editor">
      <Region id="routing-enabled" label={t('enabled.label')}>
        <div className="flex items-start gap-3">
          <Toggle
            checked={draft.enabled}
            disabled={disabled}
            ariaLabel={t('enabled.label')}
            onChange={(enabled) => dispatch({ type: 'EDIT', patch: { enabled } })}
          />
          <span className="font-sans text-[12px] font-normal leading-[1.55] text-(--text-tertiary)">
            {t('enabled.pauseHint')}
          </span>
        </div>
      </Region>

      <Region id="routing-decision" label={t('decision.label')}>
        <div className="flex flex-wrap items-center gap-[9px]">
          <AnchoredFlyout
            ariaLabel={t('decision.label')}
            align="start"
            width={280}
            estimatedHeight={10 + Math.max(1, decisions.length) * 44}
            triggerClassName="inline-flex min-w-[240px] max-desktop:w-full max-desktop:min-w-0"
            trigger={({ open, menuId, toggle }) => (
              <button
                type="button"
                aria-label={t('decision.label')}
                disabled={disabled}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? menuId : undefined}
                onClick={toggle}
                className={`inp min-h-8 w-full justify-between gap-2 text-left ${disabled ? 'cursor-default opacity-60' : 'cursor-pointer'}`}
              >
                <span className="truncate font-sans text-[12.5px] font-normal leading-normal">
                  {decision?.name ?? (draft.decisionId ? t('decision.hidden') : t('decision.select'))}
                </span>
                <Icon name="chevron-down" size={14} color="var(--text-tertiary)" className="flex-none" />
              </button>
            )}
          >
            {({ close }) => (
              <>
                {loading ? (
                  <div className="px-[9px] py-[7px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                    {tDecisions('loading')}
                  </div>
                ) : (
                  decisions.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={entry.id === draft.decisionId}
                      className={entry.id === draft.decisionId ? 'fopt on' : 'fopt'}
                      onClick={() => {
                        close(true)
                        if (entry.id !== draft.decisionId) dispatch({ type: 'SELECT_DECISION', decisionId: entry.id })
                      }}
                    >
                      <span className="flex min-w-0 flex-1 flex-col items-start">
                        <span className="truncate">{entry.name}</span>
                        <span className="mono text-[11px] text-(--text-tertiary)">
                          {t('decision.summary', {
                            type: tDecisions(`types.${entry.question.type}`),
                            model: entry.model
                          })}
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
                    beginInlineCreate({ kind: 'routing', botId })
                    close()
                  }}
                >
                  <Icon name="plus" size={15} color="var(--text-tertiary)" />
                  {t('decision.create')}
                </Link>
              </>
            )}
          </AnchoredFlyout>
          {decision && (
            <>
              <span className="mono text-[11px] text-(--text-tertiary)">
                {t('decision.summary', { type: tDecisions(`types.${decision.question.type}`), model: decision.model })}
              </span>
              <Link
                href={orgPath(`/decisions/${encodeURIComponent(decision.id)}`)}
                className="lnk gap-[6px] text-[11.5px] font-medium"
              >
                <Icon name="pencil" size={12} />
                {decision.canEdit === false ? t('decision.view') : t('decision.edit')}
              </Link>
            </>
          )}
        </div>
        {issues.some((issue) => issue.code === 'decision_required') && (
          <FieldIssue>{t('decision.required')}</FieldIssue>
        )}
      </Region>

      <Region id="routing-channels" label={t('channels.label')}>
        {groupChannels.length === 0 ? (
          <Note icon="info">{t('channels.noEligible')}</Note>
        ) : (
          <>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('channels.search')}
              aria-label={t('channels.search')}
              className="inp h-8 min-h-0 w-full desktop:max-w-[320px]"
            />
            <ul className="m-0 flex max-h-[260px] list-none flex-col overflow-y-auto rounded-md border border-(--border-subtle) p-0">
              {filtered.map((channel) => {
                const checked = draft.channelIds.includes(channel.channelId)
                const off = channel.trigger === 'off' && !checked
                const gate = channel.binding === 'gate'
                return (
                  <li
                    key={channel.channelId}
                    className="flex flex-wrap items-center gap-2 border-b border-(--border-subtle) px-3 py-2 last:border-b-0"
                  >
                    <label
                      className={`flex min-w-0 flex-1 items-center gap-2 font-sans text-[12.5px] font-normal leading-normal ${off ? 'text-(--text-tertiary)' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled || off}
                        onChange={() => dispatch({ type: 'TOGGLE_CHANNEL', channelId: channel.channelId })}
                      />
                      <span className="mono truncate">{channel.name}</span>
                    </label>
                    {off && (
                      <>
                        <span className="badge bg-(--surface-active) text-(--text-tertiary)">
                          {t('channels.offRow')}
                        </span>
                        <Link href={settings} className="lnk text-[11.5px] font-medium">
                          {t('channels.enableFirst')}
                        </Link>
                      </>
                    )}
                    {gate && !checked && (
                      <span className="w-full font-sans text-[11px] font-normal leading-[1.45] text-(--text-tertiary)">
                        {t('channels.gateRow')}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
          <span>{t('channels.count', { count: draft.channelIds.length })}</span>
          {draft.channelIds.length > 0 ? (
            <span className="text-(--text-tertiary)">
              {t('channels.applyNote', { names: draft.channelIds.map(channelName).join(', ') })}
            </span>
          ) : (
            <span className="text-(--text-tertiary)">{t('channels.none')}</span>
          )}
          <Link href={settings} className="lnk text-[11.5px] font-medium">
            {t('channels.manage')}
          </Link>
        </div>
        {removed.map((channelId) => {
          const removal = draft.removals[channelId] ?? { trigger: null }
          const missing = issues.some((issue) => issue.code === 'trigger_required' && issue.path[1] === channelId)
          return (
            <fieldset
              key={channelId}
              data-testid="routing-removal"
              className="m-0 flex flex-col gap-2 rounded-md border border-(--amber-500) bg-(--status-paused-soft) px-3 py-[10px]"
            >
              <legend className="px-1 font-sans text-[12px] font-semibold leading-normal">
                {t('removal.title', { channel: channelName(channelId) })}
              </legend>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 font-sans text-[12px] font-normal leading-normal">
                  {t('removal.trigger')}
                  <select
                    className="inp h-8 min-h-0"
                    value={removal.trigger ?? ''}
                    disabled={disabled}
                    onChange={(event) =>
                      dispatch({
                        type: 'SET_REMOVAL',
                        channelId,
                        removal: { ...removal, trigger: (event.target.value || null) as RemovalTrigger | null }
                      })
                    }
                  >
                    <option value="" disabled>
                      {t('removal.trigger')}
                    </option>
                    {(['off', 'mention', 'auto'] as const).map((trigger) => (
                      <option key={trigger} value={trigger}>
                        {t(`removal.triggers.${trigger}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2 font-sans text-[12px] font-normal leading-normal">
                  {t('removal.defaultAgent')}
                  <select
                    className="inp h-8 min-h-0"
                    value={removal.agentId ?? ''}
                    disabled={disabled}
                    onChange={(event) => {
                      const { agentId: _previous, ...rest } = removal
                      dispatch({
                        type: 'SET_REMOVAL',
                        channelId,
                        removal: event.target.value ? { ...rest, agentId: event.target.value } : rest
                      })
                    }}
                  >
                    <option value="">{t('removal.keep')}</option>
                    {roster.agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {missing && <FieldIssue>{t('removal.triggerRequired', { channel: channelName(channelId) })}</FieldIssue>}
            </fieldset>
          )
        })}
      </Region>

      <Region id="routing-rules" label={t('rules.title')}>
        {question?.type === 'choice' && <Note icon="info">{t('rules.choiceHint')}</Note>}
        {question?.type === 'score' && <Note icon="info">{t('rules.scoreHint')}</Note>}
        {draft.rules.length === 0 ? (
          <Note icon="list">{t('rules.empty')}</Note>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-2 p-0 desktop:gap-0">
            {order.map((index, position) => {
              const rule = draft.rules[index]!
              return (
                <RuleRow
                  key={rule.id}
                  t={t}
                  number={position + 1}
                  rule={rule}
                  question={question}
                  issues={ruleIssues(issues, index)}
                  agents={roster.agents}
                  disabled={disabled}
                  onChange={(next) =>
                    dispatch({
                      type: 'EDIT',
                      patch: (current) => ({
                        ...current,
                        rules: current.rules.map((r) => (r.id === next.id ? next : r))
                      })
                    })
                  }
                  onRemove={() => dispatch({ type: 'REMOVE_RULE', id: rule.id })}
                  onRefresh={roster.refresh}
                />
              )
            })}
          </ol>
        )}
        {question?.type === 'score' &&
          gaps.map((gap) => (
            <Note key={`${gap.min}-${gap.max}`} icon="minus">
              {t('rules.gap', {
                interval: intervalText({ type: 'score', min: gap.min, max: gap.max }, question.criteria.length)
              })}
            </Note>
          ))}
        {question?.type === 'choice' && draft.rules.length > 1 && <Note icon="users">{t('rules.dedupe')}</Note>}
        {canWrite && (
          <button
            type="button"
            className="lnk self-start gap-[6px] text-[12.5px] font-medium"
            disabled={busy || !question}
            onClick={() => dispatch({ type: 'ADD_RULE', rule: newRule(question, draft.rules) })}
          >
            <Icon name="plus" size={14} />
            {t('rules.add')}
          </button>
        )}
      </Region>

      <Region id="routing-otherwise" label={t('otherwise.label')}>
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="inp h-8 min-h-0"
            aria-label={t('otherwise.label')}
            value={draft.otherwise}
            disabled={disabled}
            onChange={(event) =>
              dispatch({
                type: 'EDIT',
                patch: { otherwise: event.target.value === 'default_agent' ? 'default_agent' : 'skip' }
              })
            }
          >
            <option value="default_agent">{t('otherwise.default')}</option>
            <option value="skip">{t('otherwise.skip')}</option>
          </select>
          <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            {t('otherwise.appliesHint')}
          </span>
        </div>
        {draft.otherwise === 'default_agent' && draft.channelIds.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="routing-otherwise-defaults">
            {draft.channelIds.map((channelId) => (
              <li key={channelId} className="mono text-[11.5px] text-(--text-secondary)">
                {t('otherwise.perChannel', {
                  channel: channelName(channelId),
                  agent: defaultFor(channelId) ?? t('otherwise.noDefault')
                })}
              </li>
            ))}
          </ul>
        )}
      </Region>

      <div className="flex flex-col gap-1 border-b border-(--border-subtle) px-4 py-3">
        <Note icon="messages-square">{t('notes.mentions')}</Note>
        <Note icon="git-branch">{t('notes.constrained')}</Note>
        <Note icon="clock">{t('notes.history')}</Note>
      </div>

      {serverError && (
        <div
          role="alert"
          className="mx-4 mt-3 flex items-start gap-[9px] rounded-md border border-(--red-500) bg-(--status-error-soft) px-[13px] py-[10px] font-sans text-[12.5px] font-normal leading-[1.55]"
        >
          <Icon name="triangle-alert" size={14} className="mt-[2px] flex-none" />
          <span className="flex flex-col gap-1">
            <span>{saveErrorText(t, serverError)}</span>
            {state.lastAttempt && <span className="text-(--text-secondary)">{t('saveError.keptDecision')}</span>}
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        {canWrite && (
          <Button variant="secondary" size="sm" ariaExpanded={testing} onClick={onToggleTest} disabled={!decision}>
            <Icon name="play" size={14} />
            {t('footer.test')}
          </Button>
        )}
        <span
          role="status"
          className="min-w-0 flex-1 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)"
        >
          {status}
        </span>
        {canWrite && (
          <>
            <Button
              variant="secondary"
              size="sm"
              className="max-desktop:flex-1"
              disabled={busy || !dirty || !saved?.config}
              onClick={() => dispatch({ type: 'CANCEL' })}
            >
              {t('footer.cancel')}
            </Button>
            {retryable ? (
              <Button variant="primary" size="sm" className="max-desktop:flex-1" disabled={busy} onClick={retry}>
                {t('footer.retry')}
              </Button>
            ) : (
              <Button variant="primary" size="sm" className="max-desktop:flex-1" disabled={!canSave} onClick={save}>
                {busy ? t('footer.saving') : t('footer.save')}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
