/**
 * `http/routes/agents.ts` (design §2.1) — CRUD for agent definitions through the
 * C6 `AgentRepo`. The CP mints the agent UUID (the wire id used across
 * `route/*`, `agent/*`, `event/session`). Scoped to the caller's org (the
 * devAuth/OIDC principal). Placement/launch happen over the WS edge — not here.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  WorkspaceListPage,
  WorkspaceReadContent,
  WorkspaceGitStatus,
  WorkspaceGitPullResult,
  MemoryReadContent,
  MemoryListPage,
  MemorySurfaceInfo,
  MemoryRecordListPage,
  MemoryRecordSearchPage,
  MemoryRecordGetResult,
  MemoryRecordCreateResult,
  MemoryRecordUpdateResult,
  MemoryRecordDeleteResult,
  MemoryRecordHistoryPage,
  DreamInfo,
  DreamListPage,
  DreamFilesPage,
  DreamFileReadContent
} from '@agentconnect.md/protocol'
import { MAX_WORKSPACE_EDIT_BYTES, gitRepoLabel, normalizeGitUrl } from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { type AgentRecord, type AgentWorkspace, isSyntheticEmail } from '../../persistence/ports.js'
import type { DaemonView } from '../../ports.js'
import { AgentId, DaemonId, type OrgId } from '../../domain/ids.js'
import { mcpProxyDef, relayHttpOrigin } from '../../orchestrator/mcpProvider.js'
import { memoryConnectionSpec, stdioMemoryConnectionSpec } from '../../orchestrator/memoryConnection.js'
import { orgOf, denyViewerWrite, ctxOf } from '../rbac.js'
import { canView, canEdit, canManageSharing, type ViewCtx } from '../visibility.js'
import { resolveShareSet } from '../sharing.js'
import { resolveAgentIconUrl, type IconUrlBases } from '../../agents/agent-icon.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { AgentMoveConflict, AgentMoveFailed, AgentMoveService } from '../../orchestrator/agentMove.js'
import { ProtocolError } from '../../domain/errors.js'
import { AGENT_WORKSPACE_INTEGRATION_CONFLICT_MESSAGE } from '../../persistence/errors.js'
import {
  CreateAgentBody,
  SetAgentWorkspaceBody,
  UpdateAgentBody,
  SetAgentDaemonBody,
  SetSharingBody,
  SetAgentCallPolicyBody,
  AgentDto,
  AgentPermissionRequestPageDto,
  AgentPermissionDecisionBody,
  AgentCreatedDto,
  AgentListDto,
  ErrorDto,
  IdParam,
  WorkspaceFilesQueryDto,
  WorkspaceFilesDto,
  WorkspaceFileQueryDto,
  WorkspaceFileDto,
  PutWorkspaceFileQueryDto,
  PutWorkspaceFileBody,
  WorkspaceFileWriteDto,
  WorkspaceGitStatusDto,
  WorkspaceGitPullDto,
  AgentMemoryDto,
  MemoryFilesDto,
  MemoryFileQueryDto,
  PutMemoryFileQueryDto,
  PutAgentMemoryBody,
  AgentMemoryWriteDto,
  MemorySurfaceDto,
  MemoryRecordPageDto,
  MemoryRecordResultDto,
  MemoryRecordGetResultDto,
  MemoryRecordDeleteResultDto,
  MemoryRecordHistoryPageDto,
  MemoryRecordSearchBodyDto,
  MemoryRecordPageQueryDto,
  MemoryRecordParamDto,
  CreateMemoryRecordBody,
  UpdateMemoryRecordBody,
  DeleteMemoryRecordBody,
  DreamDto,
  DreamListDto,
  DreamFilesDto,
  DreamFileDto,
  DreamIdParam,
  StartDreamBody,
  AdoptDreamBody,
  type AgentDtoT,
  type WorkspaceFilesDtoT,
  type WorkspaceFileDtoT,
  type WorkspaceGitStatusDtoT,
  type WorkspaceGitPullDtoT,
  type AgentMemoryDtoT,
  type MemoryFilesDtoT,
  type MemorySurfaceDtoT,
  type MemoryRecordPageDtoT,
  type MemoryRecordResultDtoT,
  type MemoryRecordGetResultDtoT,
  type MemoryRecordDeleteResultDtoT,
  type MemoryRecordHistoryPageDtoT,
  type DreamDtoT,
  type DreamListDtoT,
  type DreamFilesDtoT,
  type DreamFileDtoT
} from '../dto/index.js'
import { provisionDaemonConnect } from '../onboarding.js'
import { Tag } from '../plugins/openapi.js'
import { GithubApiError } from '../../github/api.js'
import { LogtoApiError } from '../../github/logto-identity.js'
import { UserAuthzDeniedError } from '../../github/user-authz.js'

/** Public bases for resolving an agent's `image` icon URL (cp/store). */
function iconBasesOf(deps: HttpDeps): IconUrlBases {
  return {
    ...(deps.config.PUBLIC_CP_URL ? { cp: deps.config.PUBLIC_CP_URL } : {}),
    ...(deps.config.S3_PUBLIC_BASE_URL ? { store: deps.config.S3_PUBLIC_BASE_URL } : {})
  }
}

interface SandboxPolicy {
  supported: boolean
  required: boolean
}

const UNAVAILABLE_SANDBOX: SandboxPolicy = { supported: false, required: false }

function sandboxPolicyOf(daemon: DaemonView | null): SandboxPolicy {
  if (!daemon) return UNAVAILABLE_SANDBOX
  const required = daemon.capabilities.features.includes('sandbox-required')
  return {
    supported: required || daemon.capabilities.features.includes('sandbox'),
    required
  }
}

/** Version-skew gate for memory dreaming. A daemon that predates the feature
 *  omits it, and the CP must NOT forward `memory/dream/*` to it: that daemon
 *  silently ignores unknown frames, so the request would hang until it times
 *  out and surface as a misleading 503. Gating here fails fast with a clear
 *  message, and the DTO projection lets the console hide the panel outright. */
const DREAMING_FEATURE = 'memory-dreaming-v1'

function dreamingSupportedOn(daemon: DaemonView | null): boolean {
  return !!daemon?.capabilities.features.includes(DREAMING_FEATURE)
}

function toDto(
  a: AgentRecord,
  ctx: ViewCtx,
  secretKeys: string[],
  hookKinds: AgentDtoT['hookKinds'],
  iconBases: IconUrlBases,
  sandboxPolicy: SandboxPolicy
): AgentDtoT {
  return {
    id: a.id,
    orgId: a.orgId,
    name: a.name,
    displayName: a.displayName,
    icon: a.icon,
    // Only `image` icons resolve to a URL (the object-store public URL); glyph/runtime
    // render locally in the console, so null there. Cache-busted by lastModified.
    iconUrl: a.icon?.kind === 'image' ? resolveAgentIconUrl(a.id, a.icon, iconBases, a.lastModifiedAt.getTime()) : null,
    description: a.description,
    runtime: a.runtime,
    model: a.model,
    reasoningEffort: a.reasoningEffort,
    outputMode: a.outputMode,
    showFooter: a.showFooter,
    fastMode: a.fastMode,
    permissionMode: a.permissionMode,
    allowRuntimeChangesInChat: a.allowRuntimeChangesInChat,
    pause: a.pause,
    env: a.env,
    // Only the secret NAMES leave the CP (AgentSecretStore.keys — values are
    // write-only and never on the record). Sorted for a stable DTO.
    secretKeys: [...secretKeys].sort(),
    mcpServers: a.mcpServers,
    skills: a.skills,
    memory: a.memory,
    status: a.status,
    daemonId: a.daemonId,
    workspace: a.workspace,
    workspaceRepoId: a.workspaceRepoId?.toString() ?? null,
    capabilities: a.capabilities,
    createdAt: a.createdAt.toISOString(),
    // The creator's userId — the stable identity the web resolves to a display name (or
    // "You" for the viewer), unified with how session senders are labeled. A synthesized
    // placeholder email (`<sub>@oidc.local`, when no real user is known) means a non-human
    // creator, so surface null → the console shows "—" instead.
    createdBy: a.createdBy && !isSyntheticEmail(a.createdBy.email) ? a.createdBy.userId : null,
    lastModifiedAt: a.lastModifiedAt.toISOString(),
    lastModifiedBy: a.lastModifiedBy && !isSyntheticEmail(a.lastModifiedBy.email) ? a.lastModifiedBy.userId : null,
    visibility: a.visibility,
    sharedWith: a.sharedWith,
    canManageSharing: canManageSharing(a, ctx),
    callPolicy: a.callPolicy,
    allowedCallerAgentIds: a.allowedCallerAgentIds,
    outboundPolicy: a.outboundPolicy,
    allowedTargetAgentIds: a.allowedTargetAgentIds,
    introduceOnJoin: a.introduceOnJoin,
    restrictFileAccess: a.restrictFileAccess,
    sandboxSupported: sandboxPolicy.supported,
    sandboxRequired: sandboxPolicy.required,
    hookKinds
  }
}

/** #642: sandbox capability and daemon-wide policy for the agent's placement.
 * Unplaced or vanished daemons are unavailable. */
async function sandboxPolicyFor(deps: HttpDeps, a: AgentRecord): Promise<SandboxPolicy> {
  if (!a.daemonId) return UNAVAILABLE_SANDBOX
  return sandboxPolicyOf(await deps.registry.get(a.daemonId))
}

/** The dto's hook-kind marks for ONE agent (single-agent reads/writes). */
async function hookKindsOf(deps: HttpDeps, agentId: string): Promise<AgentDtoT['hookKinds']> {
  const hooks = await deps.repos.hook.listForAgent(AgentId(agentId))
  return [...new Set(hooks.filter((h) => h.enabled).map((h) => h.kind))]
}

/** Wire REP → HTTP body: null-coalesce optional fields (the zod response schema
 *  is enforced on serialization). Pure — exported for the unit test. */
export function toWorkspaceFilesDto(page: WorkspaceListPage): WorkspaceFilesDtoT {
  return {
    path: page.path,
    exists: page.exists,
    entries: page.entries.map((e) => ({
      name: e.name,
      type: e.type,
      size: e.size ?? null,
      mtime: e.mtime ?? null
    })),
    nextCursor: page.nextCursor ?? null
  }
}

/** Wire REP → HTTP body for one file slice (see {@link toWorkspaceFilesDto}). */
export function toWorkspaceFileDto(rep: WorkspaceReadContent): WorkspaceFileDtoT {
  return {
    path: rep.path,
    exists: rep.exists,
    size: rep.size ?? null,
    mtime: rep.mtime ?? null,
    encoding: rep.encoding ?? null,
    content: rep.content ?? null,
    offset: rep.offset ?? null,
    nextOffset: rep.nextOffset ?? null,
    truncated: rep.truncated ?? null
  }
}

/** Wire REP → HTTP body for a memory slice (see {@link toWorkspaceFileDto}). */
export function toAgentMemoryDto(rep: MemoryReadContent): AgentMemoryDtoT {
  return {
    path: rep.path,
    exists: rep.exists,
    size: rep.size ?? null,
    mtime: rep.mtime ?? null,
    content: rep.content ?? null,
    offset: rep.offset ?? null,
    nextOffset: rep.nextOffset ?? null,
    truncated: rep.truncated ?? null
  }
}

/** Wire REP → HTTP body for a memory-dir listing. */
export function toMemoryFilesDto(rep: MemoryListPage): MemoryFilesDtoT {
  return { exists: rep.exists, files: rep.entries }
}

/** Wire REP → HTTP body for one dream job's metadata (never staged bodies). */
export function toDreamDto(dream: DreamInfo): DreamDtoT {
  return {
    dreamId: dream.dreamId,
    agentId: dream.agentId,
    status: dream.status,
    trigger: dream.trigger,
    sessionIds: dream.sessionIds,
    snapshotDigest: dream.snapshotDigest,
    instructions: dream.instructions ?? null,
    skills: dream.skills ?? null,
    usage: dream.usage ?? null,
    error: dream.error ?? null,
    createdAt: dream.createdAt,
    endedAt: dream.endedAt ?? null
  }
}

export function toDreamListDto(rep: DreamListPage): DreamListDtoT {
  return { dreams: rep.dreams.map(toDreamDto) }
}

