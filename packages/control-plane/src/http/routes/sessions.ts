/**
 * `http/routes/sessions.ts` (design §2.1) — the console's session views.
 *
 * The CP stores session metadata only (sessions are created on the daemon path;
 * transcripts/attachments/tool bodies stay daemon-local). So the list is a DB
 * read, while transcript views remain on-demand daemon pulls:
 *
 * - `GET /sessions` lists CP-stored session metadata synced by daemon
 *   `event/session` snapshots. Transcript bodies still stay daemon-local.
 * - `GET /sessions/:id/messages` pulls one transcript page from a daemon that can
 *   serve it — the recorded one, else a member of the shared store the session was
 *   written to — and proxies it through. Bodies transit the CP live for display
 *   only, never persisted (body-locality §1/§12).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { AgentId, DaemonId, HookId, OrgId, SessionId } from '../../domain/ids.js'
import { orgOf, ctxOf, denyNonOwner } from '../rbac.js'
import { decodeConversationKey, encodeConversationKey } from '../conversation-key.js'
import { canChangeSessionVisibility, canContinueSession, canView, canViewSession } from '../../authorization/policy.js'
import {
  AUTO_MERGE_FEATURE,
  AutoMergeErrorReason,
  CODE_HOST_PROVIDERS,
  isCodeHostHookKind,
  isSessionIdentityPlatform,
  SANDBOX_KEEP_ALIVE_FEATURE,
  continuableOrigin,
  type CodeHostProvider,
  type HookKind
} from '@agentconnect.md/protocol'
import { makeSessionAccessResolver } from '../session-access.js'
import { resolveContinuationHost } from '../session-continuation.js'
import { Tag } from '../plugins/openapi.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { ConnectionClosed } from '../../ws/registry.js'
import { sessionContentReaders } from '../../domain/session-content.js'
import { visibilityStateOf } from '../../orchestrator/visibilityPush.js'
import type { PullRequestView } from '../../github/pull-request-view.service.js'
import type { ConversationCoordinate, SessionMetaRecord } from '../../persistence/ports.js'
import { GithubApiError } from '../../github/api.js'
import { GitCredDeniedError } from '../../github/service.js'
import { ProtocolError } from '../../domain/errors.js'
import {
  SessionListPageDto,
  SessionFacetsDto,
  SessionDetailDto,
  SessionHistoryDto,
  SessionToolBodyQueryDto,
  SessionToolBodyChunkDto,
  ErrorDto,
  IdParam,
  SessionPullRequestDto,
  SessionPullRequestQueryDto,
  SessionPullRequestAutoMergeBodyDto,
  SessionPullRequestAutoMergeDto,
  SessionPullRequestMergeDto,
  SessionSandboxKeepAliveDto,
  type SessionPullRequestDtoT,
  SetSessionVisibilityBody,
  SessionVisibilityDto,
  SetSessionExternalAccessBody,
  SessionExternalAccessDto
} from '../dto/index.js'

const SESSION_PLATFORM_IDS = ['slack', 'telegram', 'webchat', 'discord', 'feishu', 'hook', 'dream'] as const

const SessionFilterQueryDto = z.object({
  // Repeatable: `?agentId=a` scopes to one agent's rows (unchanged), while
  // `?agentId=a&agentId=b` asks for the CONVERSATIONS both took part in and
  // returns each of their sessions in those threads. Fastify's querystring
  // parser hands repeated keys over as an array.
  agentId: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
  platform: z.enum(SESSION_PLATFORM_IDS).optional(),
  // The integration axis is every routing platform plus each code host, which the facet
  // projection promotes out of the generic hook bucket. Derived from the shared provider
  // list, so a promoted host is selectable the moment it can be emitted.
  integration: z.enum([...SESSION_PLATFORM_IDS, ...CODE_HOST_PROVIDERS]).optional(),
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
type HookSessionRow = Pick<SessionPageRow, 'agentId' | 'platform' | 'channel' | 'triggeredBy' | 'hookKind'>
type HookSessionMetadata = {
  agentId: string | null
  kind: HookKind
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

/** Which code-host hook definitions this request has to resolve, keyed by provider. A
 *  repository filter stays GitHub-only — the numeric repo id is GitHub's alone; otherwise
 *  each host's ids are read when the facet projection classifies everything, when that
 *  host is the requested integration, or when `hook` needs to exclude it. Iterating the
 *  shared provider list is what keeps this seam level with the facet projection: a host
 *  that can be emitted as a facet is resolved here too, so it can also be selected. */
