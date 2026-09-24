'use client'

// A session's Decision results in its message flow: one marker under each judged or routed message, opening Recent evaluations.

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Icon } from '@/components/ui'
import { useConsoleData } from '@/lib/data-context'
import { useOptionalDecisionsPrototype } from '@/lib/decisions/provider'
import { answerText } from '@/lib/decisions/evaluations'
import { evaluationsBySeq, sessionGateLane, type SessionGateLane } from '@/lib/decisions/session-evaluations'
import { codeHostRoutingEvaluations, type DecisionEvaluationSource } from '@/lib/decisions/evaluation-source'
import type { CodeHostRoutingKey } from '@/lib/api'
import {
  isCodeHostRoutingScope,
  type CodeHostRoutingFamily,
  type DecisionEvaluationRecord
} from '@agentconnect.md/protocol/decision'
import type { CodehostTurnFacts } from '@agentconnect.md/protocol/user-turn-body'
import { OutcomeBadge } from './DecisionEvaluationDetail'

const PAGE = 50
const MAX_PAGES = 5
const PENDING_POLL_MS = 5000
const NONE = new Map<number, DecisionEvaluationRecord>()

/** The session's gated lane and each judged message's evaluation, keyed by transcript seq. */
export function useSessionDecisionResults(
  session: { agentId?: string | null; platform?: string | null; channelId?: string | null },
  seqs: readonly number[]
): { lane: SessionGateLane | null; bySeq: ReadonlyMap<number, DecisionEvaluationRecord> } {
  const decisions = useOptionalDecisionsPrototype()
  const { integrations } = useConsoleData()
  const { agentId, platform, channelId } = session
  const lane = useMemo(
    () => (decisions ? sessionGateLane(integrations, { agentId, platform, channelId }) : null),
    [decisions, integrations, agentId, platform, channelId]
  )
  const seqSet = useMemo(() => new Set(seqs), [seqs])
  const oldest = seqs.length > 0 ? Math.min(...seqs) : null
  const newest = seqs.length > 0 ? Math.max(...seqs) : null
  // Pages newest-first until the lane reaches back past the session's oldest loaded message.
  const { data } = useSWR(
    lane && decisions && oldest !== null
      ? [
          'session-decision-evaluations',
          decisions.api.mode,
          decisions.orgId,
          lane.conversation.integrationId,
          lane.conversation.channelId,
          oldest,
          newest
        ]
      : null,
    async () => {
      const records: DecisionEvaluationRecord[] = []
      let cursor: number | undefined
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const next = await decisions!.api.listEvaluations(lane!.conversation, { cursor, limit: PAGE })
        records.push(...next.items)
        const last = next.items[next.items.length - 1]
        if (next.nextCursor === null || !last || last.seq < oldest!) break
        cursor = next.nextCursor
      }
      return records
    },
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      // A verdict read mid-evaluation settles without touching the transcript, so poll only while one is pending.
      refreshInterval: (latest) => (latest?.some((record) => record.outcome === 'pending') ? PENDING_POLL_MS : 0)
    }
  )
  const bySeq = useMemo(() => (data ? evaluationsBySeq(data, seqSet) : NONE), [data, seqSet])
  return { lane, bySeq }
}

/** "Received a decision result" under the judged message; the whole line opens that evaluation. */
export function DecisionResultMarker({
  record,
  decisionName,
  onOpen
}: {
  record: DecisionEvaluationRecord
  decisionName?: string
  onOpen: () => void
}) {
  const t = useTranslations('Sessions.decisionResult')
  const tDecisions = useTranslations('Decisions')
  const answer = answerText(record.answer, { yes: tDecisions('condition.yes'), no: tDecisions('condition.no') })
  return (
    <div className="flex justify-center">
      <button
        type="button"
        onClick={onOpen}
        title={t('open')}
        className="flex min-w-0 max-w-full cursor-pointer items-center gap-[7px] rounded-full border border-(--border-subtle) bg-(--surface-card) px-[11px] py-[4px] text-left hover:bg-(--surface-hover)"
      >
        <Icon name="git-branch" size={12} color="var(--text-tertiary)" className="flex-none" />
        <span className="min-w-0 truncate font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
          {t('received')}
          {decisionName && <span className="text-(--text-tertiary)"> · {decisionName}</span>}
          {answer && <span className="mono text-[11px] text-(--text-tertiary)"> · {answer}</span>}
        </span>
        <OutcomeBadge record={record} />
        <Icon name="chevron-right" size={12} color="var(--text-tertiary)" className="flex-none" />
      </button>
    </div>
  )
}

/** The repository routing lane a routed code-host turn's verdict lives in, or null for an unrouted turn. */
export function codeHostTurnRouting(
  facts: CodehostTurnFacts | undefined
): { scope: CodeHostRoutingKey; seq: number } | null {
  const routing = facts?.routing
  if (!routing || !isCodeHostRoutingScope(facts.provider, routing.family)) return null
  return {
    scope: { provider: facts.provider, repoId: routing.repoId, family: routing.family as CodeHostRoutingFamily },
    seq: routing.verdictSeq
  }
}

/** A routed code-host turn's verdict under its message; renders nothing until that lane serves it. */
export function CodeHostDecisionResult({
  facts,
  onOpen
}: {
  facts: CodehostTurnFacts
  onOpen: (open: { source: DecisionEvaluationSource; seq: number; repoName?: string }) => void
}) {
  const decisions = useOptionalDecisionsPrototype()
  const routing = codeHostTurnRouting(facts)
  const { provider, repoId, family } = routing?.scope ?? {}
  const seq = routing?.seq
  const source = useMemo(
    () =>
      decisions && provider && repoId && family
        ? codeHostRoutingEvaluations(decisions.api, decisions.orgId, { provider, repoId, family })
        : null,
    [decisions, provider, repoId, family]
  )
  // The view-authorized list, bounded to this verdict: its detail read needs edit access to every member.
  const { data } = useSWR(
    source && seq !== undefined ? ['session-code-host-evaluation', ...source.key, seq] : null,
    async () => (await source!.list({ cursor: seq! + 1, limit: 1 })).items.find((item) => item.seq === seq) ?? null,
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      refreshInterval: (latest) => (latest?.outcome === 'pending' ? PENDING_POLL_MS : 0)
    }
  )
  if (!data || !source) return null
  return (
    <DecisionResultMarker
      record={data}
      decisionName={decisions?.decisions.find((d) => d.id === data.decisionId)?.name}
      onOpen={() => onOpen({ source, seq: data.seq, repoName: facts.subject.repo })}
    />
  )
}