export function toDreamFilesDto(rep: DreamFilesPage): DreamFilesDtoT {
  return { exists: rep.exists, files: rep.entries }
}

export function toDreamFileDto(rep: DreamFileReadContent): DreamFileDtoT {
  return {
    path: rep.path,
    exists: rep.exists,
    size: rep.size ?? null,
    mtime: rep.mtime ?? null,
    content: rep.content ?? null,
    offset: rep.offset ?? null,
    nextOffset: rep.nextOffset ?? null,
    truncated: rep.truncated ?? null
  }
}

export function toMemorySurfaceDto(rep: MemorySurfaceInfo): MemorySurfaceDtoT {
  return { shape: rep.shape, capabilities: rep.capabilities }
}

export function toMemoryRecordPageDto(rep: MemoryRecordListPage | MemoryRecordSearchPage): MemoryRecordPageDtoT {
  return {
    records: rep.records,
    nextCursor: 'nextCursor' in rep ? (rep.nextCursor ?? null) : null
  }
}

export function toMemoryRecordResultDto(
  rep: MemoryRecordCreateResult | MemoryRecordUpdateResult
): MemoryRecordResultDtoT {
  return { record: rep.record }
}

export function toMemoryRecordGetResultDto(rep: MemoryRecordGetResult): MemoryRecordGetResultDtoT {
  return { record: rep.record }
}

export function toMemoryRecordDeleteResultDto(rep: MemoryRecordDeleteResult): MemoryRecordDeleteResultDtoT {
  return { id: rep.id, deleted: rep.deleted }
}

export function toMemoryRecordHistoryPageDto(rep: MemoryRecordHistoryPage): MemoryRecordHistoryPageDtoT {
  return { events: rep.events, nextCursor: rep.nextCursor ?? null }
}

/** Wire REP → HTTP body for a workspace git status. `repo`/`agentDir` are folded
 *  in from the agent config (the daemon reports only live checkout facts). */
export function toWorkspaceGitStatusDto(
  rep: WorkspaceGitStatus,
  cfg: { repo?: string; agentDir?: string } = {}
): WorkspaceGitStatusDtoT {
  return {
    isRepo: rep.isRepo,
    clean: rep.clean,
    repo: cfg.repo ?? null,
    agentDir: cfg.agentDir ?? null,
    branch: rep.branch ?? null,
    tracking: rep.tracking ?? null,
    ahead: rep.ahead ?? null,
    behind: rep.behind ?? null,
    files: rep.files ?? [],
    truncated: rep.truncated ?? false,
    lastCommit: rep.lastCommit ?? null,
    lastFetchAt: rep.lastFetchAt ?? null
  }
}

/** Wire REP → HTTP body for a workspace git pull (see {@link toWorkspaceFilesDto}). */
export function toWorkspaceGitPullDto(rep: WorkspaceGitPullResult): WorkspaceGitPullDtoT {
  return {
    isRepo: rep.isRepo,
    ok: rep.ok,
    detail: rep.detail ?? null,
    changed: rep.changed ?? null,
    insertions: rep.insertions ?? null,
    deletions: rep.deletions ?? null
  }
}

/** Map a daemon-edge failure to a 503 message, or null to rethrow. Covers: no
 *  live connection, the socket dropping mid-flight ('connection closed'), and a
 *  daemon-side `error` frame (ProtocolError — e.g. path containment
 *  BAD_PAYLOAD). Anything else is a CP bug → the 500 handler. */
function daemonEdgeFailure(err: unknown): string | null {
  if (err instanceof NoConnection || (err instanceof Error && err.message === 'connection closed')) {
    return 'owning daemon is offline'
  }
  if (err instanceof ProtocolError) return `daemon rejected the request: ${err.message}`
  return null
}

function memoryAdminFailure(
  err: unknown
): { status: 400 | 409 | 503; error: 'Bad Request' | 'Conflict' | 'Service Unavailable'; message: string } | null {
  if (err instanceof ProtocolError && err.code === 'BAD_PAYLOAD') {
    return { status: 400, error: 'Bad Request', message: `daemon rejected the request: ${err.message}` }
  }
  if (err instanceof ProtocolError && err.code === 'CONFLICT') {
    return { status: 409, error: 'Conflict', message: err.message }
  }
  const unavailable = daemonEdgeFailure(err)
  return unavailable === null ? null : { status: 503, error: 'Service Unavailable', message: unavailable }
}