async function codeHostHookFilters(
  deps: HttpDeps,
  orgId: OrgId,
  query: z.infer<typeof SessionFilterQueryDto>,
  classifyAll: boolean
): Promise<{ codeHostHookIds: Partial<Record<CodeHostProvider, HookId[]>>; repoHookIds?: HookId[] }> {
  if (query.githubRepoId) {
    const githubHooks = await deps.repos.hook.listForOrgKind(orgId, 'github')
    return {
      codeHostHookIds: { github: githubHooks.map((hook) => hook.id) },
      repoHookIds: githubHooks.filter((hook) => hook.repoId?.toString() === query.githubRepoId).map((hook) => hook.id)
    }
  }
  const wanted = (provider: CodeHostProvider) =>
    classifyAll || query.integration === provider || query.integration === 'hook'
  const codeHostHookIds: Partial<Record<CodeHostProvider, HookId[]>> = {}
  await Promise.all(
    CODE_HOST_PROVIDERS.filter(wanted).map(async (provider) => {
      codeHostHookIds[provider] = await deps.repos.hook.listIdsForOrgKind(orgId, provider)
    })
  )
  return { codeHostHookIds }
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

function agentDisplayName(agent: { name: string; displayName?: string | null }): string {
  return agent.displayName?.trim() || agent.name
}

function sessionRelation(
  s: { id: string; agentId: string; platform: string | null; title: string | null },
  agentNames: ReadonlyMap<string, string>
) {
  return {
    id: s.id,
    agentId: s.agentId,
    agentName: agentNames.get(s.agentId) ?? null,
    platform: s.platform ?? 'slack',
    title: s.title
  }
}

function hookMetadataForSession(metadata: Map<string, HookSessionMetadata>, session: HookSessionRow) {
  return metadata.get(hookIdForSession(session) ?? '')
}

async function hookMetadataForSessions(
  deps: HttpDeps,
  sessions: HookSessionRow[],
  orgId: OrgId
): Promise<Map<string, HookSessionMetadata>> {
  const ids = [...new Set(sessions.map(hookIdForSession).filter((id): id is string => Boolean(id)))]
  const metadata = new Map<string, HookSessionMetadata>()
  // The batch read is org-fenced (org-scoped-data-layer.md §3), so foreign ids
  // are simply absent — no post-filter needed.
  for (const hook of await deps.repos.hook.getMany(orgId, ids.map(HookId))) {
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

/** A hook session's own source kind. The creation-time snapshot is authoritative — the
 *  definition it fired from may have been deleted since, and a session's history must not
 *  change when that happens. Only rows written before the snapshot existed read the live
 *  hook, and a hook that no longer resolves leaves them with no kind at all. */
function sessionHookKind(s: HookSessionRow, hook: HookSessionMetadata | undefined): HookKind | null {
  return s.hookKind ?? hook?.kind ?? null
}

/** A hook session's integration facet. EVERY code host is promoted out of the generic
 *  hook bucket so each gets a first-class entry the console can filter by; only the
 *  generic kind keeps the raw `hook` platform. The predicate is derived from the shared
 *  hook-kind vocabulary, so a new host is promoted here without a code change, and the
 *  value matches the client's own `sessionPlatform` classification. */
function sessionIntegration(s: HookSessionRow, hook: HookSessionMetadata | undefined): string {
  const platform = s.platform ?? 'slack'
  if (platform !== 'hook') return platform
  const kind = sessionHookKind(s, hook)
  return kind && isCodeHostHookKind(kind) ? kind : platform
}

/** Display name for a hook source with no name of its own. TOTAL over the hook-kind
 *  vocabulary, so a new code host cannot inherit the generic "Webhook" label the way
 *  GitLab did — adding one to the shared union fails this file's type-check first. */
const HOOK_KIND_LABEL: Record<HookKind, string> = { webhook: 'Webhook', github: 'GitHub', gitlab: 'GitLab' }

/** A channel id is only unique within its platform, so the label cache keys on both.
 *  The space is safe: no platform conversation id we store contains one. */
function conversationNameKey(platform: string | null, channel: string): string {
  return `${platform ?? 'slack'} ${channel}`
}

/**
 * Names for the conversations in these rows the reporting daemon never labeled, read
 * from the org's channel directory — the same source a schedule's target channel is
 * named through.
 *
 * `channelName` is a snapshot of the daemon's own name cache at the moment it emitted
 * `event/session`, and that cache learns a channel from the bot's membership listing.
 * A conversation the agent only ever POSTS into can therefore leave the column null for
 * good, leaving the console to print a raw platform id. The directory is durable and
 * already holds the name, so reading it here repairs existing rows too.
 */
async function channelNamesForSessions(
  deps: HttpDeps,
  sessions: readonly (HookSessionRow & { channelName: string | null })[],
  orgId: OrgId
): Promise<Map<string, string>> {
  const wanted = new Map<string, ConversationCoordinate>()
  for (const s of sessions) {
    const platform = s.platform ?? 'slack'
    // A session-identity platform holds no conversation of its own here — a hook
    // session's `channel` is its hook id, and webchat's is its conversation id.
    if (s.channelName || !s.channel || isSessionIdentityPlatform(platform)) continue
    wanted.set(conversationNameKey(platform, s.channel), { platform, channelId: s.channel })
  }
  const names = new Map<string, string>()
  if (wanted.size === 0) return names
  for (const row of await deps.repos.integrationChannel.namesForOrg(orgId, [...wanted.values()])) {
    names.set(conversationNameKey(row.platform, row.channelId), row.name)
  }
  return names
}

function sessionDisplayMetadata(
  s: HookSessionRow & { channelName: string | null; triggeredByName: string | null },
  hook: HookSessionMetadata | undefined,
  channelNames: ReadonlyMap<string, string>
) {
  // Hook kind remains valid after reassignment, but the current name only
  // describes historical rows while the hook still belongs to the same agent.
  const hookName = hook?.agentId === s.agentId ? hook.name : undefined
  // A row with neither a snapshot nor a resolvable hook has no kind to name, so it stays generic.
  const kind = sessionHookKind(s, hook)
  const sourceLabel = HOOK_KIND_LABEL[kind ?? 'webhook']
  return {
    channelName:
      s.platform === 'hook'
        ? (hookName ?? s.channelName ?? null)
        : (s.channelName ??
          (s.channel ? (channelNames.get(conversationNameKey(s.platform, s.channel)) ?? null) : null)),
    triggeredByName: s.triggeredBy?.startsWith(HOOK_TRIGGER_PREFIX)
      ? (hookName ?? s.triggeredByName ?? sourceLabel)
      : (s.triggeredByName ?? null)
  }
}

function sessionFacets(
  index: SessionFacetIndex,
  hookMetadata: Map<string, HookSessionMetadata>,
  agentNames: ReadonlyMap<string, string>,
  channelNames: ReadonlyMap<string, string>
) {
  const integrations = new Set<string>()
  const facetAgentNames: Record<string, string> = {}
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
      hookKind: HookKind | null
      githubRepoId: string | null
    }
  >()

  const integrationRows = [...index.integrations].sort(
    (a, b) =>
      b.lastActivityAt.getTime() - a.lastActivityAt.getTime() ||
      b.startedAt.getTime() - a.startedAt.getTime() ||
      b.id.localeCompare(a.id)
  )
  for (const agentId of index.agents) {
    const name = agentNames.get(agentId)
    if (name) facetAgentNames[agentId] = name
  }
  for (const session of integrationRows) {
    const hook = hookMetadataForSession(hookMetadata, session)
    integrations.add(sessionIntegration(session, hook))
  }
  for (const session of index.channels) {
    const channel = session.channel!
    const hook = hookMetadataForSession(hookMetadata, session)
    const display = sessionDisplayMetadata(session, hook, channelNames)
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
    const display = sessionDisplayMetadata(session, hook, channelNames)
    const githubRepoId = hook?.kind === 'github' ? (hook.repoId?.toString() ?? null) : null
    triggers.set(triggeredBy, {
      value: triggeredBy,
      integration: sessionIntegration(session, hook),
      name: display.triggeredByName,
      hookKind: sessionHookKind(session, hook),
      githubRepoId
    })
  }

  return {
    agents: index.agents,
    agentNames: facetAgentNames,
    integrations: [...integrations],
    channels: [...channels.values()],
    triggers: [...triggers.values()]
  }
}

function sessionDto(
  s: SessionPageRow,
  hookMetadata: Map<string, HookSessionMetadata>,
  agentNames: ReadonlyMap<string, string>,
  channelNames: ReadonlyMap<string, string>
) {
  const hook = hookMetadataForSession(hookMetadata, s)
  const display = sessionDisplayMetadata(s, hook, channelNames)
  return {
    sessionId: s.id,
    sessionKey: {
      platform: s.platform ?? 'slack',
      channel: s.channel ?? '',
      ...(s.thread !== null ? { thread: s.thread } : {})
    },
    agentId: s.agentId,
    agentName: agentNames.get(s.agentId) ?? null,
    title: s.title ?? null,
    status: s.status ?? null,
    lastActivityAt: s.lastActivityAt.toISOString(),
    usage: s.usage ?? null,
    triggeredBy: s.triggeredBy ?? null,
    hookKind: sessionHookKind(s, hook),
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
    contentSetId: s.contentSetId ?? null,
    workspaceIsolation: s.workspaceIsolation ?? null,
    visibility: s.visibility,
    externalProvider: s.externalProvider,
    externalResolution: s.externalResolution,
    contentPurgedAt: s.contentPurgedAt ? s.contentPurgedAt.toISOString() : null
  }
}

function feishuRegionForSession(
  session: { externalProvider: string | null; externalScopeId: string | null },
  scopes: readonly { id: string; provider: string; realmKey: string }[]
): 'feishu' | 'lark' | null {
  if (session.externalProvider !== 'feishu' || !session.externalScopeId) return null
  const scope = scopes.find((candidate) => candidate.id === session.externalScopeId && candidate.provider === 'feishu')
  const region = scope?.realmKey.split(':', 1)[0]
  return region === 'feishu' || region === 'lark' ? region : null
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

// HookRun.reviewEvent -> the panel's review vocabulary. An unrecognized event maps to nothing rather than to a guess.
function agentReviewOf(event: string | null): 'approved' | 'changes_requested' | 'commented' | null {
  if (event === 'APPROVE') return 'approved'
  if (event === 'REQUEST_CHANGES') return 'changes_requested'
  if (event === 'COMMENT') return 'commented'
  return null
}

/** What the EDGE said about its watcher, or null when nobody could be asked (no live daemon, or one
 *  too old to serve the frame) — which the panel draws differently from a confident "not armed". */
export interface AutoMergeOverlay {
  armed: boolean
  placement?: 'sandbox' | 'daemon'
  waitingOn?: string
  lastError?: string
}

// Service view -> HTTP body, 1:1 plus the caller's write capability and the edge's watcher state;
// degradation judgements are the service's.
function toSessionPullRequestDto(
  view: PullRequestView,
  canArmAutoMerge: boolean,
  autoMerge: AutoMergeOverlay | null,
  // How this PR was found. Defaulted to the run, which is the only source that existed before §12.6.
  link: {
    linkedBy: 'run' | 'head-branch'
    linkBranch: string | null
    linkScope: 'session' | 'shared' | null
    linkAmbiguous: boolean
  } = {
    linkedBy: 'run',
    linkBranch: null,
    linkScope: null,
    linkAmbiguous: false
  }
): SessionPullRequestDtoT {
  return {
    ...link,
    canArmAutoMerge,
    autoMergeArmed: autoMerge ? autoMerge.armed : null,
    autoMergePlacement: autoMerge?.placement ?? null,
    autoMergeWaitingOn: autoMerge?.waitingOn ?? null,
    autoMergeError: autoMerge?.lastError ?? null,
    repoFullName: view.repoFullName,
    pullNumber: view.pullNumber,
    title: view.title,
    body: view.body,
    state: view.state,
    isDraft: view.isDraft,
    url: view.url,
    headRef: view.headRef,
    baseRef: view.baseRef,
    additions: view.additions,
    deletions: view.deletions,
    reviewDecision: view.reviewDecision,
    checks: view.checks,
    checksTruncated: view.checksTruncated,
    reviews: view.reviews,
    threads: view.threads,
    unresolvedCount: view.unresolvedCount,
    threadsTruncated: view.threadsTruncated,
    degraded: view.degraded,
    degradedReason: view.degradedReason,
    agentReview: view.agentReview
  }
}

export function sessionRoutes(deps: HttpDeps) {
  return async function sessionRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    // Session reads are authorized by the Session audience, independently from
    // the owning Agent's Team visibility. Passing this gate grants transcript
    // access only; Agent configuration and workspace routes keep their own Agent
    // resource gate. The repo arm and this in-app check must stay two spellings
    // of one rule — both come from `canViewSession`, fed the SAME identity set:
    // console identity plus provider-plugin contributions.
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
      const session = await deps.repos.session.get(orgOf(req), SessionId(sessionId))
      if (!session) return null
      const access = await sessionAccess.forSessions(req, [session])
      if (!canViewSession(session, ctxOf(req), access.identitySet, access.externalAccess)) return null
      return { session, access }
    }

    // Daemon-local session content, read through a daemon that can still serve it. The recorded
    // daemon owns it, but a pool member is replaceable: retiring one deletes its row and nulls the
    // session's `daemonId`, while every peer on the store it wrote to reads the same rows. So:
    // recorded daemon first, then the members of THIS session's `contentSetId` — nobody at all
    // when that store was private, which is how a move keeps answering 503 rather than serving a
    // false empty page from a machine that never held the session.
    type ContentRead<T> = { ok: true; value: T } | { ok: false; reason: 'unplaced' | 'offline' }
    const readSessionContent = async <T>(
      req: FastifyRequest,
      session: { daemonId: string | null; contentSetId: string | null },
      read: (daemonId: string) => Promise<T>
    ): Promise<ContentRead<T>> => {
      const readers = sessionContentReaders({
        recordedDaemonId: session.daemonId,
        sharedStoreMembers: session.contentSetId
          ? await deps.repos.memberSet.sharedStoreMemberIdsOf(session.contentSetId)
          : []
      })
      if (readers.length === 0) return { ok: false, reason: session.daemonId ? 'offline' : 'unplaced' }
      // EVERY failure moves to the next holder of the same store, not just an unreachable socket:
      // during a rollout the readers span two images, and one that answers an error is no more
      // authoritative about rows its peers hold than one whose socket died. A read that no holder
      // answered still fails LOUD on the last real error — only an unreachable set is a 503 —
      // so a bug that breaks the read everywhere is never dressed up as unavailability.
      let failure: unknown
      for (const daemonId of readers) {
        try {
          return { ok: true, value: await read(daemonId) }
        } catch (err) {
          if (!(err instanceof NoConnection) && !(err instanceof ConnectionClosed)) {
            failure = err
            req.log.warn({ err, daemonId }, 'session content read failed on a holder of the store; trying the next one')
          }
        }
      }
      if (failure !== undefined) throw failure
      return { ok: false, reason: 'offline' }
    }

    // The two 503s the content proxies answer with when nothing served the read.
    const contentUnavailable = (reason: 'unplaced' | 'offline') => ({
      error: 'Service Unavailable',
      statusCode: 503 as const,
      message: reason === 'unplaced' ? 'session has no recorded daemon' : 'owning daemon is offline'
    })

    type ExternalAccessProvider = 'slack' | 'github' | 'feishu'
    const externalAccessAvailable = (provider: ExternalAccessProvider) =>
      deps.sessionAccessPlugins?.find((plugin) => plugin.provider === provider)?.available === true

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
        const orgAgents = await deps.repos.agent.list(orgOf(req))
        const orgAgentIds = orgAgents.map((agent) => agent.id)
        const agentNames = new Map(orgAgents.map((agent) => [agent.id, agentDisplayName(agent)]))
        const requested = requestedAgentIds(req.query)
        if (requested.some((id) => !new Set<string>(orgAgentIds).has(id))) {
          return { agents: [], agentNames: {}, integrations: [], channels: [], triggers: [] }
        }
        const { codeHostHookIds, repoHookIds } = await codeHostHookFilters(deps, orgOf(req), req.query, true)
        // A multi-agent request narrows to the qualifying CONVERSATIONS and then
        // reads facets off every member row the caller can see, rather than only
        // the selected agents' rows: a facet answers "what else can I narrow by",
        // and a conversation's channel is the same whichever member you read.
        const query = {
          agentIds: orgAgentIds,
          ...(requested.length === 1 ? { agentId: AgentId(requested[0]!) } : {}),
          ...(requested.length > 1 ? { conversationAgentIds: requested.map(AgentId) } : {}),
          ...(req.query.platform ? { platform: req.query.platform } : {}),
          ...(req.query.integration ? { integration: req.query.integration } : {}),
          ...(req.query.channel ? { channel: req.query.channel } : {}),
          ...(req.query.triggeredBy ? { triggeredBy: req.query.triggeredBy } : {}),
          codeHostHookIds,
          ...(repoHookIds ? { hookTriggerIds: repoHookIds } : {})
        }
        // Each facet drops its own active filter, so its external-audience
        // snapshot must span the same org-agent superset.
        const { viewer } = await viewerForQuery(req, { agentIds: orgAgentIds.map(AgentId) })
        const index = await deps.repos.session.listFacets({ ...query, viewer })
        const metadataRows = [...index.integrations, ...index.channels, ...index.triggers]
        const [hookMetadata, channelNames] = await Promise.all([
          hookMetadataForSessions(deps, metadataRows, orgOf(req)),
          channelNamesForSessions(deps, metadataRows, orgOf(req))
        ])
        return sessionFacets(index, hookMetadata, agentNames, channelNames)
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

        // Agent Team visibility does not narrow Session reads. Agent names are a
        // session-scoped display projection only; the Agent endpoints remain
        // resource-gated, so a hidden owner still has no Agent/Workspace link.
        const orgAgents = await deps.repos.agent.list(orgOf(req))
        const orgAgentIds = orgAgents.map((agent) => agent.id)
        const orgAgentIdSet = new Set<string>(orgAgentIds)
        const agentNames = new Map(orgAgents.map((agent) => [agent.id, agentDisplayName(agent)]))
        // Every requested id must still name an Agent in this org. Unknown and
        // cross-org ids make the whole answer empty rather than being dropped.
        const requested = requestedAgentIds(req.query)
        const selectedAgentIds =
          requested.length > 0
            ? requested.every((id) => orgAgentIdSet.has(id))
              ? requested.map(AgentId)
              : []
            : orgAgentIds
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

        // Each code host is a semantic subtype of hook sessions. Resolve definitions
        // only when integration classification or a repository-wide trigger filter needs them.
        const { codeHostHookIds, repoHookIds } = await codeHostHookFilters(deps, orgOf(req), req.query, false)
        // Two or more selected agents ask for the threads they SHARE. The rows stay
        // scoped to those agents (`agentIds`), so `?agentId=a` keeps returning
        // exactly what it always did. Every branch below reads this one binding —
        // a path that took `agentIds` alone would silently answer the wider
        // "either agent" question under the same query string.
        const conversationAgentIds = requested.length > 1 ? selectedAgentIds : undefined
        // Membership is read over everything the caller may see, so a grouped row
        // still names the participants an agent filter kept out of its `sessions`.
        // It reaches the query before the viewer is resolved, because the scopes
        // that authorize those extra members have to be resolved with it.
        const memberAgentIds = requested.length > 0 ? orgAgentIds : undefined
        const query = {
          agentIds: selectedAgentIds,
          ...(conversationAgentIds ? { conversationAgentIds } : {}),
          ...(memberAgentIds ? { memberAgentIds } : {}),
          ...(req.query.platform ? { platform: req.query.platform } : {}),
          ...(req.query.integration ? { integration: req.query.integration } : {}),
          ...(req.query.channel ? { channel: req.query.channel } : {}),
          ...(req.query.triggeredBy ? { triggeredBy: req.query.triggeredBy } : {}),
          ...(Object.keys(codeHostHookIds).length > 0 ? { codeHostHookIds } : {}),
          ...(repoHookIds ? { hookTriggerIds: repoHookIds } : {}),
          ...(cursor ? { cursor } : {}),
          limit: req.query.limit,
          includeTotal: !cursor
        }
        const { viewer, access } = await viewerForQuery(req, query)

        // §5.2 key-addressed resolver: a bounded metadata-only member lookup for
        // a direct conversation load — the paginated list is not a key lookup.
        if (conversationKey) {
          // Resolved over the MEMBERSHIP agents and split here, so the key form
          // reports the same membership the grouped page does — the two must not
          // disagree about who took part just because one of them was addressed
          // by key. The participant arm still rides along: addressing a
          // conversation by key must not widen the same repeated `agentId` into an
          // `IN` filter, or a key that holds A but not B would answer with A's
          // members when the caller asked for a conversation the two of them share.
          const members = await deps.repos.session.listConversationMembers(
            { agentIds: memberAgentIds ?? selectedAgentIds, conversationAgentIds, viewer },
            conversationKey
          )
          const selected = new Set<string>(selectedAgentIds)
          const rows = members.filter((session) => selected.has(session.agentId))
          const [hookMetadata, channelNames] = await Promise.all([
            hookMetadataForSessions(deps, rows, orgOf(req)),
            channelNamesForSessions(deps, rows, orgOf(req))
          ])
          return {
            conversations:
              rows.length > 0
                ? [
                    {
                      key: encodeConversationKey(conversationKey),
                      platform: conversationKey.platform,
                      channel: conversationKey.channel,
                      thread: conversationKey.thread,
                      sessions: rows.map((session) => sessionDto(session, hookMetadata, agentNames, channelNames)),
                      memberSessionIds: members.map((session) => session.id)
                    }
                  ]
                : [],
            total: rows.length > 0 ? 1 : 0,
            nextCursor: null,
            accessSyncDegraded: access.degraded,
            accessIssues: access.accessIssues
          }
        }

        if (!grouped) {
          const page = await deps.repos.session.listPage({ ...query, viewer })
          const [hookMetadata, channelNames] = await Promise.all([
            hookMetadataForSessions(deps, page.sessions, orgOf(req)),
            channelNamesForSessions(deps, page.sessions, orgOf(req))
          ])
          const nextCursor = page.hasMore ? encodeSessionCursor(page.sessions[page.sessions.length - 1]!) : null
          return {
            sessions: page.sessions.map((session) => sessionDto(session, hookMetadata, agentNames, channelNames)),
            total: page.total,
            nextCursor,
            accessSyncDegraded: access.degraded,
            accessIssues: access.accessIssues,
            ...(orgHasSessions !== undefined ? { orgHasSessions } : {})
          }
        }

        const page = await deps.repos.session.listConversationPage({ ...query, viewer })
        const allRows = page.conversations.flatMap((c) => c.sessions)
        const [hookMetadata, channelNames] = await Promise.all([
          hookMetadataForSessions(deps, allRows, orgOf(req)),
          channelNamesForSessions(deps, allRows, orgOf(req))
        ])
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
            sessions: c.sessions.map((session) => sessionDto(session, hookMetadata, agentNames, channelNames)),
            memberSessionIds: c.memberSessionIds
          })),
          total: page.total,
          nextCursor,
          accessSyncDegraded: access.degraded,
          accessIssues: access.accessIssues,
          ...(orgHasSessions !== undefined ? { orgHasSessions } : {})
        }
      }
    )

    // Deep-link detail (…/sessions/:id): served from CP-stored SessionMeta (synced
    // via the `event/session` EVT), so the page resolves even when the daemon is
    // offline. Metadata only — the transcript stays a `/messages` daemon pull.
    // 404 for an unknown session OR one outside the Session's own audience.
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
        // Relationships may cross agents (and daemons). Enumerate Agents only to
        // keep the metadata query org-scoped and to project display names; each
        // linked Session is independently filtered by its own audience below.
        const orgAgents = await deps.repos.agent.list(orgOf(req))
        const orgAgentIds = orgAgents.map((agent) => agent.id)
        const orgAgentIdSet = new Set<string>(orgAgentIds)
        const agentNames = new Map(orgAgents.map((agent) => [agent.id, agentDisplayName(agent)]))
        const ctx = ctxOf(req)
        const [parent, children, siblingCandidates, usage, webchatRoster, hookMetadata, channelNames] =
          await Promise.all([
            s.parentSessionId ? deps.repos.session.get(orgOf(req), s.parentSessionId) : Promise.resolve(null),
            deps.repos.session.listChildren(SessionId(s.id), orgAgentIds),
            s.parentSessionId ? deps.repos.session.listChildren(s.parentSessionId, orgAgentIds) : Promise.resolve([]),
            deps.repos.sessionUsage.get(s.agentId, s.id),
            // A webchat session's channel IS its conversation id; the roster feeds
            // the adopted-session composer/header, which has no relay socket.
            s.platform === 'webchat' && s.channel
              ? deps.repos.webchatConversation.participants(orgOf(req), s.channel)
              : Promise.resolve([]),
            hookMetadataForSessions(deps, [s], orgOf(req)),
            channelNamesForSessions(deps, [s], orgOf(req))
          ])
        const hook = hookMetadataForSession(hookMetadata, s)
        const display = sessionDisplayMetadata(s, hook, channelNames)
        // Continuation gate (webchat-cross-integration-continuation.md §6.5):
        // the same predicate + state checks the mint route applies, projected as
        // one server-computed flag + bounded product-language reason.
        const continuationUnavailableReason = await (async () => {
          const owningAgent = orgAgents.find((agent) => agent.id === s.agentId)
          if (
            !owningAgent ||
            !canView(owningAgent, ctx) ||
            !canContinueSession(s, ctx, access.identitySet, access.externalAccess)
          ) {
            return 'unauthorized' as const
          }
          if (s.contentPurgedAt) return 'content_purged' as const
          if (!continuableOrigin(s.platform ?? '')) return 'unsupported_platform' as const
          const host = await resolveContinuationHost(deps, s, owningAgent)
          return host.ok ? null : host.reason
        })()
        const siblings = siblingCandidates.filter((candidate) => candidate.id !== s.id)
        const related = [...(parent ? [parent] : []), ...siblings, ...children]
        const relatedAccess = await sessionAccess.forSessions(req, related)
        const parentVisible =
          parent !== null &&
          orgAgentIdSet.has(parent.agentId) &&
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
        const accessIssues = [
          ...new Map(
            [...access.accessIssues, ...relatedAccess.accessIssues].map((issue) => [
              `${issue.provider}:${issue.region ?? ''}:${issue.reason}`,
              issue
            ])
          ).values()
        ]
        return {
          id: s.id,
          parentSession: parentVisible ? sessionRelation(parent, agentNames) : null,
          siblingSessions: visibleSiblings.map((session) => sessionRelation(session, agentNames)),
          childSessions: visibleChildren.map((session) => sessionRelation(session, agentNames)),
          agentId: s.agentId,
          agentName: agentNames.get(s.agentId) ?? null,
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
          hookKind: sessionHookKind(s, hook),
          channelName: display.channelName,
          triggeredByName: display.triggeredByName,
          threadUrl: s.threadUrl,
          tenantScope: s.tenantScope ?? null,
          participants:
            webchatRoster.length > 1
              ? webchatRoster.map((p) => ({
                  agentId: p.agentId,
                  name: agentNames.get(p.agentId) ?? null,
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
          contentSetId: s.contentSetId ?? null,
          workspaceIsolation: s.workspaceIsolation,
          activityState: s.activityState,
          visibility: s.visibility,
          externalProvider: s.externalProvider,
          externalResolution: s.externalResolution,
          feishuRegion: feishuRegionForSession(s, access.externalScopes),
          // The §5.1 cutover state: CP read gates apply at commit, but the memory
          // boundary only takes effect once every affected daemon has acked.
          visibilityState: await visibilityStateOf(deps.visibilityPush, deps.repos, [s.id]),
          canChangeVisibility: canChangeSessionVisibility(s, ctx, access.identitySet),
          canContinue: continuationUnavailableReason === null,
          continuationUnavailableReason,
          accessSyncDegraded: access.degraded || relatedAccess.degraded,
          accessIssues,
          contentPurgedAt: s.contentPurgedAt ? s.contentPurgedAt.toISOString() : null,
          contentPurgedReason: s.contentPurgedReason ?? null,
          startedAt: s.startedAt.toISOString(),
          endedAt: s.endedAt ? s.endedAt.toISOString() : null
        }
      }
    )

    // Replay view: proxy a page of the session's chat history live from a daemon that can
    // serve it. CP stores list/detail metadata only, not transcript bodies. The recorded daemon
    // is tried first; only a session written to a shared store has other daemons holding the
    // same rows, and an agent move never changes which store that was.
    r.get(
      '/sessions/:id/messages',
      {
        schema: {
          tags: [Tag.Sessions],
          summary: 'Get session messages',
          description:
            "Proxies a page of the session's chat history live from a daemon holding it — the recording daemon, or a member of the shared store it was written to; 503 when none is reachable.",
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
        const { session } = owned
        // Retention GC (#485): the daemon deleted this session's local content, so
        // there is provably nothing to proxy. Answer the empty page directly rather
        // than round-tripping to a daemon that would return the same thing — and
        // rather than 503-ing when its daemon happens to be offline, which would
        // read as "try again later" for a transcript that is never coming back. The
        // console keys its explanation off `contentPurgedAt`, not off this page.
        if (session.contentPurgedAt) {
          return { sessionId: session.id, messages: [], nextCursor: null, liveCursor: null, liveMore: false }
        }
        const read = await readSessionContent(req, session, (daemonId) =>
          deps.control.sessionHistory(daemonId, session.orgId, {
            agentId: session.agentId,
            sessionId: session.id,
            ...(req.query.cursor !== undefined ? { cursor: req.query.cursor } : {}),
            ...(req.query.after !== undefined ? { after: req.query.after } : {}),
            limit: req.query.limit ?? 50
          })
        )
        if (!read.ok) return reply.code(503).send(contentUnavailable(read.reason))
        // Provider membership and identity can be revoked while the daemon is
        // answering. Re-run the complete predicate before any body leaves CP.
        if (!(await getOrgViewableSession(req, req.params.id))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'session not found' })
        }
        const page = read.value
        return {
          sessionId: page.sessionId,
          messages: page.messages,
          nextCursor: page.nextCursor ?? null,
          liveCursor: page.liveCursor ?? null,
          liveMore: page.liveMore ?? false
        }
      }
    )

    // Full-body view resolves the same content readers as history. The console pages by
    // offset until nextOffset is null. 503 when no reader is reachable.
    r.get(
      '/sessions/:id/tool-body',
      {
        schema: {
          tags: [Tag.Sessions],
          summary: 'Get a tool-call body',
          description:
            "Proxies one byte slice of a tool call's untruncated ToolBody JSON live from a daemon holding the session; the console pages by offset until nextOffset is null. 503 when none is reachable.",
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
        const { session } = owned
        const read = await readSessionContent(req, session, (daemonId) =>
          deps.control.sessionToolBody(daemonId, session.orgId, {
            agentId: session.agentId,
            sessionId: session.id,
            toolCallId: req.query.toolCallId,
            offset: req.query.offset ?? 0
          })
        )
        if (!read.ok) return reply.code(503).send(contentUnavailable(read.reason))
        if (!(await getOrgViewableSession(req, req.params.id))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'session not found' })
        }
        const chunk = read.value
        return {
          sessionId: chunk.sessionId,
          toolCallId: chunk.toolCallId,
          data: chunk.data,
          totalBytes: chunk.totalBytes,
          nextOffset: chunk.nextOffset ?? null
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
          orgOf(req),
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

    // §12.6's second identity source, shared by the PR read and the auto-merge write: the pull request
    // this session's OWN head branch has, for a session no pull-request run owns — plus the agent whose
    // grant those writes ride, which for a branch link is the session's own agent rather than a run's.
    const branchPullRequestLink = async (req: FastifyRequest, session: SessionMetaRecord, force: boolean) => {
      const links = deps.sessionPullRequestLink
      if (!links) return null
      const agent = await deps.repos.agent.get(orgOf(req), session.agentId)
      if (!agent) return null
      const link = await links.resolve(agent, session, force)
      return link ? { ...link, agent } : null
    }

    // The write arms' identity, in the GET's order: the owning run's PR, else the branch link — plus the
    // agent whose grant the write rides (the RUN's agent for a run link, the SESSION's for a branch link).
    const pullRequestWriteLink = async (req: FastifyRequest, session: SessionMetaRecord) => {
      const run = await deps.repos.hook.latestPullRequestRunForSession(orgOf(req), session.id)
      if (run?.pullNumber && run.repoId && run.repoFullName && run.sourceInstallationId) {
        return {
          repoId: run.repoId,
          repoFullName: run.repoFullName,
          pullNumber: run.pullNumber,
          installationId: run.sourceInstallationId,
          agent: run.agentId ? await deps.repos.agent.get(orgOf(req), AgentId(run.agentId)) : null
        }
      }
      return branchPullRequestLink(req, session, false)
    }

    /**
     * Ask the edge what its merge-when-ready watcher holds for this pull request.
     *
     * A live read on every panel poll, because the armed set is in memory at the edge and there is
     * no row anywhere to read instead — that is the design, not a gap: a sandbox that was reclaimed
     * or a daemon that restarted is genuinely no longer watching, and the box must go back to
     * unchecked. null (not `false`) whenever nobody could be asked, so the panel can say "unknown"
     * rather than assert a state it never heard.
     */
    const autoMergeOverlay = async (
      req: FastifyRequest,
      agent: { id: AgentId; daemonId: string | null } | null,
      repoFullName: string,
      pullNumber: number
    ): Promise<AutoMergeOverlay | null> => {
      if (!agent?.daemonId) return null
      const daemon = await deps.registry.getAvailable(orgOf(req), DaemonId(agent.daemonId))
      if (!daemon?.capabilities.features.includes(AUTO_MERGE_FEATURE)) return null
      try {
        const state = await deps.control.autoMergeState(agent.daemonId, orgOf(req), {
          agentId: agent.id,
          repoFullName,
          prNumber: pullNumber
        })
        return {
          armed: state.armed,
          ...(state.placement ? { placement: state.placement } : {}),
          ...(state.waitingOn ? { waitingOn: state.waitingOn } : {}),
          ...(state.lastError ? { lastError: state.lastError } : {})
        }
      } catch {
        // An offline or refusing daemon costs the panel its toggle state and nothing else — the
        // whole pull request read must not fail over a control's decoration.
        return null
      }
    }

    // The session's PR (§3.4): identity from the owning run — or, with no run, from the session
    // worktree's own head branch (§12.6) — and live state from GitHub; a GitHub failure is DATA
    // (`degraded`), and only a session neither source can name a PR for 404s (hides the tab).
    r.get(
      '/sessions/:id/pull-request',
      {
        schema: {
          tags: [Tag.Sessions],
          summary: 'Get the session’s pull request',
          description:
            'This session’s pull request: identity (repo, number, url, head/base) plus live state (checks, current reviews, unresolved review threads) proxied from GitHub in one GraphQL read. Identity comes from the owning hook run where one exists (`linkedBy: run`, which also carries the review facts a rate-limited answer falls back on); otherwise from the head branch of the checkout this session works in (`linkedBy: head-branch`, `linkBranch`, `linkScope`), so a pull request the agent opened mid-conversation is linked too — `linkScope: shared` means the branch came from the agent’s primary checkout, which every session on a shared-workspace agent works in, so the pull request is real but not exclusively this session’s; `linkAmbiguous` says the branch has more than one open pull request and this is the first of them. GitHub being rate limited, denying the installation, or unreachable is data — `degraded` names which, identity survives, and the live lists are empty — because a panel that still names its PR beats an empty one. 404 when neither source names a pull request (no run and no pull request for that branch, a purged session, a workspace that is not a checkout, no daemon serving the agent) or when the deployment has no GitHub App configured; the console then draws its branch state and a create action instead. Review thread bodies are user content: proxied, never stored.',
          operationId: 'getSessionPullRequest',
          params: IdParam,
          querystring: SessionPullRequestQueryDto,
          response: { 200: SessionPullRequestDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const absent = () =>
          reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'pull request not found' })
        // Session audience first: thread bodies are content, unreadable for a session the caller cannot open.
        const owned = await getOrgViewableSession(req, req.params.id)
        if (!owned) return absent()
        const view = deps.pullRequestView
        if (!view) return absent()
        const run = await deps.repos.hook.latestPullRequestRunForSession(orgOf(req), owned.session.id)
        // No run, or a legacy row that predates repo/installation capture (nothing to mint against):
        // fall back to the branch. A PR the agent opened from a conversation creates no HookRun at all,
        // which is the whole reason this arm exists — the run stays the PREFERRED source, because it
        // also carries the review facts (subject, draft, recorded review) a branch lookup cannot know.
        if (!run?.pullNumber || !run.repoId || !run.repoFullName || !run.sourceInstallationId) {
          const link = await branchPullRequestLink(req, owned.session, req.query.refresh === true)
          if (!link) return absent()
          const canArmBranch = deps.github
            ? await deps.github.canArmAutoMerge(link.agent, link.repoId, link.repoFullName)
            : false
          return toSessionPullRequestDto(
            await view.view(
              {
                orgId: orgOf(req),
                installationId: link.installationId,
                repoId: link.repoId,
                repoFullName: link.repoFullName,
                pullNumber: link.pullNumber
              },
              req.query.refresh === true
            ),
            canArmBranch,
            await autoMergeOverlay(req, link.agent, link.repoFullName, link.pullNumber),
            {
              linkedBy: 'head-branch',
              linkBranch: link.branch,
              linkScope: link.scope,
              linkAmbiguous: link.ambiguous
            }
          )
        }
        // The subject's own open/draft facts feed the degraded arm, so a rate-limited panel still names them.
        const subject = run.projectionId
          ? (await deps.repos.hook.listReviewSubjects(run.projectionId)).find((s) => s.pullNumber === run.pullNumber)
          : undefined
        // The caller's write capability, Postgres-only: per-run like the overlay facts, so never cached.
        const agent = run.agentId ? await deps.repos.agent.get(orgOf(req), AgentId(run.agentId)) : null
        const canArm =
          agent && deps.github ? await deps.github.canArmAutoMerge(agent, run.repoId, run.repoFullName) : false
        return toSessionPullRequestDto(
          await view.view(
            {
              orgId: orgOf(req),
              installationId: run.sourceInstallationId,
              repoId: run.repoId,
              repoFullName: run.repoFullName,
              pullNumber: run.pullNumber,
              ...(subject ? { knownIsOpen: subject.isOpen } : {}),
              ...(run.isDraft !== null ? { knownIsDraft: run.isDraft } : {}),
              ...(agentReviewOf(run.reviewEvent) ? { knownAgentReview: agentReviewOf(run.reviewEvent)! } : {})
            },
            req.query.refresh === true
          ),
          canArm,
          await autoMergeOverlay(req, agent, run.repoFullName, run.pullNumber)
        )
      }
    )

    // ── POST /sessions/:id/pull-request/auto-merge ───────────────────────────
    // The M6 write: arm/disarm GitHub auto-merge under the owning agent's clamped grant. The token is
    // minted per call and never stored; the view cache is dropped so the next read shows the new state.
    r.post(
      '/sessions/:id/pull-request/auto-merge',
      {
        schema: {
          tags: [Tag.Sessions],
          summary: 'Arm or disarm auto-merge on the session’s pull request',
          description:
            'Arms or disarms merge-when-ready (squash) for this session’s pull request. The watcher runs at the EDGE — in the agent’s sandbox when its work runs in a pod, otherwise in the owning daemon’s process — and polls GitHub until the pull request is open, undrafted, conflict-free, with no failing or running check and no requested changes, then squash-merges the head it judged. It is deliberately NOT GitHub’s own auto-merge: `enablePullRequestAutoMerge` refuses every pull request that is not BLOCKED, so on a repository without required status checks it can never be armed at all. Nothing is persisted: the armed set is in memory at the edge, so a reclaimed sandbox or a restarted daemon forgets it and the box reads back unchecked. Arming needs the owning agent’s clamped grant to carry `pull_requests: write`, so a read- or comment-tier agent is refused (403); idempotent — asking for the state it is already in returns that state. 404 mirrors the GET. 409 with a `code` for every refusal the edge names: `AUTO_MERGE_SANDBOX_ASLEEP` (a cluster agent whose pod is down — its watcher belongs in that pod, so start the sandbox first), `AUTO_MERGE_ALREADY_MERGEABLE` (the pull request can be merged now, and arming would merge it on the first tick with no confirmation — use the Merge route, which the console confirms), `AUTO_MERGE_UNSUPPORTED_IMAGE` (a sandbox from an image predating the watcher — resume it), `DAEMON_FEATURE_MISSING`, `NO_DAEMON`. 503 when the daemon is unreachable.',
          operationId: 'setSessionPullRequestAutoMerge',
          params: IdParam,
          body: SessionPullRequestAutoMergeBodyDto,
          response: {
            200: SessionPullRequestAutoMergeDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const absent = () =>
          reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'pull request not found' })
        const owned = await getOrgViewableSession(req, req.params.id)
        if (!owned) return absent()
        const github = deps.github
        if (!github) return absent()
        const linked = await pullRequestWriteLink(req, owned.session)
        if (!linked) return absent()
        const agent = linked.agent
        if (!agent) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', statusCode: 403, message: 'the owning agent no longer exists' })
        }
        // The capability gate is unchanged even though the CP performs no mutation here: the edge
        // merges under this same clamped grant, so a read- or comment-tier agent must be refused at
        // the door rather than arming a watcher whose merge would be denied a minute later.
        if (!(await github.canArmAutoMerge(agent, linked.repoId, linked.repoFullName))) {
          return reply.code(403).send({
            error: 'Forbidden',
            statusCode: 403,
            message: 'the owning agent’s repository access is below write tier'
          })
        }
        if (!agent.daemonId) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'no daemon serves this agent', code: 'NO_DAEMON' })
        }
        const daemon = await deps.registry.getAvailable(orgOf(req), agent.daemonId)
        if (!daemon?.capabilities.features.includes(AUTO_MERGE_FEATURE)) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'this agent’s daemon does not serve merge-when-ready; upgrade its daemon',
            code: 'DAEMON_FEATURE_MISSING'
          })
        }
        try {
          const state = await deps.control.autoMergeSet(agent.daemonId, orgOf(req), {
            agentId: agent.id,
            repoFullName: linked.repoFullName,
            prNumber: linked.pullNumber,
            enabled: req.body.enabled
          })
          return {
            armed: state.armed,
            placement: state.placement ?? null,
            waitingOn: state.waitingOn ?? null,
            error: state.lastError ?? null
          }
        } catch (err) {
          const failure = autoMergeEdgeFailureOf(err)
          if (!failure) throw err
          return reply.code(failure.statusCode).send(failure)
        }
      }
    )

    // ── POST /sessions/:id/pull-request/merge ────────────────────────────────
    // The direct merge: the same identity and the same clamped write grant as auto-merge, but the
    // mutation is mergePullRequest — one press merges now rather than arming GitHub to merge later.
    r.post(
      '/sessions/:id/pull-request/merge',
      {
        schema: {
          tags: [Tag.Sessions],
          summary: 'Merge the session’s pull request',
          description:
            'Merges this session’s pull request (squash) — the same identity the GET resolves, from the owning run or the session branch — using an installation token clamped to the owning agent’s repository tier (the write requires `pull_requests: write`, so a read- or comment-tier agent is refused 403). Idempotent: an already-merged pull request succeeds without a mutation. 404 mirrors the GET; 409 relays GitHub declining the merge (not mergeable, checks failing); 429 is GitHub rate limiting; 502 is GitHub unreachable.',
          operationId: 'mergeSessionPullRequest',
          params: IdParam,
          response: {
            200: SessionPullRequestMergeDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            429: ErrorDto,
            502: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const absent = () =>
          reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'pull request not found' })
        const owned = await getOrgViewableSession(req, req.params.id)
        if (!owned) return absent()
        const view = deps.pullRequestView
        const github = deps.github
        if (!view || !github) return absent()
        const linked = await pullRequestWriteLink(req, owned.session)
        if (!linked) return absent()
        const agent = linked.agent
        if (!agent) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', statusCode: 403, message: 'the owning agent no longer exists' })
        }
        try {
          const cred = await github.mintAutoMergeForAgent(agent, linked.repoId, linked.repoFullName)
          // Pin the head the operator was shown: the projection is the same cached one the panel renders,
          // and a commit pushed after it lands makes GitHub refuse rather than merge an unreviewed revision.
          const projection = await view.view({
            orgId: orgOf(req),
            installationId: linked.installationId,
            repoId: linked.repoId,
            repoFullName: linked.repoFullName,
            pullNumber: linked.pullNumber
          })
          if (!projection.headOid) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'pull request head unavailable — refresh and retry'
            })
          }
          return await view.merge(
            { repoId: linked.repoId, repoFullName: linked.repoFullName, pullNumber: linked.pullNumber },
            cred.token,
            projection.headOid
          )
        } catch (err) {
          const failure = prWriteFailureOf(err)
          if (!failure) throw err
          return reply.code(failure.statusCode).send(failure)
        }
      }
    )

    // ── POST /sessions/:id/sandbox-keep-alive ────────────────────────────────
    // An open console page renewing its lease on the agent's pod. The CP relays and stores nothing:
    // the daemon decides whether to hold, and the lease lapses on its own once the page stops asking.
    r.post(
      '/sessions/:id/sandbox-keep-alive',
      {
        schema: {
          tags: [Tag.Sessions],
          summary: 'Hold this session’s sandbox while its page is open',
          description:
            'Renews an open console page’s lease on the agent’s sandbox pod, so the idle sweep does not suspend work the page is watching. The DAEMON decides whether to hold, from facts the console cannot assert: uncommitted files in this session’s worktree, or an armed merge-when-ready watcher — which for a cluster agent is a process inside that very pod, so a suspend would silently disarm it. The answer says which reasons applied and for how long the hold stands; the console renews inside that window while its document is visible, and the hold lapses within one TTL when the page closes, the tab goes to the background, or the machine sleeps. Nothing is persisted, there is nothing to release, and a suspended pod is never woken by this call (`asleep: true`). `placement: daemon` means the agent runs no sandbox at all, which is an answer rather than an error. 404 mirrors the session reads; 409 when no daemon serves the agent or it is too old to hold a lease; 503 when its daemon is unreachable.',
          operationId: 'keepSessionSandboxAlive',
          params: IdParam,
          response: { 200: SessionSandboxKeepAliveDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const absent = () => reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'session not found' })
        const owned = await getOrgViewableSession(req, req.params.id)
        if (!owned) return absent()
        const agent = await deps.repos.agent.get(orgOf(req), owned.session.agentId)
        if (!agent) return absent()
        if (!agent.daemonId) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'no daemon serves this agent', code: 'NO_DAEMON' })
        }
        const daemon = await deps.registry.getAvailable(orgOf(req), DaemonId(agent.daemonId))
        if (!daemon?.capabilities.features.includes(SANDBOX_KEEP_ALIVE_FEATURE)) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'this agent’s daemon does not hold sandboxes for an open page; upgrade its daemon',
            code: 'DAEMON_FEATURE_MISSING'
          })
        }
        try {
          const held = await deps.control.sandboxKeepAlive(agent.daemonId, orgOf(req), {
            agentId: agent.id,
            sessionId: owned.session.id
          })
          return {
            held: held.held,
            reasons: held.reasons,
            ttlMs: held.ttlMs ?? null,
            placement: held.placement ?? null,
            asleep: held.asleep === true
          }
        } catch (err) {
          const failure = autoMergeEdgeFailureOf(err)
          if (!failure) throw err
          return reply.code(failure.statusCode).send(failure)
        }
      }
    )
  }
}

