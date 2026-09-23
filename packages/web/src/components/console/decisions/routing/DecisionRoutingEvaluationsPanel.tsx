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
import { formatEvaluationTime } from '../DecisionEvaluationSheet'
import { DecisionRoutingEvaluationSheet, RoutingOutcomeBadge } from './DecisionRoutingEvaluationSheet'

const PAGE = 20
const COLUMNS =
  'desktop:grid desktop:grid-cols-[120px_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,1fr)_64px] desktop:items-center desktop:gap-3'

function unavailableKind(cause: unknown): 'offline' | 'unsupported' | null {
  const parts = errorParts(cause)
  if (parts?.status !== 503) return null
  return parts.code === 'DAEMON_UPGRADE_REQUIRED' ? 'unsupported' : 'offline'
}

export function DecisionRoutingEvaluationsPanel({
  botId,
  channels,
  agentNames,
  ruleNumbers
}: {
  botId: string
  /** The routed channels the filter offers, with their names. */
  channels: Array<{ channelId: string; name: string }>
  agentNames: ReadonlyMap<string, string>
  /** Each saved rule's editor number, so a matched rule reads as the row the editor shows. */
  ruleNumbers: ReadonlyMap<string, number>
}) {
  const t = useTranslations('Decisions.routing')
  const tDecisions = useTranslations('Decisions')
  const locale = useLocale()
  const { api, orgId } = useDecisionsPrototype()
  const words = { yes: tDecisions('condition.yes'), no: tDecisions('condition.no') }
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
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (open !== null || !opener.current) return
    opener.current.focus()
    opener.current = null
  }, [open])
  const closeSheet = useCallback(() => setOpen(null), [])
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
      className="flex flex-wrap items-start gap-2 font-sans text-[12px] font-normal leading-[1.55] text-(--text-tertiary)"
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
      <div className="overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card)">
        <div
          className={`hidden border-b border-(--border-subtle) px-[12px] py-[7px] font-sans text-[11px] font-medium leading-normal text-(--text-tertiary) ${COLUMNS}`}
        >
          <span>{t('evaluations.columns.time')}</span>
          <span>{t('evaluations.columns.channel')}</span>
          <span>{t('evaluations.columns.answer')}</span>
          <span>{t('evaluations.columns.matched')}</span>
          <span>{t('evaluations.columns.targets')}</span>
          <span>{t('evaluations.columns.outcome')}</span>
          <span className="text-right">{t('evaluations.columns.latency')}</span>
        </div>
        <ul className="m-0 list-none p-0">
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
            return (
              <li key={`${record.channel}:${record.seq}`} className="border-b border-(--border-subtle) last:border-b-0">
                <button
                  type="button"
                  onClick={(event) => {
                    opener.current = event.currentTarget
                    setOpen({ seq: record.seq, channel: record.channel })
                  }}
                  className={`flex w-full cursor-pointer flex-col gap-[5px] border-0 bg-transparent px-[12px] py-[9px] text-left hover:bg-(--surface-hover) ${COLUMNS}`}
                >
                  <span className="flex items-center justify-between gap-2 desktop:contents">
                    <span className="mono text-[11.5px] text-(--text-secondary)">
                      {formatEvaluationTime(record.at, locale)}
                    </span>
                    <span className="desktop:hidden">
                      <RoutingOutcomeBadge record={record} />
                    </span>
                  </span>
                  <span className="mono min-w-0 truncate text-[11.5px] text-(--text-secondary)">
                    <span className="font-sans text-(--text-tertiary) desktop:hidden">
                      {t('evaluations.columns.channel')}:{' '}
                    </span>
                    {channelName(record.channel)}
                  </span>
                  <span className="min-w-0 truncate font-sans text-[12px] font-normal leading-normal text-(--text-primary)">
                    <span className="text-(--text-tertiary) desktop:hidden">{t('evaluations.columns.answer')}: </span>
                    {answer}
                  </span>
                  <span className="mono min-w-0 truncate text-[11.5px] text-(--text-secondary)">
                    <span className="font-sans text-(--text-tertiary) desktop:hidden">
                      {t('evaluations.columns.matched')}:{' '}
                    </span>
                    {matched}
                  </span>
                  <span className="mono min-w-0 truncate text-[11.5px] text-(--text-secondary)">
                    <span className="font-sans text-(--text-tertiary) desktop:hidden">
                      {t('evaluations.columns.targets')}:{' '}
                    </span>
                    {targetsText(record, agentNames) ?? '—'}
                  </span>
                  <span className="hidden min-w-0 desktop:flex">
                    <RoutingOutcomeBadge record={record} />
                  </span>
                  <span className="mono text-[11.5px] text-(--text-tertiary) desktop:text-right">
                    <span className="font-sans desktop:hidden">{t('evaluations.columns.latency')}: </span>
                    {latencyText(record.latencyMs) ?? '—'}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    )

  return (
    <div className="flex flex-col gap-2" data-testid="routing-evaluations">
      <label className="flex flex-wrap items-center gap-2 font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
        {t('evaluations.channelFilter')}
        <select className="inp h-8 min-h-0" value={channelId} onChange={(event) => setChannelId(event.target.value)}>
          <option value="">{t('evaluations.allChannels')}</option>
          {channels.map((channel) => (
            <option key={channel.channelId} value={channel.channelId}>
              {channel.name}
            </option>
          ))}
        </select>
      </label>
      {body}
      {data && nextCursor !== null && (
        <div className="flex flex-wrap items-center gap-[9px]">
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
      {open !== null && (
        <DecisionRoutingEvaluationSheet
          botId={botId}
          channelId={open.channel}
          channelName={channelName(open.channel)}
          seq={open.seq}
          summary={items.find((record) => record.seq === open.seq && record.channel === open.channel) ?? null}
          agentNames={agentNames}
          onClose={closeSheet}
        />
      )}
    </div>
  )
}
