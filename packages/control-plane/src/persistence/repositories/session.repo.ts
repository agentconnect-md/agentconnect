/**
 * PgSessionRepo — converged session milestones (design §3.8, §3.14).
 *
 * METADATA ONLY: there is no body column to write. `recordMilestone` upserts on
 * `sessionId`, advancing `phase` and keeping the latest `link`/`summary`; the
 * `end` phase stamps `endedAt`. The launch tie (`launchId`) is set on create.
 */
import {
  CODE_HOST_PROVIDERS,
  isCodeHostProvider,
  GENERIC_HOOK_KIND,
  type CodeHostProvider,
  type HookKind,
  type Platform
} from '@agentconnect.md/protocol'
import {
  Prisma,
  type ExternalScope,
  type SessionExternalAccessPolicy,
  type SessionMeta
} from '../../generated/prisma/client.js'
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
  ConversationKey,
  ConversationPageRecord,
  SessionFacetQuery,
  SessionFacetRecord,
  SessionFacetIndex,
  EventSessionInput,
  SessionUsageCounts,
  SessionQuery,
  SessionPhase,
  ActivityState,
  SessionVisibility,
  VisibilitySource,
  ExternalResolution,
  ExternalScopeRecord,
  SessionExternalAccessPolicyRecord,
  ExternalAccessPolicyState
} from '../ports.js'
import { AgentId, BotId, DaemonId, LaunchId, OrgId, SessionId } from '../../domain/ids.js'
import { sessionViewerSql } from './session-access-sql.js'

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
    tenantScope: s.tenantScope,
    phase: s.phase as SessionPhase,
    link: s.link,
    summary: s.summary,
    title: s.title,
    status: s.status,
    lastActivityAt: s.lastActivityAt,
    triggeredBy: s.triggeredBy,
    channelName: s.channelName,
    triggeredByName: s.triggeredByName,
    hookKind: (s.hookKind as HookKind | null) ?? null,
    threadUrl: s.threadUrl,
    runtime: s.runtime,
    model: s.model,
    effort: s.effort,
    fastMode: s.fastMode,
    permissionMode: s.permissionMode,
    outputMode: s.outputMode,
    daemonId: s.daemonId ? DaemonId(s.daemonId) : null,
    contentSetId: s.contentSetId,
    workspaceIsolation: s.workspaceIsolation as 'shared' | 'session' | null,
    activityState: s.activityState as ActivityState,
    orgId: OrgId(s.orgId),
    visibility: s.visibility as SessionVisibility,
    ownerIdentity: s.ownerIdentity,
    visibilitySource: s.visibilitySource as VisibilitySource,
    visibilityRev: s.visibilityRev,
    visibilityAckedRev: s.visibilityAckedRev,
    externalProvider: s.externalProvider,
    externalScopeId: s.externalScopeId,
    externalResolution: (s.externalResolution as ExternalResolution | null) ?? null,
    legacyUnresolved: s.legacyUnresolved,
    classifiedPolicyRev: s.classifiedPolicyRev,
    contentPurgedAt: s.contentPurgedAt,
    contentPurgedReason: s.contentPurgedReason,
    startedAt: s.startedAt,
    endedAt: s.endedAt
  }
}

function toExternalScopeRecord(scope: ExternalScope): ExternalScopeRecord {
  return {
    id: scope.id,
    orgId: OrgId(scope.orgId),
    provider: scope.provider,
    realmKey: scope.realmKey,
    resourceKind: scope.resourceKind,
    resourceKey: scope.resourceKey,
    credentialKind: scope.credentialKind,
    credentialId: scope.credentialId,
    aclRevision: scope.aclRevision,
    revokedAt: scope.revokedAt
  }
}

