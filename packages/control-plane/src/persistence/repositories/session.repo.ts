/**
 * PgSessionRepo — converged session milestones (design §3.8, §3.14).
 *
 * METADATA ONLY: there is no body column to write. `recordMilestone` upserts on
 * `sessionId`, advancing `phase` and keeping the latest `link`/`summary`; the
 * `end` phase stamps `endedAt`. The launch tie (`launchId`) is set on create.
 */
import type { Platform } from '@agentconnect.md/protocol'
import { Prisma, type SessionMeta } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type {
  SessionRepo,
  SessionMetaRecord,
  SessionListRecord,
  SessionFilterQuery,
  SessionPageQuery,
  SessionPageRecord,
  SessionFacetQuery,
  SessionFacetRecord,
  SessionFacetIndex,
  EventSessionInput,
  SessionUsageCounts,
  SessionQuery,
  SessionPhase,
  ActivityState
} from '../ports.js'
import { AgentId, DaemonId, LaunchId, SessionId } from '../../domain/ids.js'

function toRecord(s: SessionMeta): SessionMetaRecord {
  return {
    id: SessionId(s.id),
    parentSessionId: s.parentSessionId ? SessionId(s.parentSessionId) : null,
    agentId: AgentId(s.agentId),
    launchId: s.launchId ? LaunchId(s.launchId) : null,
    platform: (s.platform as Platform | null) ?? null,
    channel: s.channel,
    thread: s.thread,
    phase: s.phase as SessionPhase,
    link: s.link,
    summary: s.summary,
    title: s.title,
    status: s.status,
    lastActivityAt: s.lastActivityAt,
    triggeredBy: s.triggeredBy,
    channelName: s.channelName,
    triggeredByName: s.triggeredByName,
    threadUrl: s.threadUrl,
    runtime: s.runtime,
    model: s.model,
    effort: s.effort,
    fastMode: s.fastMode,
    permissionMode: s.permissionMode,
    outputMode: s.outputMode,
    daemonId: s.daemonId ? DaemonId(s.daemonId) : null,
    activityState: s.activityState as ActivityState,
    startedAt: s.startedAt,
    endedAt: s.endedAt
  }
}

function usageKey(agentId: string, sessionId: string): string {
  return `${agentId}:${sessionId}`
}

function usageCounts(u: {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  thoughtTokens: number
  cachedReadTokens: number
  cachedWriteTokens: number
  contextUsed: number | null
  contextSize: number | null
  costAmount: number
  costCurrency: string | null
}): SessionUsageCounts {
  return {
    totalTokens: u.totalTokens,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    thoughtTokens: u.thoughtTokens,
    cachedReadTokens: u.cachedReadTokens,
    cachedWriteTokens: u.cachedWriteTokens,
    ...(u.contextUsed !== null ? { contextUsed: u.contextUsed } : {}),
    ...(u.contextSize !== null ? { contextSize: u.contextSize } : {}),
    ...(u.costAmount !== 0 || u.costCurrency ? { costAmount: u.costAmount } : {}),
    ...(u.costCurrency ? { costCurrency: u.costCurrency } : {})
  }
}

const HOOK_TRIGGER_PREFIX = 'hook:'

function platformWhere(platform: Platform): Prisma.SessionMetaWhereInput {
  // Pre-platform session rows were Slack sessions; preserve the list contract.
  return platform === 'slack' ? { OR: [{ platform: 'slack' }, { platform: null }] } : { platform }
}

function sessionWhere(q: SessionQuery): Prisma.SessionMetaWhereInput {
  const filters: Prisma.SessionMetaWhereInput[] = []
  if (q.agentId) filters.push({ agentId: q.agentId })
  else if (q.agentIds) filters.push({ agentId: { in: q.agentIds } })
  if (q.platform) filters.push(platformWhere(q.platform))
  if (q.channel) filters.push({ channel: q.channel })
  return filters.length === 0 ? {} : { AND: filters }
}

function cursorWhere(cursor: NonNullable<SessionQuery['cursor']>): Prisma.SessionMetaWhereInput {
  const activityAt = new Date(cursor.activityMs)
  const startedAt = new Date(cursor.startedMs)
  return {
    OR: [
      { lastActivityAt: { lt: activityAt } },
      { lastActivityAt: activityAt, startedAt: { lt: startedAt } },
      { lastActivityAt: activityAt, startedAt, id: { lt: cursor.id } }
    ]
  }
}

