/**
 * `http/routes/sessions.ts` (design §2.1) — the console's session views.
 *
 * The CP stores session metadata only (sessions are created on the daemon path;
 * transcripts/attachments/tool bodies stay daemon-local). So the list is a DB
 * read, while transcript views remain on-demand daemon pulls:
 *
 * - `GET /sessions` lists CP-stored session metadata synced by daemon
 *   `event/session` snapshots. Transcript bodies still stay daemon-local.
 * - `GET /sessions/:id/messages` pulls one transcript page from the owning
 *   daemon (resolved via the row's `agentId`) and proxies it through. Bodies
 *   transit the CP live for display only, never persisted (body-locality §1/§12).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { AgentId, HookId, OrgId, SessionId } from '../../domain/ids.js'
import { orgOf, ctxOf, denyNonOwner } from '../rbac.js'
import { decodeConversationKey, encodeConversationKey } from '../conversation-key.js'
import { canChangeSessionVisibility, canView, canViewSession } from '../../authorization/policy.js'
import { makeSessionAccessResolver } from '../session-access.js'
import { Tag } from '../plugins/openapi.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { visibilityStateOf } from '../../orchestrator/visibilityPush.js'
import {
  SessionListPageDto,
  SessionFacetsDto,
  SessionDetailDto,
  SessionHistoryDto,
  SessionToolBodyQueryDto,
  SessionToolBodyChunkDto,
  ErrorDto,
  IdParam,
  SetSessionVisibilityBody,
  SessionVisibilityDto,
  SetSessionExternalAccessBody,
  SessionExternalAccessDto
} from '../dto/index.js'

const SessionFilterQueryDto = z.object({
  // Repeatable: `?agentId=a` scopes to one agent's rows (unchanged), while
  // `?agentId=a&agentId=b` asks for the CONVERSATIONS both took part in and
  // returns each of their sessions in those threads. Fastify's querystring
  // parser hands repeated keys over as an array.
  agentId: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
  platform: z.enum(['slack', 'telegram', 'webchat', 'discord', 'feishu', 'hook', 'dream']).optional(),
  integration: z.enum(['slack', 'telegram', 'webchat', 'discord', 'feishu', 'hook', 'github', 'dream']).optional(),
  channel: z.string().optional(),
  triggeredBy: z.string().optional(),
  githubRepoId: z
    .string()
    .regex(/^[1-9]\d*$/)
    .optional()
})

const SessionQueryDto = SessionFilterQueryDto.extend({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  // merged-conversation-view.md §5.2: the grouped list is the DEFAULT response
  // shape; `view=flat` returns the raw session rows (the pre-grouped shape).
  view: z.enum(['grouped', 'flat']).default('grouped'),
  // §5.2 key-addressed member resolver: resolves one conversation's current
  // visible member sessions without paging the grouped list.
  conversationKey: z.string().min(1).max(512).optional()
})

type SessionCursor = { activityMs: number; startedMs: number; id: string }
type SessionPageRow = Awaited<ReturnType<HttpDeps['repos']['session']['listPage']>>['sessions'][number]
type SessionFacetIndex = Awaited<ReturnType<HttpDeps['repos']['session']['listFacets']>>
type HookSessionRow = Pick<SessionPageRow, 'agentId' | 'platform' | 'channel' | 'triggeredBy'>
type HookSessionMetadata = {
  agentId: string | null
  kind: 'webhook' | 'github'
  name: string
  repoId: bigint | null
}

/** The agent filter as a de-duplicated list, whichever form it arrived in. One id
 *  scopes to that agent's sessions; several ask for the conversations all of them
 *  took part in (merged-conversation-view.md §5.1 grouping). */
function requestedAgentIds(query: z.infer<typeof SessionFilterQueryDto>): string[] {
  const raw = query.agentId
  if (raw === undefined) return []
  return [...new Set(Array.isArray(raw) ? raw : [raw])].filter((id) => id.length > 0)
}

const HOOK_TRIGGER_PREFIX = 'hook:'
const HookIdString = z.string().uuid()

async function githubHookFilters(
  deps: HttpDeps,
  orgId: OrgId,
  query: z.infer<typeof SessionFilterQueryDto>,
  classifyAll: boolean
): Promise<{ githubHookIds: HookId[]; repoHookIds?: HookId[] }> {
  if (query.githubRepoId) {
    const githubHooks = await deps.repos.hook.listForOrgKind(orgId, 'github')
    return {
      githubHookIds: githubHooks.map((hook) => hook.id),
      repoHookIds: githubHooks.filter((hook) => hook.repoId?.toString() === query.githubRepoId).map((hook) => hook.id)
    }
  }
  return {
    githubHookIds:
      classifyAll || query.integration === 'github' || query.integration === 'hook'
        ? await deps.repos.hook.listIdsForOrgKind(orgId, 'github')
        : []
  }
}