export function agentRoutes(deps: HttpDeps) {
  return async function agentRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    // Fetch an agent AND verify it belongs to the caller's active org AND is visible
    // to them — a cross-org id OR a restricted agent they can't see both read as
    // absent (404), never as someone else's resource.
    const getOrgAgent = async (req: FastifyRequest, id: string): Promise<AgentRecord | null> => {
      const agent = await deps.repos.agent.get(AgentId(id))
      if (!agent || agent.orgId !== req.orgCtx!.orgId) return null
      return canView(agent, ctxOf(req)) ? agent : null
    }

    const resolvePolicyAgentIds = async (
      req: FastifyRequest,
      subjectAgentId: string,
      requestedIds: string[],
      existingIds: string[]
    ): Promise<string[]> => {
      const peers = (await deps.repos.agent.list(orgOf(req))).filter((agent) => agent.id !== subjectAgentId)
      const peerIds = new Set(peers.map((agent) => String(agent.id)))
      const visiblePeerIds = new Set(
        peers.filter((agent) => canView(agent, ctxOf(req))).map((agent) => String(agent.id))
      )
      // A collaborator editing the target may not see every restricted caller
      // previously granted by an owner. Preserve those valid existing grants,
      // while only accepting NEW choices from the editor's visible peer set.
      const retainedHiddenIds = existingIds.filter((id) => peerIds.has(id) && !visiblePeerIds.has(id))
      const requestedVisibleIds = requestedIds.filter((id) => visiblePeerIds.has(id))
      return [...new Set([...retainedHiddenIds, ...requestedVisibleIds])]
    }

    // The agent's secret KEY NAMES for the DTO ([] when none) — never the values.
    const secretKeysOf = async (agentId: string): Promise<string[]> =>
      (await deps.repos.agentSecret.keys([AgentId(agentId)])).get(agentId) ?? []

    // Replicate a spec change to the agent's owning daemon so its local config
    // replica stays current (direct Slack→daemon launch reads the replica, not
    // the CP). Best-effort: if the agent isn't placed or the daemon is offline,
    // the `register/ok` reconcile roster is the backstop on its next connect.
    const replicateUpsert = async (agent: AgentRecord): Promise<void> => {
      if (!agent.daemonId) return
      const spec = await deps.agentSpecs.assemble(agent)
      try {
        await deps.control.agentUpsert(agent.daemonId, { agentId: agent.id, spec })
      } catch (err) {
        // Best-effort (see the register/ok reconcile backstop above): the agent update is
        // ALREADY persisted, so a daemon-side hiccup must not fail the HTTP write — not just
        // an offline daemon (NoConnection) but also a rejected/failed live reconcile or a
        // slow/absent ack (agent/upsert became a blocking request-ack in #740; before that a
        // reconcile hiccup was silent). The daemon re-syncs from the register/ok roster on its
        // next (re)connect. Matches the icon route's replicate handler.
        if (err instanceof NoConnection) {
          app.log.debug({ agentId: agent.id, daemonId: agent.daemonId }, 'agent/upsert skipped: daemon offline')
        } else {
          app.log.warn(
            { err, agentId: agent.id, daemonId: agent.daemonId },
            'agent/upsert live reconcile failed (backstop: reconnect roster)'
          )
        }
      }
    }

    const replicateRemove = async (agentId: string, daemonId: string | null): Promise<void> => {
      if (!daemonId) return
      try {
        await deps.control.agentRemove(daemonId, { agentId })
      } catch (err) {
        if (!(err instanceof NoConnection)) throw err
        app.log.debug({ agentId, daemonId }, 'agent/remove skipped: daemon offline')
      }
    }

    // The alive relay's HTTP origin for MCP proxy defs (ws→http/wss→https), or null
    // when no relay is live. Mirrors the mcp-providers route's relayBaseUrl.
    const relayProxyBase = async (): Promise<string | null> => {
      const alive = await deps.repos.relay.listAlive(new Date(Date.now() - (deps.config.RELAY_STALE_MS ?? 0)))
      const url = alive[0]?.daemonUrl
      return url ? relayHttpOrigin(url) : null
    }

    // Reflect an agent's MCP enable-list change onto its daemon's proxy-def set: push
    // the relay proxy def for each newly-enabled REGISTRY provider, and drop a def once
    // no placed agent on that daemon still enables it. A registry provider's def (which
    // carries the grant key + relay URL) reaches a daemon ONLY via provider CRUD or this
    // transition — so without this, enabling an already-registered provider never
    // provisions the def and the next session can't resolve the server (register/ok
    // reconcile is the slow backstop). Names that aren't registry providers are
    // daemon-local defs and left alone. Best-effort + never throws: an offline daemon
    // (or transient error) is covered by the reconcile roster on its next register.
    const syncMcpDefsForAgent = async (
      orgId: OrgId,
      daemonId: string,
      before: readonly string[],
      after: readonly string[]
    ): Promise<void> => {
      const added = after.filter((n) => !before.includes(n))
      const removed = before.filter((n) => !after.includes(n))
      if (added.length === 0 && removed.length === 0) return
      try {
        const byName = new Map((await deps.repos.mcpProvider.listForOrg(orgId)).map((p) => [p.name, p]))
        const send = async (fn: () => Promise<void>) => {
          try {
            await fn()
          } catch (err) {
            if (!(err instanceof NoConnection)) throw err // offline ⇒ reconcile backstop
          }
        }
        if (added.some((n) => byName.has(n))) {
          const base = await relayProxyBase()
          for (const name of added) {
            const provider = base ? byName.get(name) : undefined
            if (!provider) continue
            const grant = (await deps.repos.mcpGrant.activeForProvider(provider.id))[0]
            if (grant) await send(() => deps.control.mcpServerUpsert(daemonId, mcpProxyDef(provider, grant.key, base!)))
          }
        }
        if (removed.some((n) => byName.has(n))) {
          const peers = await deps.repos.agent.list(orgId)
          for (const name of removed) {
            if (!byName.has(name)) continue
            const stillUsed = peers.some((a) => a.daemonId === daemonId && a.mcpServers.includes(name))
            if (!stillUsed) await send(() => deps.control.mcpServerRemove(daemonId, name))
          }
        }
      } catch (err) {
        app.log.warn({ daemonId, err }, 'mcp def sync failed (reconcile will converge)')
      }
    }

    // A caller may DISABLE a registry MCP provider they can't see (one already on the
    // agent), but may not ADD one back — the enable-list surface mirrors provider
    // visibility. Returns a 403 message for any newly-added name that resolves to a
    // provider outside the caller's view; daemon-local (non-registry) names carry no
    // visibility and always pass. `before` is [] on create.
    const enablingUnseenDenied = async (
      orgId: OrgId,
      ctx: ViewCtx,
      before: readonly string[],
      after: readonly string[]
    ): Promise<string | null> => {
      const added = after.filter((n) => !before.includes(n))
      if (added.length === 0) return null
      const visible = new Set((await deps.repos.mcpProvider.listForOrg(orgId, ctx)).map((p) => p.name))
      const registry = new Set((await deps.repos.mcpProvider.listForOrg(orgId)).map((p) => p.name))
      const blocked = added.filter((n) => registry.has(n) && !visible.has(n))
      return blocked.length ? `cannot enable MCP provider you don't have access to: ${blocked.join(', ')}` : null
    }

    // Skills enablement authorization (shared-skills.md §9). A skill-ref is
    // "<source>/<skill>" / "<source>/*" / "<source>"; its self-contained definition
    // is pushed to the daemon, so a caller may only ADD refs to sources they can see.
    // Newly-added refs to an unknown OR unviewable source are blocked, so the
    // enable-list surface mirrors source visibility (same rule as MCP providers);
    // removing/keeping a ref to a source they can't see is allowed. `before` is [] on create.
    const enablingUnseenSkillDenied = async (
      orgId: OrgId,
      ctx: ViewCtx,
      before: readonly string[],
      after: readonly string[]
    ): Promise<string | null> => {
      const sourceOf = (ref: string) => (ref.includes('/') ? ref.slice(0, ref.indexOf('/')) : ref)
      const addedSources = [...new Set(after.filter((r) => !before.includes(r)).map(sourceOf))]
      if (addedSources.length === 0) return null
      const visible = new Set((await deps.repos.skillSource.listForOrg(orgId, ctx)).map((s) => s.name))
      const blocked = addedSources.filter((n) => !visible.has(n))
      return blocked.length
        ? `cannot enable skills from a source you don't have access to: ${blocked.join(', ')}`
        : null
    }

    const validateExternalMemoryBinding = async (
      memory: AgentRecord['memory'] | undefined,
      orgId: OrgId
    ): Promise<string | null> => {
      if (memory?.provider !== 'external') return null
      const connection = await deps.repos.externalMemoryConnection.get(memory.connectionId)
      if (!connection || connection.orgId !== orgId) return 'external memory connection not found in this organization'
      // Probing is daemon-owned and a connection reaches a daemon through its
      // first binding, so rejecting every non-ready connection here creates a
      // bootstrap deadlock. Persist probing/degraded bindings; daemon admission
      // remains fail-closed until this exact definition passes conformance.
      // A proven-invalid revision, however, is actionable static failure and is
      // rejected until the owner updates the connection (which bumps revision
      // and returns it to probing).
      if (connection.status === 'invalid' && connection.probedRevision === connection.revision) {
        return 'external memory connection failed conformance validation'
      }
      return null
    }

    const externalMemoryConnectionIds = (...memories: Array<AgentRecord['memory'] | null | undefined>): string[] => [
      ...new Set(memories.flatMap((memory) => (memory?.provider === 'external' ? [memory.connectionId] : [])))
    ]

    /** Registry-before-agent ordering: a live daemon must see the referenced
     * connection before it applies an external-memory AgentSpec. */
    const pushExternalMemoryToDaemon = async (agent: AgentRecord, daemonId: string): Promise<boolean> => {
      if (agent.memory?.provider !== 'external') return true
      try {
        const connection = await deps.repos.externalMemoryConnection.get(agent.memory.connectionId)
        if (!connection || connection.orgId !== agent.orgId) return false
        const installation = await deps.repos.memoryPluginInstallation.get(connection.installationId)
        if (!installation) return false
        if (installation.transport === 'stdio') {
          const secrets = (await deps.repos.externalMemoryConnectionSecret.get(connection.id)) ?? {}
          await deps.control.memoryConnectionUpsert(
            daemonId,
            stdioMemoryConnectionSpec(connection, installation, secrets)
          )
          return true
        }
        const [grant, secretKeys, base] = await Promise.all([
          deps.repos.externalMemoryGrant.activeForConnection(connection.id).then((rows) => rows.at(-1)),
          deps.repos.externalMemoryConnectionSecret.keys(connection.id),
          relayProxyBase()
        ])
        if (!grant || !base) return false
        await deps.control.memoryConnectionUpsert(
          daemonId,
          memoryConnectionSpec(connection, installation, secretKeys, grant.key, base)
        )
        return true
      } catch {
        // The projection is grant-bearing. A codec/transport error can retain
        // the rejected payload, so log only stable identifiers here.
        app.log.warn(
          { agentId: agent.id, daemonId },
          'external memory registry live sync failed (backstop: reconnect roster)'
        )
        return false
      }
    }

    const pushExternalMemoryBeforeAgent = async (agent: AgentRecord): Promise<void> => {
      if (!agent.daemonId) return
      await pushExternalMemoryToDaemon(agent, agent.daemonId)
    }

    const removeExternalMemoryFromDaemonIfUnused = async (
      orgId: OrgId,
      daemonId: string,
      connectionId: string
    ): Promise<void> => {
      try {
        const stillUsed = (await deps.repos.agent.list(orgId)).some(
          (agent) =>
            agent.daemonId === daemonId &&
            agent.memory?.provider === 'external' &&
            agent.memory.connectionId === connectionId
        )
        if (!stillUsed) await deps.control.memoryConnectionRemove(daemonId, connectionId)
      } catch (err) {
        // Offline/version-skewed daemon converges the full registry on reconnect.
        app.log.warn({ daemonId, connectionId, err }, 'external memory registry removal deferred')
      }
    }

    const removeUnusedExternalMemoryAfterAgent = async (before: AgentRecord, after: AgentRecord): Promise<void> => {
      if (!before.daemonId || before.memory?.provider !== 'external') return
      const connectionId = before.memory.connectionId
      if (
        after.daemonId === before.daemonId &&
        after.memory?.provider === 'external' &&
        after.memory.connectionId === connectionId
      ) {
        return
      }
      await removeExternalMemoryFromDaemonIfUnused(before.orgId, before.daemonId, connectionId)
    }

    const agentMoves = new AgentMoveService({
      agents: deps.repos.agent,
      assignments: deps.repos.assignment,
      integrations: deps.repos.integration,
      integrationChannels: deps.repos.integrationChannel,
      bots: deps.repos.bot,
      botSecrets: deps.repos.botSecret,
      specs: deps.agentSpecs,
      crons: deps.repos.cron,
      control: deps.control,
      hooks: deps.hooks,
      sharedBot: deps.sharedBot,
      collabRoutes: deps.collabRoutes,
      mutations: deps.agentMutations,
      sessionOwners: deps.sessionOwners,
      log: app.log
    })
    const refreshMutationAgent = async (observed: AgentRecord): Promise<AgentRecord | null> => {
      const current = await deps.repos.agent.get(observed.id)
      if (
        !current ||
        current.daemonId !== observed.daemonId ||
        current.lastModifiedAt.getTime() !== observed.lastModifiedAt.getTime()
      ) {
        return null
      }
      return current
    }

    r.post(
      '/agents',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Create an agent',
          description:
            'Mint a new agent definition scoped to the caller’s org; the CP assigns its UUID. With ?connect=true, also provisions a daemon connect token and start command for onboarding.',
          operationId: 'createAgent',
          body: CreateAgentBody,
          querystring: z.object({ connect: z.stringbool().default(false) }),
          response: {
            201: AgentCreatedDto,
            400: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            429: ErrorDto,
            502: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const conflict = (message: string) => reply.code(409).send({ error: 'Conflict', statusCode: 409, message })
        // A caller-named daemon must belong to the caller's org AND be VISIBLE to
        // them — otherwise an agent could be placed onto (and executed by) another
        // tenant's daemon, or a collaborator could place one onto a restricted
        // daemon they can't see (which would also make this an existence oracle for
        // restricted daemons). A cross-org id and a restricted-and-invisible one
        // both read as absent (same 404). Mirrors integrations/cron referential writes.
        const placedDaemon =
          req.body.daemonId !== undefined ? await deps.registry.get(DaemonId(req.body.daemonId)) : null
        if (req.body.daemonId !== undefined) {
          if (!placedDaemon || placedDaemon.orgId !== req.orgCtx!.orgId || !canView(placedDaemon, ctxOf(req))) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'daemon not found' })
          }
        }
        const sandboxPolicy = sandboxPolicyOf(placedDaemon)
        if (sandboxPolicy.required && req.body.restrictFileAccess === false) {
          return conflict('Run in sandbox is required by this daemon')
        }
        if (!sandboxPolicy.supported && req.body.restrictFileAccess === true) {
          return conflict('Run in sandbox is unavailable on this daemon')
        }
        const restrictFileAccess = sandboxPolicy.required
          ? true
          : sandboxPolicy.supported
            ? (req.body.restrictFileAccess ?? false)
            : false
        // github-app workspace: the picked installation must be a LIVE claim of
        // THIS org, and the repo must sit inside that installation's account +
        // grant set. Ordered AFTER the daemonId visibility gate (404 semantics);
        // these answer 409 — installations and their grant sets are org-level
        // infrastructure (visibility taxonomy), so a 409 is not an oracle.
        const ws = req.body.workspace
        let workspace = ws
        let workspaceRepoId: bigint | undefined
        if (ws?.mode === 'github' && ws.installationId === undefined && ws.gitAccess === 'write') {
          return conflict('github write access requires a GitHub App installation')
        }
        if (ws?.mode === 'github' && ws.installationId !== undefined) {
          if (!deps.github) return conflict('github-app workspaces are not enabled on this control plane')
          const ins = await deps.repos.githubInstallation.get(ws.installationId)
          if (!ins || ins.orgId !== req.orgCtx!.orgId || ins.revokedAt) {
            return conflict('github installation not found in this org')
          }
          const repoParts = gitRepoLabel(ws.gitRepo).split('/')
          const [owner, repo] = repoParts
          if (repoParts.length !== 2 || !owner || !repo) {
            return conflict('workspace gitRepo is not a github repository')
          }
          if (owner.toLowerCase() !== ins.accountLogin.toLowerCase()) {
            return conflict(`repo owner ${owner} does not match the installation account ${ins.accountLogin}`)
          }
          try {
            const ref = await deps.github.repoRefFor(ins, owner, repo)
            if (!ref) {
              return conflict(`${owner}/${repo} is not granted to the installation — re-select it on GitHub`)
            }
            workspaceRepoId = ref.repoId
            // The installation lookup, not the caller's clone host/path, is the
            // authority for an App-backed workspace.
            workspace = { ...ws, gitRepo: normalizeGitUrl(ref.fullName) }
            // Per-user gate (identity assertion, open question #7) — the SECURITY check;
            // the picker's preflight is UX only. The creator must hold the
            // access level the agent will run with: gitAccess=write (the
            // default) demands their own push permission on GitHub.
            if (deps.githubUserAuthz) {
              await deps.githubUserAuthz.assertAccess(
                req.principal!.userId,
                ins,
                owner,
                repo,
                ws.gitAccess === 'read' ? 'read' : 'write'
              )
            }
          } catch (e) {
            if (e instanceof UserAuthzDeniedError) {
              return reply
                .code(403)
                .send({ error: 'Forbidden', statusCode: 403, message: `github: ${e.message}`, code: e.code })
            }
            if (e instanceof LogtoApiError) {
              // Identity assertion unavailable — the gate fails CLOSED, as
              // upstream trouble (retryable), never as a silent allow.
              return reply.code(502).send({ error: 'Bad Gateway', statusCode: 502, message: e.message })
            }
            if (e instanceof GithubApiError) {
              const status = e.code === 'RATE_LIMITED' ? 429 : 502
              return reply.code(status).send({
                error: status === 429 ? 'Too Many Requests' : 'Bad Gateway',
                statusCode: status,
                message: `github: ${e.message}`
              })
            }
            throw e
          }
        }
        if (Array.isArray(req.body.mcpServers)) {
          const denied = await enablingUnseenDenied(orgOf(req), ctxOf(req), [], req.body.mcpServers)
          if (denied) return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: denied })
        }
        if (Array.isArray(req.body.skills)) {
          const denied = await enablingUnseenSkillDenied(orgOf(req), ctxOf(req), [], req.body.skills)
          if (denied) return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: denied })
        }
        const memoryRelease = deps.memoryConnectionMutations.tryBeginMutation(
          externalMemoryConnectionIds(req.body.memory)
        )
        if (!memoryRelease) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'external memory connection is being updated; retry agent creation'
          })
        }
        try {
          const memoryError = await validateExternalMemoryBinding(req.body.memory, orgOf(req))
          if (memoryError) {
            return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: memoryError })
          }
          // Restricted-on-create: intersect the requested share set with current org
          // members (same rule as PUT /sharing) so a create can't grant a non-member.
          const initialSharedWith = req.body.sharedWith
            ? await resolveShareSet(deps.repos.user, orgOf(req), req.body.sharedWith)
            : undefined
          // Selected-callers-on-create: intersect the requested caller allow-list
          // with visible same-org peers (same rule as PUT /call-policy). The new
          // agent isn't a peer yet, so `agentId` self-exclusion is a harmless no-op.
          const agentId = AgentId(randomUUID())
          const initialAllowedCallers =
            req.body.callPolicy === 'selected'
              ? await resolvePolicyAgentIds(req, agentId, req.body.allowedCallerAgentIds ?? [], [])
              : undefined
          const initialAllowedTargets =
            req.body.outboundPolicy === 'selected'
              ? await resolvePolicyAgentIds(req, agentId, req.body.allowedTargetAgentIds ?? [], [])
              : undefined
          // One transaction for the agent row + its initial secret rows (sealing
          // happens before it opens) — a failure can't leave a partial definition.
          const agent = await deps.repos.agentConfig.create(
            {
              id: agentId,
              orgId: orgOf(req),
              name: req.body.name,
              ...(req.body.displayName !== undefined ? { displayName: req.body.displayName } : {}),
              // Absent ⇒ the repo assigns a random glyph+color combo (product default).
              ...(req.body.icon !== undefined ? { icon: req.body.icon } : {}),
              ...(req.body.description !== undefined ? { description: req.body.description } : {}),
              runtime: req.body.runtime,
              ...(req.body.model !== undefined ? { model: req.body.model } : {}),
              ...(req.body.reasoningEffort !== undefined ? { reasoningEffort: req.body.reasoningEffort } : {}),
              ...(req.body.outputMode !== undefined ? { outputMode: req.body.outputMode } : {}),
              ...(req.body.showFooter !== undefined ? { showFooter: req.body.showFooter } : {}),
              ...(req.body.fastMode !== undefined ? { fastMode: req.body.fastMode } : {}),
              ...(req.body.permissionMode !== undefined ? { permissionMode: req.body.permissionMode } : {}),
              ...(req.body.allowRuntimeChangesInChat !== undefined
                ? { allowRuntimeChangesInChat: req.body.allowRuntimeChangesInChat }
                : {}),
              ...(req.body.pause !== undefined ? { pause: req.body.pause } : {}),
              ...(req.body.introduceOnJoin !== undefined ? { introduceOnJoin: req.body.introduceOnJoin } : {}),
              restrictFileAccess,
              ...(req.body.env !== undefined ? { env: req.body.env } : {}),
              ...(req.body.mcpServers !== undefined ? { mcpServers: req.body.mcpServers } : {}),
              ...(req.body.skills !== undefined ? { skills: req.body.skills } : {}),
              ...(req.body.memory !== undefined ? { memory: req.body.memory } : {}),
              ...(req.body.daemonId !== undefined ? { daemonId: DaemonId(req.body.daemonId) } : {}),
              ...(workspace !== undefined ? { workspace } : {}),
              ...(workspaceRepoId !== undefined ? { workspaceRepoId } : {}),
              ...(req.principal ? { createdByUserId: req.principal.userId } : {}),
              ...(req.body.visibility ? { visibility: req.body.visibility } : {}),
              ...(initialSharedWith ? { sharedWith: initialSharedWith } : {}),
              ...(req.body.callPolicy ? { callPolicy: req.body.callPolicy } : {}),
              ...(initialAllowedCallers ? { allowedCallerAgentIds: initialAllowedCallers } : {}),
              ...(req.body.outboundPolicy ? { outboundPolicy: req.body.outboundPolicy } : {}),
              ...(initialAllowedTargets ? { allowedTargetAgentIds: initialAllowedTargets } : {}),
              capabilities: req.body.capabilities
            },
            // Initial write-only secrets — same transaction, so the first
            // replicateUpsert below always sees the complete definition.
            req.body.secrets
          )
          // `?connect=true` also provisions a daemon connect token + start command
          // so the onboarding screen can show "run this to connect a daemon".
          const connect = req.query.connect
            ? await provisionDaemonConnect(deps.apiKeys, deps.config, req.orgCtx!.orgId, req.principal?.userId)
            : undefined
          // Issue the private definition first. Even if its probe ACK is lost,
          // the WebSocket preserves frame order and daemon admission remains
          // closed until the registry validates it.
          await pushExternalMemoryBeforeAgent(agent)
          await replicateUpsert(agent) // no-op until placed; reconcile carries it otherwise
          if (agent.daemonId) await syncMcpDefsForAgent(orgOf(req), agent.daemonId, [], agent.mcpServers)
          return reply.code(201).send({
            ...toDto(
              agent,
              ctxOf(req),
              await secretKeysOf(agent.id),
              await hookKindsOf(deps, agent.id),
              iconBasesOf(deps),
              sandboxPolicy
            ),
            ...(connect ? { connect } : {})
          })
        } finally {
          memoryRelease()
        }
      }
    )

    r.get(
      '/agents',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List agents',
          description: 'Every agent definition in the caller’s active org.',
          operationId: 'listAgents',
          response: { 200: AgentListDto }
        }
      },
      async (req) => {
        const ctx = ctxOf(req)
        const rows = await deps.repos.agent.list(orgOf(req), ctx)
        const hookKinds = await deps.repos.hook.kindsByAgent(orgOf(req))
        const secretKeys = await deps.repos.agentSecret.keys(rows.map((a) => a.id))
        const daemonIds = [...new Set(rows.flatMap((a) => (a.daemonId ? [a.daemonId] : [])))]
        const policies = new Map(
          await Promise.all(
            daemonIds.map(async (daemonId) => [daemonId, sandboxPolicyOf(await deps.registry.get(daemonId))] as const)
          )
        )
        return rows.map((a) =>
          toDto(
            a,
            ctx,
            secretKeys.get(a.id) ?? [],
            hookKinds.get(a.id) ?? [],
            iconBasesOf(deps),
            a.daemonId ? (policies.get(a.daemonId) ?? UNAVAILABLE_SANDBOX) : UNAVAILABLE_SANDBOX
          )
        )
      }
    )

    r.get(
      '/agents/:id',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Get an agent',
          description: 'Fetch one agent by id; a cross-org id reads as absent (404).',
          operationId: 'getAgent',
          params: IdParam,
          response: { 200: AgentDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        return toDto(
          agent,
          ctxOf(req),
          await secretKeysOf(agent.id),
          await hookKindsOf(deps, agent.id),
          iconBasesOf(deps),
          await sandboxPolicyFor(deps, agent)
        )
      }
    )

    r.get(
      '/agents/:id/permission-requests',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List agent approval requests',
          description:
            'Proxy the owning daemon’s bounded, secret-masked approval queue. Only callers who can edit the agent may read it; the Control Plane does not persist these requests.',
          operationId: 'listAgentPermissionRequests',
          params: IdParam,
          response: { 200: AgentPermissionRequestPageDto, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        try {
          const page = await deps.control.agentPermissionRequests(agent.daemonId, {
            agentId: agent.id,
            limit: 100
          })
          return { requests: page.requests }
        } catch (err) {
          const unavailable = daemonEdgeFailure(err)
          if (unavailable !== null) {
            return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: unavailable })
          }
          throw err
        }
      }
    )

    r.post(
      '/agents/:id/permission-requests/:requestId/decision',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Decide an agent approval request',
          description:
            'Allow or deny one pending runtime request on the owning daemon. Only callers who can edit the agent may decide it.',
          operationId: 'decideAgentPermissionRequest',
          params: z.object({ id: z.string().uuid(), requestId: z.string().uuid() }),
          body: AgentPermissionDecisionBody,
          response: {
            200: z.object({ ok: z.literal(true) }),
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        try {
          const ack = await deps.control.agentPermissionDecision(agent.daemonId, {
            agentId: agent.id,
            requestId: req.params.requestId,
            decision: req.body.decision
          })
          if (!ack.ok) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: ack.reason ?? 'permission request is no longer pending'
            })
          }
          return { ok: true as const }
        } catch (err) {
          const unavailable = daemonEdgeFailure(err)
          if (unavailable !== null) {
            return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: unavailable })
          }
          throw err
        }
      }
    )

    // Edit the spec (name / system-prompt / model / runtime / capabilities).
    // Persisted as the source of truth; `agent/upsert` hot-syncs the owning
    // daemon's replica, and the new spec also rides the next `register/ok` and
    // `agent/launch`.
    r.patch(
      '/agents/:id',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Update an agent',
          description:
            'Edit the agent spec or widen an existing GitHub workspace from read to write access; the change hot-syncs the owning daemon’s replica and rides the next register/launch.',
          operationId: 'updateAgent',
          params: IdParam,
          body: UpdateAgentBody,
          response: {
            200: AgentDto,
            400: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            429: ErrorDto,
            502: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const existing = await getOrgAgent(req, req.params.id)
        if (!existing) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        // A collaborator who can VIEW a restricted agent may still not EDIT it unless
        // they're the creator / a grantee / an owner — the per-resource narrowing on
        // top of the role-only denyViewerWrite gate.
        if (!canEdit(existing, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        const release = deps.agentMutations.tryBeginMutation(existing.id)
        if (!release) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'agent move is in progress; retry the edit' })
        }
        const targetMemory = req.body.memory === undefined ? existing.memory : req.body.memory
        const memoryRelease = deps.memoryConnectionMutations.tryBeginMutation(
          externalMemoryConnectionIds(existing.memory, targetMemory)
        )
        if (!memoryRelease) {
          release()
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'external memory connection is being updated; retry the edit'
          })
        }
        try {
          if (!(await refreshMutationAgent(existing))) {
            return reply
              .code(409)
              .send({ error: 'Conflict', statusCode: 409, message: 'agent changed; refresh and retry the edit' })
          }
          const sandboxPolicy = await sandboxPolicyFor(deps, existing)
          if (sandboxPolicy.required && req.body.restrictFileAccess === false) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'Run in sandbox is required by this daemon'
            })
          }
          if (!sandboxPolicy.supported && req.body.restrictFileAccess === true) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'Run in sandbox is unavailable on this daemon'
            })
          }
          if (req.body.agentDir !== undefined && existing.workspace.mode !== 'github') {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'working subdirectory is only available for GitHub workspaces'
            })
          }
          if (req.body.gitAccess === 'write') {
            const conflict = (message: string) => reply.code(409).send({ error: 'Conflict', statusCode: 409, message })
            if (existing.workspace.mode !== 'github' || existing.workspace.installationId === undefined) {
              return conflict('write access can only upgrade an existing GitHub App workspace')
            }
            if (!deps.github) return conflict('github-app workspaces are not enabled on this control plane')

            const [owner, repo] = gitRepoLabel(existing.workspace.gitRepo).split('/')
            if (!owner || !repo) return conflict('workspace gitRepo is not a github repository')
            const installation = await deps.repos.githubInstallation.liveByOrgAndAccount(existing.orgId, owner)
            if (!installation || installation.suspendedAt) {
              return conflict(`no live GitHub installation covers ${owner}`)
            }
            try {
              const ref = await deps.github.repoRefFor(installation, owner, repo)
              if (!ref || (existing.workspaceRepoId !== undefined && existing.workspaceRepoId !== ref.repoId)) {
                return conflict('workspace repository is no longer covered by its GitHub installation')
              }
              if (deps.githubUserAuthz) {
                const [canonicalOwner, canonicalRepo] = ref.fullName.split('/')
                if (!canonicalOwner || !canonicalRepo) {
                  return conflict('workspace gitRepo is not a github repository')
                }
                await deps.githubUserAuthz.assertAccess(
                  req.principal!.userId,
                  installation,
                  canonicalOwner,
                  canonicalRepo,
                  'write'
                )
              }
            } catch (e) {
              if (e instanceof UserAuthzDeniedError) {
                return reply
                  .code(403)
                  .send({ error: 'Forbidden', statusCode: 403, message: `github: ${e.message}`, code: e.code })
              }
              if (e instanceof LogtoApiError) {
                return reply.code(502).send({ error: 'Bad Gateway', statusCode: 502, message: e.message })
              }
              if (e instanceof GithubApiError) {
                const status = e.code === 'RATE_LIMITED' ? 429 : 502
                return reply.code(status).send({
                  error: status === 429 ? 'Too Many Requests' : 'Bad Gateway',
                  statusCode: status,
                  message: `github: ${e.message}`
                })
              }
              throw e
            }
          }
          // null clears the list (removal-only) → nothing to gate; only an explicit
          // array can add a provider.
          if (Array.isArray(req.body.mcpServers)) {
            const denied = await enablingUnseenDenied(orgOf(req), ctxOf(req), existing.mcpServers, req.body.mcpServers)
            if (denied) return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: denied })
          }
          if (Array.isArray(req.body.skills)) {
            const denied = await enablingUnseenSkillDenied(orgOf(req), ctxOf(req), existing.skills, req.body.skills)
            if (denied) return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: denied })
          }
          const memoryError = await validateExternalMemoryBinding(targetMemory ?? undefined, orgOf(req))
          if (memoryError) {
            return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: memoryError })
          }
          // The row patch and the secret merge commit as ONE transaction (sealing
          // outside it), so the replicateUpsert below can only ever ship a
          // definition that fully applied — never a half-updated one.
          const { secrets: secretsPatch, ...bodyPatch } = req.body
          const agent = await deps.repos.agentConfig.update(
            AgentId(req.params.id),
            {
              ...bodyPatch,
              ...(req.principal ? { lastModifiedByUserId: req.principal.userId } : {})
            },
            secretsPatch
          )
          await pushExternalMemoryBeforeAgent(agent)
          await replicateUpsert(agent)
          await removeUnusedExternalMemoryAfterAgent(existing, agent)
          // Provision/drop MCP proxy defs for an enable-list change on a stably-placed
          // agent (a daemon move goes through AgentMoveService + reconcile, not here).
          if (agent.daemonId && agent.daemonId === existing.daemonId) {
            await syncMcpDefsForAgent(orgOf(req), agent.daemonId, existing.mcpServers, agent.mcpServers)
          }
          return toDto(
            agent,
            ctxOf(req),
            await secretKeysOf(agent.id),
            await hookKindsOf(deps, agent.id),
            iconBasesOf(deps),
            sandboxPolicy
          )
        } finally {
          memoryRelease()
          release()
        }
      }
    )

    // Workspace changes use the acknowledged lifecycle rather than generic
    // PATCH: the daemon drains active work, reconciles the local checkout, and
    // evicts cached repository credentials before success.
    r.put(
      '/agents/:id/workspace',
      {
        schema: {
          tags: [Tag.Workspace],
          summary: 'Edit an agent workspace',
          description:
            'Replace a workspace with scratch or a covered GitHub repository, or edit its repository, branch, working directory, and read/write access. Changing workspace type, repository, or branch discards daemon-local workspace files. The caller must hold the requested GitHub permission. Active work is drained and repository credentials are invalidated before success. Enabled GitHub review or Check actions reject edits that remove their required write authority.',
          operationId: 'setAgentWorkspace',
          params: IdParam,
          body: SetAgentWorkspaceBody,
          response: {
            200: AgentDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            429: ErrorDto,
            502: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const existing = await getOrgAgent(req, req.params.id)
        if (!existing) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!canEdit(existing, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        const conflict = (message: string) => reply.code(409).send({ error: 'Conflict', statusCode: 409, message })
        if (existing.daemonId) {
          const daemon = await deps.registry.get(existing.daemonId)
          const live = deps.liveness.get(existing.daemonId)
          if (!daemon || live?.reachable !== true || live.state !== 'READY') {
            return conflict('the agent must be online and ready to edit its workspace')
          }
          if (!daemon.capabilities.features.includes('workspace-edit-v2')) {
            return conflict('this agent version does not support workspace editing')
          }
        }

        try {
          let workspace: AgentWorkspace = { mode: 'scratch' }
          let workspaceRepoId: bigint | undefined
          if (req.body.mode === 'github') {
            if (!deps.github) return conflict('GitHub workspaces are not enabled for this deployment')
            const [owner, repo] = req.body.repoFullName.split('/')
            if (!owner || !repo) return conflict('repoFullName must be owner/repo')
            const installation = await deps.repos.githubInstallation.liveByOrgAndAccount(existing.orgId, owner)
            if (!installation || installation.suspendedAt) {
              return conflict(`no live GitHub installation covers ${owner}`)
            }
            const ref = await deps.github.repoRefFor(installation, owner, repo)
            if (!ref) return conflict(`${owner}/${repo} is not granted to the GitHub installation`)
            if (deps.githubUserAuthz) {
              await deps.githubUserAuthz.assertAccess(
                req.principal!.userId,
                installation,
                owner,
                repo,
                req.body.gitAccess
              )
            }
            workspace = {
              mode: 'github',
              gitRepo: normalizeGitUrl(ref.fullName),
              gitBranch: req.body.gitBranch ?? ref.defaultBranch,
              ...(req.body.agentDir ? { agentDir: req.body.agentDir } : {}),
              installationId: installation.id,
              gitAccess: req.body.gitAccess
            }
            workspaceRepoId = ref.repoId
          }

          const writableRepoId =
            workspace.mode === 'github' && (workspace.gitAccess ?? 'write') === 'write' ? workspaceRepoId : undefined
          const affectedRepoIds = new Set(
            [existing.workspaceRepoId, workspaceRepoId].filter((repoId): repoId is bigint => repoId !== undefined)
          )
          const currentRepoName =
            existing.workspace.mode === 'github' ? gitRepoLabel(existing.workspace.gitRepo).toLowerCase() : undefined
          const blocking = (await deps.repos.hook.listForAgent(existing.id)).some((hook) => {
            if (
              hook.kind !== 'github' ||
              !hook.enabled ||
              (hook.reviewPolicy === 'off' && hook.reportingMode === 'off') ||
              hook.repoId === writableRepoId
            ) {
              return false
            }
            return (
              (hook.repoId !== null && affectedRepoIds.has(hook.repoId)) ||
              (existing.workspaceRepoId === undefined && hook.repoFullName?.toLowerCase() === currentRepoName)
            )
          })
          if (blocking) {
            return conflict(AGENT_WORKSPACE_INTEGRATION_CONFLICT_MESSAGE)
          }

          const converted = await agentMoves.setWorkspace(existing, workspace, workspaceRepoId, req.principal?.userId)
          return toDto(
            converted,
            ctxOf(req),
            await secretKeysOf(converted.id),
            await hookKindsOf(deps, converted.id),
            iconBasesOf(deps),
            await sandboxPolicyFor(deps, converted)
          )
        } catch (err) {
          if (err instanceof AgentMoveConflict) return conflict(err.message)
          if (err instanceof AgentMoveFailed) {
            app.log.warn({ err, agentId: existing.id }, 'workspace edit failed')
            return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: err.message })
          }
          if (err instanceof UserAuthzDeniedError) {
            return reply
              .code(403)
              .send({ error: 'Forbidden', statusCode: 403, message: `github: ${err.message}`, code: err.code })
          }
          if (err instanceof LogtoApiError) {
            return reply.code(502).send({ error: 'Bad Gateway', statusCode: 502, message: err.message })
          }
          if (err instanceof GithubApiError) {
            const status = err.code === 'RATE_LIMITED' ? 429 : 502
            return reply.code(status).send({
              error: status === 429 ? 'Too Many Requests' : 'Bad Gateway',
              statusCode: status,
              message: `github: ${err.message}`
            })
          }
          throw err
        }
      }
    )

    // Cold-reprovision an agent on another daemon. The explicit action keeps
    // destructive/local-state semantics out of generic spec PATCH: source and
    // target must both advertise the move protocol and be READY; the source
    // archives its local root before the CAS placement change, then the target
    // receives the complete CP-owned definition and activates last.
    r.put(
      '/agents/:id/daemon',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Move an agent to another daemon',
          description:
            'Cold-reprovision an agent on another READY daemon. The active turn is drained; daemon-local workspace, memory, and transcript data are not migrated.',
          operationId: 'moveAgentDaemon',
          params: IdParam,
          body: SetAgentDaemonBody,
          response: { 200: AgentDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const existing = await getOrgAgent(req, req.params.id)
        if (!existing) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!canEdit(existing, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }

        const target = await deps.registry.get(DaemonId(req.body.daemonId))
        if (!target || target.orgId !== req.orgCtx!.orgId || !canView(target, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'daemon not found' })
        }

        const conflict = (message: string) => reply.code(409).send({ error: 'Conflict', statusCode: 409, message })
        const moveReady = (daemonId: string) => {
          const live = deps.liveness.get(daemonId)
          return live?.reachable === true && live.state === 'READY'
        }
        const MOVE_FEATURE = 'agent-move-v1'

        if (!moveReady(target.daemonId)) return conflict('target daemon is not ready')
        if (!target.capabilities.features.includes(MOVE_FEATURE)) {
          return conflict('target daemon does not support agent moves')
        }
        const targetRuntime = target.runtimeProfiles.find((p) => p.runtime === existing.runtime)
        if (target.runtimeProfiles.length > 0 && !targetRuntime) {
          return conflict(`target daemon does not support runtime ${existing.runtime}`)
        }
        // A 'cached' model list (hydrated from the daemon's last-good cache, not
        // confirmed by a live probe this process) is permissive exactly like an
        // empty one — only a probed list enforces membership, so a daemon that
        // restarted mid-upgrade never strands a move on a stale hydrated list
        // (runtime-model-catalog.md §5).
        if (
          existing.model &&
          targetRuntime &&
          targetRuntime.modelsSource !== 'cached' &&
          targetRuntime.models.length > 0 &&
          !targetRuntime.models.includes(existing.model)
        ) {
          return conflict(`target daemon does not support model ${existing.model} for runtime ${existing.runtime}`)
        }
        for (const name of existing.mcpServers) {
          const server = target.mcpServers.find((candidate) => candidate.name === name)
          if (!server) return conflict(`target daemon cannot attach MCP server ${name}`)
          const caps = targetRuntime?.mcpCapabilities
          const transportSupported =
            server.transport === 'stdio' || !caps || (server.transport === 'http' ? caps.http : caps.sse)
          if (!transportSupported) {
            return conflict(
              `target runtime ${existing.runtime} does not support MCP ${server.transport} transport for ${name}`
            )
          }
        }
        if (
          existing.daemonId !== target.daemonId &&
          target.load &&
          target.maxAgents > 0 &&
          target.load.agents >= target.maxAgents
        ) {
          return conflict('target daemon is at agent capacity')
        }

        if (existing.daemonId) {
          const source = await deps.registry.get(existing.daemonId)
          if (!source || !moveReady(source.daemonId)) return conflict('source daemon is not ready')
          if (!source.capabilities.features.includes(MOVE_FEATURE)) {
            return conflict('source daemon does not support agent moves')
          }
        }

        const memoryRelease = deps.memoryConnectionMutations.tryBeginMutation(
          externalMemoryConnectionIds(existing.memory)
        )
        if (!memoryRelease) return conflict('external memory connection is being updated; retry the move')
        let targetStaged = false
        try {
          // The connection registry is a separate private wire. Stage it before
          // agent/activate so target admission cannot observe a dangling binding.
          // This also repairs a target that committed the move but lost the reply.
          // Mark the cleanup obligation before the request: an ACK timeout can
          // mean the daemon applied the grant-bearing definition but its reply
          // was lost, so a failed request is not proof that nothing was staged.
          targetStaged = existing.memory?.provider === 'external'
          if (!(await pushExternalMemoryToDaemon(existing, target.daemonId))) {
            if (existing.memory?.provider === 'external') {
              await removeExternalMemoryFromDaemonIfUnused(
                existing.orgId,
                target.daemonId,
                existing.memory.connectionId
              )
              targetStaged = false
            }
            return reply.code(503).send({
              error: 'Service Unavailable',
              statusCode: 503,
              message: 'external memory connection could not be staged on the target daemon'
            })
          }

          // Retry/repair: the prior response may have been lost, or a failed move
          // may have left DB placement on a partially bootstrapped target. Reapply
          // the full bundle + activate; all operations are idempotent.
          if (existing.daemonId === target.daemonId) {
            try {
              const repaired = await agentMoves.ensureActive(existing)
              return toDto(
                repaired,
                ctxOf(req),
                await secretKeysOf(repaired.id),
                await hookKindsOf(deps, repaired.id),
                iconBasesOf(deps),
                sandboxPolicyOf(target)
              )
            } catch (err) {
              if (err instanceof AgentMoveConflict) return conflict(err.message)
              if (err instanceof AgentMoveFailed) {
                app.log.warn({ err, agentId: existing.id }, 'agent move repair failed')
                return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: err.message })
              }
              throw err
            }
          }

          const moved = await agentMoves.move(existing, target.daemonId, req.principal?.userId)
          // The pre-activation probe fact can arrive before the placement CAS and
          // is correctly rejected by the daemon-ownership check. Re-send the
          // idempotent definition after commit so the daemon re-emits its current
          // body-free fact under the now-authoritative target placement.
          await pushExternalMemoryToDaemon(moved, target.daemonId)
          if (existing.daemonId && existing.memory?.provider === 'external') {
            await removeExternalMemoryFromDaemonIfUnused(
              existing.orgId,
              existing.daemonId,
              existing.memory.connectionId
            )
          }
          return toDto(
            moved,
            ctxOf(req),
            await secretKeysOf(moved.id),
            await hookKindsOf(deps, moved.id),
            iconBasesOf(deps),
            sandboxPolicyOf(target)
          )
        } catch (err) {
          if (err instanceof AgentMoveConflict) return conflict(err.message)
          if (err instanceof AgentMoveFailed) {
            app.log.warn({ err, agentId: existing.id }, 'agent move failed')
            return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: err.message })
          }
          throw err
        } finally {
          // Re-read usage instead of trusting a local "committed" flag: a move
          // may commit placement and then lose its reply. If the target is now
          // authoritative the usage check retains the entry; otherwise it
          // removes a definition whose ACK may merely have been lost.
          if (targetStaged && existing.memory?.provider === 'external') {
            await removeExternalMemoryFromDaemonIfUnused(existing.orgId, target.daemonId, existing.memory.connectionId)
          }
          memoryRelease()
        }
      }
    )

    // Delete the agent. Removes the C6 definition (including agent-owned hooks),
    // then tells the owning daemon to drop it from its local replica
    // (`agent/remove`, best-effort).
    r.delete(
      '/agents/:id',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Delete an agent',
          description:
            'Remove the agent definition and its hooks, then tell the owning daemon to drop it from its local replica (best-effort).',
          operationId: 'deleteAgent',
          params: IdParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const existing = await getOrgAgent(req, req.params.id)
        if (!existing) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!canEdit(existing, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        const release = deps.agentMutations.tryBeginMutation(existing.id)
        if (!release) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'agent move is in progress; retry the delete' })
        }
        const memoryRelease = deps.memoryConnectionMutations.tryBeginMutation(
          externalMemoryConnectionIds(existing.memory)
        )
        if (!memoryRelease) {
          release()
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'external memory connection is being updated; retry the delete'
          })
        }
        try {
          const current = await refreshMutationAgent(existing)
          if (!current) {
            return reply
              .code(409)
              .send({ error: 'Conflict', statusCode: 409, message: 'agent changed; refresh and retry the delete' })
          }
          // AgentRepo holds the shared agent lifecycle lock while it captures
          // every HookDef, tombstones their durable review projections, and
          // cascades the Agent/HookDef rows in one transaction.
          const removedHooks = await deps.repos.agent.delete(AgentId(req.params.id))
          await replicateRemove(current.id, current.daemonId)
          if (current.daemonId && current.memory?.provider === 'external') {
            await removeExternalMemoryFromDaemonIfUnused(current.orgId, current.daemonId, current.memory.connectionId)
          }
          for (const h of removedHooks) deps.hooks.remove(h.id)
          return reply.code(204).send(null)
        } finally {
          memoryRelease()
          release()
        }
      }
    )

    // Set who can see this agent (visibility + share set). Gated exactly like a
    // content edit (canManageSharing === canEdit, §13.3): viewers can't, and a
    // collaborator who can't even view a restricted agent 404s. Visibility never
    // rides the wire, so there's nothing to replicate to the daemon.
    r.put(
      '/agents/:id/sharing',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Set agent sharing',
          description:
            'Set the agent’s visibility (org-wide vs restricted) and share set. Requires edit rights on the agent; sharedWith is intersected with current org members.',
          operationId: 'setAgentSharing',
          params: IdParam,
          body: SetSharingBody,
          response: { 200: AgentDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const existing = await getOrgAgent(req, req.params.id)
        if (!existing) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!canManageSharing(existing, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot change sharing' })
        }
        const release = deps.agentMutations.tryBeginMutation(existing.id)
        if (!release) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'agent move is in progress; retry the edit' })
        }
        try {
          if (!(await refreshMutationAgent(existing))) {
            return reply
              .code(409)
              .send({ error: 'Conflict', statusCode: 409, message: 'agent changed; refresh and retry the edit' })
          }
          const sharedWith = await resolveShareSet(deps.repos.user, orgOf(req), req.body.sharedWith)
          const agent = await deps.repos.agent.setSharing(
            AgentId(req.params.id),
            { visibility: req.body.visibility, sharedWith },
            req.principal?.userId
          )
          return toDto(
            agent,
            ctxOf(req),
            await secretKeysOf(agent.id),
            await hookKindsOf(deps, agent.id),
            iconBasesOf(deps),
            await sandboxPolicyFor(deps, agent)
          )
        } finally {
          release()
        }
      }
    )

    r.put(
      '/agents/:id/call-policy',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Set directional agent visibility',
          description:
            'Set which peer agents may call this agent and which peers this agent may discover or call. Effective access requires both directions to allow it. Requires edit rights; allow-lists are intersected with visible same-org peer agents.',
          operationId: 'setAgentCallPolicy',
          params: IdParam,
          body: SetAgentCallPolicyBody,
          response: { 200: AgentDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const existing = await getOrgAgent(req, req.params.id)
        if (!existing) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!canEdit(existing, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        const release = deps.agentMutations.tryBeginMutation(existing.id)
        if (!release) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'agent move is in progress; retry the edit' })
        }
        try {
          const current = await refreshMutationAgent(existing)
          if (!current) {
            return reply
              .code(409)
              .send({ error: 'Conflict', statusCode: 409, message: 'agent changed; refresh and retry the edit' })
          }
          const allowedCallerAgentIds =
            req.body.callPolicy === 'selected'
              ? await resolvePolicyAgentIds(
                  req,
                  req.params.id,
                  req.body.allowedCallerAgentIds,
                  current.allowedCallerAgentIds
                )
              : []
          const outboundPolicy = req.body.outboundPolicy ?? current.outboundPolicy
          const requestedTargetAgentIds =
            req.body.allowedTargetAgentIds ??
            (req.body.outboundPolicy === undefined ? current.allowedTargetAgentIds : [])
          const allowedTargetAgentIds =
            outboundPolicy === 'selected'
              ? await resolvePolicyAgentIds(req, req.params.id, requestedTargetAgentIds, current.allowedTargetAgentIds)
              : []
          const agent = await deps.repos.agent.setCallPolicy(
            AgentId(req.params.id),
            {
              callPolicy: req.body.callPolicy,
              allowedCallerAgentIds,
              outboundPolicy,
              allowedTargetAgentIds
            },
            req.principal?.userId
          )
          // Push both policy replicas immediately: AgentSpec serves same-daemon
          // authorization; the collaboration snapshot serves directory/relay/target
          // authorization. Reconnect reconciliation remains the offline backstop.
          await Promise.all([replicateUpsert(agent), deps.collabRoutes.broadcast(agent.orgId)])
          return toDto(
            agent,
            ctxOf(req),
            await secretKeysOf(agent.id),
            await hookKindsOf(deps, agent.id),
            iconBasesOf(deps),
            await sandboxPolicyFor(deps, agent)
          )
        } finally {
          release()
        }
      }
    )

    // Workspace browser: proxy one directory page live from the owning daemon.
    // The CP stores NO workspace data (body-locality §1/§12) — a missing dir is
    // data (`exists:false`), not an error. 503 when unplaced/daemon offline.
    r.get(
      '/agents/:id/workspace/files',
      {
        schema: {
          tags: [Tag.Workspace],
          summary: 'List workspace files',
          description:
            'Proxy one directory page live from the owning daemon; a missing directory is data (exists:false), not an error. 503 when unplaced or the daemon is offline.',
          operationId: 'listAgentWorkspaceFiles',
          params: IdParam,
          querystring: WorkspaceFilesQueryDto,
          response: { 200: WorkspaceFilesDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }

        try {
          const page = await deps.control.workspaceList(agent.daemonId, {
            agentId: agent.id,
            path: req.query.path ?? '',
            ...(req.query.cursor !== undefined ? { cursor: req.query.cursor } : {}),
            limit: req.query.limit ?? 200
          })
          return toWorkspaceFilesDto(page)
        } catch (err) {
          const unavailable = daemonEdgeFailure(err)
          if (unavailable !== null) {
            return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: unavailable })
          }
          throw err
        }
      }
    )

    // Workspace file view: proxy one byte slice live from the owning daemon
    // (64 KiB default; the UI pages with `offset` while `truncated`). A missing
    // file is data (`exists:false`); binary files come back `encoding:'none'`.
    r.get(
      '/agents/:id/workspace/file',
      {
        schema: {
          tags: [Tag.Workspace],
          summary: 'Read a workspace file',
          description:
            'Proxy one byte slice of a file live from the owning daemon (64 KiB default; page with offset while truncated). A missing file is data (exists:false); binary files come back encoding:none.',
          operationId: 'readAgentWorkspaceFile',
          params: IdParam,
          querystring: WorkspaceFileQueryDto,
          response: { 200: WorkspaceFileDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }

        try {
          const rep = await deps.control.workspaceRead(agent.daemonId, {
            agentId: agent.id,
            path: req.query.path,
            offset: req.query.offset ?? 0,
            limit: req.query.limit ?? 65536
          })
          return toWorkspaceFileDto(rep)
        } catch (err) {
          const unavailable = daemonEdgeFailure(err)
          if (unavailable !== null) {
            return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: unavailable })
          }
          throw err
        }
      }
    )

    // Create or replace one scratch-workspace text file. The caller must be able
    // to edit the agent; bytes transit to the daemon and are never persisted here.
    r.put(
      '/agents/:id/workspace/file',
      {
        schema: {
          tags: [Tag.Workspace],
          summary: 'Create or replace a scratch workspace file',
          description:
            'Atomically create or replace one UTF-8 file in a scratch workspace on the owning daemon. Requires edit access to the agent. Creation never overwrites an existing file; replacement requires the mtime returned by the last read. Conflicts return 409. GitHub workspaces remain read-only. The control plane stores no file content.',
          operationId: 'putAgentWorkspaceFile',
          params: IdParam,
          querystring: PutWorkspaceFileQueryDto,
          body: PutWorkspaceFileBody,
          response: {
            200: WorkspaceFileWriteDto,
            400: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        if (agent.workspace.mode !== 'scratch') {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: 'workspace files are editable only in scratch workspaces'
          })
        }
        if (Buffer.byteLength(req.body.content, 'utf8') > MAX_WORKSPACE_EDIT_BYTES) {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: `workspace file exceeds the ${MAX_WORKSPACE_EDIT_BYTES}-byte edit limit`
          })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }

        const daemon = await deps.registry.get(agent.daemonId)
        if (!daemon?.capabilities.features.includes('workspace-file-edit-v1')) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'this agent version does not support workspace file editing'
          })
        }

        try {
          const writeReq = {
            agentId: agent.id,
            path: req.query.path,
            contentBase64: Buffer.from(req.body.content, 'utf8').toString('base64'),
            ...(req.body.ifMatchMtime ? { ifMatchMtime: req.body.ifMatchMtime } : {})
          }
          const ok = await deps.control.workspaceWrite(agent.daemonId, writeReq)
          return { path: ok.path, size: ok.size, mtime: ok.mtime }
        } catch (err) {
          if (err instanceof ProtocolError && err.code === 'CONFLICT') {
            return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: err.message })
          }
          if (err instanceof ProtocolError && err.code === 'BAD_PAYLOAD') {
            return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: err.message })
          }
          const unavailable = daemonEdgeFailure(err)
          if (unavailable !== null) {
            return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: unavailable })
          }
          throw err
        }
      }
    )

    // Agent memory: a directory at the agent root (outside the workspace) — a
    // MEMORY.md index plus topic files — proxied live from the owning daemon. A
    // not-yet-created file/dir is data (`exists:false`). The CP stores nothing
    // (body-locality §1/§12). Convenience: `GET …/memory` reads the index.
    r.get(
      '/agents/:id/memory',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Read the agent memory index',
          description:
            "Proxy the agent's memory index (<agent-root>/memory/MEMORY.md) live from the owning daemon; a not-yet-created file is data (exists:false). 503 when unplaced or the daemon is offline.",
          operationId: 'readAgentMemory',
          params: IdParam,
          querystring: MemoryFileQueryDto,
          response: { 200: AgentMemoryDto, 400: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (agent.memory?.provider === 'none') {
          return toAgentMemoryDto({ agentId: agent.id, path: req.query.path ?? 'MEMORY.md', exists: false })
        }
        if (agent.memory?.provider === 'external') {
          return reply
            .code(400)
            .send({ error: 'Bad Request', statusCode: 400, message: 'external memory does not expose files' })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        try {
          const rep = await deps.control.memoryRead(agent.daemonId, {
            agentId: agent.id,
            path: req.query.path ?? 'MEMORY.md',
            offset: req.query.offset ?? 0,
            limit: req.query.limit ?? 65536
          })
          return toAgentMemoryDto(rep)
        } catch (err) {
          const unavailable = daemonEdgeFailure(err)
          if (unavailable !== null) {
            return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: unavailable })
          }
          throw err
        }
      }
    )

    // List the files in the memory dir (the index + topic files).
    r.get(
      '/agents/:id/memory/files',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List agent memory files',
          description:
            "List the files in the agent's memory dir (MEMORY.md index + topic files) live from the owning daemon. 503 when unplaced or the daemon is offline.",
          operationId: 'listAgentMemoryFiles',
          params: IdParam,
          response: { 200: MemoryFilesDto, 400: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (agent.memory?.provider === 'none') {
          return toMemoryFilesDto({ agentId: agent.id, exists: false, entries: [] })
        }
        if (agent.memory?.provider === 'external') {
          return reply
            .code(400)
            .send({ error: 'Bad Request', statusCode: 400, message: 'external memory does not expose files' })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        try {
          const rep = await deps.control.memoryList(agent.daemonId, { agentId: agent.id })
          return toMemoryFilesDto(rep)
        } catch (err) {
          const unavailable = daemonEdgeFailure(err)
          if (unavailable !== null) {
            return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: unavailable })
          }
          throw err
        }
      }
    )

    // Read one memory file (`?path=` defaults to the MEMORY.md index).
    r.get(
      '/agents/:id/memory/file',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Read a memory file',
          description:
            'Proxy one byte slice of a memory file (?path defaults to MEMORY.md) live from the owning daemon; a missing file is data (exists:false). 503 when unplaced or the daemon is offline.',
          operationId: 'readAgentMemoryFile',
          params: IdParam,
          querystring: MemoryFileQueryDto,
          response: { 200: AgentMemoryDto, 400: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (agent.memory?.provider === 'none') {
          return toAgentMemoryDto({ agentId: agent.id, path: req.query.path ?? 'MEMORY.md', exists: false })
        }
        if (agent.memory?.provider === 'external') {
          return reply
            .code(400)
            .send({ error: 'Bad Request', statusCode: 400, message: 'external memory does not expose files' })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        try {
          const rep = await deps.control.memoryRead(agent.daemonId, {
            agentId: agent.id,
            path: req.query.path ?? 'MEMORY.md',
            offset: req.query.offset ?? 0,
            limit: req.query.limit ?? 65536
          })
          return toAgentMemoryDto(rep)
        } catch (err) {
          const unavailable = daemonEdgeFailure(err)
          if (unavailable !== null) {
            return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: unavailable })
          }
          throw err
        }
      }
    )

    // Replace one memory file (console edit; `?path=` defaults to the index). Write
    // is gated exactly like a content edit (`canEdit`); the daemon owns the file.
    r.put(
      '/agents/:id/memory/file',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Replace a memory file',
          description:
            'Replace one memory file (?path defaults to MEMORY.md) on the owning daemon; returns the written size/mtime. `ifMatchMtime` (optional) is optimistic concurrency — a 409 if the file changed under you. Requires edit permission. 503 when unplaced or the daemon is offline.',
          operationId: 'putAgentMemoryFile',
          params: IdParam,
          querystring: PutMemoryFileQueryDto,
          body: PutAgentMemoryBody,
          response: {
            200: AgentMemoryWriteDto,
            400: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        if (agent.memory?.provider === 'none') {
          return reply
            .code(400)
            .send({ error: 'Bad Request', statusCode: 400, message: 'memory is disabled for this agent' })
        }
        if (agent.memory?.provider === 'external') {
          return reply
            .code(400)
            .send({ error: 'Bad Request', statusCode: 400, message: 'external memory does not expose files' })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        try {
          const ok = await deps.control.memoryWrite(agent.daemonId, {
            agentId: agent.id,
            path: req.query.path ?? 'MEMORY.md',
            content: req.body.content,
            ...(req.body.ifMatchMtime ? { ifMatchMtime: req.body.ifMatchMtime } : {})
          })
          return { path: ok.path, size: ok.size, mtime: ok.mtime }
        } catch (err) {
          // The daemon rejects a stale write (CONFLICT) or an over-budget / bad-path
          // write (BAD_PAYLOAD) — surface those as 409 / 400, not the generic 503.
          if (err instanceof ProtocolError && err.code === 'CONFLICT') {
            return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: err.message })
          }
          if (err instanceof ProtocolError && err.code === 'BAD_PAYLOAD') {
            return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: err.message })
          }
          const unavailable = daemonEdgeFailure(err)
          if (unavailable !== null) {
            return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: unavailable })
          }
          throw err
        }
      }
    )

    // Provider-neutral memory administration. Files remain on the legacy routes
    // above; external providers expose canonical records below. The CP is a
    // transient proxy only: record/query bodies are never persisted or logged.
    r.get(
      '/agents/:id/memory/surface',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Get the agent memory administration surface',
          operationId: 'getAgentMemorySurface',
          params: IdParam,
          response: { 200: MemorySurfaceDto, 400: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        const provider = agent.memory?.provider ?? 'managed'
        if (provider === 'none') return { shape: 'none' as const, capabilities: [] }
        if (provider !== 'external') return { shape: 'files' as const, capabilities: [] }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        try {
          return toMemorySurfaceDto(await deps.control.memorySurface(agent.daemonId, { agentId: agent.id }))
        } catch (err) {
          const failure = memoryAdminFailure(err)
          if (failure)
            return reply
              .code(failure.status)
              .send({ error: failure.error, statusCode: failure.status, message: failure.message })
          throw err
        }
      }
    )

    r.post(
      '/agents/:id/memory/records/search',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Search external-memory records',
          operationId: 'searchAgentMemoryRecords',
          params: IdParam,
          body: MemoryRecordSearchBodyDto,
          response: { 200: MemoryRecordPageDto, 400: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (agent.memory?.provider !== 'external') {
          return reply
            .code(400)
            .send({ error: 'Bad Request', statusCode: 400, message: 'record memory is not enabled' })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        try {
          return toMemoryRecordPageDto(
            await deps.control.memoryRecordSearch(agent.daemonId, {
              agentId: agent.id,
              query: req.body.query,
              topK: req.body.topK ?? 20,
              maxBytes: req.body.maxBytes ?? 32768
            })
          )
        } catch (err) {
          const failure = memoryAdminFailure(err)
          if (failure)
            return reply
              .code(failure.status)
              .send({ error: failure.error, statusCode: failure.status, message: failure.message })
          throw err
        }
      }
    )

    r.get(
      '/agents/:id/memory/records',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List external-memory records',
          operationId: 'listAgentMemoryRecords',
          params: IdParam,
          querystring: MemoryRecordPageQueryDto,
          response: { 200: MemoryRecordPageDto, 400: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (agent.memory?.provider !== 'external') {
          return reply
            .code(400)
            .send({ error: 'Bad Request', statusCode: 400, message: 'record memory is not enabled' })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        try {
          return toMemoryRecordPageDto(
            await deps.control.memoryRecordList(agent.daemonId, {
              agentId: agent.id,
              ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
              limit: req.query.limit ?? 20
            })
          )
        } catch (err) {
          const failure = memoryAdminFailure(err)
          if (failure)
            return reply
              .code(failure.status)
              .send({ error: failure.error, statusCode: failure.status, message: failure.message })
          throw err
        }
      }
    )

    r.post(
      '/agents/:id/memory/records',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Create an external-memory record',
          operationId: 'createAgentMemoryRecord',
          params: IdParam,
          body: CreateMemoryRecordBody,
          response: {
            200: MemoryRecordResultDto,
            400: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        if (agent.memory?.provider !== 'external') {
          return reply
            .code(400)
            .send({ error: 'Bad Request', statusCode: 400, message: 'record memory is not enabled' })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        try {
          return toMemoryRecordResultDto(
            await deps.control.memoryRecordCreate(agent.daemonId, {
              agentId: agent.id,
              operationId: randomUUID(),
              text: req.body.text,
              ...(req.body.metadata ? { metadata: req.body.metadata } : {})
            })
          )
        } catch (err) {
          const failure = memoryAdminFailure(err)
          if (failure)
            return reply
              .code(failure.status)
              .send({ error: failure.error, statusCode: failure.status, message: failure.message })
          throw err
        }
      }
    )

    r.get(
      '/agents/:id/memory/records/:recordId',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Get an external-memory record',
          operationId: 'getAgentMemoryRecord',
          params: MemoryRecordParamDto,
          response: { 200: MemoryRecordGetResultDto, 400: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (agent.memory?.provider !== 'external') {
          return reply
            .code(400)
            .send({ error: 'Bad Request', statusCode: 400, message: 'record memory is not enabled' })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        try {
          return toMemoryRecordGetResultDto(
            await deps.control.memoryRecordGet(agent.daemonId, { agentId: agent.id, id: req.params.recordId })
          )
        } catch (err) {
          const failure = memoryAdminFailure(err)
          if (failure)
            return reply
              .code(failure.status)
              .send({ error: failure.error, statusCode: failure.status, message: failure.message })
          throw err
        }
      }
    )

    r.put(
      '/agents/:id/memory/records/:recordId',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Update an external-memory record',
          operationId: 'updateAgentMemoryRecord',
          params: MemoryRecordParamDto,
          body: UpdateMemoryRecordBody,
          response: {
            200: MemoryRecordResultDto,
            400: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        if (agent.memory?.provider !== 'external') {
          return reply
            .code(400)
            .send({ error: 'Bad Request', statusCode: 400, message: 'record memory is not enabled' })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        try {
          return toMemoryRecordResultDto(
            await deps.control.memoryRecordUpdate(agent.daemonId, {
              agentId: agent.id,
              operationId: randomUUID(),
              id: req.params.recordId,
              text: req.body.text,
              ...(req.body.metadata ? { metadata: req.body.metadata } : {}),
              ...(req.body.version ? { version: req.body.version } : {})
            })
          )
        } catch (err) {
          const failure = memoryAdminFailure(err)
          if (failure)
            return reply
              .code(failure.status)
              .send({ error: failure.error, statusCode: failure.status, message: failure.message })
          throw err
        }
      }
    )

    r.delete(
      '/agents/:id/memory/records/:recordId',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Delete an external-memory record',
          operationId: 'deleteAgentMemoryRecord',
          params: MemoryRecordParamDto,
          body: DeleteMemoryRecordBody,
          response: {
            200: MemoryRecordDeleteResultDto,
            400: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        if (agent.memory?.provider !== 'external') {
          return reply
            .code(400)
            .send({ error: 'Bad Request', statusCode: 400, message: 'record memory is not enabled' })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        try {
          return toMemoryRecordDeleteResultDto(
            await deps.control.memoryRecordDelete(agent.daemonId, {
              agentId: agent.id,
              operationId: randomUUID(),
              id: req.params.recordId,
              ...(req.body.version ? { version: req.body.version } : {})
            })
          )
        } catch (err) {
          const failure = memoryAdminFailure(err)
          if (failure)
            return reply
              .code(failure.status)
              .send({ error: failure.error, statusCode: failure.status, message: failure.message })
          throw err
        }
      }
    )

    r.get(
      '/agents/:id/memory/records/:recordId/history',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List external-memory record history',
          operationId: 'listAgentMemoryRecordHistory',
          params: MemoryRecordParamDto,
          querystring: MemoryRecordPageQueryDto,
          response: {
            200: MemoryRecordHistoryPageDto,
            400: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (agent.memory?.provider !== 'external') {
          return reply
            .code(400)
            .send({ error: 'Bad Request', statusCode: 400, message: 'record memory is not enabled' })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        try {
          return toMemoryRecordHistoryPageDto(
            await deps.control.memoryRecordHistory(agent.daemonId, {
              agentId: agent.id,
              id: req.params.recordId,
              ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
              limit: req.query.limit ?? 20
            })
          )
        } catch (err) {
          const failure = memoryAdminFailure(err)
          if (failure)
            return reply
              .code(failure.status)
              .send({ error: failure.error, statusCode: failure.status, message: failure.message })
          throw err
        }
      }
    )

    // ── Memory dreaming (docs/designs/memory-dreaming.md §10) ──────────────────
    // Offline consolidation jobs over the managed store. The CP is a pure relay
    // here: lifecycle + staged-output review are forwarded to the owning daemon
    // and nothing (metadata or bodies) is persisted CP-side — list/get require a
    // live daemon (offline metadata caching is deferred, design §8/§10).
    // Managed-provider only; a non-managed agent is a 400. Lifecycle mutations
    // require edit rights (viewers get 403).

    /** Guard: managed provider + a live daemon, or the right 4xx/503 reply.
     *  `edit: true` additionally requires edit rights (403 for a viewer) — dream
     *  lifecycle mutations run agent work or replace the live store, so they must
     *  match the viewer-read-only invariant of the other memory mutations. */
    const dreamAgentOrReply = async (
      req: FastifyRequest,
      reply: FastifyReply,
      id: string,
      edit = false
    ): Promise<(AgentRecord & { daemonId: string }) | null> => {
      const agent = await getOrgAgent(req, id)
      if (!agent) {
        await reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        return null
      }
      if (edit && !canEdit(agent, ctxOf(req))) {
        await reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        return null
      }
      if (agent.memory?.provider !== undefined && agent.memory.provider !== 'managed') {
        await reply
          .code(400)
          .send({ error: 'Bad Request', statusCode: 400, message: 'dreaming requires the managed memory provider' })
        return null
      }
      if (!agent.daemonId) {
        await reply
          .code(503)
          .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        return null
      }
      // Version skew: refuse before we send a frame the daemon would drop.
      if (!dreamingSupportedOn(await deps.registry.get(agent.daemonId))) {
        await reply.code(409).send({
          error: 'Conflict',
          statusCode: 409,
          message: 'this agent version does not support memory dreaming; upgrade its daemon',
          // Machine-readable so the console can hide the panel instead of
          // string-matching the prose.
          code: 'DAEMON_FEATURE_MISSING'
        })
        return null
      }
      return agent as AgentRecord & { daemonId: string }
    }

    const sendDreamFailure = (reply: FastifyReply, err: unknown): boolean => {
      const failure = memoryAdminFailure(err)
      if (!failure) return false
      void reply
        .code(failure.status)
        .send({ error: failure.error, statusCode: failure.status, message: failure.message })
      return true
    }

    // Start a dream (manual trigger).
    r.post(
      '/agents/:id/memory/dreams',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Start a memory dream',
          description:
            'Kick off an offline consolidation job over the managed store on the owning daemon. Returns the pending job; poll it for status. 400 if dreaming is not enabled, 409 if one is already in flight, 503 when the daemon is offline.',
          operationId: 'startAgentMemoryDream',
          params: IdParam,
          body: StartDreamBody,
          response: { 200: DreamDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await dreamAgentOrReply(req, reply, req.params.id, true)
        if (!agent) return
        try {
          const { dream } = await deps.control.dreamStart(agent.daemonId, {
            agentId: agent.id,
            trigger: 'manual',
            ...(req.body.sessionWindow !== undefined ? { sessionWindow: req.body.sessionWindow } : {}),
            ...(req.body.instructions !== undefined ? { instructions: req.body.instructions } : {})
          })
          return toDreamDto(dream)
        } catch (err) {
          if (sendDreamFailure(reply, err)) return
          throw err
        }
      }
    )

    // List an agent's dream jobs (newest first).
    r.get(
      '/agents/:id/memory/dreams',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List memory dreams',
          description: "List the agent's memory dream jobs (newest first), proxied from the owning daemon.",
          operationId: 'listAgentMemoryDreams',
          params: IdParam,
          querystring: z.object({ limit: z.coerce.number().int().positive().max(50).optional() }),
          response: { 200: DreamListDto, 400: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await dreamAgentOrReply(req, reply, req.params.id)
        if (!agent) return
        try {
          return toDreamListDto(
            await deps.control.dreamList(agent.daemonId, { agentId: agent.id, limit: req.query.limit ?? 20 })
          )
        } catch (err) {
          if (sendDreamFailure(reply, err)) return
          throw err
        }
      }
    )

    // Fetch one dream job's metadata.
    r.get(
      '/agents/:id/memory/dreams/:dreamId',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Get a memory dream',
          description: "Fetch one dream job's metadata (never staged bodies), proxied from the owning daemon.",
          operationId: 'getAgentMemoryDream',
          params: DreamIdParam,
          response: { 200: DreamDto, 400: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await dreamAgentOrReply(req, reply, req.params.id)
        if (!agent) return
        try {
          const { dream } = await deps.control.dreamGet(agent.daemonId, {
            agentId: agent.id,
            dreamId: req.params.dreamId
          })
          return toDreamDto(dream)
        } catch (err) {
          if (sendDreamFailure(reply, err)) return
          throw err
        }
      }
    )

    // Cancel a pending|running dream.
    r.post(
      '/agents/:id/memory/dreams/:dreamId/cancel',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Cancel a memory dream',
          description:
            'Cancel a pending or running dream on the owning daemon (cancel-wins; a late extraction result is never staged). 409 if the dream is already terminal.',
          operationId: 'cancelAgentMemoryDream',
          params: DreamIdParam,
          response: { 200: DreamDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await dreamAgentOrReply(req, reply, req.params.id, true)
        if (!agent) return
        try {
          const { dream } = await deps.control.dreamCancel(agent.daemonId, {
            agentId: agent.id,
            dreamId: req.params.dreamId
          })
          return toDreamDto(dream)
        } catch (err) {
          if (sendDreamFailure(reply, err)) return
          throw err
        }
      }
    )

    // Adopt a completed dream's staged store (fenced; `force` overrides the fence).
    r.post(
      '/agents/:id/memory/dreams/:dreamId/adopt',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Adopt a memory dream',
          description:
            "Atomically replace the agent's live managed store with this dream's staged output (with a backup). Fenced against changes since the snapshot unless `force` is set. 409 on a fence conflict or a non-completed dream.",
          operationId: 'adoptAgentMemoryDream',
          params: DreamIdParam,
          body: AdoptDreamBody,
          response: { 200: DreamDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await dreamAgentOrReply(req, reply, req.params.id, true)
        if (!agent) return
        try {
          const { dream } = await deps.control.dreamAdopt(agent.daemonId, {
            agentId: agent.id,
            dreamId: req.params.dreamId,
            force: req.body.force ?? false
          })
          return toDreamDto(dream)
        } catch (err) {
          if (sendDreamFailure(reply, err)) return
          throw err
        }
      }
    )

    // Discard a terminal dream's staged output (keeps the job record).
    r.post(
      '/agents/:id/memory/dreams/:dreamId/discard',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Discard a memory dream',
          description:
            "Delete a terminal dream's staged output on the owning daemon, keeping the job record for history. 409 if the dream is not in a terminal state.",
          operationId: 'discardAgentMemoryDream',
          params: DreamIdParam,
          response: { 200: DreamDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await dreamAgentOrReply(req, reply, req.params.id, true)
        if (!agent) return
        try {
          const { dream } = await deps.control.dreamDiscard(agent.daemonId, {
            agentId: agent.id,
            dreamId: req.params.dreamId
          })
          return toDreamDto(dream)
        } catch (err) {
          if (sendDreamFailure(reply, err)) return
          throw err
        }
      }
    )

    // List a dream's staged output files (the review surface).
    r.get(
      '/agents/:id/memory/dreams/:dreamId/files',
      {
        schema: {
          tags: [Tag.Agents],
          summary: "List a dream's staged files",
          description:
            "List the files in this dream's staged output store (index + topics). Nothing staged yet is data (exists:false), not an error.",
          operationId: 'listAgentMemoryDreamFiles',
          params: DreamIdParam,
          response: { 200: DreamFilesDto, 400: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await dreamAgentOrReply(req, reply, req.params.id)
        if (!agent) return
        try {
          return toDreamFilesDto(
            await deps.control.dreamFiles(agent.daemonId, { agentId: agent.id, dreamId: req.params.dreamId })
          )
        } catch (err) {
          if (sendDreamFailure(reply, err)) return
          throw err
        }
      }
    )

    // Read one byte slice of a dream's staged file (memory/read semantics).
    r.get(
      '/agents/:id/memory/dreams/:dreamId/file',
      {
        schema: {
          tags: [Tag.Agents],
          summary: "Read a dream's staged file",
          description:
            'Proxy one byte slice of a staged output file (default the MEMORY.md index) live from the owning daemon. `nextOffset` is authoritative — clients must not recompute it.',
          operationId: 'readAgentMemoryDreamFile',
          params: DreamIdParam,
          querystring: MemoryFileQueryDto,
          response: { 200: DreamFileDto, 400: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await dreamAgentOrReply(req, reply, req.params.id)
        if (!agent) return
        try {
          return toDreamFileDto(
            await deps.control.dreamFileRead(agent.daemonId, {
              agentId: agent.id,
              dreamId: req.params.dreamId,
              path: req.query.path ?? 'MEMORY.md',
              offset: req.query.offset ?? 0,
              limit: req.query.limit ?? 65536
            })
          )
        } catch (err) {
          if (sendDreamFailure(reply, err)) return
          throw err
        }
      }
    )

    // Workspace git status: is the owning daemon's checkout clean? A dirty tree or
    // a from-scratch (non-repo) workspace is data (`clean`/`isRepo`), not an error.
    r.get(
      '/agents/:id/workspace/gitstatus',
      {
        schema: {
          tags: [Tag.Workspace],
          summary: 'Get workspace git status',
          description:
            'Report whether the owning daemon’s checkout is clean; a dirty tree or a from-scratch (non-repo) workspace is data (clean/isRepo), not an error.',
          operationId: 'getAgentWorkspaceGitStatus',
          params: IdParam,
          response: { 200: WorkspaceGitStatusDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        // Route through getOrgAgent (org boundary + canView) — a bare repo.get here
        // would leak a restricted / cross-org agent's checkout state.
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }

        try {
          const rep = await deps.control.workspaceGitStatus(agent.daemonId, { agentId: agent.id })
          const ws = agent.workspace
          const cfg =
            ws.mode === 'github' ? { repo: ws.gitRepo, ...(ws.agentDir ? { agentDir: ws.agentDir } : {}) } : {}
          return toWorkspaceGitStatusDto(rep, cfg)
        } catch (err) {
          const unavailable = daemonEdgeFailure(err)
          if (unavailable !== null) {
            return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: unavailable })
          }
          throw err
        }
      }
    )

    // Workspace git pull: force an on-demand ff-only pull on the owning daemon. A
    // pull that can't fast-forward (offline, diverged, local edits) is data
    // (`ok:false` + `detail`), not an HTTP error — only an offline daemon → 503.
    r.post(
      '/agents/:id/workspace/gitpull',
      {
        schema: {
          tags: [Tag.Workspace],
          summary: 'Pull the workspace',
          description:
            'Force an on-demand ff-only pull on the owning daemon; a pull that can’t fast-forward (diverged, local edits) is data (ok:false + detail), only an offline daemon yields 503.',
          operationId: 'pullAgentWorkspace',
          params: IdParam,
          response: { 200: WorkspaceGitPullDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        // Route through getOrgAgent (org boundary + canView) — a bare repo.get here
        // would let a non-viewer trigger a pull on a restricted / cross-org agent.
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }

        try {
          const rep = await deps.control.workspaceGitPull(agent.daemonId, { agentId: agent.id })
          return toWorkspaceGitPullDto(rep)
        } catch (err) {
          const unavailable = daemonEdgeFailure(err)
          if (unavailable !== null) {
            return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: unavailable })
          }
          throw err
        }
      }
    )
  }
}