function pagedWhere(q: SessionQuery): Prisma.SessionMetaWhereInput {
  const base = sessionWhere(q)
  return q.cursor ? { AND: [base, cursorWhere(q.cursor)] } : base
}

function queryAgentIds(q: SessionQuery): string[] {
  if (q.agentId) return [q.agentId]
  return q.agentIds ?? []
}

function platformSql(platform: Platform): Prisma.Sql {
  return platform === 'slack'
    ? Prisma.sql`(s."platform" = 'slack' OR s."platform" IS NULL)`
    : Prisma.sql`s."platform" = ${platform}`
}

function hookTriggerSql(hookIds: string[]): Prisma.Sql {
  if (hookIds.length === 0) return Prisma.sql`FALSE`
  const triggers = hookIds.map((id) => `${HOOK_TRIGGER_PREFIX}${id}`)
  return Prisma.sql`
    (
      s."triggeredBy" IN (${Prisma.join(triggers)})
      OR (
        s."platform" = 'hook'
        AND
        (
          s."triggeredBy" IS NULL
          OR s."triggeredBy" = ${HOOK_TRIGGER_PREFIX}
          OR s."triggeredBy" NOT LIKE ${`${HOOK_TRIGGER_PREFIX}%`}
        )
        AND s."channel" IN (${Prisma.join(hookIds)})
      )
    )
  `
}

function githubHookSql(githubHookIds: string[]): Prisma.Sql {
  return Prisma.sql`s."platform" = 'hook' AND ${hookTriggerSql(githubHookIds)}`
}

function genericHookSql(githubHookIds: string[]): Prisma.Sql {
  if (githubHookIds.length === 0) return Prisma.sql`s."platform" = 'hook'`
  const triggers = githubHookIds.map((id) => `${HOOK_TRIGGER_PREFIX}${id}`)
  return Prisma.sql`
    s."platform" = 'hook'
    AND (s."triggeredBy" IS NULL OR s."triggeredBy" NOT IN (${Prisma.join(triggers)}))
    AND (
      (s."triggeredBy" LIKE ${`${HOOK_TRIGGER_PREFIX}%`} AND s."triggeredBy" <> ${HOOK_TRIGGER_PREFIX})
      OR s."channel" IS NULL
      OR s."channel" NOT IN (${Prisma.join(githubHookIds)})
    )
  `
}

function integrationSql(q: SessionFilterQuery): Prisma.Sql | null {
  if (!q.integration) return null
  const githubHookIds = q.githubHookIds ?? []
  if (q.integration === 'github') return githubHookSql(githubHookIds)
  if (q.integration === 'hook') return genericHookSql(githubHookIds)
  return platformSql(q.integration)
}

