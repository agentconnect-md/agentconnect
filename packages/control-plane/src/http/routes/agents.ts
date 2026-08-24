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
  WorkspaceGitDiffResult,
  WorkspaceGitLog,
  WorkspaceGitPullResult,
  WorkspaceGitCommitResult,
  WorkspaceGitPushResult,
  WorkspaceGitMessageResult,
  TaskList,
  MemoryReadContent,
  MemoryListPage,
  MemoryHistoryPage,
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
import { gitlabWorkspaceAccessLevel } from '../../gitlab/api.js'
import type { GitlabLiveProject } from '../../gitlab/provisioner.js'
import { gitlabAccountUnavailableMessage } from '../../gitlab/account.service.js'
import {
  MAX_WORKSPACE_EDIT_BYTES,
  AGENT_CONFIG_REVISION_FEATURE,
  ORGANIZATION_KNOWLEDGE_FEATURE,
  WORKSPACE_SESSION_READ_FEATURE,
  WORKSPACE_REPO_SCOPE_FEATURE,
  WORKSPACE_GIT_MESSAGE_FEATURE,
  WORKSPACE_GIT_REVIEW_FEATURE,
  WORKSPACE_GIT_WRITE_FEATURE,
  TASK_LIST_FEATURE,
  RUNTIME_COMMANDS_FEATURE,
  AGENT_WAKE_FEATURE,
  WorkspaceErrorReason,
  TaskErrorReason,
  gitRepoLabel,
  normalizeGitUrl
} from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import {
  type AgentRecord,
  type AgentSkillSourceFence,
  type AgentWorkspace,
  type AssignedOrganizationMetadata,
  type McpProviderRecord,
  isSyntheticEmail
} from '../../persistence/ports.js'
import type { DaemonView } from '../../ports.js'
import { AgentId, DaemonId, OrgId, SessionId } from '../../domain/ids.js'
import { advertises, requiredGitlabFeatures } from '../../domain/daemon-features.js'
import {
  dutyEligibility,
  onSet,
  placementLabel,
  placementTargetOf,
  type PlacementTarget
} from '../../domain/placement.js'
import type { ResolvableAgent } from '../../orchestrator/placementResolver.js'
import { currentMcpGrant, mcpProxyDef, relayHttpOrigin } from '../../orchestrator/mcpProvider.js'
import { serializeByProviderNames } from './mcp-providers.js'

/** Thrown inside the provider-name fence when the in-fence visibility re-check
 *  refuses an enable-list name; the route maps it to a 403. */
class McpEnableDenied extends Error {}
/** The skill-source twin: thrown inside the source-name fence when the in-fence
 *  visibility re-check refuses a submitted skill-ref; the route maps it to a 403. */