function hookIdForSession(s: HookSessionRow): string | null {
  const triggerId = s.triggeredBy?.startsWith(HOOK_TRIGGER_PREFIX)
    ? s.triggeredBy.slice(HOOK_TRIGGER_PREFIX.length)
    : ''
  // Anchored hooks run on their delivery integration (for example Slack), so
  // `triggeredBy: hook:<id>` is authoritative. The channel fallback is only for
  // legacy headless hook sessions that predate that trigger identity.
  const id = triggerId || (s.platform === 'hook' ? s.channel : '') || ''
  return HookIdString.safeParse(id).success ? id : null
}

function sessionRelation(s: { id: string; agentId: string; platform: string | null; title: string | null }) {
  return { id: s.id, agentId: s.agentId, platform: s.platform ?? 'slack', title: s.title }
}

function hookMetadataForSession(metadata: Map<string, HookSessionMetadata>, session: HookSessionRow) {
  return metadata.get(hookIdForSession(session) ?? '')
}

async function hookMetadataForSessions(
  deps: HttpDeps,
  sessions: HookSessionRow[],
  orgId: string
): Promise<Map<string, HookSessionMetadata>> {
  const ids = [...new Set(sessions.map(hookIdForSession).filter((id): id is string => Boolean(id)))]
  const metadata = new Map<string, HookSessionMetadata>()
  for (const hook of await deps.repos.hook.getMany(ids.map(HookId))) {
    if (hook.orgId !== orgId) continue
    metadata.set(hook.id, { agentId: hook.agentId, kind: hook.kind, name: hook.name, repoId: hook.repoId })
  }
  return metadata
}

function encodeSessionCursor(s: { id: string; startedAt: Date; lastActivityAt: Date }): string {
  return Buffer.from(
    JSON.stringify({
      activityMs: s.lastActivityAt.getTime(),
      startedMs: s.startedAt.getTime(),
      id: s.id
    } satisfies SessionCursor),
    'utf8'
  ).toString('base64url')
}

function decodeSessionCursor(raw: string): SessionCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<SessionCursor>
    if (
      typeof parsed.activityMs !== 'number' ||
      !Number.isFinite(parsed.activityMs) ||
      typeof parsed.startedMs !== 'number' ||
      !Number.isFinite(parsed.startedMs) ||
      typeof parsed.id !== 'string' ||
      parsed.id.length === 0
    ) {
      return null
    }
    return { activityMs: parsed.activityMs, startedMs: parsed.startedMs, id: parsed.id }
  } catch {
    return null
  }
}

function sessionIntegration(s: HookSessionRow, hook: HookSessionMetadata | undefined): string {
  const platform = s.platform ?? 'slack'
  return platform === 'hook' && hook?.kind === 'github' ? 'github' : platform
}

function sessionDisplayMetadata(
  s: HookSessionRow & { channelName: string | null; triggeredByName: string | null },
  hook: HookSessionMetadata | undefined
) {
  // Hook kind remains valid after reassignment, but the current name only
  // describes historical rows while the hook still belongs to the same agent.
  const hookName = hook?.agentId === s.agentId ? hook.name : undefined
  return {
    channelName: s.platform === 'hook' ? (hookName ?? s.channelName ?? null) : (s.channelName ?? null),
    triggeredByName: s.triggeredBy?.startsWith(HOOK_TRIGGER_PREFIX)
      ? (hookName ?? s.triggeredByName ?? 'Webhook')
      : (s.triggeredByName ?? null)
  }
}

