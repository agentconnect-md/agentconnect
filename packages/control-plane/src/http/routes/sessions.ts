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
import { orgOf, ctxOf } from '../rbac.js'
import { canView } from '../visibility.js'
import { Tag } from '../plugins/openapi.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import {
  SessionListPageDto,
  SessionFacetsDto,
  SessionDetailDto,
  SessionHistoryDto,
  SessionToolBodyQueryDto,
  SessionToolBodyChunkDto,
  ErrorDto,
  IdParam
} from '../dto/index.js'

const SessionFilterQueryDto = z.object({
  agentId: z.string().optional(),
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
  limit: z.coerce.number().int().positive().max(200).default(50)
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

function sessionRelation(s: { id: string; agentId: string; title: string | null }) {
  return { id: s.id, agentId: s.agentId, title: s.title }
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
    daemonId: s.daemonId ?? null
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

    const getOrgViewableSession = async (req: FastifyRequest, sessionId: string) => {
      const session = await deps.repos.session.get(SessionId(sessionId))
      if (!session) return null
      const agent = await getOrgViewableAgent(req, session.agentId)
      return agent ? { session, agent } : null
    }

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
        if (req.query.agentId && !new Set<string>(visibleAgentIds).has(req.query.agentId)) {
          return { agents: [], integrations: [], channels: [], triggers: [] }
        }
        const { githubHookIds, repoHookIds } = await githubHookFilters(deps, orgOf(req), req.query, true)
        const index = await deps.repos.session.listFacets({
          agentIds: visibleAgentIds,
          ...(req.query.agentId ? { agentId: AgentId(req.query.agentId) } : {}),
          ...(req.query.platform ? { platform: req.query.platform } : {}),
          ...(req.query.integration ? { integration: req.query.integration } : {}),
          ...(req.query.channel ? { channel: req.query.channel } : {}),
          ...(req.query.triggeredBy ? { triggeredBy: req.query.triggeredBy } : {}),
          githubHookIds,
          ...(repoHookIds ? { hookTriggerIds: repoHookIds } : {})
        })
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
            'Lists CP-stored session metadata synced by daemon event/session snapshots; transcript bodies remain daemon-local.',
          operationId: 'listSessions',
          querystring: SessionQueryDto,
          response: { 200: SessionListPageDto, 400: ErrorDto }
        }
      },
      async (req, reply) => {
        const cursor = req.query.cursor ? decodeSessionCursor(req.query.cursor) : undefined
        if (req.query.cursor && !cursor) {
          return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: 'invalid session cursor' })
        }

        // The set of agents THIS caller may see (owner ⇒ all). Session metadata
        // inherits visibility from the owning agent, so restricted-agent rows are
        // hidden before any title/channel/usage metadata reaches the caller.
        const visibleAgentIds = (await deps.repos.agent.list(orgOf(req), ctxOf(req))).map((agent) => agent.id)
        const visibleAgentIdSet = new Set<string>(visibleAgentIds)
        const selectedAgentIds = req.query.agentId
          ? visibleAgentIdSet.has(req.query.agentId)
            ? [AgentId(req.query.agentId)]
            : []
          : visibleAgentIds
        if (selectedAgentIds.length === 0) {
          return {
            sessions: [],
            total: cursor ? null : 0,
            nextCursor: null
          }
        }

        // GitHub is a semantic subtype of hook sessions. Resolve definitions only
        // when integration classification or a repository-wide trigger filter needs them.
        const { githubHookIds, repoHookIds } = await githubHookFilters(deps, orgOf(req), req.query, false)
        const page = await deps.repos.session.listPage({
          agentIds: selectedAgentIds,
          ...(req.query.platform ? { platform: req.query.platform } : {}),
          ...(req.query.integration ? { integration: req.query.integration } : {}),
          ...(req.query.channel ? { channel: req.query.channel } : {}),
          ...(req.query.triggeredBy ? { triggeredBy: req.query.triggeredBy } : {}),
          ...(githubHookIds.length > 0 ? { githubHookIds } : {}),
          ...(repoHookIds ? { hookTriggerIds: repoHookIds } : {}),
          ...(cursor ? { cursor } : {}),
          limit: req.query.limit,
          includeTotal: !cursor
        })
        const hookMetadata = await hookMetadataForSessions(deps, page.sessions, orgOf(req))
        const nextCursor = page.hasMore ? encodeSessionCursor(page.sessions[page.sessions.length - 1]!) : null

        return {
          sessions: page.sessions.map((session) => sessionDto(session, hookMetadata)),
          total: page.total,
          nextCursor
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
            'Returns CP-stored session metadata plus visible parent and child session links; transcript bodies remain daemon-local.',
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
        const { session: s } = owned
        // Relationships may cross agents (and daemons), so apply the same
        // owning-agent visibility rule to every linked session. A hidden parent
        // is indistinguishable from no parent; hidden children are omitted.
        const visibleAgentIds = (await deps.repos.agent.list(orgOf(req), ctxOf(req))).map((a) => a.id)
        const visibleAgentIdSet = new Set<string>(visibleAgentIds)
        const [parent, children, usage] = await Promise.all([
          s.parentSessionId ? deps.repos.session.get(s.parentSessionId) : Promise.resolve(null),
          deps.repos.session.listChildren(SessionId(s.id), visibleAgentIds),
          deps.repos.sessionUsage.get(s.agentId, s.id)
        ])
        return {
          id: s.id,
          parentSession: parent && visibleAgentIdSet.has(parent.agentId) ? sessionRelation(parent) : null,
          childSessions: children.map(sessionRelation),
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
          runtime: s.runtime,
          model: s.model,
          effort: s.effort,
          fastMode: s.fastMode,
          permissionMode: s.permissionMode,
          outputMode: s.outputMode,
          daemonId: s.daemonId,
          activityState: s.activityState,
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
  }
}
