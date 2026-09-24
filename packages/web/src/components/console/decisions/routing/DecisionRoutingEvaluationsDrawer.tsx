'use client'

// Routing Recent evaluations (decisions.md §9.5): the host's router verdicts, filtered per conversation audience by the CP.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Button, Icon } from '@/components/ui'
import { useDecisionsPrototype } from '@/lib/decisions/provider'
import { errorParts } from '@/lib/decisions/binding'
import { answerText, latencyText } from '@/lib/decisions/evaluations'
import { matchedRuleNumbers, targetsText } from '@/lib/decisions/routing-evaluations'
import type { DecisionRoutingEvaluationRecord } from '@agentconnect.md/protocol/decision'
import { EvaluationsDrawer, formatEvaluationTime } from '../EvaluationParts'
import { DecisionRoutingEvaluationDetail, RoutingOutcomeBadge } from './DecisionRoutingEvaluationDetail'

const PAGE = 20
const COLUMNS = 'desktop:grid desktop:grid-cols-[96px_minmax(0,1fr)_auto_60px] desktop:items-center desktop:gap-3'

function unavailableKind(cause: unknown): 'offline' | 'unsupported' | null {
  const parts = errorParts(cause)
  if (parts?.status !== 503) return null
  return parts.code === 'DAEMON_UPGRADE_REQUIRED' ? 'unsupported' : 'offline'
}