// GitHub/clamp failures onto HTTP, as DATA: capability and installation denials are 403, rate limits
// 429, GitHub down 502 — and GitHub declining the write itself (clean status, not mergeable, closed PR)
// is a 409, not a 5xx. Null means "not ours" and the caller rethrows.
/**
 * A merge-when-ready failure at the EDGE, as a status the console can act on.
 *
 * `unsupported-image` is a 409 rather than a 503: the daemon answered, and the answer is that this
 * agent's runtime image predates the in-sandbox watcher — a resume onto the current image fixes it,
 * where "try again later" would be a lie. An unknown agent is a stale placement (409 too: the
 * console's own read will re-resolve it), and an offline or refusing daemon is a 503.
 */
function autoMergeEdgeFailureOf(
  err: unknown
): { error: string; statusCode: 409 | 503; message: string; code?: string } | null {
  if (err instanceof ProtocolError && err.code === 'BAD_PAYLOAD') {
    const reason = AutoMergeErrorReason.safeParse(err.details?.reason)
    if (reason.success) {
      return {
        error: 'Conflict',
        statusCode: 409,
        message: err.message,
        code: `AUTO_MERGE_${reason.data.toUpperCase().replaceAll('-', '_')}`
      }
    }
  }
  if (err instanceof NoConnection || (err instanceof Error && err.message === 'connection closed')) {
    return { error: 'Service Unavailable', statusCode: 503, message: 'owning daemon is offline' }
  }
  if (err instanceof ProtocolError) {
    return { error: 'Service Unavailable', statusCode: 503, message: `daemon rejected the request: ${err.message}` }
  }
  return null
}

function prWriteFailureOf(err: unknown): { error: string; statusCode: 403 | 409 | 429 | 502; message: string } | null {
  const failure = (statusCode: 403 | 409 | 429 | 502, error: string) => ({
    error,
    statusCode,
    message: err instanceof Error ? err.message : String(err)
  })
  if (err instanceof GitCredDeniedError) {
    return err.code === 'RATE_LIMITED' ? failure(429, 'Too Many Requests') : failure(403, 'Forbidden')
  }
  if (err instanceof GithubApiError) {
    if (err.code === 'RATE_LIMITED') return failure(429, 'Too Many Requests')
    if (err.code === 'LEASE_DENIED') return failure(403, 'Forbidden')
    if (err.status === 0 || err.status >= 500) return failure(502, 'Bad Gateway')
    return failure(409, 'Conflict')
  }
  return null
}
