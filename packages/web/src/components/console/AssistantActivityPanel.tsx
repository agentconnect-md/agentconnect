'use client'

// The Activity view of an assistant-mode agent (assistant-mode.md §1.7, §5.11): its items, sub-sessions, what waits for approval, and post grants.
import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import useSWR from 'swr'
import {
  ApiError,
  decideAgentPermissionRequest,
  decideAssistantDraft,
  deleteAssistantItem,
  fetchAssistantDrafts,
  fetchAssistantGrants,
  fetchAssistantItem,
  fetchAssistantItems,
  fetchAssistantSubsessions,
  memberDisplayName,
  revokeAssistantGrant,
  type AgentPermissionOptionDto,
  type AssistantDraftDecision,
  type AssistantDraftDto,
  type AssistantDraftOutcomeDto,
  type AssistantGrantDto,
  type AssistantItemDto,
  type AssistantItemStatus,
  type AssistantPermissionRequestDto,
  type AssistantSubsessionDto
} from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { chatPlatformName, chatRoomSigil } from '@/lib/platform-labels'
import { consoleKeys } from '@/lib/swr-keys'
import { Button, Icon } from '@/components/ui'

const REFRESH_MS = 30_000

const ITEM_STATUS_CLASS: Record<AssistantItemStatus, string> = {
  active: 'bg-(--status-online-soft) text-(--status-online-text)',
  waiting: 'bg-(--status-paused-soft) text-(--status-paused)',
  done: 'bg-(--surface-active) text-(--text-tertiary)',
  dropped: 'bg-(--surface-active) text-(--text-tertiary)'
}

const SUBSESSION_STATE_CLASS: Record<AssistantSubsessionDto['state'], string> = {
  open: 'bg-(--status-info-soft) text-(--status-info)',
  done: 'bg-(--status-online-soft) text-(--status-online-text)',
  failed: 'bg-(--status-error-soft) text-(--status-error)'
}

type Translate = ReturnType<typeof useTranslations<'Agents.detail.activity'>>

/** How an answer to a sub-session's permission request ended here; `gone` is one another surface answered first. */
type PermissionResult = 'allowed' | 'denied' | 'gone'

/** How a decision on a draft ended: its outcome, why the daemon refused it, sent without an answer, or a proposal left waiting at the sub-session limit. */
type DraftResult =
  | { outcome: AssistantDraftOutcomeDto }
  | { refused: 'expired' | 'decided' | 'gone' }
  | { unconfirmed: true }
  | { busy: string }

const DRAFT_REFUSALS: Record<string, 'expired' | 'decided'> = {
  DRAFT_EXPIRED: 'expired',
  DRAFT_ALREADY_DECIDED: 'decided'
}

/** Names a conversation from the agent's integrations; webchat and unknown rows fall back to the platform and id. */
function usePlaceLabel(
  agentId: string
): (place: { platform?: string; channel: string; integrationId?: string | null }) => string {
  const t = useTranslations('Agents.detail.activity')
  const { integrations } = useConsoleData()
  return ({ platform, channel, integrationId }) => {
    const own = integrations.filter((i) => (integrationId ? i.id === integrationId : i.platform === platform))
    const ranked = [...own.filter((i) => i.agentId === agentId), ...own.filter((i) => i.agentId !== agentId)]
    for (const integration of ranked) {
      const row = integration.channels.find((c) => c.channelId === channel)
      if (!row) continue
      if (row.kind === 'im') return t('dmWith', { name: row.name })
      return row.kind === 'mpim' ? row.name : `${chatRoomSigil(integration.platform)}${row.name}`
    }
    const known = platform ?? ranked[0]?.platform
    if (known === 'webchat') return t('webchat')
    return known ? `${chatPlatformName(known, known)} · ${channel}` : channel
  }
}

function errorText(t: Translate, error: unknown): string {
  return error instanceof ApiError && error.code === 'DAEMON_FEATURE_MISSING' ? t('upgradeDaemon') : t('unavailable')
}

function Section({
  title,
  count,
  children,
  kind
}: {
  title: string
  count?: number
  children: ReactNode
  kind: string
}) {
  return (
    <section className="card overflow-hidden max-desktop:rounded-lg desktop:max-w-[880px]" data-activity-section={kind}>
      <div className="flex items-center gap-2 border-b border-(--border-subtle) px-4 py-3 font-sans text-[14px] font-semibold leading-normal desktop:py-[13px]">
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {count !== undefined && count > 0 ? (
          <span className="badge flex-none bg-(--surface-active) text-(--text-tertiary)">{count}</span>
        ) : null}
      </div>
      {children}
    </section>
  )
}