export function DecisionRoutingEvaluationsDrawer({
  botId,
  botName,
  channels,
  agentNames,
  ruleNumbers,
  onClose
}: {
  botId: string
  botName?: string
  /** The routed channels the filter offers, with their names. */
  channels: Array<{ channelId: string; name: string }>
  agentNames: ReadonlyMap<string, string>
  /** Each saved rule's editor number, so a matched rule reads as the row the editor shows. */
  ruleNumbers: ReadonlyMap<string, number>
  onClose: () => void
}) {
  const t = useTranslations('Decisions.routing')
  const tDecisions = useTranslations('Decisions')
  const locale = useLocale()
  const { api, orgId, decisions } = useDecisionsPrototype()
  const words = { yes: tDecisions('condition.yes'), no: tDecisions('condition.no') }
  const decisionName = useCallback(
    (id: string) => decisions.find((entry) => entry.id === id)?.name ?? tDecisions('binding.hiddenDecision'),
    [decisions, tDecisions]
  )
  const [channelId, setChannelId] = useState<string>('')
  const { data, error, isLoading, mutate } = useSWR(
    ['decision-routing-evaluations', api.mode, orgId, botId, channelId],
    () => api.listRoutingEvaluations(botId, { ...(channelId ? { channelId } : {}), limit: PAGE })
  )
  const [appended, setAppended] = useState<{
    base: unknown
    items: DecisionRoutingEvaluationRecord[]
    nextCursor: number | null
  } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)
  const [open, setOpen] = useState<{ seq: number; channel: string } | null>(null)
  const opener = useRef<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (open !== null || opener.current === null) return
    const key = opener.current
    ;[...(listRef.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [])]
      .find((row) => row.dataset.row === key)
      ?.focus()
    opener.current = null
  }, [open])
  const back = useCallback(() => setOpen(null), [])
  const more = appended && appended.base === data ? appended : null
  const items = [...(data?.items ?? []), ...(more?.items ?? [])]
  const nextCursor = more ? more.nextCursor : (data?.nextCursor ?? null)
  const channelName = (id: string) => channels.find((channel) => channel.channelId === id)?.name ?? id

  // A page the audience filter emptied can still continue, so Load more follows the cursor, not the row count.
  const loadMore = async () => {
    if (nextCursor === null || loadingMore) return
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await api.listRoutingEvaluations(botId, {
        ...(channelId ? { channelId } : {}),
        cursor: nextCursor,
        limit: PAGE
      })
      setAppended((current) => ({
        base: data,
        items: [...(current && current.base === data ? current.items : []), ...page.items],
        nextCursor: page.nextCursor
      }))
    } catch (cause) {
      setMoreError(errorParts(cause)?.message ?? (cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setLoadingMore(false)
    }
  }

  const note = (icon: string, text: string, action?: { label: string; run: () => void }) => (
    <div
      role="status"
      className="flex flex-wrap items-start gap-2 px-[18px] py-4 font-sans text-[12px] font-normal leading-[1.55] text-(--text-tertiary)"
    >
      <Icon name={icon} size={13} className="mt-[2px] flex-none" />
      <span className="min-w-0 flex-1">{text}</span>
      {action && (
        <button type="button" className="lnk text-[11.5px] font-medium" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  )

  let body
  if (isLoading && !data) body = note('loader', tDecisions('loading'))
  else if (error && !data) {
    const kind = unavailableKind(error)
    body =
      kind === 'offline'
        ? note('wifi-off', t('evaluations.offline'), { label: t('retryLoad'), run: () => void mutate() })
        : kind === 'unsupported'
          ? note('circle-arrow-up', t('evaluations.unsupported'))
          : note('triangle-alert', t('evaluations.error', { message: errorParts(error)?.message ?? String(error) }), {
              label: t('retryLoad'),
              run: () => void mutate()
            })
  } else if (items.length === 0) body = note('info', t('evaluations.empty'))
  else
    body = (
      <>
        <div
          className={`hidden border-b border-(--border-subtle) bg-(--surface-sunken) px-[18px] py-[7px] font-sans text-[11px] font-medium leading-normal text-(--text-tertiary) ${COLUMNS}`}
        >
          <span>{t('evaluations.columns.time')}</span>
          <span>{t('evaluations.columns.channelAnswer')}</span>
          <span>{t('evaluations.columns.outcome')}</span>
          <span className="text-right">{t('evaluations.columns.latency')}</span>
        </div>
        <ul ref={listRef} className="m-0 list-none p-0">
          {items.map((record) => {
            const answer =
              answerText(record.answer, words) ??
              (!record.evaluated
                ? t('evaluations.notEvaluated')
                : record.detailsExpired
                  ? tDecisions('evaluations.expired')
                  : '—')
            const numbers = matchedRuleNumbers(record, ruleNumbers)
            const keys = record.matchedKeys.length ? ` (${record.matchedKeys.join(', ')})` : ''
            const matched = record.usedOtherwise
              ? t('evaluations.otherwise')
              : numbers.length
                ? `${t('evaluations.rules', { numbers: numbers.join(', ') })}${keys}`
                : record.matchedKeys.join(', ') || '—'
            const rowKey = `${record.channel}:${record.seq}`
            return (
              <li key={rowKey} className="border-b border-(--border-subtle)">
                <button
                  type="button"
                  data-row={rowKey}
                  onClick={() => {
                    opener.current = rowKey
                    setOpen({ seq: record.seq, channel: record.channel })
                  }}
                  className={`flex w-full cursor-pointer flex-col gap-[5px] border-0 bg-transparent px-[18px] py-[10px] text-left hover:bg-(--surface-hover) ${COLUMNS}`}
                >
                  <span className="flex items-center justify-between gap-2 desktop:contents">
                    <span className="mono text-[11px] text-(--text-tertiary)">
                      {formatEvaluationTime(record.at, locale)}
                    </span>
                    <span className="desktop:hidden">
                      <RoutingOutcomeBadge record={record} />
                    </span>
                  </span>
                  <span className="flex min-w-0 flex-col gap-[3px]">
                    <span className="truncate font-sans text-[12.5px] font-normal leading-[1.4] text-(--text-primary)">
                      <span className="mono text-(--text-secondary)">{channelName(record.channel)}</span> · {answer}
                    </span>
                    <span className="mono truncate text-[11px] text-(--text-tertiary)">
                      {matched} · {targetsText(record, agentNames) ?? '—'}
                    </span>
                  </span>
                  <span className="hidden min-w-0 desktop:flex">
                    <RoutingOutcomeBadge record={record} />
                  </span>
                  <span className="mono text-[11px] text-(--text-tertiary) desktop:text-right">
                    <span className="font-sans desktop:hidden">{t('evaluations.columns.latency')}: </span>
                    {latencyText(record.latencyMs) ?? '—'}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        {nextCursor !== null && (
          <div className="flex flex-wrap items-center gap-[9px] px-[18px] py-3">
            <Button variant="secondary" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? tDecisions('loading') : t('evaluations.loadMore')}
            </Button>
            {moreError && (
              <span className="font-sans text-[12px] font-normal leading-normal text-(--status-error)">
                {t('evaluations.error', { message: moreError })}
              </span>
            )}
          </div>
        )}
        <div className="px-[18px] py-3">
          <span className="font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
            {tDecisions('evaluations.retention')}
          </span>
        </div>
      </>
    )

  return (
    <EvaluationsDrawer
      title={t('evaluations.title')}
      subtitle={[botName, t('evaluations.subtitle')].filter(Boolean).join(' · ')}
      closeLabel={tDecisions('evaluations.drawer.close')}
      onClose={onClose}
      onBack={open !== null ? back : null}
      testId="routing-evaluations"
    >
      {open !== null ? (
        <DecisionRoutingEvaluationDetail
          botId={botId}
          channelId={open.channel}
          channelName={channelName(open.channel)}
          seq={open.seq}
          summary={items.find((record) => record.seq === open.seq && record.channel === open.channel) ?? null}
          agentNames={agentNames}
          decisionName={decisionName}
          onBack={back}
        />
      ) : (
        <>
          <label className="flex flex-wrap items-center gap-2 border-b border-(--border-subtle) px-[18px] py-[10px] font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
            {t('evaluations.channelFilter')}
            <select
              className="inp h-8 min-h-0"
              value={channelId}
              onChange={(event) => setChannelId(event.target.value)}
            >
              <option value="">{t('evaluations.allChannels')}</option>
              {channels.map((channel) => (
                <option key={channel.channelId} value={channel.channelId}>
                  {channel.name}
                </option>
              ))}
            </select>
          </label>
          {body}
        </>
      )}
    </EvaluationsDrawer>
  )
}