class SkillEnableDenied extends Error {}
import { parseSkillRef, redactSourceCredentials } from '../../orchestrator/skillSource.js'
import { memoryConnectionSpec, stdioMemoryConnectionSpec } from '../../orchestrator/memoryConnection.js'
import { orgOf, denyViewerWrite, ctxOf } from '../rbac.js'
import { refreshMutationAgent as refreshAgentUnderMutation } from '../mutation-agent.js'
import { canView, canViewSession, canEdit, canManageSharing, type ViewCtx } from '../../authorization/policy.js'
import { makeSessionAccessResolver } from '../session-access.js'
import { resolveShareSet } from '../sharing.js'
import { resolveAgentIconUrl, type IconUrlBases } from '../../agents/agent-icon.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { AgentMoveConflict, AgentMoveFailed } from '../../orchestrator/agentMove.js'
import { AgentWakeCoordinator } from '../../orchestrator/agentWake.js'
import { convergeIntegrationGating } from '../../orchestrator/integrationPush.js'
import { reconcileAgentLinkedDms } from '../../orchestrator/linkedDmReconcile.js'
import { ProtocolError } from '../../domain/errors.js'
import {
  AGENT_WORKSPACE_INTEGRATION_CONFLICT_MESSAGE,
  MemoryConnectionBusy,
  MemoryConnectionMissing
} from '../../persistence/errors.js'
import { OrganizationEnvironmentAdmissionError } from '../../persistence/repositories/organization-environment-fence.js'
import {
  CreateAgentBody,
  SetAgentWorkspaceBody,
  UpdateAgentBody,
  SetAgentDaemonBody,
  SetSharingBody,
  SetAgentCallPolicyBody,
  AgentDto,
  AgentPermissionRequestPageDto,
  AgentSkillSourceListDto,
  AgentPermissionDecisionBody,
  AgentCreatedDto,
  AgentListDto,
  ErrorDto,
  IdParam,
  WorkspaceFilesQueryDto,
  WorkspaceRepoScopeQueryDto,
  WorkspaceScopeQueryDto,
  WorkspaceFilesDto,
  WorkspaceFileQueryDto,
  WorkspaceFileDto,
  PutWorkspaceFileQueryDto,
  PutWorkspaceFileBody,
  WorkspaceFileWriteDto,
  DeleteWorkspaceFileQueryDto,
  WorkspaceFileDeleteDto,
  WorkspaceGitStatusDto,
  WorkspaceGitDiffQueryDto,
  WorkspaceGitDiffDto,
  WorkspaceGitLogQueryDto,
  WorkspaceGitLogDto,
  WorkspaceGitPullDto,
  WorkspaceGitStageBody,
  WorkspaceGitCommitBody,
  WorkspaceGitCommitResultDto,
  WorkspaceGitPushResultDto,
  WorkspaceGitMessageResultDto,
  AgentTasksQueryDto,
  AgentTasksDto,
  AgentWakeDto,
  AgentMemoryDto,
  MemoryFilesDto,
  MemoryFilesQueryDto,
  MemoryChannelsDto,
  MemoryFileQueryDto,
  PutMemoryFileQueryDto,
  PutAgentMemoryBody,
  AgentMemoryWriteDto,
  MemoryHistoryQueryDto,
  MemoryHistoryPageDto,
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
  DreamSkillParam,
  DreamSkillContentDto,
  LocalSkillsDto,
  RuntimeCommandsDto,
  StartDreamBody,
  AdoptDreamBody,
  AcceptDreamSkillBody,
  type AgentDtoT,
  type WorkspaceFilesDtoT,
  type WorkspaceFileDtoT,
  type WorkspaceGitStatusDtoT,
  type WorkspaceGitDiffDtoT,
  type WorkspaceGitLogDtoT,
  type WorkspaceGitPullDtoT,
  type WorkspaceGitCommitResultDtoT,
  type WorkspaceGitPushResultDtoT,
  type WorkspaceGitMessageResultDtoT,
  type AgentTasksDtoT,
  type AgentMemoryDtoT,
  type MemoryFilesDtoT,
  type MemoryHistoryPageDtoT,
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
import { buildAgentMoves } from '../agent-moves.js'
import { GithubApiError } from '../../github/api.js'
import { LogtoApiError } from '../../github/logto-identity.js'
import { UserAuthzDeniedError } from '../../github/user-authz.js'
import { syncAgentBotIcons } from '../agent-bot-icon-sync.js'

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

function organizationKnowledgeSupportedOn(daemon: DaemonView | null): boolean {
  return !!daemon?.capabilities.features.includes(ORGANIZATION_KNOWLEDGE_FEATURE)
}

/** Does this daemon persist and enforce the monotonic `AgentSpec.configRevision`?
 *  The precondition for placing an agent bound to an organization environment entry
 *  (organization-secrets-and-variables.md §10). */
function configRevisionSupportedOn(daemon: DaemonView | null): boolean {
  return !!daemon?.capabilities.features.includes(AGENT_CONFIG_REVISION_FEATURE)
}

/** No assigned organization rows — the shape a minimal/legacy graph resolves to. */
const NO_ORGANIZATION_ENVIRONMENT: AssignedOrganizationMetadata = { variables: [], secretKeys: [] }

function workspaceToDto(workspace: AgentWorkspace, workspaceRepoId?: bigint): AgentDtoT['workspace'] {
  if (workspace.mode === 'scratch') return { mode: 'scratch' }
  if (workspace.mode === 'gitlab') {
    return {
      mode: 'gitlab',
      worktree: workspace.isolation === 'session',
      gitRepo: workspace.gitRepo,
      ...(workspace.gitBranch !== undefined ? { gitBranch: workspace.gitBranch } : {}),
      ...(workspace.agentDir !== undefined ? { agentDir: workspace.agentDir } : {}),
      ...(workspaceRepoId !== undefined ? { projectId: workspaceRepoId.toString() } : {}),
      ...(workspace.gitAccess !== undefined ? { gitAccess: workspace.gitAccess } : {})
    }
  }
  return {
    mode: 'github',
    worktree: workspace.isolation === 'session',
    gitRepo: workspace.gitRepo,
    ...(workspace.gitBranch !== undefined ? { gitBranch: workspace.gitBranch } : {}),
    ...(workspace.agentDir !== undefined ? { agentDir: workspace.agentDir } : {}),
    ...(workspace.mode === 'github' && workspace.installationId !== undefined
      ? { installationId: workspace.installationId }
      : {}),
    ...(workspace.gitAccess !== undefined ? { gitAccess: workspace.gitAccess } : {})
  }
}

function toDto(
  a: AgentRecord,
  ctx: ViewCtx,
  secretKeys: string[],
  hookKinds: AgentDtoT['hookKinds'],
  iconBases: IconUrlBases,
  placementView: PlacementView,
  // Organization entries assigned to THIS agent. Metadata only: variable values
  // plus secret KEY names, resolved without decrypting anything (design §6).
  organizationEnvironment: AssignedOrganizationMetadata = NO_ORGANIZATION_ENVIRONMENT
): AgentDtoT {
  return {
    id: a.id,
    orgId: a.orgId,
    name: a.name,
    displayName: a.displayName,
    builtin: a.builtin,
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
    showStatusBar: a.showStatusBar,
    fastMode: a.fastMode,
    permissionMode: a.permissionMode,
    approvalsReviewer: a.approvalsReviewer ?? null,
    allowRuntimeChangesInChat: a.allowRuntimeChangesInChat,
    pause: a.pause,
    env: a.env,
    // Only the secret NAMES leave the CP (AgentSecretStore.keys — values are
    // write-only and never on the record). Sorted for a stable DTO.
    secretKeys: [...secretKeys].sort(),
    // Read-only inherited rows. A member who can view this agent sees its
    // organization variable values and organization secret key names, and learns
    // nothing about entries assigned only to another agent (§4).
    organizationVariables: organizationEnvironment.variables,
    organizationSecretKeys: organizationEnvironment.secretKeys,
    mcpServers: a.mcpServers,
    skills: a.skills,
    managedSkills: a.managedSkills,
    memory: a.memory,
    status: a.status,
    placementKind: a.placementKind,
    daemonId: a.daemonId,
    daemonName: a.daemonId ? placementView.daemonName : null,
    setId: a.setId,
    placementReady: placementView.ready,
    workspace: workspaceToDto(a.workspace, a.workspaceRepoId),
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
    canEdit: canEdit(a, ctx),
    canManageSharing: canManageSharing(a, ctx),
    callPolicy: a.callPolicy,
    allowedCallerAgentIds: a.allowedCallerAgentIds,
    outboundPolicy: a.outboundPolicy,
    allowedTargetAgentIds: a.allowedTargetAgentIds,
    introduceOnJoin: a.introduceOnJoin,
    runInSandbox: a.runInSandbox,
    sandboxSupported: placementView.sandbox.supported,
    sandboxRequired: placementView.sandbox.required,
    hookKinds
  }
}

/** One placement resolution supplies its display name, sandbox policy, and readiness. */
interface PlacementView {
  daemonName: string | null
  sandbox: SandboxPolicy
  ready: boolean
}

const NO_PLACEMENT: PlacementView = { daemonName: null, sandbox: UNAVAILABLE_SANDBOX, ready: false }

function placementViewOf(deps: HttpDeps, daemon: DaemonView | null): PlacementView {
  const live = daemon ? deps.liveness.get(daemon.daemonId) : undefined
  return {
    daemonName: daemon?.name ?? null,
    sandbox: sandboxPolicyOf(daemon),
    ready: live?.reachable === true && live.state === 'READY'
  }
}

/**
 * The API-sugar edge (daemon-groups.md §4): `{ placementKind: 'pool' }` names THE org-less set, so
 * the console's existing "Cloud" entry needs no change and storage keeps one representation.
 * `{ placementKind: 'set', setId }` names one explicitly; a set belonging to another org is not
 * resolvable here, exactly as another org's daemon is not.
 */
async function resolveTargetSetId(
  deps: HttpDeps,
  orgId: OrgId,
  body: { placementKind?: 'daemon' | 'pool' | 'set'; setId?: string }
): Promise<string | null> {
  if (body.placementKind === 'pool') return deps.repos.memberSet.crossOrgSetId()
  if (body.placementKind !== 'set' || body.setId === undefined) return null
  const set = await deps.repos.memberSet.get(body.setId)
  return set && (set.orgId === null || set.orgId === orgId) ? set.id : null
}

/** The members of a set that could serve an agent right now. One read; reuse it for a page.
 *  Membership is the read — not "org-less daemon", which is only what the pool's membership MEANS
 *  by the write-time invariant (daemon-groups.md §2). */
async function readySetMembers(deps: HttpDeps, orgId: OrgId, setId: string): Promise<DaemonView[]> {
  const [daemons, memberIds] = await Promise.all([
    deps.registry.listAvailable(orgId),
    deps.repos.memberSet.memberIdsOf(setId)
  ])
  const members = new Set(memberIds)
  return daemons.filter((d) => members.has(d.daemonId) && placementViewOf(deps, d).ready)
}

async function placementViewFor(deps: HttpDeps, a: AgentRecord, setMembers?: DaemonView[]): Promise<PlacementView> {
  const eligibility = dutyEligibility(a)
  if (eligibility.scope === 'none') return NO_PLACEMENT
  if (eligibility.scope === 'daemon') {
    // The org-fenced agent read supplies the availability scope for its daemon.
    return placementViewOf(deps, await deps.registry.getAvailable(a.orgId, eligibility.daemonId))
  }
  const members = setMembers ?? (await readySetMembers(deps, OrgId(a.orgId), eligibility.setId))
  return placementViewOf(deps, members[0] ?? null)
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

/** Wire REP → HTTP body for one file slice (see {@link toWorkspaceFilesDto}). `type`
 *  keeps a directory readable as DATA instead of an empty file — or an outage. */
export function toWorkspaceFileDto(rep: WorkspaceReadContent): WorkspaceFileDtoT {
  return {
    path: rep.path,
    exists: rep.exists,
    type: rep.type ?? null,
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

/** Wire REP → bounded HTTP page for managed file provenance. */
export function toMemoryHistoryPageDto(rep: MemoryHistoryPage): MemoryHistoryPageDtoT {
  return { events: rep.events, nextCursor: rep.nextCursor ?? null }
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
    executionSessionId: dream.executionSessionId ?? null,
    runtime: dream.runtime ?? null,
    model: dream.model ?? null,
    stopReason: dream.stopReason ?? null,
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
  return {
    exists: rep.exists,
    files: rep.entries,
    ...(rep.reviewToken !== undefined ? { reviewToken: rep.reviewToken } : {})
  }
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
    files: (rep.files ?? []).map((f) => ({
      path: f.path,
      index: f.index,
      workingDir: f.workingDir,
      additions: f.additions ?? null,
      deletions: f.deletions ?? null
    })),
    truncated: rep.truncated ?? false,
    lastCommit: rep.lastCommit ?? null,
    lastFetchAt: rep.lastFetchAt ?? null
  }
}

/** The config half of a git-status body: the daemon reports only live checkout facts, so
 *  the configured repo/subdir are folded in from the agent. Shared by every route that
 *  answers with a `WorkspaceGitStatusDto` (the status read and both stage writes). */
export function workspaceGitConfigOf(agent: AgentRecord): { repo?: string; agentDir?: string } {
  const ws = agent.workspace
  return ws.mode === 'github' ? { repo: ws.gitRepo, ...(ws.agentDir ? { agentDir: ws.agentDir } : {}) } : {}
}

/** The same, for a status read scoped to a secondary root: that root IS the repository named, and
 *  the primary's working subdirectory means nothing inside it. */
export function workspaceGitConfigFor(
  agent: AgentRecord,
  repo: string | undefined
): { repo?: string; agentDir?: string } {
  return repo ? { repo } : workspaceGitConfigOf(agent)
}

/** Wire REP → HTTP body for one path's unified diff. Every "no diff" reason stays
 *  data: a non-repo workspace, an absent path, a binary change, no changes at all. */
export function toWorkspaceGitDiffDto(rep: WorkspaceGitDiffResult): WorkspaceGitDiffDtoT {
  return {
    path: rep.path,
    isRepo: rep.isRepo,
    exists: rep.exists,
    diff: rep.diff ?? null,
    binary: rep.binary ?? false,
    truncated: rep.truncated ?? false
  }
}

/** Wire REP → HTTP body for the commit log. `tracking` null ⇒ the branch tracks
 *  nothing, so every commit's `pushed` reads false and the console draws no markers;
 *  `base` names the ref the listing excludes, null ⇒ the checkout's whole history. */
export function toWorkspaceGitLogDto(rep: WorkspaceGitLog): WorkspaceGitLogDtoT {
  return {
    isRepo: rep.isRepo,
    commits: rep.commits,
    truncated: rep.truncated,
    tracking: rep.tracking ?? null,
    base: rep.base ?? null
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

/** Wire REP → HTTP body for a console commit. Every refusal stays data, carrying the
 *  daemon's closed `reason` so the console can offer the right next action (stage
 *  something, commit from the agent, register an identity) instead of parsing prose. */
export function toWorkspaceGitCommitDto(rep: WorkspaceGitCommitResult): WorkspaceGitCommitResultDtoT {
  return {
    isRepo: rep.isRepo,
    ok: rep.ok,
    sha: rep.sha ?? null,
    detail: rep.detail ?? null,
    reason: rep.reason ?? null
  }
}

/** Wire REP → HTTP body for a console push. `ahead` is what is STILL unpushed, so a
 *  successful push reports 0 and a refusal reports the commits that did not land. */
export function toWorkspaceGitPushDto(rep: WorkspaceGitPushResult): WorkspaceGitPushResultDtoT {
  return {
    isRepo: rep.isRepo,
    ok: rep.ok,
    detail: rep.detail ?? null,
    ahead: rep.ahead ?? null,
    reason: rep.reason ?? null
  }
}

/** Wire REP → HTTP body for a drafted commit message. The CP proxies the text and
 *  stores none of it (body-locality, §1/§12); a runtime that declines is `ok:false`. */
export function toWorkspaceGitMessageDto(rep: WorkspaceGitMessageResult): WorkspaceGitMessageResultDtoT {
  return { ok: rep.ok, message: rep.message ?? null, detail: rep.detail ?? null }
}

/** Wire REP → HTTP body for one ACP session's background tasks. The CP proxies the daemon's
 *  order (live first, then its bounded settled history) and stores nothing; `tracked:false`
 *  stays data so the console can say "this runtime reports no tasks" rather than "none are
 *  running". Absent optionals become explicit nulls for the response schema. */
export function toAgentTasksDto(rep: TaskList): AgentTasksDtoT {
  return {
    sessionId: rep.sessionId,
    tracked: rep.tracked,
    tasks: rep.tasks.map((task) => ({
      id: task.id,
      description: task.description ?? null,
      state: task.state,
      subagent: task.subagent,
      startedAt: task.startedAt,
      endedAt: task.endedAt ?? null,
      detail: task.detail ?? null
    })),
    truncated: rep.truncated
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

/** The daemon's workspace `reason` as the HTTP `code` the console branches on; null
 *  when it named none (older daemon), so the caller keeps its generic answer. */
export function workspaceErrorCode(err: ProtocolError): string | null {
  const reason = WorkspaceErrorReason.safeParse(err.details?.reason)
  return reason.success ? `WORKSPACE_${reason.data.toUpperCase().replaceAll('-', '_')}` : null
}

/** The one workspace reason that is TRANSIENT rather than a bad request: the agent's sandbox is not
 *  running, so its files are unreachable until it is. 503 like an offline daemon, because that is
 *  what it is — but WITH the code, which is how the console tells "come back in a moment" from a
 *  daemon that may never come back, and from an empty workspace. */
const SANDBOX_UNAVAILABLE = 'WORKSPACE_SANDBOX_UNAVAILABLE'

/** Status a console can act on instead of the 503 that reads as an offline daemon:
 *  a worktree the daemon lacks is 404 (as when the CP pre-empts the read), a bad path
 *  400, a stale fence 409. Reasonless ⇒ {@link daemonEdgeFailure}; null ⇒ rethrow. */
export function workspaceFailure(
  err: unknown
): { status: 400 | 404 | 409 | 503; error: string; message: string; code?: string } | null {
  if (err instanceof ProtocolError && (err.code === 'BAD_PAYLOAD' || err.code === 'CONFLICT')) {
    const code = workspaceErrorCode(err)
    if (code !== null) {
      if (err.code === 'CONFLICT') return { status: 409, error: 'Conflict', message: err.message, code }
      if (code === 'WORKSPACE_UNKNOWN_AGENT') {
        return { status: 404, error: 'Not Found', message: 'workspace not found', code }
      }
      // Ahead of the 400: the daemon reports it as a refused request (it carries a reason), but
      // nothing about the request was wrong, and a 400 tells a console to stop retrying.
      if (code === SANDBOX_UNAVAILABLE) {
        return { status: 503, error: 'Service Unavailable', message: err.message, code }
      }
      return { status: 400, error: 'Bad Request', message: err.message, code }
    }
  }
  const unavailable = daemonEdgeFailure(err)
  return unavailable === null ? null : { status: 503, error: 'Service Unavailable', message: unavailable }
}

/** Send {@link workspaceFailure}'s answer; false ⇒ not a daemon-edge failure, rethrow. */
function sendWorkspaceFailure(reply: FastifyReply, err: unknown): boolean {
  const failure = workspaceFailure(err)
  if (!failure) return false
  void reply.code(failure.status).send({
    error: failure.error,
    statusCode: failure.status,
    message: failure.message,
    ...(failure.code ? { code: failure.code } : {})
  })
  return true
}

/** A memory or dream request refused because the agent's sandbox is not running: the workspace
 *  reader's transient 503 + code, so the console wakes the sandbox (#1077). false ⇒ not that. */
function sendSandboxUnavailable(reply: FastifyReply, err: unknown): boolean {
  if (!(err instanceof ProtocolError) || workspaceErrorCode(err) !== SANDBOX_UNAVAILABLE) return false
  void reply
    .code(503)
    .send({ error: 'Service Unavailable', statusCode: 503, message: err.message, code: SANDBOX_UNAVAILABLE })
  return true
}

/** A workspace MUTATION's failure mapping, which differs from a read's on purpose: the
 *  status is the mutation's (409 for a conflict, 400 for a refused payload) whatever the
 *  daemon names, and a reason only rides along as the machine `code` — a write that was
 *  not performed must never read as a resource that is absent. false ⇒ rethrow. */
function sendWorkspaceMutationFailure(reply: FastifyReply, err: unknown): boolean {
  const code = err instanceof ProtocolError ? workspaceErrorCode(err) : null
  if (err instanceof ProtocolError && err.code === 'CONFLICT') {
    void reply.code(409).send({ error: 'Conflict', statusCode: 409, message: err.message, ...(code ? { code } : {}) })
    return true
  }
  // Same exception as the read path, and it matters more here: a 400 on a write tells the console the
  // edit itself was rejected, so the reader would go fix content that was never the problem.
  if (err instanceof ProtocolError && code === SANDBOX_UNAVAILABLE) {
    void reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: err.message, code })
    return true
  }
  if (err instanceof ProtocolError && err.code === 'BAD_PAYLOAD') {
    void reply
      .code(400)
      .send({ error: 'Bad Request', statusCode: 400, message: err.message, ...(code ? { code } : {}) })
    return true
  }
  const unavailable = daemonEdgeFailure(err)
  if (unavailable !== null) {
    void reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: unavailable })
    return true
  }
  return false
}

/** The daemon's task `reason` as the HTTP `code` the console branches on; null when it named
 *  none (older daemon), so the caller keeps its generic answer. Kept separate from
 *  {@link workspaceErrorCode} because the two enums are independent — a reason added to one
 *  must not silently start being emitted under the other's prefix. */
export function taskErrorCode(err: ProtocolError): string | null {
  const reason = TaskErrorReason.safeParse(err.details?.reason)
  return reason.success ? `TASK_${reason.data.toUpperCase().replaceAll('-', '_')}` : null
}

/** Status a console can act on instead of the 503 that reads as an offline daemon: an agent the
 *  daemon does not hold is 404 (stale placement), and there is no 409 arm because the read
 *  mutates nothing. Reasonless ⇒ {@link daemonEdgeFailure}; null ⇒ rethrow. */
export function taskFailure(err: unknown): { status: 404 | 503; error: string; message: string; code?: string } | null {
  if (err instanceof ProtocolError && err.code === 'BAD_PAYLOAD') {
    const code = taskErrorCode(err)
    if (code === 'TASK_UNKNOWN_AGENT') {
      return { status: 404, error: 'Not Found', message: 'agent not found on its daemon', code }
    }
  }
  const unavailable = daemonEdgeFailure(err)
  return unavailable === null ? null : { status: 503, error: 'Service Unavailable', message: unavailable }
}

/** Send {@link taskFailure}'s answer; false ⇒ not a daemon-edge failure, rethrow. */
function sendTaskFailure(reply: FastifyReply, err: unknown): boolean {
  const failure = taskFailure(err)
  if (!failure) return false
  void reply.code(failure.status).send({
    error: failure.error,
    statusCode: failure.status,
    message: failure.message,
    ...(failure.code ? { code: failure.code } : {})
  })
  return true
}

function memoryAdminFailure(err: unknown): {
  status: 400 | 409 | 503
  error: 'Bad Request' | 'Conflict' | 'Service Unavailable'
  message: string
  code?: string
} | null {
  // A cluster agent's memory tree is on its sandbox volume: asleep is the workspace reader's transient
  // 503 + code, which the console answers by waking the sandbox (#1077) — never a 400.
  if (err instanceof ProtocolError && workspaceErrorCode(err) === SANDBOX_UNAVAILABLE) {
    return { status: 503, error: 'Service Unavailable', message: err.message, code: SANDBOX_UNAVAILABLE }
  }
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
      const agent = await deps.repos.agent.get(orgOf(req), AgentId(id))
      if (!agent) return null
      return canView(agent, ctxOf(req)) ? agent : null
    }

    /**
     * The same read, with `daemonId` resolved to the member that SERVES the agent right now
     * instead of the one its placement names. Every daemon-edge proxy below (workspace, git,
     * memory, dreams, tasks, skills, permissions) loads through this, because for a `set`
     * placement the row names no machine at all and the live answer is the ledger's.
     *
     * Deliberately NOT used by the placement-authoritative routes — create, PATCH, move, delete —
     * which compare and write the placement itself and must see what the row says.
     */
    const getServingAgent = async (req: FastifyRequest, id: string): Promise<AgentRecord | null> => {
      const agent = await getOrgAgent(req, id)
      if (!agent) return null
      const daemonId = await deps.placementResolver.servingDaemon(agent)
      return { ...agent, daemonId }
    }

    // A session worktree is part of that session's protected body surface. The
    // caller must pass both the owning-agent gate above and the session's own
    // private/external visibility rule before its daemon-local files are read.
    const sessionAccess = makeSessionAccessResolver(deps)
    // The session half of that gate, shared with the tasks read: the row must be THIS agent's,
    // still hold its content, and pass the session's own private/external visibility rule.
    // Isolation is deliberately not part of it — that is a worktree question, and a session's
    // background tasks exist whatever checkout it runs in. null ⇒ refuse as absent.
    const visibleAgentSession = async (req: FastifyRequest, agentId: string, sessionId: string) => {
      const session = await deps.repos.session.get(orgOf(req), SessionId(sessionId))
      if (!session || session.agentId !== agentId || session.contentPurgedAt) return null
      const access = await sessionAccess.forSessions(req, [session])
      return canViewSession(session, ctxOf(req), access.identitySet, access.externalAccess) ? session : null
    }
    const canReadWorkspaceScope = async (
      req: FastifyRequest,
      agentId: string,
      sessionId: string | undefined
    ): Promise<boolean> => {
      if (!sessionId) return true
      const session = await visibleAgentSession(req, agentId, sessionId)
      // A shared checkout has no per-session worktree, so the daemon would answer BAD_PAYLOAD.
      return session?.workspaceIsolation === 'session'
    }

    // A `repo` scope names one of the agent's AUTHORIZED additional repositories, matched
    // case-insensitively like every other repository full name. A name the agent does not
    // authorize reads as an absent workspace, exactly as an unknown path does, so the query
    // never becomes an oracle for which repositories exist or which an agent may reach.
    const canReadWorkspaceRepoScope = async (agent: AgentRecord, repo: string | undefined): Promise<boolean> => {
      if (!repo) return true
      const rows = await deps.repos.agentRepoAuth.listForAgent(agent.id)
      return rows.some((row) => row.repoFullName.toLowerCase() === repo.toLowerCase())
    }

    const requireSessionWorkspaceRead = async (
      reply: FastifyReply,
      orgId: OrgId,
      daemonId: DaemonId,
      sessionId: string | undefined
    ): Promise<boolean> => {
      if (!sessionId) return true
      const daemon = await deps.registry.getAvailable(orgId, daemonId)
      if (daemon?.capabilities.features.includes(WORKSPACE_SESSION_READ_FEATURE)) return true
      reply.code(409).send({
        error: 'Conflict',
        statusCode: 409,
        message: 'this agent version does not support session worktree browsing'
      })
      return false
    }

    // Version skew: an older daemon drops an unknown frame silently, so the REQ would
    // burn its whole retransmit budget and then read as an offline daemon. Refuse first.
    const requireDaemonFeature = async (
      reply: FastifyReply,
      orgId: OrgId,
      daemonId: DaemonId,
      feature: string,
      message: string
    ): Promise<boolean> => {
      const daemon = await deps.registry.getAvailable(orgId, daemonId)
      if (daemon?.capabilities.features.includes(feature)) return true
      reply.code(409).send({ error: 'Conflict', statusCode: 409, message, code: 'DAEMON_FEATURE_MISSING' })
      return false
    }

    // Version skew: an older daemon simply ignores `repo` and would answer for the PRIMARY
    // workspace — the wrong repository's files under the right name. Refuse instead.
    const requireRepoScope = async (
      reply: FastifyReply,
      orgId: OrgId,
      daemonId: DaemonId,
      repo: string | undefined
    ): Promise<boolean> =>
      !repo ||
      (await requireDaemonFeature(
        reply,
        orgId,
        daemonId,
        WORKSPACE_REPO_SCOPE_FEATURE,
        'this agent version does not support browsing an additional repository; upgrade its daemon'
      ))

    const requireGitReview = (reply: FastifyReply, orgId: OrgId, daemonId: DaemonId): Promise<boolean> =>
      requireDaemonFeature(
        reply,
        orgId,
        daemonId,
        WORKSPACE_GIT_REVIEW_FEATURE,
        'this agent version does not support git review reads; upgrade its daemon'
      )

    // The write gate is separate from the review gate, and the wand's from both: the
    // console hides exactly the controls a given daemon cannot serve.
    const requireGitWrite = (reply: FastifyReply, orgId: OrgId, daemonId: DaemonId): Promise<boolean> =>
      requireDaemonFeature(
        reply,
        orgId,
        daemonId,
        WORKSPACE_GIT_WRITE_FEATURE,
        'this agent version does not support git writes from the console; upgrade its daemon'
      )

    const requireGitMessage = (reply: FastifyReply, orgId: OrgId, daemonId: DaemonId): Promise<boolean> =>
      requireDaemonFeature(
        reply,
        orgId,
        daemonId,
        WORKSPACE_GIT_MESSAGE_FEATURE,
        'this agent version cannot draft commit messages; upgrade its daemon'
      )

    // Separate from every git gate: a daemon can serve the Tasks panel without serving git
    // review, and the console hides exactly the tabs a given daemon cannot answer.
    const requireTasks = (reply: FastifyReply, orgId: OrgId, daemonId: DaemonId): Promise<boolean> =>
      requireDaemonFeature(
        reply,
        orgId,
        daemonId,
        TASK_LIST_FEATURE,
        'this agent version does not report background tasks; upgrade its daemon'
      )

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
    const secretKeysOf = async (orgId: OrgId, agentId: string): Promise<string[]> =>
      (await deps.repos.agentSecret.keys(orgId, [AgentId(agentId)])).get(agentId) ?? []

    /** Assigned organization rows for ONE agent's DTO. Metadata only — this path
     *  never decrypts an organization secret (design §6). */
    const organizationEnvironmentOf = async (agent: AgentRecord): Promise<AssignedOrganizationMetadata> =>
      (await deps.repos.organizationEnvironmentResolver?.metadataForAgents(agent.orgId, [agent.id]))?.get(agent.id) ??
      NO_ORGANIZATION_ENVIRONMENT

    /** How many organization entries are assigned to this agent — the placement
     *  gate's input. Counts through the metadata resolver, so it never decrypts. */
    const organizationEnvironmentBindingCount = async (agent: AgentRecord): Promise<number> => {
      const assigned = await organizationEnvironmentOf(agent)
      return assigned.variables.length + assigned.secretKeys.length
    }

    /** The list-endpoint form: ONE batched resolve instead of a query per agent. */
    const organizationEnvironmentOfAll = async (
      orgId: OrgId,
      agents: readonly AgentRecord[]
    ): Promise<Map<string, AssignedOrganizationMetadata>> =>
      (await deps.repos.organizationEnvironmentResolver?.metadataForAgents(
        orgId,
        agents.map((agent) => agent.id)
      )) ?? new Map()

    // Replicate a spec change to every daemon that serves this agent — its
    // placement AND any member currently holding its duty (deps.agentDelivery is
    // the one resolver). The daemon's local config replica must stay current
    // because a direct Slack→daemon launch reads the replica, not the CP.
    // Best-effort: if the agent reaches no daemon or a daemon is offline, the
    // `register/ok` reconcile roster is the backstop on its next connect.
    const replicateUpsert = (agent: AgentRecord): Promise<void> =>
      deps.agentDelivery.upsert(agent, (err, daemonId) => {
        // Best-effort (see the register/ok reconcile backstop above): the agent update is
        // ALREADY persisted, so a daemon-side hiccup must not fail the HTTP write — not just
        // an offline daemon (NoConnection) but also a rejected/failed live reconcile or a
        // slow/absent ack (agent/upsert became a blocking request-ack in #740; before that a
        // reconcile hiccup was silent). The daemon re-syncs from the register/ok roster on its
        // next (re)connect. Matches the icon route's replicate handler.
        if (err instanceof NoConnection) {
          app.log.debug({ agentId: agent.id, daemonId }, 'agent/upsert skipped: daemon offline')
        } else {
          app.log.warn(
            { err, agentId: agent.id, daemonId },
            'agent/upsert live reconcile failed (backstop: reconnect roster)'
          )
        }
      })

    const replicateRemove = (agent: ResolvableAgent, orgId: string): Promise<void> =>
      deps.agentDelivery.remove(agent, orgId, (err, target) => {
        if (!(err instanceof NoConnection)) throw err
        app.log.debug({ agentId: agent.id, daemonId: target }, 'agent/remove skipped: daemon offline')
      })

    // A gitlab workspace write changes who consumes the project, so the §7.2
    // accounts and memberships must reconverge — the same kick a gitlab hook
    // write does. Retargeting converges BOTH projects, IN THE ORDER GIVEN: the
    // agent joins one and leaves the other, and joining must land first.
    // Fire-and-forget, like every post-write convergence here.
    const convergeGitlabProjects = (orgId: OrgId, projectIds: Iterable<bigint | undefined>): void => {
      const gitlab = deps.gitlab
      if (!gitlab) return
      const projects = [...new Set([...projectIds].filter((id): id is bigint => id !== undefined))]
      // SEQUENTIAL: two projects under one top-level group share the agent's
      // single account, so converging them in parallel would have them contend
      // for its mutation lease and back off against each other.
      void (async () => {
        for (const projectId of projects) {
          await gitlab.provisioner
            .convergeProject(orgId, projectId)
            .catch((err) => app.log.warn({ err, projectId: projectId.toString() }, 'gitlab workspace converge failed'))
        }
      })()
    }

    // The alive relay's HTTP origin for MCP proxy defs (ws→http/wss→https), or null
    // when no relay is live. Mirrors the mcp-providers route's relayBaseUrl.
    const relayProxyBase = async (): Promise<string | null> => {
      const alive = await deps.repos.relay.listAlive(new Date(Date.now() - (deps.config.RELAY_STALE_MS ?? 0)))
      const url = alive[0]?.daemonUrl
      return url ? relayHttpOrigin(url) : null
    }

    // A registry provider's def (grant key + relay proxy URL) reaches a daemon ONLY by CP push:
    // provider CRUD, an enable-list edit, a move, or the register/ok reconcile as the slow
    // backstop. The two primitives below are that push and its inverse; every caller is
    // best-effort, because an offline daemon converges on its next register.
    /** The org registry rows among these names. A name with no row is a daemon-local def
     *  (the operator's `config.json`) — never pushed, never removed, and absent here. */
    const registryProvidersOf = async (orgId: OrgId, names: readonly string[]) => {
      const wanted = new Set(names)
      const rows = wanted.size === 0 ? [] : await deps.repos.mcpProvider.listForOrg(orgId)
      return rows.filter((p) => wanted.has(p.name))
    }
    // One daemon's send, never surfaced: offline is the reconcile backstop, and the error is not
    // logged because a codec/transport error can retain the grant-bearing payload.
    const sendMcp = async (daemonId: string, fn: () => Promise<void>) => {
      try {
        await fn()
      } catch (err) {
        if (!(err instanceof NoConnection)) app.log.warn({ daemonId }, 'mcp def send failed (reconcile will converge)')
      }
    }
    /** Push each provider's proxy def to these daemons. Nothing to push without a live relay. */
    const pushMcpDefs = async (providers: readonly McpProviderRecord[], daemonIds: readonly string[]) => {
      if (providers.length === 0 || daemonIds.length === 0) return
      try {
        const base = await relayProxyBase()
        if (!base) return
        for (const provider of providers) {
          const grant = currentMcpGrant(await deps.repos.mcpGrant.activeForProvider(provider.orgId, provider.id))
          if (!grant) continue
          const spec = mcpProxyDef(provider, grant, base)
          for (const daemonId of daemonIds) await sendMcp(daemonId, () => deps.control.mcpServerUpsert(daemonId, spec))
        }
      } catch (err) {
        app.log.warn({ err }, 'mcp def push failed (reconcile will converge)')
      }
    }
    /** Drop each provider's def from those of these daemons that serve NO agent still enabling
     *  it. "Still used" is delivery-set membership, not placement: a duty holder counts. */
    const dropMcpDefsIfUnused = async (
      orgId: OrgId,
      providers: readonly McpProviderRecord[],
      daemonIds: readonly string[]
    ) => {
      if (providers.length === 0 || daemonIds.length === 0) return
      try {
        const peers = await deps.repos.agent.list(orgId)
        for (const { name } of providers) {
          const stillOn = new Set(
            await deps.agentDelivery.daemonsForAgents(peers.filter((a) => a.mcpServers.includes(name)))
          )
          for (const daemonId of daemonIds) {
            if (!stillOn.has(daemonId))
              await sendMcp(daemonId, () => deps.control.mcpServerRemove(daemonId, orgId, name))
          }
        }
      } catch (err) {
        app.log.warn({ err }, 'mcp def removal deferred (reconcile will converge)')
      }
    }

    // Reflect an enable-list edit onto every daemon serving the agent (a duty holder installed
    // the same list and needs the same defs): provision the newly-enabled registry providers,
    // retire the disabled ones that nobody there still uses. Never throws — its callers have
    // already committed the row, and a failed sync converges on the daemon's next register.
    const syncMcpDefsForAgent = async (
      agent: AgentRecord,
      before: readonly string[],
      after: readonly string[]
    ): Promise<void> => {
      const added = after.filter((n) => !before.includes(n))
      const removed = before.filter((n) => !after.includes(n))
      if (added.length === 0 && removed.length === 0) return
      try {
        const targets = await deps.agentDelivery.daemonsFor(agent)
        if (targets.length === 0) return
        await pushMcpDefs(await registryProvidersOf(agent.orgId, added), targets)
        await dropMcpDefsIfUnused(agent.orgId, await registryProvidersOf(agent.orgId, removed), targets)
      } catch (err) {
        app.log.warn({ agentId: agent.id, err }, 'mcp def sync failed (reconcile will converge)')
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

    // Run an agent write inside the (orgId, name) provider chains of every name its
    // SUBMITTED enable-list contains (serializeByProviderNames — sorted, deadlock-
    // free), so the write cannot land between a provider DELETE's reference check and
    // its row drop, nor interleave with a same-name provider create (see
    // routes/mcp-providers.ts — the chains are keyed by NAME, the durable binding
    // key, so no resolve-to-row-id staleness exists). Keyed off the whole submitted
    // list, NOT an added-vs-before diff: ordinary agent edits may overlap, so a
    // full-replace PATCH re-asserting a name it believes unchanged may be the write
    // that RESTORES it after a concurrent removal, and it must serialize like any
    // other reference-creating write. Removal-only submissions ([] / null /
    // untouched) don't join any chain: a stale 409 on the delete side is benign, a
    // missed reference is not.
    //
    // The visibility gate re-runs INSIDE the fence, with the keep-exemption derived
    // from the agent's COMMITTED enable-list — never from request-time snapshots.
    // Committed-hold is sound on its own: while an agent holds a name, its provider
    // row can be neither deleted nor name-captured by a new row (both 409 while
    // referenced), so a held name's current row is necessarily the one the hold was
    // originally authorized against.
    //
    // The decision itself is handed to `run` as a checker and evaluated INSIDE the
    // agent-row-locked update transaction (AgentUpdateOpts.authorizeMcpServers),
    // against the same committed list that write is about to merge onto: a
    // removal-only PATCH joins no provider-name chain, so any hold read taken here
    // in the fence could be invalidated before the write lands — only the row lock
    // makes hold-check and write inseparable. The registry/visibility sets ARE safe
    // to capture here: provider create/delete/sharing all serialize on the very
    // name chains this fence holds. A refusal surfaces as McpEnableDenied (the
    // route maps it to 403).
    const withSubmittedMcpProviderChains = async <T>(
      orgId: OrgId,
      ctx: ViewCtx,
      submitted: readonly string[] | null | undefined,
      run: (authorizeMcpServers: (currentlyHeld: readonly string[]) => void) => Promise<T>
    ): Promise<T> => {
      if (!submitted || submitted.length === 0) return run(() => {})
      return serializeByProviderNames(orgId, submitted, async () => {
        const registry = new Set((await deps.repos.mcpProvider.listForOrg(orgId)).map((p) => p.name))
        const visible = new Set((await deps.repos.mcpProvider.listForOrg(orgId, ctx)).map((p) => p.name))
        return run((currentlyHeld) => {
          const held = new Set(currentlyHeld)
          const blocked = submitted.filter((n) => registry.has(n) && !held.has(n) && !visible.has(n))
          if (blocked.length) {
            throw new McpEnableDenied(`cannot enable MCP provider you don't have access to: ${blocked.join(', ')}`)
          }
        })
      })
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

    // The skill-source twin of withSubmittedMcpProviderChains, carried as an
    // in-transaction fence rather than a route-level chain (see
    // routes/skill-sources.ts and AgentSkillSourceFence): the repo takes the
    // (orgId, name) advisory scope of every SOURCE the submitted skill-refs
    // name, keyed off the whole submitted list (a stale full-replace PATCH may
    // be the write that RESTORES a ref after a concurrent removal).
    // Removal-only submissions ([] / null / untouched) carry no fence.
    //
    // The visibility gate runs INSIDE the write's transaction, under those
    // scopes, with the keep-exemption derived from the agent's COMMITTED refs
    // (the row-locked bag read): a kept ref's source can be neither deleted nor
    // name-captured while held (both 409 while referenced), so the committed
    // hold is exactly the authorization it was granted under. One
    // skills-specific difference from MCP: there is no daemon-local fallback
    // for a skill-ref — a submitted NEW ref whose source is unknown (e.g. just
    // deleted under the same scope) or unviewable is refused, so a dangling ref
    // can never be committed through this surface. A refusal surfaces as
    // SkillEnableDenied (the route maps it to 403).
    const skillSourceFenceFor = (
      orgId: OrgId,
      ctx: ViewCtx,
      submitted: readonly string[] | null | undefined
    ): AgentSkillSourceFence | undefined => {
      if (!submitted || submitted.length === 0) return undefined
      return {
        orgId,
        names: submitted.map((ref) => parseSkillRef(ref).source),
        viewer: ctx,
        authorize: (committedHeld, visibleSourceNames) => {
          const held = new Set(committedHeld)
          const blocked = [
            ...new Set(submitted.filter((ref) => !held.has(ref)).map((ref) => parseSkillRef(ref).source))
          ].filter((n) => !visibleSourceNames.has(n))
          if (blocked.length) {
            throw new SkillEnableDenied(
              `cannot enable skills from a source you don't have access to: ${blocked.join(', ')}`
            )
          }
        }
      }
    }

    const validateExternalMemoryBinding = async (
      memory: AgentRecord['memory'] | undefined,
      orgId: OrgId
    ): Promise<string | null> => {
      if (memory?.provider !== 'external') return null
      const connection = await deps.repos.externalMemoryConnection.get(orgId, memory.connectionId)
      if (!connection) return 'external memory connection not found in this organization'
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

    const validateManagedSkills = async (
      ids: readonly string[] | null | undefined,
      orgId: OrgId
    ): Promise<string | null> => {
      if (!ids || ids.length === 0) return null
      const repo = deps.repos.organizationKnowledge
      if (!repo) return 'managed skills are unavailable on this control plane'
      const rows = await Promise.all([...new Set(ids)].map((id) => repo.getManagedSkill(orgId, id)))
      const invalid = rows.some((row) => !row || row.archivedAt !== null)
      return invalid ? 'managed skill not found, archived, or outside this organization' : null
    }

    /** Registry-before-agent ordering: a live daemon must see the referenced
     * connection before it applies an external-memory AgentSpec. */
    const pushExternalMemoryToDaemon = async (agent: AgentRecord, daemonId: string): Promise<boolean> => {
      if (agent.memory?.provider !== 'external') return true
      try {
        const connection = await deps.repos.externalMemoryConnection.get(agent.orgId, agent.memory.connectionId)
        if (!connection) return false
        const installation = await deps.repos.memoryPluginInstallation.get(connection.installationId)
        if (!installation) return false
        if (installation.transport === 'stdio') {
          const secrets = (await deps.repos.externalMemoryConnectionSecret.get(connection.orgId, connection.id)) ?? {}
          await deps.control.memoryConnectionUpsert(
            daemonId,
            stdioMemoryConnectionSpec(connection, installation, secrets)
          )
          return true
        }
        const [grant, secretKeys, base] = await Promise.all([
          deps.repos.externalMemoryGrant
            .activeForConnection(connection.orgId, connection.id)
            .then((rows) => rows.at(-1)),
          deps.repos.externalMemoryConnectionSecret.keys(connection.orgId, connection.id),
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

    /** Every daemon serving this agent gets the connection before the spec that
     *  names it — a duty holder included, or its memory admission stays closed. */
    const pushExternalMemoryBeforeAgent = async (agent: AgentRecord): Promise<void> => {
      for (const daemonId of await deps.agentDelivery.daemonsFor(agent)) {
        await pushExternalMemoryToDaemon(agent, daemonId)
      }
    }

    const removeExternalMemoryFromDaemonIfUnused = async (
      orgId: OrgId,
      daemonId: string,
      connectionId: string
    ): Promise<void> => {
      try {
        // "Still used on this daemon" is delivery-set membership, not placement:
        // a duty holder serving another agent bound to the connection keeps it.
        const users = (await deps.repos.agent.list(orgId)).filter(
          (agent) => agent.memory?.provider === 'external' && agent.memory.connectionId === connectionId
        )
        const stillOn = new Set(await deps.agentDelivery.daemonsForAgents(users))
        if (!stillOn.has(daemonId)) await deps.control.memoryConnectionRemove(daemonId, connectionId)
      } catch (err) {
        // Offline/version-skewed daemon converges the full registry on reconnect.
        app.log.warn({ daemonId, connectionId, err }, 'external memory registry removal deferred')
      }
    }

    const removeUnusedExternalMemoryAfterAgent = async (before: AgentRecord, after: AgentRecord): Promise<void> => {
      if (before.memory?.provider !== 'external') return
      const connectionId = before.memory.connectionId
      if (
        after.daemonId === before.daemonId &&
        after.memory?.provider === 'external' &&
        after.memory.connectionId === connectionId
      ) {
        return
      }
      for (const daemonId of await deps.agentDelivery.daemonsFor(before)) {
        await removeExternalMemoryFromDaemonIfUnused(before.orgId, daemonId, connectionId)
      }
    }

    const agentMoves = buildAgentMoves(deps, app.log)
    const refreshMutationAgent = (observed: AgentRecord) => refreshAgentUnderMutation(deps.repos.agent, observed)

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
        // Placement accepts visible org-owned daemons and this org's member sets, never another
        // org's daemon — or a SET, which names no member and is validated against its live members
        // instead, exactly like the move route's set target.
        const wantsSet = req.body.placementKind === 'pool' || req.body.placementKind === 'set'
        const targetSetId = wantsSet ? await resolveTargetSetId(deps, orgOf(req), req.body) : null
        if (wantsSet && targetSetId === null) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'member set not found' })
        }
        const setMembers = targetSetId ? await readySetMembers(deps, orgOf(req), targetSetId) : []
        if (wantsSet && setMembers.length === 0) return conflict('no daemon in the target member set is ready')
        const placedDaemon = wantsSet
          ? (setMembers[0] ?? null)
          : req.body.daemonId !== undefined
            ? await deps.registry.getAvailable(orgOf(req), DaemonId(req.body.daemonId))
            : null
        if (!wantsSet && req.body.daemonId !== undefined) {
          if (!placedDaemon || !canView(placedDaemon, ctxOf(req))) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'daemon not found' })
          }
        }
        if (req.body.managedSkills?.length && placedDaemon && !organizationKnowledgeSupportedOn(placedDaemon)) {
          return conflict('managed skills require a daemon that supports organization knowledge')
        }
        const sandboxPolicy = sandboxPolicyOf(placedDaemon)
        if (sandboxPolicy.required && req.body.runInSandbox === false) {
          return conflict('Run in sandbox is required by this daemon')
        }
        if (!sandboxPolicy.supported && req.body.runInSandbox === true) {
          return conflict('Run in sandbox is unavailable on this daemon')
        }
        const runInSandbox = sandboxPolicy.required
          ? true
          : sandboxPolicy.supported
            ? (req.body.runInSandbox ?? false)
            : false
        // github-app workspace: the picked installation must be a LIVE claim of
        // THIS org, and the repo must sit inside that installation's account +
        // grant set. Ordered AFTER the daemonId visibility gate (404 semantics);
        // these answer 409 — installations and their grant sets are org-level
        // infrastructure (visibility taxonomy), so a 409 is not an oracle.
        const ws = req.body.workspace
        let workspace: AgentWorkspace | undefined =
          ws?.mode === 'github'
            ? {
                mode: 'github',
                isolation: ws.worktree === false ? 'shared' : 'session',
                gitRepo: ws.gitRepo,
                ...(ws.gitBranch !== undefined ? { gitBranch: ws.gitBranch } : {}),
                ...(ws.agentDir !== undefined ? { agentDir: ws.agentDir } : {}),
                ...(ws.installationId !== undefined ? { installationId: ws.installationId } : {}),
                ...(ws.gitAccess !== undefined ? { gitAccess: ws.gitAccess } : {})
              }
            : ws?.mode === 'gitlab'
              ? undefined // resolved below against the managed binding
              : ws
                ? { mode: 'scratch', isolation: 'shared' }
                : undefined
        let workspaceRepoId: bigint | undefined
        if (ws?.mode === 'gitlab') {
          if (!deps.gitlab) return conflict('gitlab workspaces are not enabled on this control plane')
          const projectId = BigInt(ws.projectId)
          const binding = await deps.repos.gitlabProjectBinding.byProject(orgOf(req), projectId)
          if (!binding || binding.state === 'cleanup_pending') {
            return conflict('the project is not a managed GitLab binding in this organization')
          }
          // §17.3/§24.4: a DIRECT placement must advertise the features NOW — the
          // delivery/reconcile gates would otherwise strand a 201'd agent
          // assigned to a daemon that can never materialize it.
          if (req.body.daemonId !== undefined) {
            const daemon = await deps.registry.getAvailable(orgOf(req), DaemonId(req.body.daemonId))
            if (!advertises(daemon?.capabilities.features, requiredGitlabFeatures(deps.gitlab?.api.baseUrl))) {
              return conflict('the selected daemon does not support GitLab workspaces yet — upgrade it first')
            }
          }
          // The persisted catalog row, not caller input and never a composed
          // URL, is the authority for the clone URL (§24.1); the binding still
          // is for the default branch absent an explicit one.
          const catalogRow = await deps.repos.codeHostRepository.byExternalId(orgOf(req), 'gitlab', projectId)
          if (!catalogRow?.cloneUrl) {
            return conflict('the GitLab project binding has no clone URL yet — repair the project first')
          }
          workspace = {
            mode: 'gitlab',
            isolation: ws.worktree === false ? 'shared' : 'session',
            gitRepo: catalogRow.cloneUrl,
            gitBranch: ws.gitBranch ?? binding.defaultBranch ?? 'main',
            ...(ws.agentDir !== undefined ? { agentDir: ws.agentDir } : {}),
            gitAccess: ws.gitAccess ?? 'write'
          }
          workspaceRepoId = projectId
        }
        if (ws?.mode === 'github' && ws.installationId === undefined && ws.gitAccess === 'write') {
          return conflict('github write access requires a GitHub App installation')
        }
        if (ws?.mode === 'github' && ws.installationId !== undefined) {
          if (!deps.github) return conflict('github-app workspaces are not enabled on this control plane')
          const ins = await deps.repos.githubInstallation.get(orgOf(req), ws.installationId)
          if (!ins || ins.revokedAt) {
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
            // Readers-first catalog convergence (gitlab-com-integration.md §8.1).
            await deps.repos.codeHostRepository.upsert({
              orgId: orgOf(req),
              provider: 'github',
              externalId: ref.repoId,
              displayPath: ref.fullName,
              cloneUrl: `https://github.com/${ref.fullName}`,
              defaultBranch: ref.defaultBranch
            })
            // The installation lookup, not the caller's clone host/path, is the
            // authority for an App-backed workspace.
            workspace = {
              mode: 'github',
              isolation: ws.worktree === false ? 'shared' : 'session',
              gitRepo: normalizeGitUrl(ref.fullName),
              ...(ws.gitBranch !== undefined ? { gitBranch: ws.gitBranch } : {}),
              ...(ws.agentDir !== undefined ? { agentDir: ws.agentDir } : {}),
              installationId: ws.installationId,
              ...(ws.gitAccess !== undefined ? { gitAccess: ws.gitAccess } : {})
            }
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
        const managedSkillError = await validateManagedSkills(req.body.managedSkills, orgOf(req))
        if (managedSkillError) {
          return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: managedSkillError })
        }
        // The friendly external-memory validation runs here; the authoritative
        // fence (connection advisory try-lock + in-transaction existence
        // re-check) lives inside the create transaction (PgAgentRepo) and
        // surfaces as MemoryConnectionBusy/Missing in the catch below.
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
          const defaultAgentVisibility = (await deps.repos.org.defaultAgentVisibility(orgOf(req))) ?? 'all'
          const callPolicy = req.body.callPolicy ?? defaultAgentVisibility
          const outboundPolicy = req.body.outboundPolicy ?? defaultAgentVisibility
          const initialAllowedCallers =
            callPolicy === 'selected'
              ? await resolvePolicyAgentIds(req, agentId, req.body.allowedCallerAgentIds ?? [], [])
              : undefined
          const initialAllowedTargets =
            outboundPolicy === 'selected'
              ? await resolvePolicyAgentIds(req, agentId, req.body.allowedTargetAgentIds ?? [], [])
              : undefined
          // One transaction for the agent row + its initial secret rows (sealing
          // happens before it opens) — a failure can't leave a partial definition.
          // Chained per submitted MCP provider name (route-level chain), and fenced
          // per submitted skill-ref source name INSIDE the create transaction (the
          // skillSources opts) so the row can't commit inside a concurrent
          // registry-delete's check→drop window. The MCP chain wraps the whole
          // transaction, so the two fence families still nest in a fixed order.
          const skillsFence = skillSourceFenceFor(orgOf(req), ctxOf(req), req.body.skills)
          let agent: AgentRecord
          try {
            agent = await withSubmittedMcpProviderChains(orgOf(req), ctxOf(req), req.body.mcpServers, (authorize) => {
              // A not-yet-created agent holds nothing, and nothing can concurrently
              // remove from it — the empty-hold decision is stable through create.
              authorize([])
              return deps.repos.agentConfig.create(
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
                  ...(req.body.showStatusBar !== undefined ? { showStatusBar: req.body.showStatusBar } : {}),
                  ...(req.body.fastMode !== undefined ? { fastMode: req.body.fastMode } : {}),
                  ...(req.body.permissionMode !== undefined ? { permissionMode: req.body.permissionMode } : {}),
                  ...(req.body.approvalsReviewer !== undefined
                    ? { approvalsReviewer: req.body.approvalsReviewer }
                    : {}),
                  ...(req.body.allowRuntimeChangesInChat !== undefined
                    ? { allowRuntimeChangesInChat: req.body.allowRuntimeChangesInChat }
                    : {}),
                  ...(req.body.pause !== undefined ? { pause: req.body.pause } : {}),
                  ...(req.body.introduceOnJoin !== undefined ? { introduceOnJoin: req.body.introduceOnJoin } : {}),
                  runInSandbox,
                  ...(req.body.env !== undefined ? { env: req.body.env } : {}),
                  ...(req.body.mcpServers !== undefined ? { mcpServers: req.body.mcpServers } : {}),
                  ...(req.body.skills !== undefined ? { skills: req.body.skills } : {}),
                  ...(req.body.managedSkills !== undefined ? { managedSkills: req.body.managedSkills } : {}),
                  ...(req.body.memory !== undefined ? { memory: req.body.memory } : {}),
                  ...(targetSetId !== null
                    ? { placementKind: 'set' as const, setId: targetSetId }
                    : req.body.daemonId !== undefined
                      ? { daemonId: DaemonId(req.body.daemonId) }
                      : {}),
                  ...(workspace !== undefined ? { workspace } : {}),
                  ...(workspaceRepoId !== undefined ? { workspaceRepoId } : {}),
                  ...(req.principal ? { createdByUserId: req.principal.userId } : {}),
                  ...(req.body.visibility ? { visibility: req.body.visibility } : {}),
                  ...(initialSharedWith ? { sharedWith: initialSharedWith } : {}),
                  callPolicy,
                  allowedCallerAgentIds: initialAllowedCallers ?? [],
                  outboundPolicy,
                  allowedTargetAgentIds: initialAllowedTargets ?? [],
                  capabilities: req.body.capabilities
                },
                // Initial write-only secrets — same transaction, so the first
                // replicateUpsert below always sees the complete definition.
                req.body.secrets,
                skillsFence ? { skillSources: skillsFence } : undefined
              )
            })
          } catch (e) {
            if (e instanceof McpEnableDenied || e instanceof SkillEnableDenied) {
              return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: e.message })
            }
            // Everything else (including the organization-environment fence's
            // admission refusal) is mapped by the outer catch below.
            throw e
          }
          // `?connect=true` also provisions a daemon connect token + start command
          // so the onboarding screen can show "run this to connect a daemon".
          const connect = req.query.connect
            ? await provisionDaemonConnect(deps.apiKeys, deps.config, req.orgCtx!.orgId, req.principal?.userId)
            : undefined
          // §7.2 BEFORE the spec push: the daemon prepares a gitlab workspace by
          // minting credentials from this agent's OWN account. The row is
          // created first on purpose — a crash here leaves an agent the next
          // convergence adopts as a consumer, where the reverse order would
          // leave an account no agent owns.
          if (agent.workspace.mode === 'gitlab' && agent.workspaceRepoId !== undefined && deps.gitlab) {
            const gitlab = deps.gitlab
            // The agent row IS the authorization here and is already committed,
            // so nothing has to run inside the lease alongside the ensure.
            const ensured = await gitlab.provisioner.provisionAgentAccount(
              agent.orgId,
              agent.workspaceRepoId,
              { agentId: agent.id, accessLevel: gitlabWorkspaceAccessLevel(agent.workspace.gitAccess) },
              async () => undefined
            )
            if (!ensured.ok) {
              // Nothing was pushed yet, so the create can still be withdrawn
              // whole rather than leaving an agent whose workspace cannot start.
              // The account rows go with it: they carry no agent foreign key on
              // purpose, so a dropped agent would otherwise orphan whatever the
              // failed provisioning already created at GitLab (§19.4).
              await deps.repos.agent
                .delete(agent.orgId, agent.id)
                .catch((err) => app.log.warn({ err, agentId: agent.id }, 'agent rollback after gitlab account failure'))
              await gitlab.accounts
                .retireAgentAccounts(agent.orgId, agent.id)
                .catch((err) => app.log.warn({ err, agentId: agent.id }, 'gitlab account rollback failed'))
              return conflict(gitlabAccountUnavailableMessage(ensured.reason))
            }
          }
          // Issue the private definition first. Even if its probe ACK is lost,
          // the WebSocket preserves frame order and daemon admission remains
          // closed until the registry validates it.
          await pushExternalMemoryBeforeAgent(agent)
          await replicateUpsert(agent) // no-op until placed; reconcile carries it otherwise
          // Mint the agent's duty group now, so a pool member can claim it on its
          // next beat instead of waiting for the first trigger's rendezvous.
          deps.recomputeDuties?.(agent.orgId)
          // A create that arrives already PLACED (`daemonId` in the body) must also enter
          // the peer directory now. `replicateUpsert` only ships the AgentSpec (same-daemon
          // authorization); a peer WAKE is authorized against the collaboration snapshot,
          // whose flat `agents[]` is the only structure an agent with no IM integration can
          // appear in — and channel membership no longer gates the directory, so there is no
          // later `integration/channels` push to rely on. Without this the agent would be
          // DISCOVERABLE (channel/agents reads the DB live) yet un-wakeable until an
          // unrelated change bumped the snapshot: the listed-but-uncallable state that
          // discovery-as-authorization forbids. Gated on placement for the same reason
          // `replicateUpsert` is — `buildCollabSnapshot` drops daemonId-less rows, so an
          // unplaced create has nothing to publish and must not churn every routingEpoch.
          // Best-effort for the same reason as `replicateUpsert` above: the agent row is
          // ALREADY committed, so a snapshot-push hiccup must not turn a successful create
          // into a 500. `register/ok` carries the same directory as the reconnect backstop.
          if (agent.daemonId) {
            try {
              await deps.collabRoutes.broadcast(agent.orgId)
            } catch (err) {
              app.log.warn(
                { err, agentId: agent.id, orgId: agent.orgId },
                'collaboration routes push failed after agent create (backstop: reconnect snapshot)'
              )
            }
          }
          await syncMcpDefsForAgent(agent, [], agent.mcpServers)
          // A gitlab workspace makes this agent a consumer of its project (§7.2).
          if (agent.workspace.mode === 'gitlab') convergeGitlabProjects(agent.orgId, [agent.workspaceRepoId])
          return reply.code(201).send({
            ...toDto(
              agent,
              ctxOf(req),
              await secretKeysOf(agent.orgId, agent.id),
              await hookKindsOf(deps, agent.id),
              iconBasesOf(deps),
              await placementViewFor(deps, agent),
              // Create already enrolled the agent into the org's `all` entries in
              // its own transaction, so the response shows what will actually apply.
              await organizationEnvironmentOf(agent)
            ),
            ...(connect ? { connect } : {})
          })
        } catch (e) {
          if (e instanceof MemoryConnectionBusy) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'external memory connection is being updated; retry agent creation'
            })
          }
          if (e instanceof MemoryConnectionMissing) {
            return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: e.message })
          }
          // See the PATCH handler: the organization-environment fence refused the
          // complete resolved definition (cross-kind downgrade, or over the wire
          // admission budget). Nothing was persisted.
          if (e instanceof OrganizationEnvironmentAdmissionError) {
            return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: e.message })
          }
          throw e
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
        const secretKeys = await deps.repos.agentSecret.keys(
          orgOf(req),
          rows.map((a) => a.id)
        )
        // ONE batched resolve for the whole page (design §6) — never a query per agent.
        const organizationEnvironment = await organizationEnvironmentOfAll(orgOf(req), rows)
        // Two batched resolves for the whole page: the named daemons, and each named set once.
        const daemonIds = [...new Set(rows.flatMap((a) => (a.daemonId ? [a.daemonId] : [])))]
        const views = new Map(
          await Promise.all(
            daemonIds.map(
              async (daemonId) =>
                [daemonId, placementViewOf(deps, await deps.registry.getAvailable(orgOf(req), daemonId))] as const
            )
          )
        )
        const setIds = [...new Set(rows.flatMap((a) => (a.setId ? [a.setId] : [])))]
        const setViews = new Map(
          await Promise.all(
            setIds.map(
              async (setId) =>
                [setId, placementViewOf(deps, (await readySetMembers(deps, orgOf(req), setId))[0] ?? null)] as const
            )
          )
        )
        const viewFor = (a: AgentRecord): PlacementView => {
          const eligibility = dutyEligibility(a)
          if (eligibility.scope === 'none') return NO_PLACEMENT
          if (eligibility.scope === 'set') return setViews.get(eligibility.setId) ?? NO_PLACEMENT
          return views.get(eligibility.daemonId) ?? NO_PLACEMENT
        }
        return rows.map((a) =>
          toDto(
            a,
            ctx,
            secretKeys.get(a.id) ?? [],
            hookKinds.get(a.id) ?? [],
            iconBasesOf(deps),
            viewFor(a),
            organizationEnvironment.get(a.id) ?? NO_ORGANIZATION_ENVIRONMENT
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
          await secretKeysOf(agent.orgId, agent.id),
          await hookKindsOf(deps, agent.id),
          iconBasesOf(deps),
          await placementViewFor(deps, agent),
          await organizationEnvironmentOf(agent)
        )
      }
    )

    r.get(
      '/agents/:id/skill-sources',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List an agent’s enabled skill sources',
          description:
            'Resolve the agent’s skill enable-list ("<source>/<skill>" refs) into the registry rows it references. Gated on viewing the AGENT, not the source: a source restricted away from the caller still resolves, because its definition is part of what this agent installs. Refs to a source that no longer exists are omitted.',
          operationId: 'listAgentSkillSources',
          params: IdParam,
          response: { 200: AgentSkillSourceListDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        const names = [...new Set(agent.skills.map((ref) => parseSkillRef(ref).source))]
        const rows = await Promise.all(names.map((name) => deps.repos.skillSource.getByName(agent.orgId, name)))
        return rows.flatMap((s) =>
          s
            ? [
                {
                  id: s.id,
                  name: s.name,
                  // This response crosses the source's OWN visibility, so the string
                  // is redacted even though `SkillSourceArg` now rejects credentials
                  // on write — rows predating that guard must not leak one here.
                  source: redactSourceCredentials(s.source),
                  ref: s.ref,
                  subDir: s.subDir,
                  skills: s.skills
                }
              ]
            : []
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
        const agent = await getServingAgent(req, req.params.id)
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
        const agent = await getServingAgent(req, req.params.id)
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
        // getOrgAgent already enforces visibility; the edit action then keeps
        // viewers read-only while collaborators and owners may edit.
        if (!canEdit(existing, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        // Built-in preset agents keep their fixed brand identity (preset-agents.md
        // §3.1): display name and icon are not editable — everything else stays an
        // ordinary edit. (The slug is create-time-immutable for every agent.)
        if (existing.builtin && (req.body.displayName !== undefined || req.body.icon !== undefined)) {
          return reply.code(403).send({
            error: 'Forbidden',
            statusCode: 403,
            message: 'built-in agent identity (display name, icon) cannot be changed'
          })
        }
        const release = deps.agentMutations.tryBeginMutation(existing.id)
        if (!release) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'agent move is in progress; retry the edit' })
        }
        // External-memory fencing (advisory try-lock on the committed + target
        // connections and the in-transaction existence re-check) happens inside
        // the update transaction (PgAgentRepo); MemoryConnectionBusy/Missing
        // surface in the catch below.
        const targetMemory = req.body.memory === undefined ? existing.memory : req.body.memory
        try {
          if (!(await refreshMutationAgent(existing))) {
            return reply
              .code(409)
              .send({ error: 'Conflict', statusCode: 409, message: 'agent changed; refresh and retry the edit' })
          }
          const placementView = await placementViewFor(deps, existing)
          if (placementView.sandbox.required && req.body.runInSandbox === false) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'Run in sandbox is required by this daemon'
            })
          }
          if (!placementView.sandbox.supported && req.body.runInSandbox === true) {
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
          const managedSkillError = await validateManagedSkills(req.body.managedSkills, orgOf(req))
          if (managedSkillError) {
            return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: managedSkillError })
          }
          const addsManagedSkill =
            Array.isArray(req.body.managedSkills) &&
            req.body.managedSkills.some((id) => !existing.managedSkills.includes(id))
          if (addsManagedSkill && existing.daemonId) {
            const daemon = await deps.registry.getAvailable(orgOf(req), existing.daemonId)
            if (!organizationKnowledgeSupportedOn(daemon)) {
              return reply.code(409).send({
                error: 'Conflict',
                statusCode: 409,
                message: 'managed skills require a daemon that supports organization knowledge'
              })
            }
          }
          const memoryError = await validateExternalMemoryBinding(targetMemory ?? undefined, orgOf(req))
          if (memoryError) {
            return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: memoryError })
          }
          // The row patch and the secret merge commit as ONE transaction (sealing
          // outside it), so the replicateUpsert below can only ever ship a
          // definition that fully applied — never a half-updated one. Chained per
          // submitted MCP provider name (route-level chain, wrapping the whole
          // transaction) and fenced per submitted skill-ref source name INSIDE
          // that transaction (the skillSources opts), so the row can't commit
          // inside a concurrent registry-delete's check→drop window.
          const { secrets: secretsPatch, ...bodyPatch } = req.body
          const skillsFence = skillSourceFenceFor(orgOf(req), ctxOf(req), req.body.skills)
          let agent: AgentRecord
          try {
            agent = await withSubmittedMcpProviderChains(
              orgOf(req),
              ctxOf(req),
              req.body.mcpServers,
              (authorizeMcpServers) =>
                deps.repos.agentConfig.update(
                  orgOf(req),
                  AgentId(req.params.id),
                  {
                    ...bodyPatch,
                    ...(req.principal ? { lastModifiedByUserId: req.principal.userId } : {})
                  },
                  secretsPatch,
                  // Evaluated inside the row-locked transaction, against the same
                  // committed lists this write merges onto (see the fence helpers).
                  { authorizeMcpServers, ...(skillsFence ? { skillSources: skillsFence } : {}) }
                )
            )
          } catch (e) {
            if (e instanceof McpEnableDenied || e instanceof SkillEnableDenied) {
              return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: e.message })
            }
            throw e
          }
          await pushExternalMemoryBeforeAgent(agent)
          await replicateUpsert(agent)
          // Pause decides whether this agent's hooks belong in the relay pool at all, so a toggle
          // needs the rule convergence a placement change gets — nothing else recomputes it.
          if ((existing.pause === true) !== (agent.pause === true)) {
            await deps.hooks.rebroadcastForAgent(AgentId(agent.id))
          }
          if (req.body.icon !== undefined) {
            void syncAgentBotIcons(deps, agent, app.log)
            void deps.gitlab?.accounts.syncAgentAvatars(agent.orgId, agent.id)
          }
          await removeUnusedExternalMemoryAfterAgent(existing, agent)
          // Provision/drop MCP proxy defs for an enable-list change with the placement
          // unchanged (a daemon move goes through AgentMoveService + reconcile, not
          // here). The fan-out itself is delivery-set-wide, so an unplaced agent whose
          // duty holders serve it is still covered.
          if (agent.daemonId === existing.daemonId) {
            await syncMcpDefsForAgent(agent, existing.mcpServers, agent.mcpServers)
          }
          return toDto(
            agent,
            ctxOf(req),
            await secretKeysOf(agent.orgId, agent.id),
            await hookKindsOf(deps, agent.id),
            iconBasesOf(deps),
            placementView,
            // A PATCH may also have enrolled the agent into `all` entries added
            // since its last edit, so re-resolve rather than echoing the request.
            await organizationEnvironmentOf(agent)
          )
        } catch (e) {
          if (e instanceof MemoryConnectionBusy) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'external memory connection is being updated; retry the edit'
            })
          }
          if (e instanceof MemoryConnectionMissing) {
            return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: e.message })
          }
          // The organization-environment fence refused this write inside its
          // transaction (organization-secrets-and-variables.md §5): either an
          // agent-local secret would sit beneath an assigned organization variable —
          // the declassification the design rejects from BOTH write directions — or
          // the resolved configuration would not fit the wire admission budget. The
          // message names keys, never values.
          if (e instanceof OrganizationEnvironmentAdmissionError) {
            return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: e.message })
          }
          throw e
        } finally {
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
          const daemon = await deps.registry.getAvailable(orgOf(req), existing.daemonId)
          const live = deps.liveness.get(existing.daemonId)
          if (!daemon || live?.reachable !== true || live.state !== 'READY') {
            return conflict('the agent must be online and ready to edit its workspace')
          }
          if (!daemon.capabilities.features.includes('workspace-edit-v2')) {
            return conflict('this agent version does not support workspace editing')
          }
        }

        try {
          let workspace: AgentWorkspace = { mode: 'scratch', isolation: 'shared' }
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
            // Readers-first catalog convergence (gitlab-com-integration.md §8.1).
            await deps.repos.codeHostRepository.upsert({
              orgId: existing.orgId,
              provider: 'github',
              externalId: ref.repoId,
              displayPath: ref.fullName,
              cloneUrl: `https://github.com/${ref.fullName}`,
              defaultBranch: ref.defaultBranch
            })
            if (deps.githubUserAuthz) {
              await deps.githubUserAuthz.assertAccess(
                req.principal!.userId,
                installation,
                owner,
                repo,
                req.body.gitAccess
              )
            }
            const worktree =
              req.body.worktree ??
              (existing.workspace.mode === 'github' ? existing.workspace.isolation === 'session' : true)
            workspace = {
              mode: 'github',
              isolation: worktree ? 'session' : 'shared',
              gitRepo: normalizeGitUrl(ref.fullName),
              gitBranch: req.body.gitBranch ?? ref.defaultBranch,
              ...(req.body.agentDir ? { agentDir: req.body.agentDir } : {}),
              installationId: installation.id,
              gitAccess: req.body.gitAccess
            }
            workspaceRepoId = ref.repoId
          }
          if (req.body.mode === 'gitlab') {
            if (!deps.gitlab) return conflict('gitlab workspaces are not enabled on this control plane')
            // §17.3: the daemon that will re-activate this workspace must
            // decode the gitlab spec arm — direct placement or a pool/duty
            // incumbent alike (the earlier check only proves workspace-edit-v2).
            const servingId = (await deps.placementResolver.servingDaemon(existing)) ?? existing.daemonId
            if (servingId) {
              const serving = await deps.registry.getAvailable(existing.orgId, servingId)
              if (!advertises(serving?.capabilities.features, requiredGitlabFeatures(deps.gitlab?.api.baseUrl))) {
                return conflict('the serving daemon does not support GitLab workspaces yet — upgrade it first')
              }
            }
            const projectId = BigInt(req.body.projectId)
            const binding = await deps.repos.gitlabProjectBinding.byProject(existing.orgId, projectId)
            if (!binding || binding.state === 'cleanup_pending') {
              return conflict('the project is not a managed GitLab binding in this organization')
            }
            const catalogRow = await deps.repos.codeHostRepository.byExternalId(existing.orgId, 'gitlab', projectId)
            if (!catalogRow?.cloneUrl) {
              return conflict('the GitLab project binding has no clone URL yet — repair the project first')
            }
            const worktree =
              req.body.worktree ??
              (existing.workspace.mode !== 'scratch' ? existing.workspace.isolation === 'session' : true)
            workspace = {
              mode: 'gitlab',
              isolation: worktree ? 'session' : 'shared',
              gitRepo: catalogRow.cloneUrl,
              gitBranch: req.body.gitBranch ?? binding.defaultBranch ?? 'main',
              ...(req.body.agentDir ? { agentDir: req.body.agentDir } : {}),
              gitAccess: req.body.gitAccess
            }
            workspaceRepoId = projectId
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

          // §7.2 BEFORE activation: the daemon prepares the workspace by minting
          // credentials from this agent's OWN GitLab account, so the account,
          // its membership, and its PATs must already exist. A post-write kick
          // cannot serve this — activation would be refused, the edit would roll
          // back, and the agent would never become the consumer that convergence
          // needs a reason to provision for.
          // A gitlab clone URL is read from the catalog BEFORE the lease, and the
          // lease's own project read converges every replicated path. Taking the
          // live answer keeps this write from putting the stale one back.
          const applyWorkspace = (live?: GitlabLiveProject): Promise<AgentRecord> =>
            agentMoves.setWorkspace(
              existing,
              live?.cloneUrl && workspace.mode === 'gitlab' ? { ...workspace, gitRepo: live.cloneUrl } : workspace,
              workspaceRepoId,
              req.principal?.userId
            )
          let converted: AgentRecord
          if (workspace.mode === 'gitlab' && workspaceRepoId !== undefined && deps.gitlab) {
            let applied
            try {
              // The edit itself runs under the binding lease this takes, so the
              // membership and the workspace row that authorizes it commit
              // together as far as convergence can see.
              applied = await deps.gitlab.provisioner.provisionAgentAccount(
                existing.orgId,
                workspaceRepoId,
                { agentId: existing.id, accessLevel: gitlabWorkspaceAccessLevel(workspace.gitAccess) },
                applyWorkspace
              )
            } catch (err) {
              // The edit rolled back, so the membership just bound belongs to an
              // agent that does not consume the project: converge it away.
              convergeGitlabProjects(existing.orgId, [workspaceRepoId])
              throw err
            }
            if (!applied.ok) return conflict(gitlabAccountUnavailableMessage(applied.reason))
            converted = applied.result
          } else {
            converted = await applyWorkspace()
          }
          // Joining, leaving, or re-clamping a gitlab project moves its §7.2
          // membership set. DESTINATION FIRST, and the order is load-bearing: an
          // account with no membership left in its root retires, so converging
          // the project being left first would retire the very account the
          // destination is about to bind — deleting it at GitLab and recreating
          // it under a new user id. Binding the destination first leaves the
          // source unbind with a still-bound account to spare.
          if (existing.workspace.mode === 'gitlab' || converted.workspace.mode === 'gitlab') {
            convergeGitlabProjects(converted.orgId, [converted.workspaceRepoId, existing.workspaceRepoId])
          }
          return toDto(
            converted,
            ctxOf(req),
            await secretKeysOf(converted.orgId, converted.id),
            await hookKindsOf(deps, converted.id),
            iconBasesOf(deps),
            await placementViewFor(deps, converted),
            await organizationEnvironmentOf(converted)
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

    // Hard-cut an agent over to another daemon. The explicit action keeps
    // destructive/local-state semantics out of generic spec PATCH. A safe move
    // requires both source and target READY; an explicit force reassign may
    // bypass only the unavailable source ACK. The target always receives the
    // complete CP-owned definition and activates last.
    r.put(
      '/agents/:id/daemon',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Move an agent to another daemon',
          description:
            'Hard-cut an agent over to another READY daemon. Active source turns are cancelled without a final reply, and subsequent messages start fresh on the target; force is an explicit disaster-recovery option when the source is unavailable. Daemon-local workspace, memory, and transcript data are not migrated or replayed.',
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

        const conflict = (message: string) => reply.code(409).send({ error: 'Conflict', statusCode: 409, message })
        const force = req.body.force === true
        const wantsSet = req.body.placementKind === 'pool' || req.body.placementKind === 'set'
        const targetSetId = wantsSet ? await resolveTargetSetId(deps, orgOf(req), req.body) : null
        if (wantsSet && targetSetId === null) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'member set not found' })
        }
        const moveReady = (daemonId: string) => {
          const live = deps.liveness.get(daemonId)
          return live?.reachable === true && live.state === 'READY'
        }
        const MOVE_FEATURE = 'agent-move-v1'

        // The daemons the target admits. A `daemon` target is one machine and every check below
        // is about that machine. A `set` target names a member set, and the CP does not get to
        // choose which member serves the agent — so the checks are evaluated against the UNION of
        // its live members: the target is admissible when SOME live member could serve this agent
        // today. Pool members are one Deployment of one image, so union and intersection differ
        // only mid-rollout, and there the ledger's install-on-grant refusal is the backstop that
        // keeps a member from holding what it cannot install.
        const candidates = targetSetId
          ? await (async () => {
              const memberIds = new Set(await deps.repos.memberSet.memberIdsOf(targetSetId))
              return (await deps.registry.listAvailable(orgOf(req))).filter(
                (d) => memberIds.has(d.daemonId) && moveReady(d.daemonId) && canView(d, ctxOf(req))
              )
            })()
          : await (async () => {
              const one = await deps.registry.getAvailable(orgOf(req), DaemonId(req.body.daemonId!))
              return one && canView(one, ctxOf(req)) ? [one] : []
            })()
        if (candidates.length === 0) {
          if (!wantsSet) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'daemon not found' })
          }
          return conflict('no daemon in the target member set is ready')
        }

        // Deferred exec config (preset-agents.md §3.2): placement is where a
        // runtime becomes mandatory — an unplaced preset carries none until the
        // user (or M1 auto-placement) chooses one.
        if (!existing.runtime) {
          return conflict('agent has no runtime yet — set a runtime before placing it on a daemon')
        }

        const placement = placementTargetOf(existing)
        const samePlacementTarget = targetSetId
          ? placement.kind === 'set' && placement.setId === targetSetId
          : placement.kind === 'daemon' && placement.daemonId === req.body.daemonId

        // The org registry rows the agent enables — read once for every candidate's facts check
        // below, then staged on the target.
        const registryProviders = await registryProvidersOf(existing.orgId, existing.mcpServers)
        const registryTransport = new Map(registryProviders.map((p) => [p.name, p.transport] as const))

        /** Why this daemon cannot take the agent, or null when it can. */
        const admits = async (daemon: DaemonView): Promise<string | null> => {
          if (!moveReady(daemon.daemonId)) return 'target daemon is not ready'
          if (!daemon.capabilities.features.includes(MOVE_FEATURE)) return 'target daemon does not support agent moves'
          if (existing.managedSkills.length > 0 && !organizationKnowledgeSupportedOn(daemon)) {
            return 'target daemon does not support organization knowledge managed skills'
          }
          // Rollout gate (organization-secrets-and-variables.md §10 step 3): an agent
          // bound to an organization entry receives FULL resolved env/secret maps, and
          // that is only safe on a daemon that persists `configRevision` and refuses an
          // older snapshot. An unplaced bound agent may be saved; placing it requires
          // the feature. Deliberately not "old daemons ignore the optional field" — a
          // late-completing older snapshot there would reinstate a rotated value.
          if ((await organizationEnvironmentBindingCount(existing)) > 0 && !configRevisionSupportedOn(daemon)) {
            return 'target daemon does not yet support organization variables and secrets, which this agent is assigned; upgrade it first'
          }
          const targetRuntime = daemon.runtimeProfiles.find((p) => p.runtime === existing.runtime)
          if (daemon.runtimeProfiles.length > 0 && !targetRuntime) {
            return `target daemon does not support runtime ${existing.runtime}`
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
            return `target daemon does not support model ${existing.model} for runtime ${existing.runtime}`
          }
          for (const name of existing.mcpServers) {
            // The CP pushes a registry def only to daemons already serving an enabling agent, so
            // "the target holds no such fact yet" is not "it cannot attach it" — reading that as a
            // refusal pinned every connector-using agent to its daemon (#1192). The move stages the
            // def; only a daemon-LOCAL name (the operator's `config.json`) is genuinely host-bound.
            const transport =
              daemon.mcpServers.find((candidate) => candidate.name === name)?.transport ?? registryTransport.get(name)
            if (!transport) return `target daemon cannot attach MCP server ${name}`
            const caps = targetRuntime?.mcpCapabilities
            const transportSupported = transport === 'stdio' || !caps || (transport === 'http' ? caps.http : caps.sse)
            if (!transportSupported) {
              return `target runtime ${existing.runtime} does not support MCP ${transport} transport for ${name}`
            }
          }
          // Capacity is a per-member fact even on a set: "some member has headroom" is exactly
          // the condition the ledger's own headroom gate applies when it hands out the duty.
          if (!samePlacementTarget && daemon.load && daemon.maxAgents > 0 && daemon.load.agents >= daemon.maxAgents) {
            return 'target daemon is at agent capacity'
          }
          return null
        }

        // First admitting candidate wins; a set target refuses only when EVERY live member
        // refuses, and then it reports the first member's reason rather than inventing one.
        let target: DaemonView | undefined
        let refusal: string | null = null
        for (const candidate of candidates) {
          const why = await admits(candidate)
          if (why === null) {
            target = candidate
            break
          }
          refusal ??= why
        }
        if (!target) return conflict(refusal ?? 'no daemon can take this agent')

        const moveTarget: PlacementTarget = targetSetId
          ? onSet(targetSetId)
          : { kind: 'daemon', daemonId: target.daemonId }

        // A same-target retry is an idempotent repair after placement already
        // committed, not a second handoff. Target admission above still applies,
        // but there is no separate source to gate before ensureActive below.
        if (!samePlacementTarget) {
          // Every member serving the agent today has to quiesce — for a set source that is the
          // duty holder, not a placement, and there may be none at all.
          const sourceDaemonIds = await deps.placementResolver.servingDaemons(existing)
          if (sourceDaemonIds.length > 0) {
            for (const sourceDaemonId of sourceDaemonIds) {
              const source = await deps.registry.getAvailable(orgOf(req), DaemonId(sourceDaemonId))
              const sourceLive = source ? deps.liveness.get(source.daemonId) : undefined
              const sourceReady = sourceLive?.reachable === true && sourceLive.state === 'READY'
              if (force) {
                if (sourceReady) return conflict('source daemon is ready; use a safe move')
                if (sourceLive?.reachable === true) {
                  return conflict('source daemon is reconnecting; wait until it is ready')
                }
              } else {
                if (!source || !moveReady(source.daemonId)) return conflict('source daemon is not ready')
                if (!source.capabilities.features.includes(MOVE_FEATURE)) {
                  return conflict('source daemon does not support agent moves')
                }
              }
            }
          } else if (force) {
            return conflict('force reassign requires an unavailable source daemon')
          }
        }

        // A move takes NO external-memory mutation scope: its connection work is
        // staging pushes (no connection row writes), and it can outlive any
        // transactional lock while a daemon cuts over. A connection mutation that
        // lands mid-move can leave the target holding a stale spec only until
        // the post-commit re-push below / the usage-checked removal in the
        // finally / the daemon reconnect snapshot converge it — and a connection
        // DELETE stays impossible throughout because this agent's committed
        // binding keeps its "no agent bound" scan refusing (409).
        let targetStaged = false
        try {
          // Registry-before-agent for the MCP defs too: the target refuses `agent/activate` for a
          // name it holds no def for, and a registry def reaches it only by CP push. An EVT with
          // no ACK — if it did not land, that activation refusal is the failure.
          await pushMcpDefs(registryProviders, [target.daemonId])
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
          if (samePlacementTarget) {
            try {
              const repaired = await agentMoves.ensureActive(existing)
              return toDto(
                repaired,
                ctxOf(req),
                await secretKeysOf(repaired.orgId, repaired.id),
                await hookKindsOf(deps, repaired.id),
                iconBasesOf(deps),
                placementViewOf(deps, target),
                await organizationEnvironmentOf(repaired)
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

          if (force) {
            req.log.warn(
              {
                agentId: existing.id,
                sourcePlacement: placementLabel(placement),
                targetPlacement: placementLabel(moveTarget),
                userId: req.principal?.userId
              },
              'agent force reassign requested while source daemon is unavailable'
            )
          }
          const moved = force
            ? await agentMoves.forceReassign(existing, moveTarget, req.principal?.userId)
            : await agentMoves.move(existing, moveTarget, req.principal?.userId)
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
          if (existing.daemonId) await dropMcpDefsIfUnused(existing.orgId, registryProviders, [existing.daemonId])
          return toDto(
            moved,
            ctxOf(req),
            await secretKeysOf(moved.orgId, moved.id),
            await hookKindsOf(deps, moved.id),
            iconBasesOf(deps),
            placementViewOf(deps, target),
            await organizationEnvironmentOf(moved)
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
          // Same usage re-read for the staged MCP defs: an authoritative target keeps them.
          await dropMcpDefsIfUnused(existing.orgId, registryProviders, [target.daemonId])
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
        // Built-in preset agents are permanent org fixtures (preset-agents.md §3):
        // deletion is refused on every surface (console, REST, MCP all land here).
        if (existing.builtin) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', statusCode: 403, message: 'built-in agent cannot be deleted' })
        }
        const release = deps.agentMutations.tryBeginMutation(existing.id)
        if (!release) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'agent move is in progress; retry the delete' })
        }
        // External-memory fencing (advisory try-lock on the committed binding's
        // connection) happens inside the delete transaction (PgAgentRepo);
        // MemoryConnectionBusy surfaces in the catch below.
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
          const removedHooks = await deps.repos.agent.delete(orgOf(req), AgentId(req.params.id))
          // WITHDRAW it from the peer directory now, the mirror of the create path above.
          // Discovery (`channel/agents`) reads the DB live while a peer WAKE is authorized
          // against the pushed snapshot, so without this every daemon in the org keeps a flat
          // `agents[]` entry whose `admits()` still says yes — a wake routed at a row that no
          // longer exists. Gated on placement for the same reason as the create: an unplaced
          // agent was never in a snapshot, so there is nothing to withdraw and no reason to
          // churn every routingEpoch. Best-effort — the row is already gone, and `register/ok`
          // carries the corrected directory as the reconnect backstop.
          if (current.daemonId) {
            try {
              await deps.collabRoutes.broadcast(current.orgId)
            } catch (err) {
              app.log.warn(
                { err, agentId: current.id, orgId: current.orgId },
                'collaboration routes push failed after agent delete (backstop: reconnect snapshot)'
              )
            }
          }
          await replicateRemove(current, current.orgId)
          // AFTER the fan-out: `remove` resolves holders from the membership rows
          // the reap deletes, and the agent row this reads by is already gone.
          deps.recomputeDuties?.(current.orgId)
          if (current.daemonId && current.memory?.provider === 'external') {
            await removeExternalMemoryFromDaemonIfUnused(current.orgId, current.daemonId, current.memory.connectionId)
          }
          for (const h of removedHooks) deps.hooks.remove(h.id)
          // §19.4: the agent's GitLab accounts retire — memberships removed,
          // PATs revoked, accounts deleted. Best-effort here; an account whose
          // external cleanup fails stays `cleanup_pending` for a repair.
          if (deps.gitlab) {
            void deps.gitlab.accounts
              .retireAgentAccounts(current.orgId, current.id)
              .catch((err) => app.log.warn({ err, agentId: current.id }, 'gitlab account retirement failed'))
          }
          return reply.code(204).send(null)
        } catch (e) {
          if (e instanceof MemoryConnectionBusy) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'external memory connection is being updated; retry the delete'
            })
          }
          throw e
        } finally {
          release()
        }
      }
    )

    // Set who can see this agent (visibility + complete Selected audience).
    // Gated exactly like a content edit (§13.3): viewers can't, and a
    // collaborator who can't view a restricted agent 404s. Identities never
    // ride the wire, but the DERIVED conversation-gating flag does (§14/§9): a
    // visibility flip re-converges every integration of the agent — direct installs
    // get a fresh spec push, HTTP bots a route recompile — best-effort, with the
    // reconcile roster as the durable backstop.
    r.put(
      '/agents/:id/sharing',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Set agent sharing',
          description:
            'Set an agent’s visibility (Everyone vs Selected) and complete Selected audience. Requires edit rights; Selected must retain at least one current organization member, and sharedWith is intersected with current membership.',
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
            orgOf(req),
            AgentId(req.params.id),
            { visibility: req.body.visibility, sharedWith },
            req.principal?.userId
          )
          if (agent.visibility !== existing.visibility) {
            await convergeIntegrationGating(deps, agent, req.log)
          }
          // §14.8: an audience that GAINED members may authorize DMs those members
          // already have open with this agent. The diff, never the whole audience — a
          // later edit must not reassert the default over an editor's own Off.
          // Best-effort: the sharing write has landed, and a failure leaves those rows
          // Off, which is where they already were.
          const gained = agent.sharedWith.filter((id) => !existing.sharedWith.includes(id))
          await reconcileAgentLinkedDms(agent, gained, {
            users: deps.repos.user,
            orgs: deps.repos.org,
            agents: deps.repos.agent,
            integrations: deps.repos.integration,
            bots: deps.repos.bot,
            channels: deps.repos.integrationChannel,
            ...(deps.logtoIdentity ? { identity: deps.logtoIdentity } : {}),
            push: (target) => convergeIntegrationGating(deps, target, req.log),
            log: req.log
          }).catch((err: unknown) => req.log.warn({ err, agentId: agent.id }, 'gated DM: sharing catch-up failed'))
          return toDto(
            agent,
            ctxOf(req),
            await secretKeysOf(agent.orgId, agent.id),
            await hookKindsOf(deps, agent.id),
            iconBasesOf(deps),
            await placementViewFor(deps, agent),
            await organizationEnvironmentOf(agent)
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
            orgOf(req),
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
            await secretKeysOf(agent.orgId, agent.id),
            await hookKindsOf(deps, agent.id),
            iconBasesOf(deps),
            await placementViewFor(deps, agent),
            await organizationEnvironmentOf(agent)
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
            'Proxy one directory page live from the owning daemon. Pass sessionId to browse an authorized isolated session worktree; a missing directory is data (exists:false), not an error. 503 when unplaced or the daemon is offline. Pass repo (owner/repo) to address one of the agent’s authorized additional repositories instead of its primary workspace; an unauthorized name reads 404, and a daemon too old to scope by repository yields 409.',
          operationId: 'listAgentWorkspaceFiles',
          params: IdParam,
          querystring: WorkspaceFilesQueryDto,
          response: { 200: WorkspaceFilesDto, 400: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await getServingAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!(await canReadWorkspaceScope(req, agent.id, req.query.sessionId))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'workspace not found' })
        }
        if (!(await canReadWorkspaceRepoScope(agent, req.query.repo))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'workspace not found' })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        if (!(await requireSessionWorkspaceRead(reply, agent.orgId, agent.daemonId, req.query.sessionId))) return
        if (!(await requireRepoScope(reply, agent.orgId, agent.daemonId, req.query.repo))) return

        try {
          const page = await deps.control.workspaceList(agent.daemonId, {
            agentId: agent.id,
            ...(req.query.sessionId ? { sessionId: req.query.sessionId } : {}),
            ...(req.query.repo ? { repo: req.query.repo } : {}),
            path: req.query.path ?? '',
            ...(req.query.cursor !== undefined ? { cursor: req.query.cursor } : {}),
            limit: req.query.limit ?? 200
          })
          return toWorkspaceFilesDto(page)
        } catch (err) {
          if (sendWorkspaceFailure(reply, err)) return
          throw err
        }
      }
    )

    // Local skill inventory: proxy the skills the agent's materialized workspace
    // can load, tagged by origin (dream-accepted / managed / git-source / repo).
    // This is the one place the console surfaces accepted Dream skills and
    // repo-committed skills, which otherwise have no post-install UI.
    r.get(
      '/agents/:id/skills/local',
      {
        schema: {
          tags: [Tag.Skills],
          summary: 'List an agent’s local skills',
          description:
            'Proxy the skills the agent’s materialized workspace can load live from the owning daemon, each tagged by origin (dream-accepted, managed, git-source, or repo-committed). `materialized:false` means the workspace has not been prepared yet, so the empty list is "unknown", not "no skills". 503 when unplaced or the daemon is offline.',
          operationId: 'listAgentLocalSkills',
          params: IdParam,
          response: { 200: LocalSkillsDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await getServingAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        try {
          return await deps.control.listLocalSkills(agent.daemonId, { agentId: agent.id })
        } catch (err) {
          const unavailable = daemonEdgeFailure(err)
          if (unavailable !== null) {
            return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: unavailable })
          }
          throw err
        }
      }
    )

    // Runtime slash commands: what the agent's ACP runtime advertised it can be
    // asked to run. Unlike skills/local this is the runtime's own answer, so it
    // covers user/plugin skills and built-ins a workspace scan never sees.
    r.get(
      '/agents/:id/commands',
      {
        schema: {
          tags: [Tag.Skills],
          summary: 'List an agent’s runtime slash commands',
          description:
            'Proxy the slash commands the agent’s ACP runtime last advertised (`available_commands_update`) live from the owning daemon — skills, plugin skills and the harness’s own built-ins in one list, each with the runtime’s description and optional argument hint. `reported:false` means no session has advertised a list yet, so the empty list is "unknown", not "no commands". 409 when the daemon predates this read, 503 when unplaced or offline.',
          operationId: 'listAgentRuntimeCommands',
          params: IdParam,
          response: { 200: RuntimeCommandsDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await getServingAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        // Version skew: an older daemon drops the frame silently, so refuse before sending it.
        const supported = await requireDaemonFeature(
          reply,
          agent.orgId,
          agent.daemonId,
          RUNTIME_COMMANDS_FEATURE,
          'this agent version does not report its runtime commands; upgrade its daemon'
        )
        if (!supported) return reply
        try {
          return await deps.control.listRuntimeCommands(agent.daemonId, { agentId: agent.id })
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
            'Proxy one byte slice of a file live from the owning daemon (64 KiB default; page with offset while truncated). Pass sessionId to read an authorized isolated session worktree. A missing file is data (exists:false); binary files come back encoding:none. Pass repo (owner/repo) to address one of the agent’s authorized additional repositories instead of its primary workspace; an unauthorized name reads 404, and a daemon too old to scope by repository yields 409.',
          operationId: 'readAgentWorkspaceFile',
          params: IdParam,
          querystring: WorkspaceFileQueryDto,
          response: { 200: WorkspaceFileDto, 400: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await getServingAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!(await canReadWorkspaceScope(req, agent.id, req.query.sessionId))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'workspace not found' })
        }
        if (!(await canReadWorkspaceRepoScope(agent, req.query.repo))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'workspace not found' })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        if (!(await requireSessionWorkspaceRead(reply, agent.orgId, agent.daemonId, req.query.sessionId))) return
        if (!(await requireRepoScope(reply, agent.orgId, agent.daemonId, req.query.repo))) return

        try {
          const rep = await deps.control.workspaceRead(agent.daemonId, {
            agentId: agent.id,
            ...(req.query.sessionId ? { sessionId: req.query.sessionId } : {}),
            ...(req.query.repo ? { repo: req.query.repo } : {}),
            path: req.query.path,
            offset: req.query.offset ?? 0,
            limit: req.query.limit ?? 65536
          })
          return toWorkspaceFileDto(rep)
        } catch (err) {
          if (sendWorkspaceFailure(reply, err)) return
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
        const agent = await getServingAgent(req, req.params.id)
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

        const daemon = await deps.registry.getAvailable(orgOf(req), agent.daemonId)
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
          if (sendWorkspaceMutationFailure(reply, err)) return
          throw err
        }
      }
    )

    // Delete one unchanged scratch-workspace file. Like writes, this is
    // authorized by the CP but executed only on the owning daemon.
    r.delete(
      '/agents/:id/workspace/file',
      {
        schema: {
          tags: [Tag.Workspace],
          summary: 'Delete a scratch workspace file',
          description:
            'Delete one regular file from a scratch workspace on the owning daemon. Requires edit access and the mtime returned by the last read, so a newer agent revision is never removed silently. Conflicts return 409. GitHub workspaces remain read-only.',
          operationId: 'deleteAgentWorkspaceFile',
          params: IdParam,
          querystring: DeleteWorkspaceFileQueryDto,
          response: {
            200: WorkspaceFileDeleteDto,
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
        const agent = await getServingAgent(req, req.params.id)
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
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }

        const daemon = await deps.registry.getAvailable(orgOf(req), agent.daemonId)
        if (!daemon?.capabilities.features.includes('workspace-file-delete-v1')) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'this agent version does not support workspace file deletion'
          })
        }

        try {
          const ok = await deps.control.workspaceDelete(agent.daemonId, {
            agentId: agent.id,
            path: req.query.path,
            ifMatchMtime: req.query.ifMatchMtime
          })
          return { path: ok.path }
        } catch (err) {
          if (sendWorkspaceMutationFailure(reply, err)) return
          throw err
        }
      }
    )

    // Wake: bring a cluster agent's sandbox to Running WITHOUT a turn, so a Files read that refused
    // with `sandbox-unavailable` has something explicit to press (#1070). A GET never wakes anything.
    const wakes = new AgentWakeCoordinator(deps.clock)
    r.post(
      '/agents/:id/wake',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Wake the agent’s sandbox',
          description:
            'Ask the daemon serving this agent to bring its cluster sandbox to Running without starting a turn, so the workspace reads become available again. Answers with what the daemon observed: 202 with running (reachable now) or starting (resume in flight — poll the workspace read); 200 with unsupported when there is nothing to wake (a machine-placed agent, or a daemon that runs no sandboxes). Wakes are debounced per agent: one in flight is joined, and one settled within the last 30 s is answered from its result. For a pool agent nobody currently serves, the wake reaches a live member, which claims the agent the way a turn would. Requires edit access; 503 when no daemon can be reached.',
          operationId: 'wakeAgent',
          params: IdParam,
          response: { 200: AgentWakeDto, 202: AgentWakeDto, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const agent = await getOrgAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        // DISPATCH, not serving: a set agent whose lease lapsed is served by nobody for one horizon,
        // and the wake is exactly the trigger that gives it a holder again.
        const daemonId = await deps.placementResolver.dispatchDaemon(agent)
        if (!daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        // A daemon that runs no sandboxes never advertises the wake, and is never sent one.
        const daemon = await deps.registry.getAvailable(agent.orgId, daemonId)
        if (!daemon?.capabilities.features.includes(AGENT_WAKE_FEATURE))
          return reply.code(200).send({ state: 'unsupported' })
        try {
          const outcome = await wakes.wake(agent.id, () =>
            deps.control.agentWake(daemonId, { agentId: agent.id }, agent.orgId)
          )
          return reply.code(outcome.state === 'unsupported' ? 200 : 202).send({ state: outcome.state })
        } catch (err) {
          const unavailable = daemonEdgeFailure(err)
          if (unavailable === null) throw err
          return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: unavailable })
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
        const agent = await getServingAgent(req, req.params.id)
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
            ...(req.query.channelKey ? { channelKey: req.query.channelKey } : {}),
            path: req.query.path ?? 'MEMORY.md',
            offset: req.query.offset ?? 0,
            limit: req.query.limit ?? 65536
          })
          return toAgentMemoryDto(rep)
        } catch (err) {
          if (sendSandboxUnavailable(reply, err)) return
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
          querystring: MemoryFilesQueryDto,
          response: { 200: MemoryFilesDto, 400: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await getServingAgent(req, req.params.id)
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
          const rep = await deps.control.memoryList(agent.daemonId, {
            agentId: agent.id,
            ...(req.query.channelKey ? { channelKey: req.query.channelKey } : {})
          })
          return toMemoryFilesDto(rep)
        } catch (err) {
          if (sendSandboxUnavailable(reply, err)) return
          const unavailable = daemonEdgeFailure(err)
          if (unavailable !== null) {
            return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: unavailable })
          }
          throw err
        }
      }
    )

    // List the channels that have their own memory folder (channel-scoped agents).
    r.get(
      '/agents/:id/memory/channels',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List agent channel memory folders',
          description:
            'List the channels that have their own memory folder for a channel-scoped agent, live from the owning daemon (empty for agent-scoped agents). 503 when unplaced or the daemon is offline.',
          operationId: 'listAgentMemoryChannels',
          params: IdParam,
          response: { 200: MemoryChannelsDto, 400: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await getServingAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (agent.memory?.provider !== undefined && agent.memory.provider !== 'managed') {
          return { channels: [] }
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        try {
          const rep = await deps.control.memoryChannels(agent.daemonId, { agentId: agent.id })
          return {
            channels: rep.channels.map((c) => ({
              channelKey: c.channelKey,
              channel: c.channel ?? null,
              transportScope: c.transportScope ?? null
            }))
          }
        } catch (err) {
          if (sendSandboxUnavailable(reply, err)) return
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
        const agent = await getServingAgent(req, req.params.id)
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
            ...(req.query.channelKey ? { channelKey: req.query.channelKey } : {}),
            path: req.query.path ?? 'MEMORY.md',
            offset: req.query.offset ?? 0,
            limit: req.query.limit ?? 65536
          })
          return toAgentMemoryDto(rep)
        } catch (err) {
          if (sendSandboxUnavailable(reply, err)) return
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
        const agent = await getServingAgent(req, req.params.id)
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
            ...(req.query.channelKey ? { channelKey: req.query.channelKey } : {}),
            path: req.query.path ?? 'MEMORY.md',
            content: req.body.content,
            ...(req.body.ifMatchMtime ? { ifMatchMtime: req.body.ifMatchMtime } : {})
          })
          return { path: ok.path, size: ok.size, mtime: ok.mtime }
        } catch (err) {
          if (sendSandboxUnavailable(reply, err)) return
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

    // Page the managed provider's hidden provenance sidecar for one selected
    // file. The CP forwards bounded rows live and never persists their bodies.
    r.get(
      '/agents/:id/memory/history',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List memory file history',
          description:
            'Return one newest-first page of add/update/delete provenance for a managed memory file. History bodies are proxied live from the owning daemon and are not persisted here.',
          operationId: 'listAgentMemoryFileHistory',
          params: IdParam,
          querystring: MemoryHistoryQueryDto,
          response: {
            200: MemoryHistoryPageDto,
            400: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const agent = await getServingAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if ((agent.memory?.provider ?? 'managed') !== 'managed') {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: 'file change history is available only for managed memory'
          })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        try {
          return toMemoryHistoryPageDto(
            await deps.control.memoryHistory(agent.daemonId, {
              agentId: agent.id,
              ...(req.query.channelKey ? { channelKey: req.query.channelKey } : {}),
              path: req.query.path,
              ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
              limit: req.query.limit ?? 5
            })
          )
        } catch (err) {
          const failure = memoryAdminFailure(err)
          if (failure) {
            return reply.code(failure.status).send({
              error: failure.error,
              statusCode: failure.status,
              message: failure.message,
              ...(failure.code ? { code: failure.code } : {})
            })
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
        const agent = await getServingAgent(req, req.params.id)
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
            return reply.code(failure.status).send({
              error: failure.error,
              statusCode: failure.status,
              message: failure.message,
              ...(failure.code ? { code: failure.code } : {})
            })
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
        const agent = await getServingAgent(req, req.params.id)
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
            return reply.code(failure.status).send({
              error: failure.error,
              statusCode: failure.status,
              message: failure.message,
              ...(failure.code ? { code: failure.code } : {})
            })
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
        const agent = await getServingAgent(req, req.params.id)
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
            return reply.code(failure.status).send({
              error: failure.error,
              statusCode: failure.status,
              message: failure.message,
              ...(failure.code ? { code: failure.code } : {})
            })
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
        const agent = await getServingAgent(req, req.params.id)
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
            return reply.code(failure.status).send({
              error: failure.error,
              statusCode: failure.status,
              message: failure.message,
              ...(failure.code ? { code: failure.code } : {})
            })
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
        const agent = await getServingAgent(req, req.params.id)
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
            return reply.code(failure.status).send({
              error: failure.error,
              statusCode: failure.status,
              message: failure.message,
              ...(failure.code ? { code: failure.code } : {})
            })
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
        const agent = await getServingAgent(req, req.params.id)
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
            return reply.code(failure.status).send({
              error: failure.error,
              statusCode: failure.status,
              message: failure.message,
              ...(failure.code ? { code: failure.code } : {})
            })
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
        const agent = await getServingAgent(req, req.params.id)
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
            return reply.code(failure.status).send({
              error: failure.error,
              statusCode: failure.status,
              message: failure.message,
              ...(failure.code ? { code: failure.code } : {})
            })
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
        const agent = await getServingAgent(req, req.params.id)
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
            return reply.code(failure.status).send({
              error: failure.error,
              statusCode: failure.status,
              message: failure.message,
              ...(failure.code ? { code: failure.code } : {})
            })
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
      const agent = await getServingAgent(req, id)
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
      if (!dreamingSupportedOn(await deps.registry.getAvailable(agent.orgId, agent.daemonId))) {
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
      void reply.code(failure.status).send({
        error: failure.error,
        statusCode: failure.status,
        message: failure.message,
        ...(failure.code ? { code: failure.code } : {})
      })
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
          description:
            "List the agent's memory dream jobs (newest first), proxied from the owning daemon. 409 when the owning daemon is too old to support dreaming (code DAEMON_FEATURE_MISSING).",
          operationId: 'listAgentMemoryDreams',
          params: IdParam,
          querystring: z.object({
            limit: z.coerce.number().int().positive().max(50).optional(),
            // Pending skill proposals outlive the store lifecycle, so they need a
            // path that does not age out behind newer history.
            pendingSkills: z.coerce.boolean().optional()
          }),
          response: { 200: DreamListDto, 400: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await dreamAgentOrReply(req, reply, req.params.id)
        if (!agent) return
        try {
          return toDreamListDto(
            await deps.control.dreamList(agent.daemonId, {
              agentId: agent.id,
              limit: req.query.limit ?? 20,
              ...(req.query.pendingSkills ? { pendingSkills: true } : {})
            })
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
          description:
            "Fetch one dream job's metadata (never staged bodies), proxied from the owning daemon. 409 when the owning daemon is too old to support dreaming (code DAEMON_FEATURE_MISSING).",
          operationId: 'getAgentMemoryDream',
          params: DreamIdParam,
          response: { 200: DreamDto, 400: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
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
            force: req.body.force ?? false,
            ...(req.body.reviewToken !== undefined ? { reviewToken: req.body.reviewToken } : {})
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

    // Read one candidate's FULL staged body. Acceptance installs executable
    // instruction content, so the reviewer must be able to see it — a
    // model-authored description cannot be evidence for itself (design §7).
    r.get(
      '/agents/:id/memory/dreams/:dreamId/skills/:name',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Read a mined skill candidate',
          description:
            'Proxy the staged SKILL.md and every staged script for one candidate live from the owning daemon, so the reviewer can read exactly what accepting would install. Nothing staged under that name is data (exists:false), not an error.',
          operationId: 'readAgentMemoryDreamSkill',
          params: DreamSkillParam,
          response: { 200: DreamSkillContentDto, 400: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await dreamAgentOrReply(req, reply, req.params.id)
        if (!agent) return
        try {
          const content = await deps.control.dreamSkillRead(agent.daemonId, {
            agentId: agent.id,
            dreamId: req.params.dreamId,
            name: req.params.name
          })
          return {
            name: content.name,
            exists: content.exists,
            skill: content.skill ?? null,
            scripts: content.scripts ?? [],
            ...(content.reviewToken !== undefined ? { reviewToken: content.reviewToken } : {})
          }
        } catch (err) {
          if (sendDreamFailure(reply, err)) return
          throw err
        }
      }
    )

    // Accept one mined skill candidate — installs it for THIS agent (design §7).
    r.post(
      '/agents/:id/memory/dreams/:dreamId/skills/:name/accept',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Accept a mined skill',
          description:
            "Install one of this dream's mined skill candidates for the agent. Copies the reviewed skill into the agent's own tree, so discarding the dream later does not uninstall it. 409 if the candidate was already dismissed or the daemon predates dreaming.",
          operationId: 'acceptAgentMemoryDreamSkill',
          params: DreamSkillParam,
          body: AcceptDreamSkillBody,
          response: { 200: DreamDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await dreamAgentOrReply(req, reply, req.params.id, true)
        if (!agent) return
        try {
          const { dream } = await deps.control.dreamSkillAccept(agent.daemonId, {
            agentId: agent.id,
            dreamId: req.params.dreamId,
            name: req.params.name,
            ...(req.body?.reviewToken !== undefined ? { reviewToken: req.body.reviewToken } : {})
          })
          return toDreamDto(dream)
        } catch (err) {
          if (sendDreamFailure(reply, err)) return
          throw err
        }
      }
    )

    // Dismiss one mined skill candidate — drops its staging, records the decision
    // so later dreams can be told not to propose it again.
    r.post(
      '/agents/:id/memory/dreams/:dreamId/skills/:name/dismiss',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Dismiss a mined skill',
          description:
            "Reject one of this dream's mined skill candidates. Its staging is dropped and the decision recorded, so later dreams are told not to propose it again. 409 if it was already accepted.",
          operationId: 'dismissAgentMemoryDreamSkill',
          params: DreamSkillParam,
          response: { 200: DreamDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await dreamAgentOrReply(req, reply, req.params.id, true)
        if (!agent) return
        try {
          const { dream } = await deps.control.dreamSkillDismiss(agent.daemonId, {
            agentId: agent.id,
            dreamId: req.params.dreamId,
            name: req.params.name
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
          response: { 200: DreamFilesDto, 400: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
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
          response: { 200: DreamFileDto, 400: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
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
            'Report whether the owning daemon’s checkout is clean. Pass sessionId for an authorized isolated session worktree; a dirty tree or a from-scratch (non-repo) workspace is data (clean/isRepo), not an error. Pass repo (owner/repo) to address one of the agent’s authorized additional repositories instead of its primary workspace; an unauthorized name reads 404, and a daemon too old to scope by repository yields 409.',
          operationId: 'getAgentWorkspaceGitStatus',
          params: IdParam,
          querystring: WorkspaceScopeQueryDto,
          response: { 200: WorkspaceGitStatusDto, 400: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        // Route through getOrgAgent (org boundary + canView) — a bare repo.get here
        // would leak a restricted / cross-org agent's checkout state.
        const agent = await getServingAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!(await canReadWorkspaceScope(req, agent.id, req.query.sessionId))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'workspace not found' })
        }
        if (!(await canReadWorkspaceRepoScope(agent, req.query.repo))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'workspace not found' })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        if (!(await requireSessionWorkspaceRead(reply, agent.orgId, agent.daemonId, req.query.sessionId))) return
        if (!(await requireRepoScope(reply, agent.orgId, agent.daemonId, req.query.repo))) return

        try {
          const rep = await deps.control.workspaceGitStatus(agent.daemonId, {
            agentId: agent.id,
            ...(req.query.sessionId ? { sessionId: req.query.sessionId } : {}),
            ...(req.query.repo ? { repo: req.query.repo } : {})
          })
          return toWorkspaceGitStatusDto(rep, workspaceGitConfigFor(agent, req.query.repo))
        } catch (err) {
          if (sendWorkspaceFailure(reply, err)) return
          throw err
        }
      }
    )

    // Workspace git diff: proxy ONE path's unified-diff text live from the owning daemon.
    // A binary change, an unchanged path and a non-repo workspace are all data.
    r.get(
      '/agents/:id/workspace/gitdiff',
      {
        schema: {
          tags: [Tag.Workspace],
          summary: 'Get a workspace file diff',
          description:
            'Proxy the unified diff of one workspace path live from the owning daemon. `scope=staged` compares the index against HEAD; the default `unstaged` compares the worktree against the index. Pass sessionId for an authorized isolated session worktree. A binary change (binary:true), a path with no changes (diff:null) and a from-scratch workspace (isRepo:false) are all data, not errors; the daemon bounds the text to the wire frame cap and reports truncated. 503 when unplaced or the daemon is offline. Pass repo (owner/repo) to address one of the agent’s authorized additional repositories instead of its primary workspace; an unauthorized name reads 404, and a daemon too old to scope by repository yields 409.',
          operationId: 'getAgentWorkspaceGitDiff',
          params: IdParam,
          querystring: WorkspaceGitDiffQueryDto,
          response: { 200: WorkspaceGitDiffDto, 400: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        // Route through getOrgAgent (org boundary + canView) — a bare repo.get here
        // would leak a restricted / cross-org agent's uncommitted work.
        const agent = await getServingAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!(await canReadWorkspaceScope(req, agent.id, req.query.sessionId))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'workspace not found' })
        }
        if (!(await canReadWorkspaceRepoScope(agent, req.query.repo))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'workspace not found' })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        if (!(await requireGitReview(reply, agent.orgId, agent.daemonId))) return
        if (!(await requireSessionWorkspaceRead(reply, agent.orgId, agent.daemonId, req.query.sessionId))) return
        if (!(await requireRepoScope(reply, agent.orgId, agent.daemonId, req.query.repo))) return

        try {
          const rep = await deps.control.workspaceGitDiff(agent.daemonId, {
            agentId: agent.id,
            ...(req.query.sessionId ? { sessionId: req.query.sessionId } : {}),
            ...(req.query.repo ? { repo: req.query.repo } : {}),
            path: req.query.path,
            staged: req.query.scope === 'staged'
          })
          return toWorkspaceGitDiffDto(rep)
        } catch (err) {
          if (sendWorkspaceFailure(reply, err)) return
          throw err
        }
      }
    )

    // Workspace git log: proxy the newest commits of the checked-out branch live from the
    // owning daemon, each marked `pushed` against the tracking ref. Empty repo ⇒ data.
    r.get(
      '/agents/:id/workspace/gitlog',
      {
        schema: {
          tags: [Tag.Workspace],
          summary: 'List workspace commits',
          description:
            'Proxy the newest commits of the owning daemon’s checked-out branch (20 by default, 50 max), newest first. Pass sessionId for an authorized isolated session worktree. Each commit is marked pushed when the branch’s upstream ref already contains it; tracking:null means the branch tracks nothing, so pushed reads false throughout. An empty repo (commits: []) and a from-scratch workspace (isRepo:false) are data, not errors. 503 when unplaced or the daemon is offline. Pass repo (owner/repo) to address one of the agent’s authorized additional repositories instead of its primary workspace; an unauthorized name reads 404, and a daemon too old to scope by repository yields 409.',
          operationId: 'listAgentWorkspaceGitLog',
          params: IdParam,
          querystring: WorkspaceGitLogQueryDto,
          response: { 200: WorkspaceGitLogDto, 400: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        // Route through getOrgAgent (org boundary + canView) — a bare repo.get here
        // would leak a restricted / cross-org agent's commit history.
        const agent = await getServingAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!(await canReadWorkspaceScope(req, agent.id, req.query.sessionId))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'workspace not found' })
        }
        if (!(await canReadWorkspaceRepoScope(agent, req.query.repo))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'workspace not found' })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        if (!(await requireGitReview(reply, agent.orgId, agent.daemonId))) return
        if (!(await requireSessionWorkspaceRead(reply, agent.orgId, agent.daemonId, req.query.sessionId))) return
        if (!(await requireRepoScope(reply, agent.orgId, agent.daemonId, req.query.repo))) return

        try {
          const rep = await deps.control.workspaceGitLog(agent.daemonId, {
            agentId: agent.id,
            ...(req.query.sessionId ? { sessionId: req.query.sessionId } : {}),
            ...(req.query.repo ? { repo: req.query.repo } : {}),
            limit: req.query.limit ?? 20
          })
          return toWorkspaceGitLogDto(rep)
        } catch (err) {
          if (sendWorkspaceFailure(reply, err)) return
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
            'Force an on-demand ff-only pull on the owning daemon; a pull that can’t fast-forward (diverged, local edits) is data (ok:false + detail), only an offline daemon yields 503. Pass repo to pull one of the agent’s authorized additional repositories instead of its primary workspace.',
          operationId: 'pullAgentWorkspace',
          params: IdParam,
          querystring: WorkspaceRepoScopeQueryDto,
          response: { 200: WorkspaceGitPullDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        // Route through getOrgAgent (org boundary + canView) — a bare repo.get here
        // would let a non-viewer trigger a pull on a restricted / cross-org agent.
        const agent = await getServingAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!(await canReadWorkspaceRepoScope(agent, req.query.repo))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'workspace not found' })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        if (!(await requireRepoScope(reply, agent.orgId, agent.daemonId, req.query.repo))) return

        try {
          const rep = await deps.control.workspaceGitPull(agent.daemonId, {
            agentId: agent.id,
            ...(req.query.repo ? { repo: req.query.repo } : {})
          })
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

    /** The chain every console git write shares: the READ chain plus the generic write gates,
     *  because no git- or workspace-scoped action exists — "may mutate this agent's workspace" is
     *  spelled `denyViewerWrite` + `canEdit`, as for the file editor. Deliberately NOT `gitpull`'s
     *  shape, which gates a mutation on `canView` alone. null ⇒ replied; nothing reached the daemon. */
    const gitWriteTarget = async (
      req: FastifyRequest,
      reply: FastifyReply,
      agentId: string,
      sessionId: string | undefined,
      repo: string | undefined,
      requireFeature: (reply: FastifyReply, orgId: OrgId, daemonId: DaemonId) => Promise<boolean>
    ): Promise<{ agent: AgentRecord; daemonId: DaemonId } | null> => {
      if (denyViewerWrite(req, reply)) return null
      const agent = await getServingAgent(req, agentId)
      if (!agent) {
        void reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        return null
      }
      if (!canEdit(agent, ctxOf(req))) {
        void reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        return null
      }
      // A session worktree is that session's protected body surface on the write side too:
      // editing the agent does not authorize touching a worktree its owner keeps private.
      if (!(await canReadWorkspaceScope(req, agent.id, sessionId))) {
        void reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'workspace not found' })
        return null
      }
      if (!(await canReadWorkspaceRepoScope(agent, repo))) {
        void reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'workspace not found' })
        return null
      }
      if (!agent.daemonId) {
        void reply
          .code(503)
          .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        return null
      }
      if (!(await requireFeature(reply, agent.orgId, agent.daemonId))) return null
      if (!(await requireSessionWorkspaceRead(reply, agent.orgId, agent.daemonId, sessionId))) return null
      if (!(await requireRepoScope(reply, agent.orgId, agent.daemonId, repo))) return null
      return { agent, daemonId: agent.daemonId }
    }

    // Stage the named paths in the owning daemon's checkout. The REP is the FRESH status,
    // so the console renders the result of its own action without a second read.
    r.post(
      '/agents/:id/workspace/gitstage',
      {
        schema: {
          tags: [Tag.Workspace],
          summary: 'Stage workspace paths',
          description:
            'Stage the named paths in the owning daemon’s checkout, or in an authorized isolated session worktree when sessionId is given. Requires edit access to the agent. Answers with the FRESH git status, so the console never re-polls for the result of its own action. An empty list, a path the checkout does not currently report as changed and a from-scratch workspace (isRepo:false) are all data, not errors; 409 when the agent is busy in its workspace, 503 when unplaced or the daemon is offline. The control plane executes no git and stores no workspace state. Pass repo (owner/repo) to address one of the agent’s authorized additional repositories instead of its primary workspace; an unauthorized name reads 404, and a daemon too old to scope by repository yields 409.',
          operationId: 'stageAgentWorkspacePaths',
          params: IdParam,
          querystring: WorkspaceScopeQueryDto,
          body: WorkspaceGitStageBody,
          response: {
            200: WorkspaceGitStatusDto,
            400: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const target = await gitWriteTarget(
          req,
          reply,
          req.params.id,
          req.query.sessionId,
          req.query.repo,
          requireGitWrite
        )
        if (!target) return

        try {
          const rep = await deps.control.workspaceGitStage(target.daemonId, {
            agentId: target.agent.id,
            ...(req.query.sessionId ? { sessionId: req.query.sessionId } : {}),
            ...(req.query.repo ? { repo: req.query.repo } : {}),
            paths: req.body.paths
          })
          return toWorkspaceGitStatusDto(rep, workspaceGitConfigFor(target.agent, req.query.repo))
        } catch (err) {
          if (sendWorkspaceMutationFailure(reply, err)) return
          throw err
        }
      }
    )

    // Unstage the named paths — the same chain, the same fresh-status answer.
    r.post(
      '/agents/:id/workspace/gitunstage',
      {
        schema: {
          tags: [Tag.Workspace],
          summary: 'Unstage workspace paths',
          description:
            'Remove the named paths from the index of the owning daemon’s checkout, or of an authorized isolated session worktree when sessionId is given. Requires edit access to the agent. Answers with the FRESH git status. The working tree is never touched, so nothing the agent wrote is lost; an empty list, a path that is not staged and a from-scratch workspace (isRepo:false) are all data. 409 when the agent is busy in its workspace, 503 when unplaced or the daemon is offline. Pass repo (owner/repo) to address one of the agent’s authorized additional repositories instead of its primary workspace; an unauthorized name reads 404, and a daemon too old to scope by repository yields 409.',
          operationId: 'unstageAgentWorkspacePaths',
          params: IdParam,
          querystring: WorkspaceScopeQueryDto,
          body: WorkspaceGitStageBody,
          response: {
            200: WorkspaceGitStatusDto,
            400: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const target = await gitWriteTarget(
          req,
          reply,
          req.params.id,
          req.query.sessionId,
          req.query.repo,
          requireGitWrite
        )
        if (!target) return

        try {
          const rep = await deps.control.workspaceGitUnstage(target.daemonId, {
            agentId: target.agent.id,
            ...(req.query.sessionId ? { sessionId: req.query.sessionId } : {}),
            ...(req.query.repo ? { repo: req.query.repo } : {}),
            paths: req.body.paths
          })
          return toWorkspaceGitStatusDto(rep, workspaceGitConfigFor(target.agent, req.query.repo))
        } catch (err) {
          if (sendWorkspaceMutationFailure(reply, err)) return
          throw err
        }
      }
    )

    // Commit the staged changes on the owning daemon, attributed to the daemon's
    // registered `gitCommitIdentity`. Every refusal is data carrying a closed `reason`.
    r.post(
      '/agents/:id/workspace/gitcommit',
      {
        schema: {
          tags: [Tag.Workspace],
          summary: 'Commit the staged workspace changes',
          description:
            'Commit whatever is staged in the owning daemon’s checkout, or in an authorized isolated session worktree when sessionId is given. Requires edit access to the agent. The commit is attributed to the identity the daemon registered at handshake, never to the console user. Nothing staged, a blank message, a daemon with no registered identity and a git refusal all come back as ok:false with a machine `reason`, not an HTTP error; 409 when the agent is busy in its workspace, 503 when unplaced or the daemon is offline. The control plane forwards the message and stores neither it nor the diff. Pass repo (owner/repo) to address one of the agent’s authorized additional repositories instead of its primary workspace; an unauthorized name reads 404, and a daemon too old to scope by repository yields 409.',
          operationId: 'commitAgentWorkspace',
          params: IdParam,
          querystring: WorkspaceScopeQueryDto,
          body: WorkspaceGitCommitBody,
          response: {
            200: WorkspaceGitCommitResultDto,
            400: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const target = await gitWriteTarget(
          req,
          reply,
          req.params.id,
          req.query.sessionId,
          req.query.repo,
          requireGitWrite
        )
        if (!target) return

        try {
          const rep = await deps.control.workspaceGitCommit(target.daemonId, {
            agentId: target.agent.id,
            ...(req.query.sessionId ? { sessionId: req.query.sessionId } : {}),
            ...(req.query.repo ? { repo: req.query.repo } : {}),
            message: req.body.message
          })
          return toWorkspaceGitCommitDto(rep)
        } catch (err) {
          if (sendWorkspaceMutationFailure(reply, err)) return
          throw err
        }
      }
    )

    // Push the checked-out branch to the daemon-authorized remote. The daemon derives
    // the refspec and never forces, so every rejection comes back as data.
    r.post(
      '/agents/:id/workspace/gitpush',
      {
        schema: {
          tags: [Tag.Workspace],
          summary: 'Push the workspace branch',
          description:
            'Push the branch checked out in the owning daemon’s workspace, or in an authorized isolated session worktree when sessionId is given, to the remote that daemon authorizes. Requires edit access to the agent. The daemon derives the refspec and never forces: a diverged branch (reason diverged), a detached HEAD (detached-head), a branch tracking nothing (no-upstream) and a remote rejection (rejected) are all ok:false data, and a push with nothing to send is ok:true with ahead:0. 409 when the agent is busy in its workspace, 503 when unplaced or the daemon is offline. Pass repo (owner/repo) to address one of the agent’s authorized additional repositories instead of its primary workspace; an unauthorized name reads 404, and a daemon too old to scope by repository yields 409.',
          operationId: 'pushAgentWorkspace',
          params: IdParam,
          querystring: WorkspaceScopeQueryDto,
          response: {
            200: WorkspaceGitPushResultDto,
            400: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const target = await gitWriteTarget(
          req,
          reply,
          req.params.id,
          req.query.sessionId,
          req.query.repo,
          requireGitWrite
        )
        if (!target) return

        try {
          const rep = await deps.control.workspaceGitPush(target.daemonId, {
            agentId: target.agent.id,
            ...(req.query.sessionId ? { sessionId: req.query.sessionId } : {}),
            ...(req.query.repo ? { repo: req.query.repo } : {})
          })
          return toWorkspaceGitPushDto(rep)
        } catch (err) {
          if (sendWorkspaceMutationFailure(reply, err)) return
          throw err
        }
      }
    )

    // Draft a commit message from the staged diff on the AGENT's own runtime. The CP is
    // never on the inference path (webchat-side-panels.md §2) — it authorizes a press,
    // forwards it, and proxies the answer without storing the diff or the message.
    r.post(
      '/agents/:id/workspace/gitmessage',
      {
        schema: {
          tags: [Tag.Workspace],
          summary: 'Draft a commit message from the staged diff',
          description:
            'Ask the owning daemon to draft a conventional-commit message from the staged diff of its checkout, or of an authorized isolated session worktree when sessionId is given. The model pass runs on the daemon against the agent’s own runtime — the control plane never calls a model provider, and stores neither the diff nor the message. Requires edit access to the agent, because it spends the agent’s model budget. Nothing staged, a runtime that declines or answers with prose, and a timeout are all ok:false with a detail to render; 503 when unplaced or the daemon is offline. This writes nothing: the reader edits the draft and commits it separately. Pass repo (owner/repo) to address one of the agent’s authorized additional repositories instead of its primary workspace; an unauthorized name reads 404, and a daemon too old to scope by repository yields 409.',
          operationId: 'draftAgentWorkspaceCommitMessage',
          params: IdParam,
          querystring: WorkspaceScopeQueryDto,
          response: {
            200: WorkspaceGitMessageResultDto,
            400: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const target = await gitWriteTarget(
          req,
          reply,
          req.params.id,
          req.query.sessionId,
          req.query.repo,
          requireGitMessage
        )
        if (!target) return

        try {
          const rep = await deps.control.workspaceGitMessage(target.daemonId, {
            agentId: target.agent.id,
            ...(req.query.sessionId ? { sessionId: req.query.sessionId } : {}),
            ...(req.query.repo ? { repo: req.query.repo } : {})
          })
          return toWorkspaceGitMessageDto(rep)
        } catch (err) {
          if (sendWorkspaceMutationFailure(reply, err)) return
          throw err
        }
      }
    )

    // One ACP session's background tasks, projected live from the owning daemon's in-memory
    // lease. A READ: there is no cancel counterpart, because no ACP primitive can address one
    // background task (webchat-side-panels.md §3.5). The CP stores nothing.
    r.get(
      '/agents/:id/tasks',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List a session’s background tasks',
          description:
            'Proxy the background tasks of ONE of the agent’s ACP sessions live from the owning daemon, live ones first and then the daemon’s bounded settled history. sessionId is REQUIRED, unlike the workspace reads: the daemon tracks tasks per (agent, ACP session) and has no per-agent aggregate to answer with. Both the session’s own visibility rule and the agent’s apply, so a session the caller cannot see reads as absent (404) — but the session’s workspace isolation does not, because tasks are not a checkout. tracked:false means the daemon holds no tracking for that session (a runtime that reports no task lifecycle, or one that has not yet), which is data and different from an empty list; a settled task stays listed for a bounded while with its outcome. There is no cancel counterpart: no agent-protocol primitive can address a single background task, so the escape hatch is cancelling the turn. 409 when the daemon is too old to report tasks, 503 when the agent is unplaced or its daemon is offline. The control plane persists none of this.',
          operationId: 'listAgentSessionTasks',
          params: IdParam,
          querystring: AgentTasksQueryDto,
          response: { 200: AgentTasksDto, 400: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        // Route through getOrgAgent (org boundary + canView) — a bare repo.get here would leak
        // a restricted / cross-org agent's work, and task descriptions are model-authored text.
        const agent = await getServingAgent(req, req.params.id)
        if (!agent) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        if (!(await visibleAgentSession(req, agent.id, req.query.sessionId))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'session not found' })
        }
        if (!agent.daemonId) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent has no live daemon' })
        }
        if (!(await requireTasks(reply, agent.orgId, agent.daemonId))) return

        try {
          const rep = await deps.control.taskList(agent.daemonId, {
            agentId: agent.id,
            sessionId: req.query.sessionId
          })
          return toAgentTasksDto(rep)
        } catch (err) {
          if (sendTaskFailure(reply, err)) return
          throw err
        }
      }
    )
  }
}