function Quiet({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-3 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
      {children}
    </div>
  )
}

/** An inline confirm strip, one responsive row: it wraps under the row's text on a phone. */
function ConfirmStrip({
  prompt,
  confirm,
  keep,
  busy,
  onConfirm,
  onKeep,
  tone = 'danger'
}: {
  prompt: string
  confirm: string
  keep: string
  busy: boolean
  onConfirm: () => void
  onKeep: () => void
  tone?: 'danger' | 'primary'
}) {
  return (
    <div
      role="group"
      className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-(--surface-sunken) px-3 py-2 font-sans text-[12.5px] font-normal leading-normal text-(--text-primary)"
    >
      <span className="min-w-0 flex-1">{prompt}</span>
      <Button variant={tone} size="xs" disabled={busy} onClick={onConfirm}>
        {confirm}
      </Button>
      <Button variant="secondary" size="xs" disabled={busy} onClick={onKeep}>
        {keep}
      </Button>
    </div>
  )
}

export function AssistantActivityPanel({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const t = useTranslations('Agents.detail.activity')
  const { activeOrg } = useOrgs()
  const orgId = activeOrg?.id
  const [closedOpen, setClosedOpen] = useState(false)

  const open = useSWR(
    consoleKeys.assistantItems(orgId, agentId, 'open'),
    ([, , , id]) => fetchAssistantItems(id as string, 'open'),
    { refreshInterval: REFRESH_MS, shouldRetryOnError: false }
  )
  const closed = useSWR(
    closedOpen ? consoleKeys.assistantItems(orgId, agentId, 'closed') : null,
    ([, , , id]) => fetchAssistantItems(id as string, 'closed'),
    { shouldRetryOnError: false }
  )
  const subsessions = useSWR(
    consoleKeys.assistantSubsessions(orgId, agentId),
    ([, , , id]) => fetchAssistantSubsessions(id as string),
    { refreshInterval: REFRESH_MS, shouldRetryOnError: false }
  )
  const drafts = useSWR(
    canEdit ? consoleKeys.assistantDrafts(orgId, agentId) : null,
    ([, , , id]) => fetchAssistantDrafts(id as string),
    { refreshInterval: REFRESH_MS, shouldRetryOnError: false }
  )
  const grants = useSWR(
    canEdit ? consoleKeys.assistantGrants(orgId, agentId) : null,
    ([, , , id]) => fetchAssistantGrants(id as string),
    { shouldRetryOnError: false }
  )

  const removeItem = async (itemId: string) => {
    await deleteAssistantItem(agentId, itemId)
    const drop = (page?: { items: AssistantItemDto[]; truncated: boolean }) =>
      page && { ...page, items: page.items.filter((item) => item.id !== itemId) }
    await Promise.all([open.mutate(drop, { revalidate: false }), closed.mutate(drop, { revalidate: false })])
  }

  const revokeGrant = async (grantId: string) => {
    await revokeAssistantGrant(agentId, grantId)
    await grants.mutate((page) => page && { ...page, grants: page.grants.filter((grant) => grant.id !== grantId) }, {
      revalidate: false
    })
  }

  // A decided or unconfirmed draft keeps its row and what happened, even after a refresh stops listing it.
  const [decided, setDecided] = useState<Record<string, { draft: AssistantDraftDto; result: DraftResult }>>({})
  const pendingDrafts = drafts.data?.drafts ?? []
  const pendingIds = new Set(pendingDrafts.map((draft) => draft.id))
  const draftRows = [
    ...pendingDrafts,
    ...Object.values(decided)
      .map((entry) => entry.draft)
      .filter((draft) => !pendingIds.has(draft.id))
  ]
  const settledHere = (id: string) => {
    const result = decided[id]?.result
    return result !== undefined && !('unconfirmed' in result) && !('busy' in result)
  }
  // A sub-session's permission request answered here keeps its row and what happened, like a draft.
  const [answered, setAnswered] = useState<
    Record<string, { request: AssistantPermissionRequestDto; result: PermissionResult }>
  >({})
  const pendingPermissions = drafts.data?.permissionRequests ?? []
  const pendingPermissionIds = new Set(pendingPermissions.map((request) => request.requestId))
  const permissionRows = [
    ...pendingPermissions,
    ...Object.values(answered)
      .map((entry) => entry.request)
      .filter((request) => !pendingPermissionIds.has(request.requestId))
  ]
  const waiting =
    pendingDrafts.filter((draft) => !settledHere(draft.id)).length +
    pendingPermissions.filter((request) => !answered[request.requestId]).length

  const decidePermission = async (
    request: AssistantPermissionRequestDto,
    decision: 'allow' | 'deny',
    optionId?: string
  ) => {
    const settle = (result: PermissionResult) =>
      setAnswered((prev) => ({ ...prev, [request.requestId]: { request, result } }))
    try {
      await decideAgentPermissionRequest(agentId, request.requestId, decision, optionId)
      settle(decision === 'allow' ? 'allowed' : 'denied')
    } catch (err) {
      // Answered elsewhere first, or its sub-session ended: whichever surface answered first won.
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        settle('gone')
        void drafts.mutate()
        return
      }
      throw err
    }
  }

  const decideDraft = async (draft: AssistantDraftDto, decision: AssistantDraftDecision) => {
    const settle = (result: DraftResult) => setDecided((prev) => ({ ...prev, [draft.id]: { draft, result } }))
    try {
      settle({ outcome: await decideAssistantDraft(agentId, draft.id, decision) })
    } catch (err) {
      const refused = err instanceof ApiError ? DRAFT_REFUSALS[err.code ?? ''] : undefined
      if (refused) return settle({ refused })
      // The agent runs as many sub-sessions as it may: the proposal keeps waiting, and says why.
      if (err instanceof ApiError && err.code === 'SUBSESSION_LIMIT') return settle({ busy: err.message })
      if (err instanceof ApiError && err.status === 404) return settle({ refused: 'gone' })
      if (err instanceof ApiError && err.code === 'DECISION_UNCONFIRMED') {
        // It may have posted without an answer: keep the row and its warning, and read the list again.
        settle({ unconfirmed: true })
        void drafts.mutate()
        return
      }
      throw err
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 desktop:gap-[18px] desktop:p-0" data-assistant-activity>
      <Section title={t('items.title')} count={open.data?.items.length} kind="items">
        <Listing state={open} count={open.data?.items.length} truncated={open.data?.truncated} empty={t('items.empty')}>
          {open.data?.items.map((item, i) => (
            <ItemRow
              key={item.id}
              agentId={agentId}
              item={item}
              first={i === 0}
              canEdit={canEdit}
              onDelete={removeItem}
            />
          ))}
        </Listing>
        <button
          type="button"
          aria-expanded={closedOpen}
          onClick={() => setClosedOpen((v) => !v)}
          className="flex w-full cursor-pointer items-center gap-2 border-t border-(--border-subtle) bg-transparent px-4 py-[10px] text-left font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)"
        >
          <Icon name={closedOpen ? 'chevron-down' : 'chevron-right'} size={14} />
          {t('items.closed')}
        </button>
        {closedOpen ? (
          <Listing
            state={closed}
            count={closed.data?.items.length}
            truncated={closed.data?.truncated}
            empty={t('items.closedEmpty')}
          >
            {closed.data?.items.map((item, i) => (
              <ItemRow
                key={item.id}
                agentId={agentId}
                item={item}
                first={i === 0}
                canEdit={canEdit}
                onDelete={removeItem}
              />
            ))}
          </Listing>
        ) : null}
      </Section>

      <Section title={t('subsessions.title')} count={subsessions.data?.subsessions.length} kind="subsessions">
        <Listing
          state={subsessions}
          count={subsessions.data?.subsessions.length}
          truncated={subsessions.data?.truncated}
          empty={t('subsessions.empty')}
        >
          {subsessions.data?.subsessions.map((s, i) => (
            <SubsessionRow key={`${s.sessionId ?? 'hidden'}:${s.startedAt}:${i}`} subsession={s} first={i === 0} />
          ))}
        </Listing>
      </Section>

      {canEdit ? (
        <Section title={t('drafts.title')} count={waiting} kind="drafts">
          <Listing
            state={drafts}
            count={permissionRows.length + draftRows.length}
            truncated={drafts.data?.truncated}
            empty={t('drafts.empty')}
          >
            {permissionRows.map((request, i) => (
              <PermissionRequestRow
                key={request.requestId}
                request={request}
                first={i === 0}
                result={answered[request.requestId]?.result}
                onDecide={decidePermission}
              />
            ))}
            {draftRows.map((draft, i) => (
              <DraftRow
                key={draft.id}
                agentId={agentId}
                draft={draft}
                first={i === 0 && permissionRows.length === 0}
                result={decided[draft.id]?.result}
                pending={pendingIds.has(draft.id)}
                onDecide={decideDraft}
              />
            ))}
          </Listing>
        </Section>
      ) : null}

      {canEdit ? (
        <Section title={t('grants.title')} count={grants.data?.grants.length} kind="grants">
          <Listing
            state={grants}
            count={grants.data?.grants.length}
            truncated={grants.data?.truncated}
            empty={t('grants.empty')}
          >
            {grants.data?.grants.map((grant, i) => (
              <GrantRow key={grant.id} agentId={agentId} grant={grant} first={i === 0} onRevoke={revokeGrant} />
            ))}
          </Listing>
        </Section>
      ) : null}
    </div>
  )
}

/** One section's body: its rows once read, else why not, and a note when the daemon held more. */
function Listing({
  state,
  count,
  truncated,
  empty,
  children
}: {
  state: { data?: unknown; error?: unknown }
  count: number | undefined
  truncated: boolean | undefined
  empty: string
  children: ReactNode
}) {
  const t = useTranslations('Agents.detail.activity')
  if (state.error && state.data === undefined) return <Quiet>{errorText(t, state.error)}</Quiet>
  if (state.data === undefined) return <Quiet>{t('loading')}</Quiet>
  return (
    <>
      {count ? <div>{children}</div> : <Quiet>{empty}</Quiet>}
      {truncated ? <Quiet>{t('more')}</Quiet> : null}
    </>
  )
}

function ItemRow({
  agentId,
  item,
  first,
  canEdit,
  onDelete
}: {
  agentId: string
  item: AssistantItemDto
  first: boolean
  canEdit: boolean
  onDelete: (itemId: string) => Promise<void>
}) {
  const t = useTranslations('Agents.detail.activity')
  const format = useFormatter()
  const { activeOrg } = useOrgs()
  const placeLabel = usePlaceLabel(agentId)
  const [expanded, setExpanded] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const detail = useSWR(
    expanded ? consoleKeys.assistantItem(activeOrg?.id, agentId, item.id) : null,
    ([, , , id, itemId]) => fetchAssistantItem(id as string, itemId as string),
    { shouldRetryOnError: false }
  )
  const places = item.places.length > 0 ? item.places : [item.origin]

  const remove = async () => {
    setBusy(true)
    setFailed(false)
    try {
      await onDelete(item.id)
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }

  return (
    <div className={`px-4 py-3 ${first ? '' : 'border-t border-(--border-subtle)'}`} data-assistant-item={item.id}>
      <div className="flex items-start gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? t('items.collapse') : t('items.expand')}
          onClick={() => setExpanded((v) => !v)}
          className="mt-[1px] flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent text-(--text-tertiary)"
        >
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-1 desktop:flex-row desktop:items-center desktop:gap-2">
            <span className={`badge w-fit flex-none ${ITEM_STATUS_CLASS[item.status]}`}>
              {t(`items.status.${item.status}`)}
            </span>
            <span className="min-w-0 break-words font-sans text-[13.5px] font-semibold leading-normal text-(--text-primary) desktop:flex-1">
              {item.title}
            </span>
          </div>
          {item.doneWhen ? (
            <div className="mt-1 break-words font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
              {t('items.doneWhen', { text: item.doneWhen })}
            </div>
          ) : null}
          <div className="mt-1 flex flex-col gap-[2px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary) desktop:flex-row desktop:flex-wrap desktop:gap-x-3">
            {item.nextCheck ? (
              <span>
                {t('items.nextCheck', {
                  time: format.dateTime(new Date(item.nextCheck), { dateStyle: 'medium', timeStyle: 'short' })
                })}
              </span>
            ) : null}
            <span className="break-words">{places.map((place) => placeLabel(place)).join(', ')}</span>
            <span>
              {t('items.updated', {
                time: format.dateTime(new Date(item.updatedAt), { dateStyle: 'medium', timeStyle: 'short' })
              })}
            </span>
          </div>
          {expanded ? (
            <div className="mt-2 rounded-md bg-(--surface-sunken) px-3 py-2" data-assistant-item-detail>
              {detail.error && !detail.data ? (
                <div className="font-sans text-[12px] text-(--text-tertiary)">{t('unavailable')}</div>
              ) : !detail.data ? (
                <div className="font-sans text-[12px] text-(--text-tertiary)">{t('loading')}</div>
              ) : (
                <>
                  {detail.data.summary ? (
                    <div className="whitespace-pre-wrap break-words font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-primary)">
                      {detail.data.summary}
                    </div>
                  ) : null}
                  {detail.data.observations.length === 0 ? (
                    <div className="font-sans text-[12px] text-(--text-tertiary)">{t('items.noObservations')}</div>
                  ) : (
                    <ol className={`m-0 flex list-none flex-col gap-2 p-0 ${detail.data.summary ? 'mt-2' : ''}`}>
                      {detail.data.observations.map((o, i) => (
                        <li key={`${o.at}:${i}`} className="flex flex-col gap-[2px] desktop:flex-row desktop:gap-3">
                          <span className="flex-none font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary) desktop:w-[150px]">
                            {format.dateTime(new Date(o.at), { dateStyle: 'medium', timeStyle: 'short' })}
                          </span>
                          <span className="min-w-0 whitespace-pre-wrap break-words font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                            {o.text}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </>
              )}
            </div>
          ) : null}
          {confirming ? (
            <ConfirmStrip
              prompt={t('items.deleteConfirm')}
              confirm={t('items.delete')}
              keep={t('keep')}
              busy={busy}
              onConfirm={() => void remove()}
              onKeep={() => setConfirming(false)}
            />
          ) : null}
          {failed ? (
            <div role="alert" className="mt-1 font-sans text-[12px] text-(--status-error)">
              {t('items.deleteFailed')}
            </div>
          ) : null}
        </div>
        {canEdit ? (
          <Button
            variant="ghost"
            size="xs"
            className="flex-none"
            disabled={busy || confirming}
            ariaLabel={t('items.delete')}
            onClick={() => setConfirming(true)}
          >
            <Icon name="trash" size={13} />
            <span className="max-desktop:hidden">{t('items.delete')}</span>
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function SubsessionRow({ subsession, first }: { subsession: AssistantSubsessionDto; first: boolean }) {
  const t = useTranslations('Agents.detail.activity')
  const format = useFormatter()
  const { orgPath } = useOrgs()
  const parent = subsession.parent
  const parentName = parent
    ? parent.channelName
      ? `${chatRoomSigil(parent.platform ?? undefined)}${parent.channelName}`
      : (parent.title ?? t('subsessions.conversation'))
    : null
  return (
    <div
      className={`flex flex-col gap-1 px-4 py-3 desktop:flex-row desktop:items-center desktop:gap-3 ${first ? '' : 'border-t border-(--border-subtle)'}`}
      data-assistant-subsession={subsession.sessionId ?? 'hidden'}
    >
      <span className={`badge w-fit flex-none ${SUBSESSION_STATE_CLASS[subsession.state]}`}>
        {t(`subsessions.state.${subsession.state}`)}
      </span>
      <div className="min-w-0 flex-1 font-sans text-[13px] font-medium leading-normal">
        {subsession.sessionId ? (
          <Link className="lnk break-words" href={orgPath(`/sessions/${encodeURIComponent(subsession.sessionId)}`)}>
            {subsession.title ?? t('subsessions.untitled')}
          </Link>
        ) : subsession.visible ? (
          <span className="text-(--text-secondary)">{t('subsessions.starting')}</span>
        ) : (
          <span className="inline-flex items-center gap-[6px] text-(--text-tertiary)">
            <Icon name="lock" size={12} />
            {t('subsessions.hidden')}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
        {parent && parentName ? (
          <Link className="lnk text-[12px]" href={orgPath(`/sessions/${encodeURIComponent(parent.sessionId)}`)}>
            {t('subsessions.from', { name: parentName })}
          </Link>
        ) : null}
        <span>
          {t('subsessions.started', {
            time: format.dateTime(new Date(subsession.startedAt), { dateStyle: 'medium', timeStyle: 'short' })
          })}
        </span>
      </div>
    </div>
  )
}

/** A background sub-session waiting for permission (assistant-mode.md §5.6): which one, what it asks to run, and the same answers its card offers. */
function PermissionRequestRow({
  request,
  first,
  result,
  onDecide
}: {
  request: AssistantPermissionRequestDto
  first: boolean
  result: PermissionResult | undefined
  onDecide: (request: AssistantPermissionRequestDto, decision: 'allow' | 'deny', optionId?: string) => Promise<void>
}) {
  const t = useTranslations('Agents.detail.activity')
  const format = useFormatter()
  const { orgPath } = useOrgs()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(false)
  const { subsession, parent } = request
  const parentName = parent
    ? parent.channelName
      ? `${chatRoomSigil(parent.platform ?? undefined)}${parent.channelName}`
      : (parent.title ?? t('subsessions.conversation'))
    : null
  const choices: { decision: 'allow' | 'deny'; label: string; optionId?: string }[] = request.options?.length
    ? request.options.map((option: AgentPermissionOptionDto) => ({
        decision: option.kind === 'allow_once' || option.kind === 'allow_always' ? 'allow' : 'deny',
        label: option.name,
        optionId: option.optionId
      }))
    : [
        { decision: 'allow', label: t('permissions.allow') },
        { decision: 'deny', label: t('permissions.deny') }
      ]

  const decide = async (choice: (typeof choices)[number]) => {
    setBusy(true)
    setFailure(false)
    try {
      await onDecide(request, choice.decision, choice.optionId)
    } catch {
      setFailure(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={`px-4 py-3 ${first ? '' : 'border-t border-(--border-subtle)'}`}
      data-assistant-permission={request.requestId}
    >
      <div className="flex flex-col gap-1 desktop:flex-row desktop:items-center desktop:gap-2">
        <span className="badge w-fit flex-none bg-(--status-paused-soft) text-(--status-paused)">
          {t('permissions.badge')}
        </span>
        <span className="min-w-0 break-words font-sans text-[13.5px] font-semibold leading-normal text-(--text-primary) desktop:flex-1">
          {subsession ? (
            <Link className="lnk" href={orgPath(`/sessions/${encodeURIComponent(subsession.sessionId)}`)}>
              {subsession.title ?? t('subsessions.untitled')}
            </Link>
          ) : (
            <span className="inline-flex items-center gap-[6px] font-medium text-(--text-tertiary)">
              <Icon name="lock" size={12} />
              {t('subsessions.hidden')}
            </span>
          )}
        </span>
      </div>
      <div
        className="mt-2 break-words rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-2 font-mono text-[11.5px] leading-[1.45] text-(--text-secondary)"
        title={request.tool}
      >
        {request.tool}
      </div>
      <div className="mt-2 flex flex-col gap-[2px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary) desktop:flex-row desktop:gap-3">
        {parent && parentName ? (
          <Link className="lnk text-[12px]" href={orgPath(`/sessions/${encodeURIComponent(parent.sessionId)}`)}>
            {t('subsessions.from', { name: parentName })}
          </Link>
        ) : null}
        <span>
          {t('permissions.expires', {
            time: format.dateTime(new Date(request.expiresAt), { dateStyle: 'medium', timeStyle: 'short' })
          })}
        </span>
      </div>
      {result ? (
        <div
          role="status"
          className={`mt-2 font-sans text-[12.5px] font-medium leading-normal ${
            result === 'allowed' ? 'text-(--status-online-text)' : 'text-(--text-secondary)'
          }`}
        >
          {t(`permissions.outcome.${result}`)}
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2" data-assistant-permission-actions>
          {choices.map((choice) => (
            <Button
              key={choice.optionId ?? choice.decision}
              variant={choice.decision === 'allow' ? 'primary' : 'secondary'}
              size="xs"
              disabled={busy}
              onClick={() => void decide(choice)}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      )}
      {failure && !result ? (
        <div role="alert" className="mt-1 font-sans text-[12px] text-(--status-error)">
          {t('permissions.decideFailed')}
        </div>
      ) : null}
    </div>
  )
}

function DraftRow({
  agentId,
  draft,
  first,
  result,
  pending,
  onDecide
}: {
  agentId: string
  draft: AssistantDraftDto
  first: boolean
  result: DraftResult | undefined
  /** The latest read still lists it as waiting for approval. */
  pending: boolean
  onDecide: (draft: AssistantDraftDto, decision: AssistantDraftDecision) => Promise<void>
}) {
  const t = useTranslations('Agents.detail.activity')
  const format = useFormatter()
  const { members } = useConsoleData()
  const placeLabel = usePlaceLabel(agentId)
  const [confirming, setConfirming] = useState<AssistantDraftDecision | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const target = draft.target.name
    ? draft.target.dm
      ? t('dmWith', { name: draft.target.name })
      : `${chatRoomSigil(draft.target.platform)}${draft.target.name}`
    : placeLabel(draft.target)
  // A proposal runs its task in the item's conversation once approved; it offers no "always allow".
  const proposal = draft.kind === 'task' ? draft.proposal : undefined
  const approver = draft.approver
  const member = approver?.consoleUserId ? members.find((m) => m.userId === approver.consoleUserId) : undefined
  const approverName = !approver
    ? t('drafts.noApprover')
    : approver.kind === 'conversation'
      ? placeLabel(approver)
      : (approver.name ?? (member ? memberDisplayName(member) : (approver.userId ?? t('drafts.noApprover'))))
  // An unconfirmed decision may be tried again only while the draft is still listed as waiting; a proposal left waiting may be approved again.
  const canDecide = !result || ('unconfirmed' in result && pending) || 'busy' in result

  const decide = async (decision: AssistantDraftDecision) => {
    setBusy(true)
    setFailure(null)
    try {
      await onDecide(draft, decision)
    } catch (err) {
      setFailure(
        err instanceof ApiError && err.code === 'DAEMON_FEATURE_MISSING'
          ? t('drafts.upgradeDaemon')
          : t('drafts.decideFailed')
      )
    } finally {
      setBusy(false)
      setConfirming(null)
    }
  }

  return (
    <div className={`px-4 py-3 ${first ? '' : 'border-t border-(--border-subtle)'}`} data-assistant-draft={draft.id}>
      {proposal ? (
        <>
          <div className="flex flex-col gap-1 desktop:flex-row desktop:items-center desktop:gap-2">
            <span className="badge w-fit flex-none bg-(--status-info-soft) text-(--status-info)">
              {t('drafts.proposal.badge')}
            </span>
            <span className="min-w-0 break-words font-sans text-[13.5px] font-semibold leading-normal text-(--text-primary) desktop:flex-1">
              {proposal.sentence}
            </span>
          </div>
          {proposal.why ? (
            <div className="mt-1 break-words font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)">
              {t('drafts.proposal.why', { why: proposal.why })}
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex flex-col gap-1 desktop:flex-row desktop:items-center desktop:gap-2">
          <span className="min-w-0 break-words font-sans text-[13.5px] font-semibold leading-normal text-(--text-primary) desktop:flex-1">
            {t('drafts.to', { target })}
            {draft.target.thread ? (
              <span className="font-normal text-(--text-tertiary)"> · {t('drafts.inThread')}</span>
            ) : null}
          </span>
          {draft.target.external ? (
            <span className="badge w-fit flex-none bg-(--status-paused-soft) text-(--status-paused)">
              {t('drafts.external')}
            </span>
          ) : null}
        </div>
      )}
      <div className="mt-2 max-h-[240px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-2 font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-primary)">
        {draft.text}
      </div>
      <div className="mt-2 flex flex-col gap-[2px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary) desktop:flex-row desktop:gap-3">
        {proposal ? <span>{t('drafts.proposal.runsIn', { place: target })}</span> : null}
        {proposal?.itemTitle ? <span>{t('drafts.proposal.item', { title: proposal.itemTitle })}</span> : null}
        <span>{t('drafts.approver', { name: approverName })}</span>
        <span>
          {t('drafts.expires', {
            time: format.dateTime(new Date(draft.expiresAt), { dateStyle: 'medium', timeStyle: 'short' })
          })}
        </span>
      </div>
      {result ? <DraftOutcome result={result} pending={pending} proposalPlace={proposal ? target : undefined} /> : null}
      {!canDecide ? null : confirming ? (
        <ConfirmStrip
          prompt={
            proposal
              ? confirming === 'discard'
                ? t('drafts.proposal.denyConfirm')
                : t('drafts.proposal.approveConfirm', { place: target })
              : confirming === 'discard'
                ? t('drafts.discardConfirm')
                : t(confirming === 'approve' ? 'drafts.approveConfirm' : 'drafts.approveAlwaysConfirm', { target })
          }
          confirm={
            confirming !== 'discard' ? t('drafts.approve') : proposal ? t('drafts.proposal.deny') : t('drafts.discard')
          }
          keep={t('drafts.cancel')}
          busy={busy}
          tone={confirming === 'discard' ? 'danger' : 'primary'}
          onConfirm={() => void decide(confirming)}
          onKeep={() => setConfirming(null)}
        />
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2" data-assistant-draft-actions>
          <Button variant="primary" size="xs" onClick={() => setConfirming('approve')}>
            {t('drafts.approve')}
          </Button>
          <Button variant="secondary" size="xs" onClick={() => setConfirming('discard')}>
            {proposal ? t('drafts.proposal.deny') : t('drafts.discard')}
          </Button>
          {draft.offerAlways && !proposal ? (
            <Button variant="secondary" size="xs" onClick={() => setConfirming('approve_always')}>
              {t('drafts.approveAlways')}
            </Button>
          ) : null}
        </div>
      )}
      {failure && canDecide ? (
        <div role="alert" className="mt-1 font-sans text-[12px] text-(--status-error)">
          {failure}
        </div>
      ) : null}
    </div>
  )
}

const OUTCOME_CLASS: Record<AssistantDraftOutcomeDto['status'], string> = {
  executing: 'text-(--status-info)',
  succeeded: 'text-(--status-online-text)',
  denied: 'text-(--text-secondary)',
  failed: 'text-(--status-error)',
  outcome_unknown: 'text-(--status-paused)'
}

/** What a decision did, in place of the draft's buttons; a proposal's names the conversation it runs in. */
function DraftOutcome({
  result,
  pending,
  proposalPlace
}: {
  result: DraftResult
  pending: boolean
  proposalPlace?: string | undefined
}) {
  const t = useTranslations('Agents.detail.activity')
  let text: string
  let tone = 'text-(--text-secondary)'
  if ('busy' in result) {
    tone = 'text-(--status-paused)'
    text = result.busy
  } else if ('unconfirmed' in result) {
    tone = 'text-(--status-paused)'
    text = pending
      ? t('drafts.outcome.unconfirmedWaiting')
      : proposalPlace !== undefined
        ? t('drafts.proposal.outcome.unconfirmedGone', { place: proposalPlace })
        : t('drafts.outcome.unconfirmedGone')
  } else if ('refused' in result) {
    text =
      proposalPlace !== undefined && result.refused === 'expired'
        ? t('drafts.proposal.outcome.expired')
        : t(`drafts.outcome.${result.refused}`)
  } else if (proposalPlace !== undefined) {
    const { status, failure } = result.outcome
    tone = OUTCOME_CLASS[status]
    text =
      status === 'failed'
        ? t('drafts.proposal.outcome.failed', { reason: failure ?? t('drafts.outcome.unknownReason') })
        : t(`drafts.proposal.outcome.${status}`, { place: proposalPlace })
  } else {
    const { status, alwaysAllowed, failure } = result.outcome
    tone = OUTCOME_CLASS[status]
    text =
      status === 'succeeded' && alwaysAllowed
        ? t('drafts.outcome.succeededAlways')
        : status === 'failed'
          ? t('drafts.outcome.failed', { reason: failure ?? t('drafts.outcome.unknownReason') })
          : // A post is never left running by its decision; read it as still settling.
            status === 'executing'
            ? t('drafts.outcome.unconfirmedWaiting')
            : t(`drafts.outcome.${status}`)
  }
  return (
    <div
      role="status"
      className={`mt-2 rounded-md bg-(--surface-sunken) px-3 py-2 font-sans text-[12.5px] font-medium leading-normal ${tone}`}
      data-assistant-draft-outcome
    >
      {text}
    </div>
  )
}

function GrantRow({
  agentId,
  grant,
  first,
  onRevoke
}: {
  agentId: string
  grant: AssistantGrantDto
  first: boolean
  onRevoke: (grantId: string) => Promise<void>
}) {
  const t = useTranslations('Agents.detail.activity')
  const format = useFormatter()
  const placeLabel = usePlaceLabel(agentId)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const granted = format.dateTime(new Date(grant.grantedAt), { dateStyle: 'medium' })

  const revoke = async () => {
    setBusy(true)
    setFailed(false)
    try {
      await onRevoke(grant.id)
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }

  return (
    <div className={`px-4 py-3 ${first ? '' : 'border-t border-(--border-subtle)'}`} data-assistant-grant={grant.id}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 font-sans text-[13.5px] font-semibold leading-normal text-(--text-primary)">
            <span className="break-words">{placeLabel(grant.source)}</span>
            <Icon name="arrow-right" size={13} color="var(--text-tertiary)" />
            <span className="break-words">{placeLabel(grant.target)}</span>
          </div>
          <div className="mt-1 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
            {grant.grantedByName
              ? t('grants.grantedBy', { name: grant.grantedByName, date: granted })
              : t('grants.granted', { date: granted })}
          </div>
          {confirming ? (
            <ConfirmStrip
              prompt={t('grants.revokeConfirm')}
              confirm={t('grants.revoke')}
              keep={t('keep')}
              busy={busy}
              onConfirm={() => void revoke()}
              onKeep={() => setConfirming(false)}
            />
          ) : null}
          {failed ? (
            <div role="alert" className="mt-1 font-sans text-[12px] text-(--status-error)">
              {t('grants.revokeFailed')}
            </div>
          ) : null}
        </div>
        <Button
          variant="secondary"
          size="xs"
          className="flex-none"
          disabled={busy || confirming}
          onClick={() => setConfirming(true)}
        >
          {t('grants.revoke')}
        </Button>
      </div>
    </div>
  )
}
