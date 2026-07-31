/**
 * PgSessionRepo — converged session milestones (design §3.8, §3.14).
 *
 * METADATA ONLY: there is no body column to write. `recordMilestone` upserts on
 * `sessionId`, advancing `phase` and keeping the latest `link`/`summary`; the
 * `end` phase stamps `endedAt`. The launch tie (`launchId`) is set on create.
 */
import type { Platform } from '@agentconnect.md/protocol'
import { Prisma, type SessionMeta } from '../../generated/prisma/client.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import type {
  SessionRepo,
  SessionMilestoneResult,
  SessionVisibilityChange,
  SessionVisibilityState,
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
  ActivityState,
  SessionVisibility,
  VisibilitySource
} from '../ports.js'
import { AgentId, BotId, DaemonId, LaunchId, OrgId, SessionId } from '../../domain/ids.js'

/** Webchat conversation ids are CP-minted UUIDs; any other `channel` shape can
 *  never name a `webchat_conversation` row, so the fence path skips it. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
    orgId: OrgId(s.orgId),
    visibility: s.visibility as SessionVisibility,
    ownerIdentity: s.ownerIdentity,
    visibilitySource: s.visibilitySource as VisibilitySource,
    visibilityRev: s.visibilityRev,
    visibilityAckedRev: s.visibilityAckedRev,
    startedAt: s.startedAt,
    endedAt: s.endedAt
  }
}

function usageKey(agentId: string, sessionId: string): string {
  return `${agentId}:${sessionId}`
}

function usageCounts(u: {
  lastActivityAt: Date
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
    reportedAt: u.lastActivityAt.toISOString(),
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

/**
 * The SQL mirror of `authorization/policy.ts#canViewSession` (session-visibility.md
 * §5). No role bypass — org owners included, every viewer sees `org` rows plus
 * `private` rows they own; only the internal/daemon-facing callers that pass no
 * viewer read unfiltered. `= ANY(array)` tolerates an empty identity set,
 * unlike the `IN (…)` list form used for agent ids.
 */
function sessionViewerSql(viewer: SessionFilterQuery['viewer']): Prisma.Sql | null {
  if (!viewer) return null
  return Prisma.sql`(
    s."visibility" = 'org'::"SessionVisibility"
    OR (s."ownerIdentity" IS NOT NULL AND s."ownerIdentity" = ANY(${viewer.identitySet}::text[]))
  )`
}