function sessionFacets(index: SessionFacetIndex, hookMetadata: Map<string, HookSessionMetadata>) {
  const integrations = new Set<string>()
  const channels = new Map<
    string,
    { value: string; platform: string; integration: string; name: string | null; triggeredByName: string | null }
  >()
  const triggers = new Map<
    string,
    {
      value: string
      integration: string
      name: string | null
      hookKind: 'webhook' | 'github' | null
      githubRepoId: string | null
    }
  >()

  const integrationRows = [...index.integrations].sort(
    (a, b) =>
      b.lastActivityAt.getTime() - a.lastActivityAt.getTime() ||
      b.startedAt.getTime() - a.startedAt.getTime() ||
      b.id.localeCompare(a.id)
  )
  for (const session of integrationRows) {
    const hook = hookMetadataForSession(hookMetadata, session)
    integrations.add(sessionIntegration(session, hook))
  }
  for (const session of index.channels) {
    const channel = session.channel!
    const hook = hookMetadataForSession(hookMetadata, session)
    const display = sessionDisplayMetadata(session, hook)
    channels.set(channel, {
      value: channel,
      platform: session.platform ?? 'slack',
      integration: sessionIntegration(session, hook),
      name: display.channelName,
      triggeredByName: display.triggeredByName
    })
  }
  for (const session of index.triggers) {
    const triggeredBy = session.triggeredBy!
    const hook = hookMetadataForSession(hookMetadata, session)
    const display = sessionDisplayMetadata(session, hook)
    const githubRepoId = hook?.kind === 'github' ? (hook.repoId?.toString() ?? null) : null
    triggers.set(triggeredBy, {
      value: triggeredBy,
      integration: sessionIntegration(session, hook),
      name: display.triggeredByName,
      hookKind: hook?.kind ?? null,
      githubRepoId
    })
  }

  return {
    agents: index.agents,
    integrations: [...integrations],
    channels: [...channels.values()],
    triggers: [...triggers.values()]
  }
}

function sessionDto(s: SessionPageRow, hookMetadata: Map<string, HookSessionMetadata>) {
  const hook = hookMetadataForSession(hookMetadata, s)
  const display = sessionDisplayMetadata(s, hook)
  return {
    sessionId: s.id,
    sessionKey: {
      platform: s.platform ?? 'slack',
      channel: s.channel ?? '',
      ...(s.thread !== null ? { thread: s.thread } : {})
    },
    agentId: s.agentId,
    title: s.title ?? null,
    status: s.status ?? null,
    lastActivityAt: s.lastActivityAt.toISOString(),
    usage: s.usage ?? null,
    triggeredBy: s.triggeredBy ?? null,
    hookKind: hook?.kind ?? null,
    channelName: display.channelName,
    triggeredByName: display.triggeredByName,
    threadUrl: s.threadUrl ?? null,
    runtime: s.runtime ?? null,
    model: s.model ?? null,
    effort: s.effort ?? null,
    fastMode: s.fastMode ?? null,
    permissionMode: s.permissionMode ?? null,
    outputMode: s.outputMode ?? null,
    daemonId: s.daemonId ?? null,
    visibility: s.visibility,
    externalProvider: s.externalProvider,
    externalResolution: s.externalResolution
  }
}

const SessionHistoryQueryDto = z
  .object({
    cursor: z.string().optional(),
    after: z
      .string()
      .regex(/^\d+$/)
      .refine((value) => Number.isSafeInteger(Number(value)))
      .optional(),
    limit: z.coerce.number().int().positive().max(200).optional()
  })
  .refine(({ cursor, after }) => cursor === undefined || after === undefined, {
    message: 'cursor and after are mutually exclusive'
  })