function toExternalPolicyRecord(policy: SessionExternalAccessPolicy): SessionExternalAccessPolicyRecord {
  return {
    orgId: OrgId(policy.orgId),
    provider: policy.provider,
    state: policy.state as ExternalAccessPolicyState,
    currentRev: policy.currentRev,
    readFenceRev: policy.readFenceRev
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
  costAmount: Prisma.Decimal // NUMERIC(38,18) — the session views only display it
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
    ...(!u.costAmount.isZero() || u.costCurrency ? { costAmount: u.costAmount.toNumber() } : {}),
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

// Default row alias for the predicate builders. The conversation grouping
// query (listConversationPage) applies the SAME predicate to an inner probe
// row, so every builder takes the alias as a parameter.
const S = Prisma.raw('s')

function platformSql(platform: Platform, a: Prisma.Sql = S): Prisma.Sql {
  return platform === 'slack'
    ? Prisma.sql`(${a}."platform" = 'slack' OR ${a}."platform" IS NULL)`
    : Prisma.sql`${a}."platform" = ${platform}`
}

function hookTriggerSql(hookIds: string[], a: Prisma.Sql = S): Prisma.Sql {
  if (hookIds.length === 0) return Prisma.sql`FALSE`
  const triggers = hookIds.map((id) => `${HOOK_TRIGGER_PREFIX}${id}`)
  return Prisma.sql`
    (
      ${a}."triggeredBy" IN (${Prisma.join(triggers)})
      OR (
        ${a}."platform" = 'hook'
        AND
        (
          ${a}."triggeredBy" IS NULL
          OR ${a}."triggeredBy" = ${HOOK_TRIGGER_PREFIX}
          OR ${a}."triggeredBy" NOT LIKE ${`${HOOK_TRIGGER_PREFIX}%`}
        )
        AND ${a}."channel" IN (${Prisma.join(hookIds)})
      )
    )
  `
}

/** The hook definition a reported session fires from. `triggeredBy` is authoritative;
 *  the channel fallback covers legacy headless hook rows that predate that identity. */
function hookIdOfEvent(ev: EventSessionInput): string | null {
  const fromTrigger = ev.triggeredBy?.startsWith(HOOK_TRIGGER_PREFIX)
    ? ev.triggeredBy.slice(HOOK_TRIGGER_PREFIX.length)
    : ''
  const id = fromTrigger || (ev.platform === 'hook' ? (ev.channel ?? '') : '')
  return UUID_RE.test(id) ? id : null
}

/** One code host's hook sessions. The row's own snapshot decides when it has one — that
 *  survives the definition being deleted — and only rows written before the column fall
 *  back to matching the live hook ids. */
function codeHostHookSql(provider: CodeHostProvider, hookIds: string[], a: Prisma.Sql = S): Prisma.Sql {
  return Prisma.sql`
    ${a}."platform" = 'hook'
    AND (
      ${a}."hookKind" = ${provider}::"HookKind"
      OR (${a}."hookKind" IS NULL AND ${hookTriggerSql(hookIds, a)})
    )
  `
}

/** Hook sessions that belong to NO code host — a snapshot naming one is excluded on its
 *  own, and pre-snapshot rows are excluded by promoted id, or a GitLab session would be
 *  counted twice: once as gitlab, once as a webhook. */
function genericHookSql(codeHostHookIds: string[], a: Prisma.Sql = S): Prisma.Sql {
  const byId =
    codeHostHookIds.length === 0
      ? Prisma.sql`TRUE`
      : Prisma.sql`
          (${a}."triggeredBy" IS NULL OR ${a}."triggeredBy" NOT IN (${Prisma.join(
            codeHostHookIds.map((id) => `${HOOK_TRIGGER_PREFIX}${id}`)
          )}))
          AND (
            (${a}."triggeredBy" LIKE ${`${HOOK_TRIGGER_PREFIX}%`} AND ${a}."triggeredBy" <> ${HOOK_TRIGGER_PREFIX})
            OR ${a}."channel" IS NULL
            OR ${a}."channel" NOT IN (${Prisma.join(codeHostHookIds)})
          )
        `
  return Prisma.sql`
    ${a}."platform" = 'hook'
    AND (
      ${a}."hookKind" = ${GENERIC_HOOK_KIND}::"HookKind"
      OR (${a}."hookKind" IS NULL AND ${byId})
    )
  `
}

/** Every promoted code-host hook id, in one list, for the generic-hook exclusion. */
function allCodeHostHookIds(q: Pick<SessionFilterQuery, 'codeHostHookIds'>): string[] {
  return CODE_HOST_PROVIDERS.flatMap((provider) => q.codeHostHookIds?.[provider] ?? [])
}

function integrationSql(q: SessionFilterQuery, a: Prisma.Sql = S): Prisma.Sql | null {
  if (!q.integration) return null
  // Each code host reads its own promoted ids; asking the shared provider list means a
  // new host is filterable here without an arm of its own.
  if (isCodeHostProvider(q.integration))
    return codeHostHookSql(q.integration, q.codeHostHookIds?.[q.integration] ?? [], a)
  if (q.integration === 'hook') return genericHookSql(allCodeHostHookIds(q), a)
  return platformSql(q.integration, a)
}

// "Conversations these agents took part in", one EXISTS per requested agent. No
// single row can be owned by two agents, so the predicate has to be asked of the
// row's CONVERSATION instead — each agent must have its own row under the same
// §5.1 key. The probe re-applies the caller's visibility predicate: a session
// only they cannot see must never be what makes a conversation qualify.
//
// One agent produces nothing — `agentId IN (…)` already implies it — so every
// existing single-agent query keeps its exact plan. Rows with a NULL channel or
// thread (cron/hook/dream singletons) drop out on their own: the key join
// compares those columns with `=`, which no NULL satisfies, and a conversation
// of one can never hold a second participant anyway.
function conversationParticipantsSql(q: SessionFilterQuery, a: Prisma.Sql, probePrefix: string): Prisma.Sql[] {
  const wanted = q.conversationAgentIds ?? []
  if (wanted.length < 2) return []
  return wanted.map((agentId, index) => {
    const p = Prisma.raw(`${probePrefix}${index}`)
    const viewerArm = sessionViewerSql(q.viewer, p)
    return Prisma.sql`
      EXISTS (
        SELECT 1
        FROM "session_meta" AS ${p}
        WHERE ${p}."agentId" = ${agentId}
          AND ${conversationKeyJoinSql(p, a)}
          ${viewerArm ? Prisma.sql`AND ${viewerArm}` : Prisma.empty}
      )
    `
  })
}

function pageWhereSql(
  q: SessionFilterQuery,
  includeCursor: boolean,
  a: Prisma.Sql = S,
  // Distinct per alias: the emit-at-max probe nests one `pageWhereSql` inside
  // another, and reusing a name there would shadow the outer participant probe.
  probePrefix = 'cp'
): Prisma.Sql {
  const filters: Prisma.Sql[] = [Prisma.sql`${a}."agentId" IN (${Prisma.join(queryAgentIds(q))})`]
  const viewerArm = sessionViewerSql(q.viewer, a)
  if (viewerArm) filters.push(viewerArm)
  if (q.platform) filters.push(platformSql(q.platform, a))
  const integration = integrationSql(q, a)
  if (integration) filters.push(integration)
  if (q.channel) filters.push(Prisma.sql`${a}."channel" = ${q.channel}`)
  if (q.triggeredBy) filters.push(Prisma.sql`${a}."triggeredBy" = ${q.triggeredBy}`)
  if (q.hookTriggerIds) filters.push(hookTriggerSql(q.hookTriggerIds, a))
  filters.push(...conversationParticipantsSql(q, a, probePrefix))
  if (includeCursor && q.cursor) {
    filters.push(Prisma.sql`
      (${a}."lastActivityAt", ${a}."startedAt", ${a}."id") < (
        ${new Date(q.cursor.activityMs)},
        ${new Date(q.cursor.startedMs)},
        ${q.cursor.id}
      )
    `)
  }
  return Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}`
}

/** One CASE arm per code host, built from the shared provider list so a new host projects
 *  its own facet value without an arm written by hand. Every provider gets an arm whether
 *  or not it still has live hooks: a snapshot alone is enough to classify a row. */
function integrationFacetSql(codeHostHookIds: Partial<Record<CodeHostProvider, string[]>>): Prisma.Sql {
  const arms = CODE_HOST_PROVIDERS.map(
    (provider) => Prisma.sql`WHEN ${codeHostHookSql(provider, codeHostHookIds[provider] ?? [])} THEN ${provider}`
  )
  return Prisma.sql`
    CASE
      ${Prisma.join(arms, ' ')}
      WHEN s."platform" IS NULL THEN 'slack'
      ELSE s."platform"
    END
  `
}

/** Conversation-key equality between two aliased session rows
 *  (merged-conversation-view.md §5.1): legacy NULL platform reads as 'slack'
 *  (mirroring `platformWhere`), tenant scope matches NULL-safely. Callers only
 *  apply this to rows whose channel/thread are both present. */
function conversationKeyJoinSql(a: Prisma.Sql, b: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    COALESCE(${a}."platform", 'slack') = COALESCE(${b}."platform", 'slack')
    AND ${a}."tenantScope" IS NOT DISTINCT FROM ${b}."tenantScope"
    AND ${a}."channel" = ${b}."channel"
    AND ${a}."thread" = ${b}."thread"
  `
}

/** In-process mirror of `conversationKeyJoinSql` for bucketing fetched rows.
 *  NUL-joined like the §5.1 codec — a printable separator could collide on
 *  parts that contain it. */
function conversationKeyOf(row: Pick<SessionMeta, 'platform' | 'tenantScope' | 'channel' | 'thread'>): string {
  return [row.platform ?? 'slack', row.tenantScope ?? '', row.channel ?? '', row.thread ?? ''].join('\u0000')
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
  hookKind: HookKind | null
  lastActivityAt: Date
  startedAt: Date
}

type SessionAgentFacetDbRow = { agentId: string }

type ResolvedSessionClassification = {
  visibility: SessionVisibility
  ownerIdentity: string | null
  source: VisibilitySource
  externalProvider: string | null
  externalScopeId: string | null
  externalResolution: ExternalResolution | null
  // A freshly classified candidate is never legacy: enablement is what stamps
  // the mark, and an A2A child copies it from the parent whose audience it takes.
  legacyUnresolved: boolean
  classifiedPolicyRev: bigint | null
}

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
    ev: EventSessionInput,
    orgId: OrgId
  ): Promise<ResolvedSessionClassification> {
    const classification = ev.classification
    const direct =
      !classification || classification.inherit === true
        ? null
        : {
            ...classification,
            externalProvider: null,
            externalScopeId: null,
            externalResolution: null,
            legacyUnresolved: false,
            classifiedPolicyRev: null
          }
    if (ev.externalCandidate) {
      const candidate = ev.externalCandidate
      await tx.sessionExternalAccessPolicy.upsert({
        where: { orgId_provider: { orgId, provider: candidate.provider } },
        create: { orgId, provider: candidate.provider },
        update: {}
      })
      // Serialize candidate creation with owner enable/disable. If ingest wins,
      // the transition's bulk UPDATE sees this row; if the transition wins,
      // classification observes its committed revision and state. Without the
      // lock a settled `org` row could land below an enable read fence forever.
      const policies = await tx.$queryRaw<SessionExternalAccessPolicy[]>(Prisma.sql`
        SELECT * FROM "session_external_access_policy"
        WHERE "orgId" = ${orgId} AND "provider" = ${candidate.provider}
        FOR UPDATE
      `)
      const policy = policies[0]!
      let scopeId: string | null = null
      let resolution = candidate.resolution
      if (candidate.resolution === 'settled' && candidate.scope) {
        const scope = candidate.scope
        const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          INSERT INTO "external_scope" (
            "orgId", "provider", "realmKey", "resourceKind", "resourceKey",
            "credentialKind", "credentialId", "createdAt", "updatedAt"
          ) VALUES (
            ${orgId}, ${candidate.provider}, ${scope.realmKey}, ${scope.resourceKind},
            ${scope.resourceKey}, ${scope.credentialKind ?? null},
            ${scope.credentialId ?? null}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
          ON CONFLICT ("orgId", "provider", "realmKey", "resourceKind", "resourceKey")
          DO UPDATE SET
            "aclRevision" = CASE
              WHEN "external_scope"."credentialKind" IS DISTINCT FROM EXCLUDED."credentialKind"
                OR "external_scope"."credentialId" IS DISTINCT FROM EXCLUDED."credentialId"
              THEN "external_scope"."aclRevision" + 1
              ELSE "external_scope"."aclRevision"
            END,
            "credentialKind" = EXCLUDED."credentialKind",
            "credentialId" = EXCLUDED."credentialId",
            "revokedAt" = NULL,
            "updatedAt" = CURRENT_TIMESTAMP
          RETURNING "id"
        `)
        scopeId = rows[0]?.id ?? null
        if (!scopeId) resolution = 'invalid'
      } else if (candidate.resolution === 'settled') {
        resolution = 'invalid'
      }
      const base = direct ?? { visibility: 'org' as const, ownerIdentity: null, source: 'default' as const }
      return {
        ...base,
        // A Feishu/Lark p2p conversation is both a private direct session and a
        // provider-bound candidate. Keep its owner-only baseline while sync is
        // disabled; enabling the policy atomically switches every candidate to
        // the live external audience below.
        visibility: policy.state === 'disabled' ? base.visibility : 'external',
        externalProvider: candidate.provider,
        externalScopeId: scopeId,
        externalResolution: resolution,
        legacyUnresolved: false,
        classifiedPolicyRev: policy.currentRev
      }
    }
    if (direct) return direct
    if (!classification) {
      return {
        visibility: 'org',
        ownerIdentity: null,
        source: 'default',
        externalProvider: null,
        externalScopeId: null,
        externalResolution: null,
        legacyUnresolved: false,
        classifiedPolicyRev: null
      }
    }
    const parent = ev.parentSessionId
      ? await tx.$queryRaw<
          Array<{
            visibility: string
            ownerIdentity: string | null
            visibilitySource: string
            externalProvider: string | null
            externalScopeId: string | null
            externalResolution: string | null
            legacyUnresolved: boolean
            classifiedPolicyRev: bigint | null
          }>
        >(
          Prisma.sql`
            SELECT "visibility", "ownerIdentity", "visibilitySource",
                   "externalProvider", "externalScopeId", "externalResolution",
                   "legacyUnresolved", "classifiedPolicyRev"
            FROM "session_meta"
            WHERE "id" = ${ev.parentSessionId} AND "orgId" = ${orgId}
            FOR SHARE
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
    if (unsettledParent) {
      return {
        visibility: 'private',
        ownerIdentity: null,
        source: 'inherited_pending',
        externalProvider: null,
        externalScopeId: null,
        externalResolution: null,
        legacyUnresolved: false,
        classifiedPolicyRev: null
      }
    }
    return {
      visibility: parent[0]!.visibility as SessionVisibility,
      ownerIdentity: parent[0]!.ownerIdentity,
      source: 'inherited',
      externalProvider: parent[0]!.externalProvider,
      externalScopeId: parent[0]!.externalScopeId,
      externalResolution: parent[0]!.externalResolution as ExternalResolution | null,
      // Inherit the parent's provenance too: a child of a legacy-unresolvable
      // parent can never resolve either, and must not read as a new failure.
      legacyUnresolved: parent[0]!.legacyUnresolved,
      classifiedPolicyRev: parent[0]!.classifiedPolicyRev
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
          "externalProvider" = ${parent.externalProvider},
          "externalScopeId" = ${parent.externalScopeId}::uuid,
          "externalResolution" = ${parent.externalResolution}::"ExternalResolution",
          "legacyUnresolved" = ${parent.legacyUnresolved},
          "classifiedPolicyRev" = ${parent.classifiedPolicyRev},
          "visibilitySource" = 'inherited'::"VisibilitySource",
          "visibilityRev" = "visibilityRev" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "parentSessionId" = ANY(${frontier}::text[])
          AND "orgId" = ${parent.orgId}
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

  /** Settle migration-marked descendants when a legacy shared root supplies its
   * first trusted scope after upgrade. Only pending rows from the same org and
   * provider move; explicit/private or contradictory rows stay fail-closed. */
  private async settleExternalDescendants(tx: PrismaLike, parent: SessionMetaRecord): Promise<SessionMetaRecord[]> {
    if (
      parent.externalProvider === null ||
      parent.externalScopeId === null ||
      parent.externalResolution !== 'settled'
    ) {
      return []
    }
    const rows = await tx.$queryRaw<SessionMeta[]>(Prisma.sql`
      WITH RECURSIVE descendants AS (
        SELECT child."id"
        FROM "session_meta" child
        WHERE child."parentSessionId" = ${parent.id} AND child."orgId" = ${parent.orgId}
        UNION
        SELECT child."id"
        FROM "session_meta" child
        JOIN descendants prior ON child."parentSessionId" = prior."id"
        WHERE child."orgId" = ${parent.orgId}
      )
      UPDATE "session_meta" s SET
        "visibility" = ${parent.visibility}::"SessionVisibility",
        "ownerIdentity" = NULL,
        "externalScopeId" = ${parent.externalScopeId}::uuid,
        "externalResolution" = 'settled'::"ExternalResolution",
        "classifiedPolicyRev" = ${parent.classifiedPolicyRev},
        "visibilityRev" = s."visibilityRev" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
      FROM descendants d
      WHERE s."id" = d."id"
        AND s."orgId" = ${parent.orgId}
        AND s."externalProvider" = ${parent.externalProvider}
        AND s."externalResolution" = 'pending'::"ExternalResolution"
      RETURNING s.*
    `)
    return rows.map(toRecord)
  }

  /**
   * The other half of settlement: a child whose parent commits between our own
   * classification read and our commit stays `inherited_pending` forever unless
   * we re-check. Same CAS, so it is a no-op once anything else has settled the
   * row. Runs in its own transaction after the milestone commits.
   */
  private async settleFromParent(
    orgId: OrgId,
    sessionId: SessionId,
    parentSessionId: SessionId
  ): Promise<SessionMetaRecord[]> {
    return withAmbientTx(this.db, async (tx) => {
      // Same-org hop (see `setVisibility`): a parent claimed across the tenancy
      // boundary reads as absent, which is exactly the "parent not here yet"
      // case this settlement already handles by staying pending.
      const parent = await tx.$queryRaw<Array<ResolvedSessionClassification & { visibilitySource: string }>>(
        Prisma.sql`
          SELECT "visibility", "ownerIdentity", "visibilitySource",
                 "externalProvider", "externalScopeId", "externalResolution",
                 "legacyUnresolved", "classifiedPolicyRev"
          FROM "session_meta"
          WHERE "id" = ${parentSessionId} AND "orgId" = ${orgId}
          FOR SHARE
        `
      )
      // Nothing to settle from a parent that is itself still waiting.
      if (parent.length !== 1 || parent[0]!.visibilitySource === 'inherited_pending') return []
      const rows = await tx.$queryRaw<SessionMeta[]>(Prisma.sql`
        UPDATE "session_meta" SET
          "visibility" = ${parent[0]!.visibility}::"SessionVisibility",
          "ownerIdentity" = ${parent[0]!.ownerIdentity},
          "externalProvider" = ${parent[0]!.externalProvider},
          "externalScopeId" = ${parent[0]!.externalScopeId}::uuid,
          "externalResolution" = ${parent[0]!.externalResolution}::"ExternalResolution",
          -- Provenance travels with the audience on BOTH inheritance paths, or a
          -- child that settles here after its parent was stamped legacy would
          -- look like a post-enable failure and degrade the policy for good.
          "legacyUnresolved" = ${parent[0]!.legacyUnresolved},
          "classifiedPolicyRev" = ${parent[0]!.classifiedPolicyRev},
          "visibilitySource" = 'inherited'::"VisibilitySource",
          "visibilityRev" = "visibilityRev" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${sessionId}
          AND "orgId" = ${orgId}
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
      const [self, ...descendants] = await this.settleFromParent(
        result.session.orgId,
        result.session.id,
        result.session.parentSessionId
      )
      if (self) return { ...result, session: self, settled: [...result.settled, ...descendants] }
    }
    return result
  }

  private async upsertMilestone(tx: PrismaLike, ev: EventSessionInput): Promise<SessionMilestoneResult> {
    const endedAt = ev.phase === 'end' ? ev.at : undefined
    const lastActivityAt = ev.lastActivityAt ?? ev.at
    // Webchat current-session fence: lock the durable conversation row BEFORE
    // the session upsert. Pointer maintenance (below), authorization reads
    // (which lock the same conversation row FOR UPDATE), and any concurrent
    // replacement-session insert all serialize here, in one lock order
    // (conversation → session_meta).
    const webchatConversationId =
      ev.platform === 'webchat' && ev.channel && UUID_RE.test(ev.channel) ? ev.channel : null
    if (webchatConversationId) {
      // Any PARTICIPANT's session serializes on the conversation row (the
      // roster is fixed at creation; `agentId` on the conversation is the
      // primary mirror, so member agents match through the participant table).
      await tx.$queryRaw(Prisma.sql`
        SELECT c."id" FROM "webchat_conversation" AS c
        WHERE c."id" = ${webchatConversationId}::uuid
          AND (
            c."agentId" = ${ev.agentId}::uuid
            OR EXISTS (
              SELECT 1 FROM "webchat_conversation_agent" AS p
              WHERE p."conversationId" = c."id" AND p."agentId" = ${ev.agentId}::uuid
            )
          )
        FOR UPDATE
      `)
    }
    const agent = await tx.agent.findUnique({ where: { id: ev.agentId }, select: { orgId: true } })
    if (!agent) return { recorded: false, session: null, settled: [] }
    const orgId = OrgId(agent.orgId)
    const cls = await this.resolveClassification(tx, ev, orgId)
    // A legacy daemon row has no durable source binding. The migration marks
    // its Slack shape `pending`; a later trusted milestone may bind or settle it
    // exactly once. An explicit DIRECT row remains immutable, while an already
    // marked external candidate no longer treats its legacy visibility source as
    // ownership authority.
    const rebound = cls.externalProvider
      ? (
          await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            UPDATE "session_meta" SET
              "visibility" = ${cls.visibility}::"SessionVisibility",
              "ownerIdentity" = NULL,
              "externalProvider" = ${cls.externalProvider},
              "externalScopeId" = ${cls.externalScopeId}::uuid,
              "externalResolution" = ${cls.externalResolution}::"ExternalResolution",
              "classifiedPolicyRev" = ${cls.classifiedPolicyRev},
              "visibilityRev" = "visibilityRev" + 1,
              "updatedAt" = CURRENT_TIMESTAMP
            WHERE "id" = ${ev.sessionId}
              AND "agentId" = ${ev.agentId}
              AND ("channel" IS NULL OR "channel" = ${ev.channel ?? null})
              AND (
                (
                  "externalProvider" IS NULL
                  AND "visibilitySource" <> 'explicit'::"VisibilitySource"
                  AND "visibility" = 'org'::"SessionVisibility"
                )
                OR (
                  "externalProvider" = ${cls.externalProvider}
                  AND "externalResolution" = 'pending'::"ExternalResolution"
                  AND ${cls.externalResolution === 'settled'}
                  AND ${cls.externalScopeId !== null}
                  AND ("externalScopeId" IS NULL OR "externalScopeId" = ${cls.externalScopeId}::uuid)
                )
              )
            RETURNING "id"
          `)
        ).length === 1
      : false
    const rows = await tx.$queryRaw<SessionMeta[]>(Prisma.sql`
      INSERT INTO "session_meta" (
        "id", "parentSessionId", "agentId", "launchId", "platform", "channel",
        "thread", "tenantScope", "phase", "link", "summary", "title", "status",
        "lastActivityAt", "triggeredBy", "channelName", "triggeredByName", "hookKind",
        "threadUrl", "runtime", "model", "effort", "fastMode",
        "permissionMode", "outputMode", "daemonId", "contentSetId", "workspaceIsolation", "orgId", "visibility",
        "ownerIdentity", "visibilitySource", "externalProvider",
        "externalScopeId", "externalResolution", "legacyUnresolved",
        "classifiedPolicyRev", "startedAt", "endedAt", "updatedAt"
      ) VALUES (
        ${ev.sessionId}, ${ev.parentSessionId ?? null}, ${ev.agentId},
        ${ev.launchId ?? null}, ${ev.platform ?? null}, ${ev.channel ?? null},
        ${ev.thread ?? null}, ${ev.transportScope ?? null}, ${ev.phase}::"SessionPhase", ${ev.link ?? null},
        ${ev.summary ?? null}, ${ev.title ?? null}, ${ev.status ?? null},
        ${lastActivityAt}, ${ev.triggeredBy ?? null}, ${ev.channelName ?? null},
        ${ev.triggeredByName ?? null},
        -- Snapshot the hook KIND beside the trigger id, resolved in this same statement.
        -- The definition can be deleted and recreated; the session's own source cannot.
        (SELECT h."kind" FROM "hook_def" h WHERE h."id" = ${hookIdOfEvent(ev)}::uuid),
        ${ev.threadUrl ?? null},
        ${ev.runtime ?? null}, ${ev.model ?? null}, ${ev.effort ?? null},
        ${ev.fastMode ?? null}, ${ev.permissionMode ?? null},
        ${ev.outputMode ?? null}, ${ev.daemonId ?? null},
        -- Read from the reporting daemon's membership in this same statement, so the store the
        -- bodies are going to can never drift from the daemon it describes. Restricted to the
        -- org-less pool: that is the set whose members provably share one data-plane store.
        (
          SELECT msm."setId" FROM "member_set_member" msm
          JOIN "member_set" ms ON ms."id" = msm."setId"
          WHERE msm."daemonId" = ${ev.daemonId ?? null}::uuid AND ms."orgId" IS NULL
        ),
        ${ev.workspaceIsolation ?? null}::"WorkspaceIsolation",
        ${orgId},
        ${cls.visibility}::"SessionVisibility", ${cls.ownerIdentity},
        ${cls.source}::"VisibilitySource", ${cls.externalProvider},
        ${cls.externalScopeId}::uuid, ${cls.externalResolution}::"ExternalResolution",
        ${cls.legacyUnresolved}, ${cls.classifiedPolicyRev}, ${ev.at},
        ${endedAt ?? null}, CURRENT_TIMESTAMP
      )
      -- Visibility remains first-wins here. The narrow legacy pending → trusted
      -- external transition, when applicable, happened in the guarded UPDATE
      -- above and cannot overwrite an explicit or private row.
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
        "tenantScope" = COALESCE(EXCLUDED."tenantScope", "session_meta"."tenantScope"),
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
        -- First non-null wins: a snapshot is a record of what fired the session, so a
        -- later report can fill it in but never rewrite it.
        "hookKind" = COALESCE("session_meta"."hookKind", EXCLUDED."hookKind"),
        "threadUrl" = COALESCE(EXCLUDED."threadUrl", "session_meta"."threadUrl"),
        "runtime" = COALESCE(EXCLUDED."runtime", "session_meta"."runtime"),
        "model" = CASE
          WHEN ${ev.model !== undefined} THEN EXCLUDED."model"
          ELSE "session_meta"."model"
        END,
        "effort" = COALESCE(EXCLUDED."effort", "session_meta"."effort"),
        "fastMode" = COALESCE(EXCLUDED."fastMode", "session_meta"."fastMode"),
        "permissionMode" = COALESCE(
          EXCLUDED."permissionMode",
          "session_meta"."permissionMode"
        ),
        "outputMode" = COALESCE(EXCLUDED."outputMode", "session_meta"."outputMode"),
        -- Content ownership is pinned by the first authenticated daemon that
        -- reports the session. A later milestone must not move daemon-local
        -- transcript/worktree provenance when the agent itself is reassigned.
        "daemonId" = COALESCE("session_meta"."daemonId", EXCLUDED."daemonId"),
        -- Filled only while the reporter IS the recorded content owner, so a milestone from a
        -- daemon that merely serves the agent now cannot claim this session's rows for its store.
        -- Null is a REAL value here (a private store), which is why this is not a COALESCE.
        "contentSetId" = CASE
          WHEN "session_meta"."daemonId" IS DISTINCT FROM EXCLUDED."daemonId"
            THEN "session_meta"."contentSetId"
          ELSE COALESCE("session_meta"."contentSetId", EXCLUDED."contentSetId")
        END,
        "workspaceIsolation" = COALESCE(
          EXCLUDED."workspaceIsolation",
          "session_meta"."workspaceIsolation"
        ),
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
      // The reporting participant's OWN pointer (webchat-multi-agents.md §3.1) —
      // the primary's row mirrors the conversation-level fence above; a member's
      // row is the only place its current session is recorded.
      await tx.$executeRaw(Prisma.sql`
        UPDATE "webchat_conversation_agent" AS p
        SET "currentSessionId" = ${session.id},
            "currentSessionRev" = p."currentSessionRev" + 1
        WHERE p."conversationId" = ${webchatConversationId}::uuid
          AND p."agentId" = ${ev.agentId}::uuid
          AND p."currentSessionId" IS DISTINCT FROM ${session.id}
          AND NOT EXISTS (
            SELECT 1 FROM "session_meta" AS cur
            WHERE cur."id" = p."currentSessionId" AND cur."startedAt" >= ${session.startedAt}
          )
      `)
    }
    // A row that is itself waiting has only placeholder values, so it must not
    // settle anything: stamping a descendant `inherited` from a pending parent
    // would drop it out of the scan when the real ancestor finally lands.
    const settled =
      session.visibilitySource === 'inherited_pending' ? [] : await this.settlePendingChildren(tx, session)
    if (rebound) settled.push(...(await this.settleExternalDescendants(tx, session)))
    // Keep the durable policy state aligned with the actual unresolved set.
    // A trusted retry may settle the final historical candidate after enable;
    // conversely, a new pending/invalid candidate must surface degradation.
    // resolveClassification's policy upsert holds the policy row until this
    // transaction commits, so a concurrent enable/disable cannot interleave.
    if (
      cls.externalProvider !== null &&
      cls.visibility === 'external' &&
      (cls.externalResolution !== 'settled' || rebound)
    ) {
      // Degradation is per row, not a count: history the migration could not bind
      // never settles, so counting it as a fault would pin the policy to
      // 'degraded' forever — and a count also lets a legacy row settling cancel
      // out a live post-enable failure, silently clearing the fault while it is
      // still there. Only an unresolved row that is NOT marked legacy degrades.
      // Same row predicate as `countExternalUnresolved`, so the state signal and
      // the owner-facing `hiddenSessions` diagnostic never disagree about which
      // rows are hidden.
      await tx.$executeRaw(Prisma.sql`
        UPDATE "session_external_access_policy" p
        SET "state" = CASE
              WHEN EXISTS (
                SELECT 1 FROM "session_meta" s
                WHERE s."orgId" = p."orgId"
                  AND s."externalProvider" = p."provider"
                  AND s."visibility" = 'external'::"SessionVisibility"
                  AND s."externalResolution" IN (
                    'pending'::"ExternalResolution", 'invalid'::"ExternalResolution"
                  )
                  AND NOT s."legacyUnresolved"
              ) THEN 'degraded'::"ExternalAccessPolicyState"
              ELSE 'enabled'::"ExternalAccessPolicyState"
            END,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE p."orgId" = ${orgId}
          AND p."provider" = ${cls.externalProvider}
          AND p."state" <> 'disabled'::"ExternalAccessPolicyState"
      `)
    }
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

  async listConversationPage(q: SessionPageQuery): Promise<ConversationPageRecord> {
    if (queryAgentIds(q).length === 0) {
      return { conversations: [], total: q.includeTotal ? 0 : null, hasMore: false }
    }
    const N = Prisma.raw('n')
    const pageWhere = pageWhereSql(q, true)
    // The probe runs the caller's OWN predicate (org/agents/viewer/filters) on
    // the inner row — a newer row the caller cannot see must not suppress a
    // conversation they can (merged-conversation-view.md §5.2). Cursor excluded:
    // the probe asks about the whole authorized row set, not the current page.
    const probeWhere = pageWhereSql({ ...q, cursor: undefined }, false, N, 'cn')
    const countWhere = pageWhereSql(q, false)
    // Emit-at-max: a row yields its conversation only when no same-key row is
    // strictly greater under the full page tuple. Rows without a groupable key
    // (NULL channel or thread — cron/hook/dream and legacy shapes) are
    // singleton conversations and always emit.
    const emitAtMax = Prisma.sql`
      (
        s."channel" IS NULL OR s."thread" IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM "session_meta" AS n
          ${probeWhere}
            AND ${conversationKeyJoinSql(N, S)}
            AND (n."lastActivityAt", n."startedAt", n."id") > (s."lastActivityAt", s."startedAt", s."id")
        )
      )
    `
    const [reps, totalRows] = await Promise.all([
      this.db.$queryRaw<SessionMeta[]>(Prisma.sql`
        SELECT s.*
        FROM "session_meta" AS s
        ${pageWhere} AND ${emitAtMax}
        ORDER BY s."lastActivityAt" DESC, s."startedAt" DESC, s."id" DESC
        LIMIT ${q.limit + 1}
      `),
      q.includeTotal
        ? this.db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
            SELECT
              (
                SELECT COUNT(*) FROM (
                  SELECT DISTINCT COALESCE(s."platform", 'slack'), s."tenantScope", s."channel", s."thread"
                  FROM "session_meta" AS s
                  ${countWhere} AND s."channel" IS NOT NULL AND s."thread" IS NOT NULL
                ) AS grouped
              )
              + (
                SELECT COUNT(*) FROM "session_meta" AS s
                ${countWhere} AND (s."channel" IS NULL OR s."thread" IS NULL)
              ) AS count
          `)
        : Promise.resolve(null)
    ])
    const hasMore = reps.length > q.limit
    const page = hasMore ? reps.slice(0, q.limit) : reps
    const groupable = page.filter((r) => r.channel !== null && r.thread !== null)
    const membersByKey = new Map<string, SessionMeta[]>()
    if (groupable.length > 0) {
      // Membership is read over `memberAgentIds` — every agent the caller may see
      // when that is wider than the filter. Who took part is a property of the
      // conversation, and a client that learned it from the filtered rows would
      // lose a member the moment the filter hid it. The participant arm goes with
      // it: these rows are already inside a qualifying conversation, so re-testing
      // it here would only cost a probe per row. Which conversations qualify, and
      // in what order, stays on `agentIds` above.
      const memberWhere = pageWhereSql(
        {
          ...q,
          ...(q.memberAgentIds ? { agentIds: q.memberAgentIds, agentId: undefined } : {}),
          conversationAgentIds: undefined,
          cursor: undefined
        },
        false
      )
      const keyTuples = groupable.map(
        (r) => Prisma.sql`(${r.platform ?? 'slack'}, ${r.tenantScope ?? ''}, ${r.channel}, ${r.thread})`
      )
      const members = await this.db.$queryRaw<SessionMeta[]>(Prisma.sql`
        SELECT s.*
        FROM "session_meta" AS s
        ${memberWhere}
          AND s."channel" IS NOT NULL AND s."thread" IS NOT NULL
          AND (COALESCE(s."platform", 'slack'), COALESCE(s."tenantScope", ''), s."channel", s."thread")
            IN (${Prisma.join(keyTuples)})
        ORDER BY s."lastActivityAt" DESC, s."startedAt" DESC, s."id" DESC
      `)
      for (const row of members) {
        const key = conversationKeyOf(row)
        const bucket = membersByKey.get(key)
        if (bucket) bucket.push(row)
        else membersByKey.set(key, [row])
      }
    }
    // Collapse each conversation to the current session per agent: rows arrive
    // newest-first, so the first row seen for an agentId wins and superseded
    // ACP session rows drop out. The representative is by construction the
    // group's first row.
    const selected = new Set<string>(queryAgentIds(q))
    const collapsed = page.map((rep) => {
      const rows =
        rep.channel !== null && rep.thread !== null ? (membersByKey.get(conversationKeyOf(rep)) ?? [rep]) : [rep]
      const perAgent: SessionMeta[] = []
      const seen = new Set<string>()
      for (const row of rows) {
        if (seen.has(row.agentId)) continue
        seen.add(row.agentId)
        perAgent.push(row)
      }
      // `rows` are the returned ones; membership is the whole collapse. They part
      // company only under an agent filter, which is exactly when the difference
      // matters.
      return { rep, rows: perAgent.filter((row) => selected.has(row.agentId)), members: perAgent }
    })
    const hydrated = await this.hydrate(collapsed.flatMap((c) => c.rows))
    const byId = new Map(hydrated.map((rec) => [rec.id, rec]))
    return {
      conversations: collapsed.map((c) => ({
        key: {
          platform: c.rep.platform ?? 'slack',
          tenantScope: c.rep.tenantScope,
          channel: c.rep.channel,
          thread: c.rep.thread
        },
        sessions: c.rows.map((row) => byId.get(SessionId(row.id))!).filter(Boolean),
        memberSessionIds: c.members.map((row) => row.id)
      })),
      total: totalRows ? Number(totalRows[0]?.count ?? 0n) : null,
      hasMore
    }
  }

  async listConversationMembers(q: SessionFacetQuery, key: ConversationKey): Promise<SessionListRecord[]> {
    if (queryAgentIds(q).length === 0 || key.channel === null || key.thread === null) return []
    const where = pageWhereSql(q, false)
    const rows = await this.db.$queryRaw<SessionMeta[]>(Prisma.sql`
      SELECT s.*
      FROM "session_meta" AS s
      ${where}
        AND COALESCE(s."platform", 'slack') = ${key.platform}
        AND COALESCE(s."tenantScope", '') = ${key.tenantScope ?? ''}
        AND s."channel" = ${key.channel}
        AND s."thread" = ${key.thread}
      ORDER BY s."lastActivityAt" DESC, s."startedAt" DESC, s."id" DESC
    `)
    const perAgent: SessionMeta[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      if (seen.has(row.agentId)) continue
      seen.add(row.agentId)
      perAgent.push(row)
    }
    return this.hydrate(perAgent)
  }

  async orgHasAny(orgId: OrgId): Promise<boolean> {
    const row = await this.db.sessionMeta.findFirst({ where: { orgId }, select: { id: true } })
    return row !== null
  }

  async latestSessionIdForAgent(orgId: OrgId, agentId: AgentId): Promise<SessionId | null> {
    // Same tie-break as every session listing, so "latest" means one thing across the CP.
    const row = await this.db.sessionMeta.findFirst({
      where: { orgId, agentId },
      orderBy: [{ lastActivityAt: 'desc' }, { startedAt: 'desc' }, { id: 'desc' }],
      select: { id: true }
    })
    return row ? SessionId(row.id) : null
  }

  async listFacets(q: SessionFacetQuery): Promise<SessionFacetIndex> {
    if (queryAgentIds(q).length === 0) return { agents: [], integrations: [], channels: [], triggers: [] }

    const agentQuery = { ...q }
    delete agentQuery.agentId
    // The agent facet answers "who else could I pick", so it drops the agent
    // filter in BOTH its forms — leaving the participant arm would only ever
    // return the agents already selected.
    delete agentQuery.conversationAgentIds
    const integrationQuery = { ...q }
    delete integrationQuery.integration
    const channelQuery = { ...q }
    delete channelQuery.channel
    delete channelQuery.platform
    const triggerQuery = { ...q }
    delete triggerQuery.triggeredBy
    delete triggerQuery.hookTriggerIds

    const integrationFacet = integrationFacetSql(q.codeHostHookIds ?? {})
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
          "channelName", "triggeredByName", "hookKind", "lastActivityAt", "startedAt"
        FROM (
          SELECT DISTINCT ON ("facetValue")
            "id", "agentId", "platform", "channel", "triggeredBy",
            "channelName", "triggeredByName", "hookKind", "lastActivityAt", "startedAt"
          FROM (
            SELECT
              s."id", s."agentId", s."platform", s."channel", s."triggeredBy",
              s."channelName", s."triggeredByName", s."hookKind", s."lastActivityAt", s."startedAt",
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
          "channelName", "triggeredByName", "hookKind", "lastActivityAt", "startedAt"
        FROM (
          SELECT DISTINCT ON (s."channel")
            s."id", s."agentId", s."platform", s."channel", s."triggeredBy",
            s."channelName", s."triggeredByName", s."hookKind", s."lastActivityAt", s."startedAt"
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
          "channelName", "triggeredByName", "hookKind", "lastActivityAt", "startedAt"
        FROM (
          SELECT DISTINCT ON (s."triggeredBy")
            s."id", s."agentId", s."platform", s."channel", s."triggeredBy",
            s."channelName", s."triggeredByName", s."hookKind", s."lastActivityAt", s."startedAt"
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

  async get(orgId: OrgId, id: SessionId): Promise<SessionMetaRecord | null> {
    // The org filter rides the unique lookup (extended where): a cross-org id
    // is indistinguishable from a missing row (org-scoped-data-layer.md §3).
    const s = await this.db.sessionMeta.findUnique({ where: { id, orgId } })
    return s ? toRecord(s) : null
  }

  async getUnscoped(id: SessionId): Promise<SessionMetaRecord | null> {
    const s = await this.db.sessionMeta.findUnique({ where: { id } })
    return s ? toRecord(s) : null
  }

  async markContentPurged(
    agentId: AgentId,
    sessionIds: SessionId[],
    reason: string,
    at: Date
  ): Promise<{ marked: SessionId[]; alreadyPurged: number }> {
    if (sessionIds.length === 0) return { marked: [], alreadyPurged: 0 }
    // `contentPurgedAt: null` in the predicate is what makes the stamp first-wins
    // under at-least-once delivery: a duplicate report matches nothing and the
    // console keeps showing the date the content actually went away. RETURNING
    // (via updateManyAndReturn) reports exactly what this call changed, so the
    // handler can distinguish "newly purged" from "already known" for its log.
    const rows = await this.db.sessionMeta.updateManyAndReturn({
      where: { id: { in: sessionIds }, agentId, contentPurgedAt: null },
      data: { contentPurgedAt: at, contentPurgedReason: reason },
      select: { id: true }
    })
    const marked = rows.map((row) => SessionId(row.id))
    // Everything the reporter claimed that this call did not stamp: a row already
    // purged, or one bound to another agent (a session id is only a purge claim
    // for the agent it is bound to). Counted together deliberately — the daemon
    // is told nothing either way, since both outcomes settle the same receipt.
    return { marked, alreadyPurged: sessionIds.length - marked.length }
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

  async listExternalScopes(q: SessionFilterQuery): Promise<ExternalScopeRecord[]> {
    if (queryAgentIds(q).length === 0) return []
    // Over the MEMBERSHIP agents, not the filtered ones. The scopes resolved here
    // become the viewer snapshot every later query is authorized against, so a
    // scope missed here is a row the membership query cannot admit — a member
    // dropped for having been filtered out, not for being invisible.
    const unrestricted = {
      ...q,
      ...(q.memberAgentIds ? { agentIds: q.memberAgentIds, agentId: undefined } : {})
    }
    delete unrestricted.viewer
    delete unrestricted.cursor
    const rows = await this.db.$queryRaw<ExternalScope[]>(Prisma.sql`
      SELECT DISTINCT scope.*
      FROM "session_meta" s
      JOIN "external_scope" scope
        ON scope."id" = s."externalScopeId"
       AND scope."orgId" = s."orgId"
       AND scope."provider" = s."externalProvider"
      ${pageWhereSql(unrestricted, false)}
        AND s."visibility" = 'external'::"SessionVisibility"
        AND s."externalResolution" = 'settled'::"ExternalResolution"
        AND scope."revokedAt" IS NULL
      ORDER BY scope."id"
    `)
    return rows.map(toExternalScopeRecord)
  }

  async getExternalScopes(ids: string[]): Promise<ExternalScopeRecord[]> {
    if (ids.length === 0) return []
    const rows = await this.db.externalScope.findMany({ where: { id: { in: ids } } })
    return rows.map(toExternalScopeRecord)
  }

  async getExternalAccessPolicy(orgId: OrgId, provider: string): Promise<SessionExternalAccessPolicyRecord | null> {
    const policy = await this.db.sessionExternalAccessPolicy.findUnique({
      where: { orgId_provider: { orgId, provider } }
    })
    return policy ? toExternalPolicyRecord(policy) : null
  }

  async countExternalUnresolved(orgId: OrgId, provider: string): Promise<number> {
    return this.db.sessionMeta.count({
      where: {
        orgId,
        externalProvider: provider,
        visibility: 'external',
        externalResolution: { in: ['pending', 'invalid'] }
      }
    })
  }

  async setExternalAccessEnabled(
    orgId: OrgId,
    provider: string,
    enabled: boolean
  ): Promise<{
    policy: SessionExternalAccessPolicyRecord
    hiddenSessions: number
    affected: SessionMetaRecord[]
  }> {
    return withAmbientTx(this.db, async (tx) => {
      await tx.sessionExternalAccessPolicy.upsert({
        where: { orgId_provider: { orgId, provider } },
        create: { orgId, provider },
        update: {}
      })
      const locked = await tx.$queryRaw<SessionExternalAccessPolicy[]>(Prisma.sql`
        SELECT * FROM "session_external_access_policy"
        WHERE "orgId" = ${orgId} AND "provider" = ${provider}
        FOR UPDATE
      `)
      const current = locked[0]!
      const alreadyEnabled = current.state !== 'disabled'
      if (enabled === alreadyEnabled) {
        const hiddenSessions = await tx.sessionMeta.count({
          where: {
            orgId,
            externalProvider: provider,
            visibility: 'external',
            externalResolution: { in: ['pending', 'invalid'] }
          }
        })
        return { policy: toExternalPolicyRecord(current), hiddenSessions, affected: [] }
      }
      const targetRev = current.currentRev + 1n
      if (!enabled) {
        const policy = await tx.sessionExternalAccessPolicy.update({
          where: { orgId_provider: { orgId, provider } },
          data: { state: 'disabled', currentRev: targetRev }
        })
        const hiddenSessions = await tx.sessionMeta.count({
          where: {
            orgId,
            externalProvider: provider,
            visibility: 'external',
            externalResolution: { in: ['pending', 'invalid'] }
          }
        })
        return { policy: toExternalPolicyRecord(policy), hiddenSessions, affected: [] }
      }

      // Fence first in this transaction. Every supported candidate below is
      // then classified at the target revision before the transition commits;
      // unresolved legacy history remains external and therefore unreadable.
      await tx.sessionExternalAccessPolicy.update({
        where: { orgId_provider: { orgId, provider } },
        data: {
          state: 'enabling',
          currentRev: targetRev,
          readFenceRev: current.readFenceRev ?? targetRev
        }
      })
      const affectedRows = await tx.$queryRaw<SessionMeta[]>(Prisma.sql`
        UPDATE "session_meta"
        SET "visibility" = 'external'::"SessionVisibility",
            "classifiedPolicyRev" = ${targetRev},
            "visibilityRev" = "visibilityRev" + 1,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "orgId" = ${orgId}
          AND "externalProvider" = ${provider}
          AND (
            "visibility" <> 'external'::"SessionVisibility"
            OR "classifiedPolicyRev" IS DISTINCT FROM ${targetRev}
          )
        RETURNING *
      `)
      const hiddenSessions = await tx.sessionMeta.count({
        where: {
          orgId,
          externalProvider: provider,
          visibility: 'external',
          externalResolution: { in: ['pending', 'invalid'] }
        }
      })
      // Whatever is unresolved at this instant is history the migration could not
      // bind — expected and hidden, but not a fault. Mark those rows so only a
      // candidate that fails to resolve LATER degrades the policy. Marking the
      // rows (rather than remembering how many there were) is what keeps a live
      // failure visible after a legacy row settles. The count itself stays
      // reportable as `hiddenSessions`. Re-enabling re-stamps from scratch: a row
      // that settled in between is cleared by the same statement.
      await tx.$executeRaw(Prisma.sql`
        UPDATE "session_meta"
        SET "legacyUnresolved" = "externalResolution" IN (
              'pending'::"ExternalResolution", 'invalid'::"ExternalResolution"
            )
        WHERE "orgId" = ${orgId}
          AND "externalProvider" = ${provider}
      `)
      const policy = await tx.sessionExternalAccessPolicy.update({
        where: { orgId_provider: { orgId, provider } },
        data: { state: 'enabled' }
      })
      return {
        policy: toExternalPolicyRecord(policy),
        hiddenSessions,
        affected: affectedRows.map(toRecord)
      }
    })
  }

  async listChildren(
    parentSessionId: SessionId,
    agentIds: AgentId[],
    viewer?: SessionFilterQuery['viewer']
  ): Promise<SessionMetaRecord[]> {
    if (agentIds.length === 0) return []
    const viewerArm = sessionViewerSql(viewer)
    const rows = viewerArm
      ? await this.db.$queryRaw<SessionMeta[]>(Prisma.sql`
          SELECT s.* FROM "session_meta" s
          WHERE s."parentSessionId" = ${parentSessionId}
            AND s."agentId" IN (${Prisma.join(agentIds)})
            AND ${viewerArm}
          ORDER BY s."startedAt" ASC, s."id" ASC
        `)
      : await this.db.sessionMeta.findMany({
          where: { parentSessionId, agentId: { in: agentIds } },
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
    orgId: OrgId,
    sessionId: SessionId,
    visibility: SessionVisibility,
    authorize?: (row: {
      visibility: SessionVisibility
      ownerIdentity: string | null
      externalProvider: string | null
    }) => boolean
  ): Promise<SessionVisibilityChange> {
    return withAmbientTx(this.db, async (tx) => {
      const locked = await tx.$queryRaw<
        Array<{ visibility: string; ownerIdentity: string | null; externalProvider: string | null }>
      >(Prisma.sql`
        SELECT "visibility", "ownerIdentity", "externalProvider"
        FROM "session_meta" WHERE "id" = ${sessionId} AND "orgId" = ${orgId} FOR UPDATE
      `)
      // The org fence rides the row-lock read, so a cross-org id takes the same
      // silent no-op exit as a missing row — never the `forbidden: true` the
      // immutable-audience guard below would answer, which would confirm it
      // exists (org-scoped-data-layer.md §3).
      if (locked.length !== 1) return { affected: [] }
      const current = {
        visibility: locked[0]!.visibility as SessionVisibility,
        ownerIdentity: locked[0]!.ownerIdentity,
        externalProvider: locked[0]!.externalProvider
      }
      // Re-authorize against the LOCKED row, not the one the route read. An
      // ancestor cascade committing in between can re-own this session, and the
      // former owner's in-flight request must not still widen it.
      if (authorize && !authorize(current)) return { affected: [], forbidden: true }
      // Shared inputs have no owner and their audience is immutable. Keep this
      // repository guard even for internal callers that omit `authorize`.
      if (current.externalProvider !== null || visibility === 'external') {
        return { affected: [], forbidden: true }
      }
      if (current.visibility === visibility) return { affected: [] } // no-op: no rev bump, no push
      const ownerIdentity = current.ownerIdentity
      const target = await tx.$queryRaw<SessionMeta[]>(Prisma.sql`
        UPDATE "session_meta" SET
          "visibility" = ${visibility}::"SessionVisibility",
          "visibilitySource" = 'explicit'::"VisibilitySource",
          "visibilityRev" = "visibilityRev" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${sessionId} AND "orgId" = ${orgId}
        RETURNING *
      `)
      const affected = target.map(toRecord)
      if (visibility === 'org') return { affected }

      const seen = new Set<string>([sessionId])
      let frontier: string[] = [sessionId]
      while (frontier.length > 0) {
        // Lock this level's children BEFORE reading them as a set to update: a
        // concurrent child insert either waits here or is caught by the re-scan.
        // `parentSessionId` is a daemon-reported free string with NO foreign key,
        // so a session in another organization can name this one as its parent.
        // Every lineage hop is therefore confined to the root's org: without it a
        // tighten here would lock, rewrite, and push another tenant's row
        // (org-scoped-data-layer.md §3 — the fence is per-hop, not just per-root).
        const children = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "session_meta"
          WHERE "parentSessionId" = ANY(${frontier}::text[]) AND "orgId" = ${orgId}
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
            "visibility" = CASE
              WHEN "externalProvider" IS NULL THEN 'private'::"SessionVisibility"
              ELSE 'external'::"SessionVisibility"
            END,
            "ownerIdentity" = CASE
              WHEN "externalProvider" IS NULL THEN ${ownerIdentity}
              ELSE NULL
            END,
            "externalResolution" = CASE
              WHEN "externalProvider" IS NULL THEN "externalResolution"
              ELSE 'invalid'::"ExternalResolution"
            END,
            "visibilitySource" = 'inherited'::"VisibilitySource",
            "visibilityRev" = "visibilityRev" + 1,
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ANY(${next}::text[])
            AND "orgId" = ${orgId}
            AND (
              ("externalProvider" IS NULL AND "visibility" <> 'private'::"SessionVisibility")
              OR ("externalProvider" IS NULL AND "ownerIdentity" IS DISTINCT FROM ${ownerIdentity})
              OR ("externalProvider" IS NOT NULL AND "visibility" <> 'external'::"SessionVisibility")
              OR ("externalProvider" IS NOT NULL AND "externalResolution" <> 'invalid'::"ExternalResolution")
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

  async visibilitySnapshotForAgents(
    agentIds: readonly string[],
    limit: number,
    includeExternal = true
  ): Promise<SessionVisibilityState[]> {
    if (agentIds.length === 0) return []
    // Keyed on the AGENTS the daemon serves, not on `session_meta.daemonId` — that column names
    // the member that first reported the session and is null once that member is reaped, so a new
    // duty holder would page zero rows and keep the gates it was never sent (#1029).
    //
    // Unacknowledged revisions FIRST, newest-active after. A session tightened
    // while this daemon was offline is by definition unacked, so it replays no
    // matter how old it is — a plain newest-first window would drop it past the
    // cap and leave the daemon capturing with a stale `org` gate forever.
    const rows = await this.db.$queryRaw<
      Array<{
        id: string
        orgId: string
        agentId: string
        visibility: string
        externalProvider: string | null
        visibilityRev: number
      }>
    >(Prisma.sql`
      SELECT "id", "orgId", "agentId", "visibility", "externalProvider", "visibilityRev"
      FROM "session_meta"
      WHERE "agentId" = ANY(${[...agentIds]}::uuid[])
        AND (${includeExternal} OR "externalProvider" IS NULL)
      ORDER BY ("visibilityAckedRev" < "visibilityRev") DESC,
               "lastActivityAt" DESC, "startedAt" DESC, "id" DESC
      LIMIT ${limit}
    `)
    return rows.map((r) => ({
      orgId: OrgId(r.orgId),
      agentId: AgentId(r.agentId),
      sessionId: SessionId(r.id),
      visibility: r.visibility as SessionVisibility,
      // External-source sessions are no longer memory-excluded just for being
      // external; only an explicitly `private` session excludes memory
      // (session-visibility.md §5.1). Keep this in step with `toPush`.
      sharedMemoryExcluded: r.visibility === 'private',
      visibilityRev: r.visibilityRev
    }))
  }

  async privateVisibilityPage(
    agentIds: readonly string[],
    limit: number,
    includeExternal = true,
    afterId?: string
  ): Promise<SessionVisibilityState[]> {
    if (agentIds.length === 0) return []
    // The rows a member must not be wrong about: `sharedMemoryExcluded` is `visibility ===
    // 'private'`, and a member that never heard of a session already fails closed. So the ONLY way
    // to leak is a stale non-private gate left from an earlier hold — which is what this page
    // overwrites. Cursored on `id` and blind to `visibilityAckedRev` on purpose: that watermark is
    // per SESSION, not per daemon, so an ack from the previous holder says nothing about this one.
    const rows = await this.db.$queryRaw<
      Array<{
        id: string
        orgId: string
        agentId: string
        visibility: string
        externalProvider: string | null
        visibilityRev: number
      }>
    >(Prisma.sql`
      SELECT "id", "orgId", "agentId", "visibility", "externalProvider", "visibilityRev"
      FROM "session_meta"
      WHERE "agentId" = ANY(${[...agentIds]}::uuid[])
        AND "visibility" = 'private'::"SessionVisibility"
        AND (${includeExternal} OR "externalProvider" IS NULL)
        ${afterId ? Prisma.sql`AND "id" > ${afterId}` : Prisma.empty}
      ORDER BY "id"
      LIMIT ${limit}
    `)
    return rows.map((r) => ({
      orgId: OrgId(r.orgId),
      agentId: AgentId(r.agentId),
      sessionId: SessionId(r.id),
      visibility: r.visibility as SessionVisibility,
      sharedMemoryExcluded: true,
      visibilityRev: r.visibilityRev
    }))
  }

  async countUnackedVisibilityForAgents(agentIds: readonly string[], includeExternal = true): Promise<number> {
    if (agentIds.length === 0) return 0
    // Same predicate as the snapshot above, or the counter reports a convergence that never
    // happened for a member whose served set the recorded column does not describe.
    const rows = await this.db.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS n FROM "session_meta"
      WHERE "agentId" = ANY(${[...agentIds]}::uuid[])
        AND (${includeExternal} OR "externalProvider" IS NULL)
        AND "visibilityAckedRev" < "visibilityRev"
    `)
    return Number(rows[0]?.n ?? 0)
  }

  /** The session plus every descendant, for the §5.1 cutover state of a cascade. */
  async visibilitySubtree(sessionId: SessionId, limit: number): Promise<SessionMetaRecord[]> {
    const rows = await this.db.$queryRaw<SessionMeta[]>(Prisma.sql`
      WITH RECURSIVE subtree AS (
        SELECT * FROM "session_meta" WHERE "id" = ${sessionId}
        UNION
        -- Same-org hop only: parentSessionId carries no foreign key, so an
        -- unconstrained walk would hand the visibility push another tenant's rows.
        SELECT child.* FROM "session_meta" child
        JOIN subtree ON child."parentSessionId" = subtree."id" AND child."orgId" = subtree."orgId"
      )
      SELECT * FROM subtree LIMIT ${limit}
    `)
    return rows.map(toRecord)
  }

  async findThreadOwner(botId: BotId, channel: string, thread: string): Promise<{ agentId: string } | null> {
    // Most-recently-active session on this bot's (channel, thread). The AGENT is the answer; who
    // serves it right now is the placement resolver's, so this asks nothing about placement at
    // all. Requiring a non-null `agent.daemonId` here excluded every pool agent — placed, but
    // naming no machine — so the pull-on-miss fallback below never fired for one.
    // The session's own daemonId is provenance only and may be null after its reporting daemon is
    // deleted; routing follows current agent placement.
    // NOTE: do NOT filter on `endedAt` — a session emits `phase:'end'` (→ `endedAt`) at the end
    // of EVERY turn, so an idle-between-turns session (the normal state of a thread's owner
    // between messages) has `endedAt` set yet is still the valid target; the daemon resumes it on
    // delivery. Filtering `endedAt: null` here made the affinity fallback miss essentially every
    // real thread (incl. a case-2a spawned session after its one headless turn).
    const row = await this.db.sessionMeta.findFirst({
      where: { channel, thread, agent: { integrations: { some: { botId, status: 'active' } } } },
      orderBy: [{ lastActivityAt: 'desc' }, { startedAt: 'desc' }],
      select: { agentId: true }
    })
    return row ? { agentId: row.agentId } : null
  }
}