function pageWhereSql(q: SessionFilterQuery, includeCursor: boolean): Prisma.Sql {
  const filters: Prisma.Sql[] = [Prisma.sql`s."agentId" IN (${Prisma.join(queryAgentIds(q))})`]
  const viewerArm = sessionViewerSql(q.viewer)
  if (viewerArm) filters.push(viewerArm)
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

  /**
   * Resolve the row's §4.2 classification, taking the shared parent lock when it
   * inherits (§4.5). `FOR SHARE` is what serializes a child insert against a
   * concurrent §4.3 tightening cascade (which holds `FOR UPDATE` on the same
   * parent): either we wait and then read the parent as already-private, or we
   * commit first and the cascade's post-lock re-scan finds us.
   *
   * The lookup is by session id ALONE — an A2A parent legitimately belongs to a
   * different agent, and often to a different daemon.
   */
  private async resolveClassification(
    tx: PrismaLike,
    ev: EventSessionInput
  ): Promise<{ visibility: SessionVisibility; ownerIdentity: string | null; source: VisibilitySource }> {
    const classification = ev.classification
    if (!classification) return { visibility: 'org', ownerIdentity: null, source: 'default' }
    if (classification.inherit !== true) return classification
    const parent = ev.parentSessionId
      ? await tx.$queryRaw<Array<{ visibility: string; ownerIdentity: string | null; visibilitySource: string }>>(
          Prisma.sql`
            SELECT "visibility", "ownerIdentity", "visibilitySource"
            FROM "session_meta" WHERE "id" = ${ev.parentSessionId} FOR SHARE
          `
        )
      : []
    // Parent not here yet (it may live on another daemon, or simply arrive
    // later): start private + unowned and mark the row for one-time settlement.
    //
    // A parent that IS here but is itself `inherited_pending` only holds the same
    // placeholder, so copying it as `inherited` would look settled and drop this
    // row out of the settlement scan — leaving a deep chain that arrives
    // root-last stuck private forever. Stay pending; the recursive settlement
    // below reaches us when the real ancestor lands.
    const unsettledParent = parent.length !== 1 || parent[0]!.visibilitySource === 'inherited_pending'
    if (unsettledParent) return { visibility: 'private', ownerIdentity: null, source: 'inherited_pending' }
    return {
      visibility: parent[0]!.visibility as SessionVisibility,
      ownerIdentity: parent[0]!.ownerIdentity,
      source: 'inherited'
    }
  }

  /**
   * §4.5 settlement: copy a settled session's visibility onto the descendants
   * that arrived before it.
   *
   * Recursive by level, because a whole chain can be waiting: a grandchild whose
   * own parent was still `inherited_pending` when it arrived is pending too, so
   * settling one level unblocks the next. Every level is the same CAS on
   * `visibilitySource`, which is what keeps it conditional and one-time — a
   * descendant its owner has meanwhile re-classified is `explicit` and left
   * alone: reconciliation never overwrites a human decision.
   */
  private async settlePendingChildren(tx: PrismaLike, parent: SessionMetaRecord): Promise<SessionMetaRecord[]> {
    const settled: SessionMetaRecord[] = []
    const seen = new Set<string>([parent.id])
    let frontier: string[] = [parent.id]
    while (frontier.length > 0) {
      const rows = await tx.$queryRaw<SessionMeta[]>(Prisma.sql`
        UPDATE "session_meta" SET
          "visibility" = ${parent.visibility}::"SessionVisibility",
          "ownerIdentity" = ${parent.ownerIdentity},
          "visibilitySource" = 'inherited'::"VisibilitySource",
          "visibilityRev" = "visibilityRev" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "parentSessionId" = ANY(${frontier}::text[])
          AND "visibilitySource" = 'inherited_pending'::"VisibilitySource"
        RETURNING *
      `)
      const next = rows.map((row) => row.id).filter((id) => !seen.has(id))
      for (const id of next) seen.add(id)
      settled.push(...rows.map(toRecord))
      frontier = next
    }
    return settled
  }

  /**
   * The other half of settlement: a child whose parent commits between our own
   * classification read and our commit stays `inherited_pending` forever unless
   * we re-check. Same CAS, so it is a no-op once anything else has settled the
   * row. Runs in its own transaction after the milestone commits.
   */
  private async settleFromParent(sessionId: SessionId, parentSessionId: SessionId): Promise<SessionMetaRecord[]> {
    return withAmbientTx(this.db, async (tx) => {
      const parent = await tx.$queryRaw<
        Array<{ visibility: string; ownerIdentity: string | null; visibilitySource: string }>
      >(
        Prisma.sql`
          SELECT "visibility", "ownerIdentity", "visibilitySource"
          FROM "session_meta" WHERE "id" = ${parentSessionId} FOR SHARE
        `
      )
      // Nothing to settle from a parent that is itself still waiting.
      if (parent.length !== 1 || parent[0]!.visibilitySource === 'inherited_pending') return []
      const rows = await tx.$queryRaw<SessionMeta[]>(Prisma.sql`
        UPDATE "session_meta" SET
          "visibility" = ${parent[0]!.visibility}::"SessionVisibility",
          "ownerIdentity" = ${parent[0]!.ownerIdentity},
          "visibilitySource" = 'inherited'::"VisibilitySource",
          "visibilityRev" = "visibilityRev" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${sessionId}
          AND "visibilitySource" = 'inherited_pending'::"VisibilitySource"
        RETURNING *
      `)
      if (rows.length !== 1) return []
      const self = toRecord(rows[0]!)
      // We just settled — anything that was waiting on US can settle now too.
      return [self, ...(await this.settlePendingChildren(tx, self))]
    })
  }

  async recordMilestone(ev: EventSessionInput): Promise<SessionMilestoneResult> {
    const result = await withAmbientTx(this.db, async (tx) => this.upsertMilestone(tx, ev))
    if (!result.recorded || !result.session) return result
    // Out-of-order arrival: our parent may have landed while we were writing.
    // Settling ourselves can in turn settle descendants that were waiting on us,
    // so they join the set the caller owes a §5.1 gate push.
    if (result.session.visibilitySource === 'inherited_pending' && result.session.parentSessionId) {
      const [self, ...descendants] = await this.settleFromParent(result.session.id, result.session.parentSessionId)
      if (self) return { ...result, session: self, settled: [...result.settled, ...descendants] }
    }
    return result
  }

  private async upsertMilestone(tx: PrismaLike, ev: EventSessionInput): Promise<SessionMilestoneResult> {
    const endedAt = ev.phase === 'end' ? ev.at : undefined
    const lastActivityAt = ev.lastActivityAt ?? ev.at
    const cls = await this.resolveClassification(tx, ev)
    // Webchat current-session fence: lock the durable conversation row BEFORE
    // the session upsert. Pointer maintenance (below), authorization reads
    // (which lock the same conversation row FOR UPDATE), and any concurrent
    // replacement-session insert all serialize here, in one lock order
    // (conversation → session_meta).
    const webchatConversationId =
      ev.platform === 'webchat' && ev.channel && UUID_RE.test(ev.channel) ? ev.channel : null
    if (webchatConversationId) {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "webchat_conversation"
        WHERE "id" = ${webchatConversationId}::uuid AND "agentId" = ${ev.agentId}::uuid
        FOR UPDATE
      `)
    }
    const rows = await tx.$queryRaw<SessionMeta[]>(Prisma.sql`
      INSERT INTO "session_meta" (
        "id", "parentSessionId", "agentId", "launchId", "platform", "channel",
        "thread", "phase", "link", "summary", "title", "status",
        "lastActivityAt", "triggeredBy", "channelName", "triggeredByName",
        "threadUrl", "runtime", "model", "effort", "fastMode",
        "permissionMode", "outputMode", "daemonId", "orgId", "visibility",
        "ownerIdentity", "visibilitySource", "startedAt", "endedAt",
        "updatedAt"
      ) VALUES (
        ${ev.sessionId}, ${ev.parentSessionId ?? null}, ${ev.agentId},
        ${ev.launchId ?? null}, ${ev.platform ?? null}, ${ev.channel ?? null},
        ${ev.thread ?? null}, ${ev.phase}::"SessionPhase", ${ev.link ?? null},
        ${ev.summary ?? null}, ${ev.title ?? null}, ${ev.status ?? null},
        ${lastActivityAt}, ${ev.triggeredBy ?? null}, ${ev.channelName ?? null},
        ${ev.triggeredByName ?? null}, ${ev.threadUrl ?? null},
        ${ev.runtime ?? null}, ${ev.model ?? null}, ${ev.effort ?? null},
        ${ev.fastMode ?? null}, ${ev.permissionMode ?? null},
        ${ev.outputMode ?? null}, ${ev.daemonId ?? null},
        -- Denormalized from the owning agent (§3) so the org-wide list predicate
        -- never joins "agent". The agentId FK guarantees the subquery resolves.
        (SELECT a."orgId" FROM "agent" a WHERE a."id" = ${ev.agentId}),
        ${cls.visibility}::"SessionVisibility", ${cls.ownerIdentity},
        ${cls.source}::"VisibilitySource", ${ev.at},
        ${endedAt ?? null}, CURRENT_TIMESTAMP
      )
      -- NOTE: the visibility columns are deliberately absent from this SET list.
      -- Classification is FIRST-WINS (§4.2): a later milestone for the same
      -- session must never re-classify it — that would undo a §4.3 decision and,
      -- for a re-emit that lost its conversationKind, silently widen a private DM.
      ON CONFLICT ("id") DO UPDATE SET
        "parentSessionId" = COALESCE(
          "session_meta"."parentSessionId",
          EXCLUDED."parentSessionId"
        ),
        "phase" = CASE
          WHEN "session_meta"."phase" IN ('problem', 'end') THEN "session_meta"."phase"
          WHEN EXCLUDED."phase" IN ('problem', 'end') THEN EXCLUDED."phase"
          WHEN "session_meta"."phase" = 'plan' AND EXCLUDED."phase" = 'start'
            THEN "session_meta"."phase"
          ELSE EXCLUDED."phase"
        END,
        "lastActivityAt" = EXCLUDED."lastActivityAt",
        "platform" = COALESCE(EXCLUDED."platform", "session_meta"."platform"),
        "channel" = COALESCE(EXCLUDED."channel", "session_meta"."channel"),
        "thread" = COALESCE(EXCLUDED."thread", "session_meta"."thread"),
        "link" = COALESCE(EXCLUDED."link", "session_meta"."link"),
        "summary" = COALESCE(EXCLUDED."summary", "session_meta"."summary"),
        "title" = COALESCE(EXCLUDED."title", "session_meta"."title"),
        "status" = COALESCE(EXCLUDED."status", "session_meta"."status"),
        "triggeredBy" = COALESCE(EXCLUDED."triggeredBy", "session_meta"."triggeredBy"),
        "channelName" = COALESCE(EXCLUDED."channelName", "session_meta"."channelName"),
        "triggeredByName" = COALESCE(
          EXCLUDED."triggeredByName",
          "session_meta"."triggeredByName"
        ),
        "threadUrl" = COALESCE(EXCLUDED."threadUrl", "session_meta"."threadUrl"),
        "runtime" = COALESCE(EXCLUDED."runtime", "session_meta"."runtime"),
        "model" = COALESCE(EXCLUDED."model", "session_meta"."model"),
        "effort" = COALESCE(EXCLUDED."effort", "session_meta"."effort"),
        "fastMode" = COALESCE(EXCLUDED."fastMode", "session_meta"."fastMode"),
        "permissionMode" = COALESCE(
          EXCLUDED."permissionMode",
          "session_meta"."permissionMode"
        ),
        "outputMode" = COALESCE(EXCLUDED."outputMode", "session_meta"."outputMode"),
        "daemonId" = COALESCE(EXCLUDED."daemonId", "session_meta"."daemonId"),
        "endedAt" = COALESCE(EXCLUDED."endedAt", "session_meta"."endedAt"),
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "session_meta"."agentId" = EXCLUDED."agentId"
      RETURNING *
    `)
    if (rows.length !== 1) return { recorded: false, session: null, settled: [] }
    const session = toRecord(rows[0]!)
    if (webchatConversationId) {
      // Advance the conversation's current-session pointer (identity only —
      // visibility stays live in the authorization predicates). The startedAt
      // guard keeps a late re-emit from an OLDER session from stealing the
      // pointer back after a replacement session has been installed; the row
      // lock above orders genuinely concurrent replacement inserts.
      await tx.$executeRaw(Prisma.sql`
        UPDATE "webchat_conversation" AS c
        SET "currentSessionId" = ${session.id},
            "currentSessionRev" = c."currentSessionRev" + 1
        WHERE c."id" = ${webchatConversationId}::uuid
          AND c."agentId" = ${ev.agentId}::uuid
          AND c."currentSessionId" IS DISTINCT FROM ${session.id}
          AND NOT EXISTS (
            SELECT 1 FROM "session_meta" AS cur
            WHERE cur."id" = c."currentSessionId" AND cur."startedAt" >= ${session.startedAt}
          )
      `)
    }
    // A row that is itself waiting has only placeholder values, so it must not
    // settle anything: stamping a descendant `inherited` from a pending parent
    // would drop it out of the scan when the real ancestor finally lands.
    const settled =
      session.visibilitySource === 'inherited_pending' ? [] : await this.settlePendingChildren(tx, session)
    return { recorded: true, session, settled }
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

  async orgHasAny(orgId: OrgId): Promise<boolean> {
    const row = await this.db.sessionMeta.findFirst({ where: { orgId }, select: { id: true } })
    return row !== null
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

  async hasPrivateWebchatSession(conversationId: string, agentId: AgentId): Promise<boolean> {
    if (!UUID_RE.test(conversationId)) return false
    // The conversation's transactionally maintained current-session pointer is
    // the ONLY session identity this authorization trusts. `endedAt` cannot
    // express "replaced": the daemon stamps phase 'end' after every turn (see
    // findThreadOwner), so an idle-between-turns session is still current, and
    // unordered historical rows must never authorize a widened replacement.
    const rows = await this.db.$queryRaw<Array<{ visibility: string }>>(Prisma.sql`
      SELECT s."visibility"
      FROM "webchat_conversation" AS c
      JOIN "session_meta" AS s
        ON s."id" = c."currentSessionId"
       AND s."agentId" = c."agentId"
       AND s."platform" = 'webchat'
       AND s."channel" = c."id"::text
      WHERE c."id" = ${conversationId}::uuid AND c."agentId" = ${agentId}::uuid
    `)
    return rows[0]?.visibility === 'private'
  }

  async listChildren(
    parentSessionId: SessionId,
    agentIds: AgentId[],
    viewer?: SessionFilterQuery['viewer']
  ): Promise<SessionMetaRecord[]> {
    if (agentIds.length === 0) return []
    const rows = await this.db.sessionMeta.findMany({
      where: {
        parentSessionId,
        agentId: { in: agentIds },
        // The Prisma spelling of `sessionViewerSql` — the same predicate as the
        // list (no org-owner bypass), so a private child never leaks its title
        // through the detail page.
        ...(viewer ? { OR: [{ visibility: 'org' as const }, { ownerIdentity: { in: viewer.identitySet } }] } : {})
      },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }]
    })
    return rows.map(toRecord)
  }

  /**
   * §4.3 reclassification, with the §4.5 cascade semantics:
   *
   *  - **Widening** (`private → org`) never cascades — each descendant stays as
   *    classified; widening a child remains its owner's own decision.
   *  - **Tightening** (`org → private`) cascades to every descendant, including
   *    `explicit` ones: the child holds prompt text copied from the parent, so
   *    leaving it org-visible would defeat the change. Privacy wins.
   *
   * The cascade is lock-then-scan to a fixpoint: each level is re-scanned only
   * AFTER its parents are locked `FOR UPDATE`. A one-shot "scan everything, then
   * update" is not sufficient — a grandchild insert holding `FOR SHARE` on its
   * mid-level parent could commit a stale `org` snapshot after the scan passed.
   */
  async setVisibility(
    sessionId: SessionId,
    visibility: SessionVisibility,
    authorize?: (row: { visibility: SessionVisibility; ownerIdentity: string | null }) => boolean
  ): Promise<SessionVisibilityChange> {
    return withAmbientTx(this.db, async (tx) => {
      const locked = await tx.$queryRaw<Array<{ visibility: string; ownerIdentity: string | null }>>(Prisma.sql`
        SELECT "visibility", "ownerIdentity" FROM "session_meta" WHERE "id" = ${sessionId} FOR UPDATE
      `)
      if (locked.length !== 1) return { affected: [] }
      const current = {
        visibility: locked[0]!.visibility as SessionVisibility,
        ownerIdentity: locked[0]!.ownerIdentity
      }
      // Re-authorize against the LOCKED row, not the one the route read. An
      // ancestor cascade committing in between can re-own this session, and the
      // former owner's in-flight request must not still widen it.
      if (authorize && !authorize(current)) return { affected: [], forbidden: true }
      if (current.visibility === visibility) return { affected: [] } // no-op: no rev bump, no push
      const ownerIdentity = current.ownerIdentity
      const target = await tx.$queryRaw<SessionMeta[]>(Prisma.sql`
        UPDATE "session_meta" SET
          "visibility" = ${visibility}::"SessionVisibility",
          "visibilitySource" = 'explicit'::"VisibilitySource",
          "visibilityRev" = "visibilityRev" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${sessionId}
        RETURNING *
      `)
      const affected = target.map(toRecord)
      if (visibility === 'org') return { affected }

      const seen = new Set<string>([sessionId])
      let frontier: string[] = [sessionId]
      while (frontier.length > 0) {
        // Lock this level's children BEFORE reading them as a set to update: a
        // concurrent child insert either waits here or is caught by the re-scan.
        const children = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "session_meta"
          WHERE "parentSessionId" = ANY(${frontier}::text[])
          ORDER BY "id"
          FOR UPDATE
        `)
        const next = children.map((c) => c.id).filter((id) => !seen.has(id))
        if (next.length === 0) break
        for (const id of next) seen.add(id)
        // Every descendant is rewritten, including ones ALREADY private: their
        // transcripts hold text copied from this session, so they must inherit
        // ITS owner. Leaving a private-but-differently-owned child alone would
        // keep that other owner's access to the tightened session's content.
        const rows = await tx.$queryRaw<SessionMeta[]>(Prisma.sql`
          UPDATE "session_meta" SET
            "visibility" = 'private'::"SessionVisibility",
            "ownerIdentity" = ${ownerIdentity},
            "visibilitySource" = 'inherited'::"VisibilitySource",
            "visibilityRev" = "visibilityRev" + 1,
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ANY(${next}::text[])
            AND (
              "visibility" <> 'private'::"SessionVisibility"
              OR "ownerIdentity" IS DISTINCT FROM ${ownerIdentity}
              OR "visibilitySource" <> 'inherited'::"VisibilitySource"
            )
          RETURNING *
        `)
        affected.push(...rows.map(toRecord))
        frontier = next
      }
      return { affected }
    })
  }

  async recordVisibilityAck(sessionId: SessionId, visibilityRev: number): Promise<void> {
    await this.db.$executeRaw(Prisma.sql`
      UPDATE "session_meta"
      SET "visibilityAckedRev" = GREATEST("visibilityAckedRev", ${visibilityRev})
      WHERE "id" = ${sessionId}
    `)
  }

  async visibilitySnapshotForDaemon(daemonId: DaemonId, limit: number): Promise<SessionVisibilityState[]> {
    // Unacknowledged revisions FIRST, newest-active after. A session tightened
    // while this daemon was offline is by definition unacked, so it replays no
    // matter how old it is — a plain newest-first window would drop it past the
    // cap and leave the daemon capturing with a stale `org` gate forever.
    const rows = await this.db.$queryRaw<Array<{ id: string; visibility: string; visibilityRev: number }>>(Prisma.sql`
      SELECT "id", "visibility", "visibilityRev"
      FROM "session_meta"
      WHERE "daemonId" = ${daemonId}::uuid
      ORDER BY ("visibilityAckedRev" < "visibilityRev") DESC,
               "lastActivityAt" DESC, "startedAt" DESC, "id" DESC
      LIMIT ${limit}
    `)
    return rows.map((r) => ({
      sessionId: SessionId(r.id),
      visibility: r.visibility as SessionVisibility,
      visibilityRev: r.visibilityRev
    }))
  }

  async countUnackedVisibility(daemonId: DaemonId): Promise<number> {
    const rows = await this.db.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS n FROM "session_meta"
      WHERE "daemonId" = ${daemonId}::uuid AND "visibilityAckedRev" < "visibilityRev"
    `)
    return Number(rows[0]?.n ?? 0)
  }

  /** The session plus every descendant, for the §5.1 cutover state of a cascade. */
  async visibilitySubtree(sessionId: SessionId, limit: number): Promise<SessionMetaRecord[]> {
    const rows = await this.db.$queryRaw<SessionMeta[]>(Prisma.sql`
      WITH RECURSIVE subtree AS (
        SELECT * FROM "session_meta" WHERE "id" = ${sessionId}
        UNION
        SELECT child.* FROM "session_meta" child
        JOIN subtree ON child."parentSessionId" = subtree."id"
      )
      SELECT * FROM subtree LIMIT ${limit}
    `)
    return rows.map(toRecord)
  }

  async findThreadOwner(
    botId: BotId,
    channel: string,
    thread: string
  ): Promise<{ agentId: string; daemonId: string } | null> {
    // Most-recently-active session on this bot's (channel, thread) whose agent is currently
    // placed. The session's daemonId is provenance only and may be null after its reporting
    // daemon is deleted; routing follows current agent placement.
    // NOTE: do NOT filter on `endedAt` — a session emits `phase:'end'` (→ `endedAt`) at the end
    // of EVERY turn, so an idle-between-turns session (the normal state of a thread's owner
    // between messages) has `endedAt` set yet is still the valid target; the daemon resumes it on
    // delivery. Filtering `endedAt: null` here made the affinity fallback miss essentially every
    // real thread (incl. a case-2a spawned session after its one headless turn).
    const row = await this.db.sessionMeta.findFirst({
      where: {
        channel,
        thread,
        agent: {
          daemonId: { not: null },
          integrations: { some: { botId, status: 'active' } }
        }
      },
      orderBy: [{ lastActivityAt: 'desc' }, { startedAt: 'desc' }],
      select: { agentId: true, agent: { select: { daemonId: true } } }
    })
    return row?.agent.daemonId ? { agentId: row.agentId, daemonId: row.agent.daemonId } : null
  }
}