export function sessionRoutes(deps: HttpDeps) {
  return async function sessionRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    // Fetch an agent AND verify it's in the caller's org AND visible to them — a
    // cross-org id OR a restricted agent they can't see both read as absent (404).
    // Sessions/usage/tool-bodies all derive their visibility from the owning agent.
    const getOrgViewableAgent = async (req: FastifyRequest, agentId: string) => {
      const agent = await deps.repos.agent.get(AgentId(agentId))
      if (!agent || agent.orgId !== req.orgCtx!.orgId) return null
      return canView(agent, ctxOf(req)) ? agent : null
    }

    // Session visibility (session-visibility.md §5) COMPOSES with the agent gate
    // above: a session is visible iff its agent is visible AND the caller passes
    // the session predicate. The repo arm and this in-app check must stay two
    // spellings of one rule — both come from `canViewSession`, fed the SAME
    // identity set: console identity plus the caller's linked Slack identity.
    const sessionAccess = makeSessionAccessResolver(deps)
    const viewerForQuery = async (req: FastifyRequest, query: Parameters<typeof sessionAccess.forQuery>[1]) => {
      const access = await sessionAccess.forQuery(req, query)
      return {
        access,
        viewer: {
          role: ctxOf(req).role,
          identitySet: [...access.identitySet],
          externalAccess: access.externalAccess
        }
      }
    }

    const getOrgViewableSession = async (req: FastifyRequest, sessionId: string) => {
      const session = await deps.repos.session.get(SessionId(sessionId))
      if (!session) return null
      const access = await sessionAccess.forSessions(req, [session])
      if (!canViewSession(session, ctxOf(req), access.identitySet, access.externalAccess)) return null
      const agent = await getOrgViewableAgent(req, session.agentId)
      return agent ? { session, agent, access } : null
    }

    type ExternalAccessProvider = 'slack' | 'github' | 'feishu'
    const externalAccessAvailable = (provider: ExternalAccessProvider) =>
      deps.logtoIdentity !== undefined &&
      (provider === 'slack'
        ? deps.slackSessionAccess !== undefined
        : provider === 'github'
          ? deps.githubSessionAccess !== undefined
          : deps.feishuSessionAccess !== undefined && Object.keys(deps.feishuPlatformApps ?? {}).length > 0)

    const externalAccessDto = async (orgId: OrgId, provider: ExternalAccessProvider, includeDiagnostics: boolean) => {
      const [policy, hiddenSessions] = await Promise.all([
        deps.repos.session.getExternalAccessPolicy(orgId, provider),
        includeDiagnostics ? deps.repos.session.countExternalUnresolved(orgId, provider) : Promise.resolve(undefined)
      ])
      return {
        provider,
        available: externalAccessAvailable(provider),
        enabled: policy?.state !== undefined && policy.state !== 'disabled',
        state: policy?.state ?? ('disabled' as const),
        currentRevision: (policy?.currentRev ?? 0n).toString(),
        readFenceRevision: policy?.readFenceRev?.toString() ?? null,
        ...(hiddenSessions !== undefined ? { hiddenSessions } : {})
      }
    }

    const registerExternalAccessRoutes = (provider: ExternalAccessProvider) => {
      const label = provider === 'slack' ? 'Slack' : provider === 'github' ? 'GitHub' : 'Feishu/Lark'
      const operationLabel = provider === 'feishu' ? 'FeishuLark' : label
      r.get(
        `/session-access/${provider}`,
        {
          schema: {
            tags: [Tag.Sessions],
            summary: `Get ${label} session access sync`,
            description: `Returns whether ${label} sessions use the provider's current audience for console access.`,
            operationId: `get${operationLabel}SessionAccess`,
            response: { 200: SessionExternalAccessDto }
          }
        },
        async (req) => externalAccessDto(orgOf(req), provider, ctxOf(req).role === 'owner')
      )

      r.put(
        `/session-access/${provider}`,
        {
          schema: {
            tags: [Tag.Sessions],
            summary: `Set ${label} session access sync`,
            description: `Owner-only setting. When enabled, ${label} sessions follow the provider's current audience; unresolved history remains hidden.`,
            operationId: `set${operationLabel}SessionAccess`,
            body: SetSessionExternalAccessBody,
            response: { 200: SessionExternalAccessDto, 403: ErrorDto, 409: ErrorDto }
          }
        },
        async (req, reply) => {
          if (denyNonOwner(req, reply)) return
          if (req.body.enabled && !externalAccessAvailable(provider)) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: `${label} session access requires OIDC and linked-identity configuration`
            })
          }
          const result = await deps.repos.session.setExternalAccessEnabled(orgOf(req), provider, req.body.enabled)
          if (result.affected.length > 0) void deps.visibilityPush?.notifySessions(result.affected)
          return {
            provider,
            available: externalAccessAvailable(provider),
            enabled: result.policy.state !== 'disabled',
            state: result.policy.state,
            currentRevision: result.policy.currentRev.toString(),
            readFenceRevision: result.policy.readFenceRev?.toString() ?? null,
            hiddenSessions: result.hiddenSessions
          }
        }
      )
    }

    registerExternalAccessRoutes('slack')
    registerExternalAccessRoutes('github')
    registerExternalAccessRoutes('feishu')

    r.get(
      '/sessions/facets',
      {
        schema: {
          tags: [Tag.Sessions],
          summary: 'List session filter facets',
          description:
            'Lists each distinct session filter facet after applying every other active filter visible to the caller.',
          operationId: 'listSessionFacets',
          querystring: SessionFilterQueryDto,
          response: { 200: SessionFacetsDto }
        }
      },
      async (req) => {
        const visibleAgentIds = (await deps.repos.agent.list(orgOf(req), ctxOf(req))).map((agent) => agent.id)
        const requested = requestedAgentIds(req.query)
        if (requested.some((id) => !new Set<string>(visibleAgentIds).has(id))) {
          return { agents: [], integrations: [], channels: [], triggers: [] }
        }
        const { githubHookIds, repoHookIds } = await githubHookFilters(deps, orgOf(req), req.query, true)
        // A multi-agent request narrows to the qualifying CONVERSATIONS and then
        // reads facets off every member row the caller can see, rather than only
        // the selected agents' rows: a facet answers "what else can I narrow by",
        // and a conversation's channel is the same whichever member you read.
        const query = {
          agentIds: visibleAgentIds,
          ...(requested.length === 1 ? { agentId: AgentId(requested[0]!) } : {}),
          ...(requested.length > 1 ? { conversationAgentIds: requested.map(AgentId) } : {}),
          ...(req.query.platform ? { platform: req.query.platform } : {}),
          ...(req.query.integration ? { integration: req.query.integration } : {}),
          ...(req.query.channel ? { channel: req.query.channel } : {}),
          ...(req.query.triggeredBy ? { triggeredBy: req.query.triggeredBy } : {}),
          githubHookIds,
          ...(repoHookIds ? { hookTriggerIds: repoHookIds } : {})
        }
        const { viewer } = await viewerForQuery(req, query)
        const index = await deps.repos.session.listFacets({ ...query, viewer })
        const metadataRows = [...index.integrations, ...index.channels, ...index.triggers]
        const hookMetadata = await hookMetadataForSessions(deps, metadataRows, orgOf(req))
        return sessionFacets(index, hookMetadata)
      }
    )

    r.get(
      '/sessions',
      {
        schema: {
          tags: [Tag.Sessions],
          summary: 'List sessions',
          description:
            'Lists CP-stored session metadata synced by daemon event/session snapshots; transcript bodies remain ' +
            'daemon-local. Returns one row per CONVERSATION by default (merged-conversation-view.md §5.2) — sessions ' +
            'sharing a thread group into `conversations`, each carrying its current member sessions. `view=flat` ' +
            'returns the raw `sessions` rows (the pre-grouped shape); `conversationKey` resolves one conversation’s ' +
            'members directly.',
          operationId: 'listSessions',
          querystring: SessionQueryDto,
          response: { 200: SessionListPageDto, 400: ErrorDto }
        }
      },
      async (req, reply) => {
        const grouped = req.query.view !== 'flat'
        const cursor = req.query.cursor ? decodeSessionCursor(req.query.cursor) : undefined
        if (req.query.cursor && !cursor) {
          return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: 'invalid session cursor' })
        }
        const conversationKey = req.query.conversationKey ? decodeConversationKey(req.query.conversationKey) : undefined
        if (req.query.conversationKey && (!conversationKey || conversationKey.channel === null)) {
          return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: 'invalid conversation key' })
        }

        // The set of agents THIS caller may see under the resource policy. Roles
        // never widen visibility, so restricted-agent rows are hidden before any
        // title/channel/usage metadata reaches the caller.
        const visibleAgentIds = (await deps.repos.agent.list(orgOf(req), ctxOf(req))).map((agent) => agent.id)
        const visibleAgentIdSet = new Set<string>(visibleAgentIds)
        // Every requested agent must be visible. One the caller cannot see makes
        // the whole answer empty rather than being quietly dropped: silently
        // widening a two-agent question to a one-agent one would answer a
        // question they did not ask with rows they may not have wanted.
        const requested = requestedAgentIds(req.query)
        const selectedAgentIds =
          requested.length > 0
            ? requested.every((id) => visibleAgentIdSet.has(id))
              ? requested.map(AgentId)
              : []
            : visibleAgentIds
        // Org-level "any session exists" boolean (first page only). Computed over the
        // FULL org — including sessions the caller can't see — which is safe precisely
        // because it is a bare boolean; the getting-started conversation step derives
        // from it so a collaborator in an active org isn't asked to run a redundant chat.
        const orgHasSessions = cursor || conversationKey ? undefined : await deps.repos.session.orgHasAny(orgOf(req))
        if (selectedAgentIds.length === 0) {
          return {
            ...(grouped || conversationKey ? { conversations: [] } : { sessions: [] }),
            total: cursor ? null : 0,
            nextCursor: null,
            ...(orgHasSessions !== undefined ? { orgHasSessions } : {})
          }
        }

        // GitHub is a semantic subtype of hook sessions. Resolve definitions only
        // when integration classification or a repository-wide trigger filter needs them.
        const { githubHookIds, repoHookIds } = await githubHookFilters(deps, orgOf(req), req.query, false)
        const query = {
          agentIds: selectedAgentIds,
          // Two or more selected agents ask for the threads they SHARE. The rows
          // stay scoped to those agents (`agentIds`), so `?agentId=a` keeps
          // returning exactly what it always did.
          ...(requested.length > 1 ? { conversationAgentIds: selectedAgentIds } : {}),
          ...(req.query.platform ? { platform: req.query.platform } : {}),
          ...(req.query.integration ? { integration: req.query.integration } : {}),
          ...(req.query.channel ? { channel: req.query.channel } : {}),
          ...(req.query.triggeredBy ? { triggeredBy: req.query.triggeredBy } : {}),
          ...(githubHookIds.length > 0 ? { githubHookIds } : {}),
          ...(repoHookIds ? { hookTriggerIds: repoHookIds } : {}),
          ...(cursor ? { cursor } : {}),
          limit: req.query.limit,
          includeTotal: !cursor
        }
        const { viewer, access } = await viewerForQuery(req, query)

        // §5.2 key-addressed resolver: a bounded metadata-only member lookup for
        // a direct conversation load — the paginated list is not a key lookup.
        if (conversationKey) {
          const members = await deps.repos.session.listConversationMembers(
            { agentIds: selectedAgentIds, viewer },
            conversationKey
          )
          const hookMetadata = await hookMetadataForSessions(deps, members, orgOf(req))
          return {
            conversations:
              members.length > 0
                ? [
                    {
                      key: encodeConversationKey(conversationKey),
                      platform: conversationKey.platform,
                      channel: conversationKey.channel,
                      thread: conversationKey.thread,
                      sessions: members.map((session) => sessionDto(session, hookMetadata))
                    }
                  ]
                : [],
            total: members.length > 0 ? 1 : 0,
            nextCursor: null,
            accessSyncDegraded: access.degraded
          }
        }

        if (!grouped) {
          const page = await deps.repos.session.listPage({ ...query, viewer })
          const hookMetadata = await hookMetadataForSessions(deps, page.sessions, orgOf(req))
          const nextCursor = page.hasMore ? encodeSessionCursor(page.sessions[page.sessions.length - 1]!) : null
          return {
            sessions: page.sessions.map((session) => sessionDto(session, hookMetadata)),
            total: page.total,
            nextCursor,
            accessSyncDegraded: access.degraded,
            ...(orgHasSessions !== undefined ? { orgHasSessions } : {})
          }
        }

        const page = await deps.repos.session.listConversationPage({ ...query, viewer })
        const allRows = page.conversations.flatMap((c) => c.sessions)
        const hookMetadata = await hookMetadataForSessions(deps, allRows, orgOf(req))
        // The grouped cursor is the last conversation's REPRESENTATIVE row —
        // emit-at-max makes resumption stateless (§5.2).
        const lastRep = page.conversations[page.conversations.length - 1]?.sessions[0]
        const nextCursor = page.hasMore && lastRep ? encodeSessionCursor(lastRep) : null
        return {
          conversations: page.conversations.map((c) => ({
            key: encodeConversationKey(c.key),
            platform: c.key.platform,
            channel: c.key.channel,
            thread: c.key.thread,
            sessions: c.sessions.map((session) => sessionDto(session, hookMetadata))
          })),
          total: page.total,
          nextCursor,
          accessSyncDegraded: access.degraded,
          ...(orgHasSessions !== undefined ? { orgHasSessions } : {})
        }
      }
    )

    // Deep-link detail (…/sessions/:id): served from CP-stored SessionMeta (synced
    // via the `event/session` EVT), so the page resolves even when the daemon is
    // offline. Metadata only — the transcript stays a `/messages` daemon pull.
    // 404 for an unknown session OR one whose owning agent this caller can't see.
    r.get(
      '/sessions/:id',
      {
        schema: {
          tags: [Tag.Sessions],
          summary: 'Get session metadata',
          description:
            'Returns CP-stored session metadata plus visible parent, sibling, and child session links; transcript bodies remain daemon-local.',
          operationId: 'getSession',
          params: IdParam,
          response: { 200: SessionDetailDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const owned = await getOrgViewableSession(req, req.params.id)
        if (!owned) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'session not found' })
        }
        const { session: s, access } = owned
        // Relationships may cross agents (and daemons), so apply the same
        // owning-agent visibility rule to every linked session. A hidden parent
        // is indistinguishable from no parent; hidden children are omitted.
        const visibleAgents = await deps.repos.agent.list(orgOf(req), ctxOf(req))
        const visibleAgentIds = visibleAgents.map((a) => a.id)
        const visibleAgentIdSet = new Set<string>(visibleAgentIds)
        const ctx = ctxOf(req)
        const [parent, children, siblingCandidates, usage, webchatRoster] = await Promise.all([
          s.parentSessionId ? deps.repos.session.get(s.parentSessionId) : Promise.resolve(null),
          deps.repos.session.listChildren(SessionId(s.id), visibleAgentIds),
          s.parentSessionId ? deps.repos.session.listChildren(s.parentSessionId, visibleAgentIds) : Promise.resolve([]),
          deps.repos.sessionUsage.get(s.agentId, s.id),
          // A webchat session's channel IS its conversation id; the roster feeds
          // the adopted-session composer/header, which has no relay socket.
          s.platform === 'webchat' && s.channel
            ? deps.repos.webchatConversation.participants(s.channel)
            : Promise.resolve([])
        ])
        const siblings = siblingCandidates.filter((candidate) => candidate.id !== s.id)
        const related = [...(parent ? [parent] : []), ...siblings, ...children]
        const relatedAccess = await sessionAccess.forSessions(req, related)
        const parentVisible =
          parent !== null &&
          visibleAgentIdSet.has(parent.agentId) &&
          canViewSession(parent, ctx, relatedAccess.identitySet, relatedAccess.externalAccess)
        // A hidden parent is indistinguishable from no parent. Keep its sibling
        // branch hidden too, otherwise the response would still reveal the
        // relationship through the parent's other children.
        const visibleSiblings = parentVisible
          ? siblings.filter((sibling) =>
              canViewSession(sibling, ctx, relatedAccess.identitySet, relatedAccess.externalAccess)
            )
          : []
        const visibleChildren = children.filter((child) =>
          canViewSession(child, ctx, relatedAccess.identitySet, relatedAccess.externalAccess)
        )
        return {
          id: s.id,
          parentSession: parentVisible ? sessionRelation(parent) : null,
          siblingSessions: visibleSiblings.map(sessionRelation),
          childSessions: visibleChildren.map(sessionRelation),
          agentId: s.agentId,
          launchId: s.launchId,
          platform: s.platform,
          channel: s.channel,
          thread: s.thread,
          phase: s.phase,
          link: s.link,
          summary: s.summary,
          title: s.title,
          status: s.status,
          lastActivityAt: s.lastActivityAt.toISOString(),
          usage,
          triggeredBy: s.triggeredBy,
          channelName: s.channelName,
          triggeredByName: s.triggeredByName,
          threadUrl: s.threadUrl,
          tenantScope: s.tenantScope ?? null,
          participants:
            webchatRoster.length > 1
              ? webchatRoster.map((p) => ({
                  agentId: p.agentId,
                  name: visibleAgents.find((a) => a.id === p.agentId)?.name ?? null,
                  primary: p.role === 'primary'
                }))
              : null,
          runtime: s.runtime,
          model: s.model,
          effort: s.effort,
          fastMode: s.fastMode,
          permissionMode: s.permissionMode,
          outputMode: s.outputMode,
          daemonId: s.daemonId,
          activityState: s.activityState,
          visibility: s.visibility,
          externalProvider: s.externalProvider,
          externalResolution: s.externalResolution,
          // The §5.1 cutover state: CP read gates apply at commit, but the memory
          // boundary only takes effect once every affected daemon has acked.
          visibilityState: await visibilityStateOf(deps.visibilityPush, deps.repos, [s.id]),
          canChangeVisibility: canChangeSessionVisibility(s, ctx, access.identitySet),
          accessSyncDegraded: access.degraded || relatedAccess.degraded,
          startedAt: s.startedAt.toISOString(),
          endedAt: s.endedAt ? s.endedAt.toISOString() : null
        }
      }
    )

    // Replay view: proxy a page of the session's chat history live from the
    // owning daemon. CP stores list/detail metadata only, not transcript bodies.
    // 503 if the agent is unplaced or its daemon is offline (the list still works).
    r.get(
      '/sessions/:id/messages',
      {
        schema: {
          tags: [Tag.Sessions],
          summary: 'Get session messages',
          description:
            "Proxies a page of the session's chat history live from the owning daemon (resolved via the row's agentId); 503 if the agent is unplaced or its daemon is offline.",
          operationId: 'getSessionMessages',
          params: IdParam,
          querystring: SessionHistoryQueryDto,
          response: { 200: SessionHistoryDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const owned = await getOrgViewableSession(req, req.params.id)
        if (!owned) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'session not found' })
        }
        const { session, agent } = owned
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }

        try {
          const page = await deps.control.sessionHistory(agent.daemonId, {
            agentId: session.agentId,
            sessionId: session.id,
            ...(req.query.cursor !== undefined ? { cursor: req.query.cursor } : {}),
            ...(req.query.after !== undefined ? { after: req.query.after } : {}),
            limit: req.query.limit ?? 50
          })
          // Provider membership and identity can be revoked while the daemon is
          // answering. Re-run the complete predicate before any body leaves CP.
          if (!(await getOrgViewableSession(req, req.params.id))) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'session not found' })
          }
          return {
            sessionId: page.sessionId,
            messages: page.messages,
            nextCursor: page.nextCursor ?? null,
            liveCursor: page.liveCursor ?? null,
            liveMore: page.liveMore ?? false
          }
        } catch (err) {
          if (err instanceof NoConnection) {
            return reply
              .code(503)
              .send({ error: 'Service Unavailable', statusCode: 503, message: 'owning daemon is offline' })
          }
          throw err
        }
      }
    )

    // Full-body view: proxy one byte slice of a tool call's untruncated ToolBody
    // JSON live from the owning daemon (resolved from SessionMeta, same as /messages).
    // The console pages by offset until nextOffset is null. 503 if the agent is
    // unplaced or its daemon is offline.
    r.get(
      '/sessions/:id/tool-body',
      {
        schema: {
          tags: [Tag.Sessions],
          summary: 'Get a tool-call body',
          description:
            "Proxies one byte slice of a tool call's untruncated ToolBody JSON live from the owning daemon; the console pages by offset until nextOffset is null. 503 if the agent is unplaced or its daemon is offline.",
          operationId: 'getSessionToolBody',
          params: IdParam,
          querystring: SessionToolBodyQueryDto,
          response: { 200: SessionToolBodyChunkDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const owned = await getOrgViewableSession(req, req.params.id)
        if (!owned) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'session not found' })
        }
        const { session, agent } = owned
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }

        try {
          const chunk = await deps.control.sessionToolBody(agent.daemonId, {
            agentId: session.agentId,
            sessionId: session.id,
            toolCallId: req.query.toolCallId,
            offset: req.query.offset ?? 0
          })
          if (!(await getOrgViewableSession(req, req.params.id))) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'session not found' })
          }
          return {
            sessionId: chunk.sessionId,
            toolCallId: chunk.toolCallId,
            data: chunk.data,
            totalBytes: chunk.totalBytes,
            nextOffset: chunk.nextOffset ?? null
          }
        } catch (err) {
          if (err instanceof NoConnection) {
            return reply
              .code(503)
              .send({ error: 'Service Unavailable', statusCode: 503, message: 'owning daemon is offline' })
          }
          throw err
        }
      }
    )

    // §4.3 direct-session reclassification — publish a useful DM transcript to
    // the org, or pull an owned direct session private. Provider-bound shared
    // sessions have an immutable audience and are rejected by the policy and
    // repository guards. Tightening cascades to descendants and stops future
    // memory capture once every affected daemon acks (§5.1); it does NOT scrub
    // what the agent already distilled while the session was org-visible.
    r.put(
      '/sessions/:id/visibility',
      {
        schema: {
          tags: [Tag.Sessions],
          summary: 'Set session visibility',
          description:
            "Reclassifies a session as private or org-visible. Allowed only for the session's recorded owner (identity match) — roles grant no re-classification rights. Tightening cascades to descendant sessions and stops future agent-memory capture once the owning daemons acknowledge; memory already distilled is not retracted.",
          operationId: 'setSessionVisibility',
          params: IdParam,
          body: SetSessionVisibilityBody,
          response: { 200: SessionVisibilityDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const owned = await getOrgViewableSession(req, req.params.id)
        if (!owned) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'session not found' })
        }
        const ctx = ctxOf(req)
        const identitySet = owned.access.identitySet
        if (!canChangeSessionVisibility(owned.session, ctx, identitySet)) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', statusCode: 403, message: 'not allowed to change this session visibility' })
        }
        // The check above read an unlocked row. Re-run it inside the write's
        // transaction: an ancestor cascade committing in between can re-own this
        // session, and the former owner's parked request must not still apply —
        // ownership is judged against the LOCKED row.
        const { affected, forbidden } = await deps.repos.session.setVisibility(
          SessionId(req.params.id),
          req.body.visibility,
          (row) => canChangeSessionVisibility(row, ctx, identitySet)
        )
        if (forbidden) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', statusCode: 403, message: 'not allowed to change this session visibility' })
        }
        // Read gates apply at commit; the daemons learn asynchronously.
        if (affected.length > 0) void deps.visibilityPush?.notifySessions(affected)
        const current = affected.find((s) => s.id === owned.session.id) ?? owned.session
        return {
          id: current.id,
          visibility: current.visibility,
          visibilityRev: current.visibilityRev,
          cascadedSessionIds: affected.filter((s) => s.id !== current.id).map((s) => s.id),
          state: await visibilityStateOf(
            deps.visibilityPush,
            deps.repos,
            affected.length > 0 ? affected.map((s) => s.id) : [current.id]
          )
        }
      }
    )
  }
}