function pageWhereSql(q: SessionFilterQuery, includeCursor: boolean): Prisma.Sql {
  const filters: Prisma.Sql[] = [Prisma.sql`s."agentId" IN (${Prisma.join(queryAgentIds(q))})`]
  if (q.platform) filters.push(platformSql(q.platform))
  const integration = integrationSql(q)
  if (integration) filters.push(integration)
  if (q.channel) filters.push(Prisma.sql`s."channel" = ${q.channel}`)
  if (q.triggeredBy) filters.push(Prisma.sql`s."triggeredBy" = ${q.triggeredBy}`)
  if (q.hookTriggerIds) filters.push(hookTriggerSql(q.hookTriggerIds))
  if (includeCursor && q.cursor) {
    filters.push(Prisma.sql`
      (s."lastActivityAt", s."startedAt", s."id") < (
        ${new Date(q.cursor.activityMs)},
        ${new Date(q.cursor.startedMs)},
        ${q.cursor.id}
      )
    `)
  }
  return Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}`
}

function integrationFacetSql(githubHookIds: string[]): Prisma.Sql {
  if (githubHookIds.length === 0) return Prisma.sql`COALESCE(s."platform", 'slack')`
  return Prisma.sql`
    CASE
      WHEN ${githubHookSql(githubHookIds)} THEN 'github'
      WHEN s."platform" IS NULL THEN 'slack'
      ELSE s."platform"
    END
  `
}

const SESSION_ORDER: Prisma.SessionMetaOrderByWithRelationInput[] = [
  { lastActivityAt: 'desc' },
  { startedAt: 'desc' },
  { id: 'desc' }
]

type SessionFacetDbRow = {
  id: string
  agentId: string
  platform: string | null
  channel: string | null
  triggeredBy: string | null
  channelName: string | null
  triggeredByName: string | null
  lastActivityAt: Date
  startedAt: Date
}

type SessionAgentFacetDbRow = { agentId: string }

function toFacetRecord(row: SessionFacetDbRow): SessionFacetRecord {
  return {
    ...row,
    id: SessionId(row.id),
    agentId: AgentId(row.agentId),
    platform: (row.platform as Platform | null) ?? null
  }
}

function phaseRank(phase: SessionPhase): number {
  switch (phase) {
    case 'start':
      return 0
    case 'plan':
      return 1
    case 'problem':
    case 'end':
      return 2
  }
}

function mergePhase(current: SessionPhase | null | undefined, incoming: SessionPhase): SessionPhase {
  if (!current) return incoming
  const currentRank = phaseRank(current)
  const incomingRank = phaseRank(incoming)
  if (incomingRank < currentRank) return current
  if (incomingRank === currentRank && currentRank === 2) return current
  return incoming
}

export class PgSessionRepo implements SessionRepo {
  constructor(private readonly db: PrismaLike) {}

  private async hydrate(rows: SessionMeta[]): Promise<SessionListRecord[]> {
    if (rows.length === 0) return []
    const usages = await this.db.sessionUsage.findMany({
      where: { OR: rows.map((row) => ({ agentId: row.agentId, sessionId: row.id })) }
    })
    const usageBySession = new Map(usages.map((usage) => [usageKey(usage.agentId, usage.sessionId), usage]))
    return rows.map((row) => {
      const usage = usageBySession.get(usageKey(row.agentId, row.id))
      return { ...toRecord(row), usage: usage ? usageCounts(usage) : null }
    })
  }

  async recordMilestone(ev: EventSessionInput): Promise<void> {
    const endedAt = ev.phase === 'end' ? ev.at : undefined
    const lastActivityAt = ev.lastActivityAt ?? ev.at
    const existing = await this.db.sessionMeta.findUnique({
      where: { id: ev.sessionId },
      select: { phase: true, parentSessionId: true }
    })
    const phase = mergePhase((existing?.phase as SessionPhase | undefined) ?? undefined, ev.phase)
    await this.db.sessionMeta.upsert({
      where: { id: ev.sessionId },
      create: {
        id: ev.sessionId,
        parentSessionId: ev.parentSessionId,
        agentId: ev.agentId,
        launchId: ev.launchId,
        platform: ev.platform,
        channel: ev.channel,
        thread: ev.thread,
        phase,
        link: ev.link,
        summary: ev.summary,
        title: ev.title,
        status: ev.status,
        lastActivityAt,
        triggeredBy: ev.triggeredBy,
        channelName: ev.channelName,
        triggeredByName: ev.triggeredByName,
        threadUrl: ev.threadUrl,
        runtime: ev.runtime,
        model: ev.model,
        effort: ev.effort,
        fastMode: ev.fastMode,
        permissionMode: ev.permissionMode,
        outputMode: ev.outputMode,
        daemonId: ev.daemonId,
        startedAt: ev.at,
        endedAt
      },
      update: {
        phase,
        lastActivityAt,
        // Like the daemon-local origin link, lineage is first-wins. Older
        // daemons omit it, and later snapshots must never re-parent a session.
        ...(ev.parentSessionId !== undefined && !existing?.parentSessionId
          ? { parentSessionId: ev.parentSessionId }
          : {}),
        ...(ev.platform !== undefined ? { platform: ev.platform } : {}),
        ...(ev.channel !== undefined ? { channel: ev.channel } : {}),
        ...(ev.thread !== undefined ? { thread: ev.thread } : {}),
        // Keep latest non-empty metadata; never overwrite with undefined.
        ...(ev.link !== undefined ? { link: ev.link } : {}),
        ...(ev.summary !== undefined ? { summary: ev.summary } : {}),
        ...(ev.title !== undefined ? { title: ev.title } : {}),
        ...(ev.status !== undefined ? { status: ev.status } : {}),
        ...(ev.triggeredBy !== undefined ? { triggeredBy: ev.triggeredBy } : {}),
        ...(ev.channelName !== undefined ? { channelName: ev.channelName } : {}),
        ...(ev.triggeredByName !== undefined ? { triggeredByName: ev.triggeredByName } : {}),
        ...(ev.threadUrl !== undefined ? { threadUrl: ev.threadUrl } : {}),
        ...(ev.runtime !== undefined ? { runtime: ev.runtime } : {}),
        ...(ev.model !== undefined ? { model: ev.model } : {}),
        ...(ev.effort !== undefined ? { effort: ev.effort } : {}),
        ...(ev.fastMode !== undefined ? { fastMode: ev.fastMode } : {}),
        ...(ev.permissionMode !== undefined ? { permissionMode: ev.permissionMode } : {}),
        ...(ev.outputMode !== undefined ? { outputMode: ev.outputMode } : {}),
        ...(ev.daemonId !== undefined ? { daemonId: ev.daemonId } : {}),
        ...(endedAt ? { endedAt } : {})
      }
    })
  }

  async listPage(q: SessionPageQuery): Promise<SessionPageRecord> {
    if (queryAgentIds(q).length === 0) {
      return { sessions: [], total: q.includeTotal ? 0 : null, hasMore: false }
    }
    const pageWhere = pageWhereSql(q, true)
    const countWhere = pageWhereSql(q, false)
    const [rows, totalRows] = await Promise.all([
      this.db.$queryRaw<SessionMeta[]>(Prisma.sql`
        SELECT s.*
        FROM "session_meta" AS s
        ${pageWhere}
        ORDER BY s."lastActivityAt" DESC, s."startedAt" DESC, s."id" DESC
        LIMIT ${q.limit + 1}
      `),
      q.includeTotal
        ? this.db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
            SELECT COUNT(*) AS count
            FROM "session_meta" AS s
            ${countWhere}
          `)
        : Promise.resolve(null)
    ])
    const total = totalRows ? Number(totalRows[0]?.count ?? 0n) : null
    const hasMore = rows.length > q.limit
    return {
      sessions: await this.hydrate(hasMore ? rows.slice(0, q.limit) : rows),
      total,
      hasMore
    }
  }

  async listFacets(q: SessionFacetQuery): Promise<SessionFacetIndex> {
    if (queryAgentIds(q).length === 0) return { agents: [], integrations: [], channels: [], triggers: [] }

    const agentQuery = { ...q }
    delete agentQuery.agentId
    const integrationQuery = { ...q }
    delete integrationQuery.integration
    const channelQuery = { ...q }
    delete channelQuery.channel
    delete channelQuery.platform
    const triggerQuery = { ...q }
    delete triggerQuery.triggeredBy
    delete triggerQuery.hookTriggerIds

    const integrationFacet = integrationFacetSql(q.githubHookIds ?? [])
    const [agents, integrations, channels, triggers] = await Promise.all([
      this.db.$queryRaw<SessionAgentFacetDbRow[]>(Prisma.sql`
        SELECT DISTINCT s."agentId"
        FROM "session_meta" AS s
        ${pageWhereSql(agentQuery, false)}
        ORDER BY s."agentId"
      `),
      this.db.$queryRaw<SessionFacetDbRow[]>(Prisma.sql`
        SELECT
          "id", "agentId", "platform", "channel", "triggeredBy",
          "channelName", "triggeredByName", "lastActivityAt", "startedAt"
        FROM (
          SELECT DISTINCT ON ("facetValue")
            "id", "agentId", "platform", "channel", "triggeredBy",
            "channelName", "triggeredByName", "lastActivityAt", "startedAt"
          FROM (
            SELECT
              s."id", s."agentId", s."platform", s."channel", s."triggeredBy",
              s."channelName", s."triggeredByName", s."lastActivityAt", s."startedAt",
              ${integrationFacet} AS "facetValue"
            FROM "session_meta" AS s
            ${pageWhereSql(integrationQuery, false)}
          ) AS filtered
          ORDER BY "facetValue", "lastActivityAt" DESC, "startedAt" DESC, "id" DESC
        ) AS latest
        ORDER BY "lastActivityAt" DESC, "startedAt" DESC, "id" DESC
      `),
      this.db.$queryRaw<SessionFacetDbRow[]>(Prisma.sql`
        SELECT
          "id", "agentId", "platform", "channel", "triggeredBy",
          "channelName", "triggeredByName", "lastActivityAt", "startedAt"
        FROM (
          SELECT DISTINCT ON (s."channel")
            s."id", s."agentId", s."platform", s."channel", s."triggeredBy",
            s."channelName", s."triggeredByName", s."lastActivityAt", s."startedAt"
          FROM "session_meta" AS s
          ${pageWhereSql(channelQuery, false)}
            AND s."channel" IS NOT NULL
            AND s."channel" <> ''
          ORDER BY s."channel", s."lastActivityAt" DESC, s."startedAt" DESC, s."id" DESC
        ) AS latest
        ORDER BY "lastActivityAt" DESC, "startedAt" DESC, "id" DESC
      `),
      this.db.$queryRaw<SessionFacetDbRow[]>(Prisma.sql`
        SELECT
          "id", "agentId", "platform", "channel", "triggeredBy",
          "channelName", "triggeredByName", "lastActivityAt", "startedAt"
        FROM (
          SELECT DISTINCT ON (s."triggeredBy")
            s."id", s."agentId", s."platform", s."channel", s."triggeredBy",
            s."channelName", s."triggeredByName", s."lastActivityAt", s."startedAt"
          FROM "session_meta" AS s
          ${pageWhereSql(triggerQuery, false)}
            AND s."triggeredBy" IS NOT NULL
            AND s."triggeredBy" <> ''
          ORDER BY s."triggeredBy", s."lastActivityAt" DESC, s."startedAt" DESC, s."id" DESC
        ) AS latest
        ORDER BY "lastActivityAt" DESC, "startedAt" DESC, "id" DESC
      `)
    ])
    return {
      agents: agents.map((row) => AgentId(row.agentId)),
      integrations: integrations.map(toFacetRecord),
      channels: channels.map(toFacetRecord),
      triggers: triggers.map(toFacetRecord)
    }
  }

  async list(q: SessionQuery): Promise<SessionListRecord[]> {
    const rows = await this.db.sessionMeta.findMany({
      where: pagedWhere(q),
      orderBy: SESSION_ORDER,
      ...(q.limit ? { take: q.limit } : {})
    })
    return this.hydrate(rows)
  }

  async get(id: SessionId): Promise<SessionMetaRecord | null> {
    const s = await this.db.sessionMeta.findUnique({ where: { id } })
    return s ? toRecord(s) : null
  }

  async listChildren(parentSessionId: SessionId, agentIds: AgentId[]): Promise<SessionMetaRecord[]> {
    if (agentIds.length === 0) return []
    const rows = await this.db.sessionMeta.findMany({
      where: { parentSessionId, agentId: { in: agentIds } },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }]
    })
    return rows.map(toRecord)
  }

  async findThreadOwner(channel: string, thread: string): Promise<{ agentId: string; daemonId: string } | null> {
    // Most-recently-active session on this (channel, thread) that has a routable daemon
    // (`daemonId` is stamped by the CP from the authenticated WS conn — trusted).
    // NOTE: do NOT filter on `endedAt` — a session emits `phase:'end'` (→ `endedAt`) at the end
    // of EVERY turn, so an idle-between-turns session (the normal state of a thread's owner
    // between messages) has `endedAt` set yet is still the valid target; the daemon resumes it on
    // delivery. Filtering `endedAt: null` here made the affinity fallback miss essentially every
    // real thread (incl. a case-2a spawned session after its one headless turn).
    const row = await this.db.sessionMeta.findFirst({
      where: { channel, thread, daemonId: { not: null } },
      orderBy: [{ lastActivityAt: 'desc' }, { startedAt: 'desc' }],
      select: { agentId: true, daemonId: true }
    })
    return row && row.daemonId ? { agentId: row.agentId, daemonId: row.daemonId } : null
  }
}
