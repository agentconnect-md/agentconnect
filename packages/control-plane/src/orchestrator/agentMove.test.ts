import { onDaemon, onSet, placementTargetOf, samePlacement, type PlacementTarget } from '../domain/placement.js'
import { describe, expect, it } from 'vitest'
import type { Ack, AgentActivate, AgentDetach, AgentUpsert } from '@agentconnect.md/protocol'
import { AgentId, BotId, CronId, DaemonId, IntegrationId, OrgId } from '../domain/ids.js'
import type {
  AgentRecord,
  AgentRepo,
  AgentWorkspace,
  BotRecord,
  CronRecord,
  GitAgentWorkspace,
  IntegrationRecord
} from '../persistence/ports.js'
import type { ControlSender } from './outbound.js'
import type { HookService } from '../hooks/hook.service.js'
import type { HttpBotOrchestrator } from './httpBot.js'
import type { CollabRoutesService } from './collabRoutes.service.js'
import { AgentMoveConflict, AgentMoveFailed, AgentMoveService } from './agentMove.js'
import { AgentSpecAssembler } from './agentSpecAssembler.js'
import { AgentMutationGate } from './agentMutationGate.js'
import { buildCpPlatformRegistry } from '../platforms/registry.js'
import { createSlackCpProvider } from '../platforms/slack/provider.js'
import { createTelegramCpProvider } from '../platforms/telegram/provider.js'
import { createDiscordCpProvider } from '../platforms/discord/provider.js'
import { createFeishuCpProvider } from '../platforms/feishu/provider.js'

// §9: the move bundle's `IntegrationSpec.config` comes from the platform
// provider. Offline stubs — the projectors reach no provider API.
const PLATFORMS = buildCpPlatformRegistry([
  createSlackCpProvider({}),
  createTelegramCpProvider({ verifyBot: async () => ({ status: 'unreachable' }) }),
  createDiscordCpProvider({ ensureMessageContentIntent: async () => 'ready' }),
  createFeishuCpProvider({})
])

const AGENT = AgentId('11111111-1111-4111-8111-111111111111')
const ORG = OrgId('55555555-5555-4555-8555-555555555555')
const SOURCE = DaemonId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
const TARGET = DaemonId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
const INTEGRATION = IntegrationId('22222222-2222-4222-8222-222222222222')
const BOT = BotId('33333333-3333-4333-8333-333333333333')
const CRON = CronId('44444444-4444-4444-8444-444444444444')
const MEMBER = DaemonId('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
const OFFLINE_MEMBER = DaemonId('dddddddd-dddd-4ddd-8ddd-dddddddddddd')
const SET = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const MODIFIED_AT = new Date('2026-07-11T00:00:00.000Z')
const SESSION_KEY = { platform: 'slack' as const, channel: 'C-move', thread: 'T-move' }
const WORKSPACE_REPO_ID = 4242n
const STAGED_MOVE = '77777777-7777-4777-8777-777777777777'
const GITHUB_WORKSPACE = {
  mode: 'git',
  gitRepo: 'https://github.com/acme/repo.git',
  gitBranch: 'main',
  credential: { provider: 'github', installationId: '66666666-6666-4666-8666-666666666666', access: 'write' }
} satisfies GitAgentWorkspace

function agent(daemonId: string | null): AgentRecord {
  return {
    id: AGENT,
    orgId: ORG,
    name: 'mover',
    displayName: null,
    builtin: false,
    icon: null,
    description: null,
    runtime: 'claude',
    model: null,
    reasoningEffort: null,
    outputMode: null,
    showFooter: true,
    showStatusBar: false,
    fastMode: null,
    permissionMode: null,
    allowRuntimeChangesInChat: false,
    pause: null,
    env: {},
    mcpServers: [],
    skills: [],
    managedSkills: [],
    memory: null,
    status: daemonId ? 'active' : 'inactive',
    placementKind: 'daemon',
    daemonId: daemonId ? DaemonId(daemonId) : null,
    setId: null,
    workspace: { mode: 'scratch' },
    capabilities: [],
    createdAt: new Date(),
    createdBy: null,
    createdByUserId: null,
    visibility: 'org',
    sharedWith: [],
    callPolicy: 'all',
    allowedCallerAgentIds: [],
    outboundPolicy: 'all',
    allowedTargetAgentIds: [],
    introduceOnJoin: false,
    runInSandbox: false,
    lastModifiedAt: MODIFIED_AT,
    lastModifiedBy: null,
    configRevision: 0n
  }
}

const integration = {
  id: INTEGRATION,
  orgId: ORG,
  agentId: AGENT,
  botId: BOT,
  platform: 'slack',
  name: 'Slack',
  status: 'active',
  createdAt: new Date()
} satisfies IntegrationRecord

const bot = {
  id: BOT,
  orgId: ORG,
  platform: 'slack',
  name: 'Slack',
  prebuilt: false,
  slackAppId: null,
  teamId: null,
  workspaceId: null,
  workspaceName: null,
  botUserId: null,
  revokedAt: null,
  credentialRevision: 1,
  credentialInstalledAt: null,
  grantedScopes: null,
  externalAppId: null,
  externalTenantId: null,
  platformConfig: null,
  discordAppId: null,
  feishuAppId: null,
  feishuRegion: null,
  shareable: false,
  transport: 'socket',
  preferredAgentId: null,
  createdBy: null,
  lastUsedAt: null,
  lastAgentName: null,
  agentIds: [AGENT],
  inUseByAgentId: AGENT,
  createdAt: new Date()
} satisfies BotRecord

const cron = {
  id: CRON,
  orgId: ORG,
  agentId: AGENT,
  name: 'daily',
  schedule: '0 0 * * *',
  timezone: 'UTC',
  targetPlatform: 'slack',
  targetChannel: null,
  targetIntegrationId: null,
  trigger: 'daily',
  enabled: true,
  lastRunAt: null,
  createdBy: null,
  createdByUserId: null,
  visibility: 'org',
  sharedWith: [],
  createdAt: new Date(),
  lastModifiedAt: new Date(),
  lastModifiedBy: null
} satisfies CronRecord

function make(
  opts: {
    failTargetActivate?: boolean
    failRollbackTargetDetach?: boolean
    casMiss?: boolean
    changeBundleAfterFirstActivate?: boolean
    moveOwnershipAfterFirstActivate?: boolean
    rejectWorkspaceActivate?: boolean
    rejectWorkspaceRestore?: boolean
    workspacePersistenceFailsBeforeCommit?: boolean
    workspacePersistenceFailsAfterCommit?: boolean
    unplaced?: boolean
    workspace?: GitAgentWorkspace
    workspaceRepoId?: bigint
    sourceDetachStarted?: () => void
    waitSourceDetach?: Promise<void>
    /** Which set each daemon belongs to (absent daemon ⇒ no set) + each set's members. */
    sets?: { setIdOf: Record<string, string>; members: Record<string, string[]> }
    /** Daemon ids the liveness fake reports READY; others read as disconnected. */
    readyDaemons?: string[]
    /** Placement columns merged over the initial record (e.g. a `set` placement). */
    placement?: Partial<AgentRecord>
    /** A repository grant that commits inside the detach → workspace-CAS window. */
    grantDuringWorkspaceCas?: { repoFullName: string; repoId: bigint }
    /** A repository grant that commits while the rejected workspace activation is in flight. */
    grantDuringWorkspaceActivate?: { repoFullName: string; repoId: bigint }
    /** The grant `setWorkspaceRepoId` finds redundant and deletes after the activation. */
    redundantGrant?: { repoFullName: string; repoId: bigint }
  } = {}
) {
  let current: AgentRecord = {
    ...agent(opts.unplaced ? null : SOURCE),
    ...(opts.workspace
      ? { workspace: opts.workspace, workspaceRepoId: opts.workspaceRepoId ?? WORKSPACE_REPO_ID }
      : {}),
    ...(opts.placement ?? {})
  }
  let grants: Array<{ repoFullName: string; repoId: bigint }> = opts.redundantGrant ? [opts.redundantGrant] : []
  let cronRows = [cron]
  const calls: string[] = []
  const activations: AgentActivate[] = []
  const upserts: AgentUpsert[] = []
  const detaches: AgentDetach[] = []
  // The org each control frame was scoped to — undefined is what an install-wide
  // member's connection rejects, so it is the interesting value here.
  const frameOrgs: Array<string | undefined> = []
  const releasedLive: (typeof SESSION_KEY)[] = []
  const mutations = new AgentMutationGate()
  const repo = {
    getUnscoped: async () => current,
    setWorkspace: async (
      _orgId: string,
      _id: string,
      _expected: Date,
      _expectedMode: AgentWorkspace['mode'],
      workspace: AgentWorkspace,
      workspaceRepoId?: bigint
    ) => {
      if (opts.workspacePersistenceFailsBeforeCommit) throw new Error('database unavailable')
      // A grant landing between the pre-detach snapshot and this CAS: it advances the same
      // per-agent revision counter, so the CAS below commits on top of ITS revision.
      if (opts.grantDuringWorkspaceCas) {
        grants = [...grants, opts.grantDuringWorkspaceCas]
        current = { ...current, configRevision: current.configRevision + 1n }
      }
      current = {
        ...current,
        workspace,
        workspaceRepoId,
        lastModifiedAt: new Date(current.lastModifiedAt.getTime() + 1),
        configRevision: current.configRevision + 1n
      }
      if (opts.workspacePersistenceFailsAfterCommit) throw new Error('database response lost')
      return current
    },
    restoreWorkspace: async (
      _orgId: string,
      _id: string,
      _expected: Date,
      _expectedWorkspace: AgentWorkspace,
      _expectedWorkspaceRepoId: bigint | undefined,
      workspace: AgentRecord['workspace'],
      workspaceRepoId?: bigint
    ) => {
      // Like the real rollback: it is an edit of its own, so it ADVANCES the revision rather than
      // rewinding to the rejected edit's predecessor — which is what the target's fence compares.
      current = {
        ...current,
        workspace,
        workspaceRepoId,
        lastModifiedAt: new Date(current.lastModifiedAt.getTime() + 1),
        configRevision: current.configRevision + 1n
      }
      return current
    },
    setWorkspaceRepoId: async (_id: string, repoId: bigint) => {
      // Like the real cleanup: it drops the now-redundant grant AND advances the revision,
      // both after the activation has already been sent.
      grants = grants.filter((grant) => grant.repoId !== repoId)
      current = { ...current, workspaceRepoId: repoId, configRevision: current.configRevision + 1n }
      return true
    },
    movePlacement: async (_id: string, expected: PlacementTarget, target: PlacementTarget) => {
      if (opts.casMiss || !samePlacement(placementTargetOf(current), expected)) return null
      current = agent(target.kind === 'daemon' ? target.daemonId : null)
      return current
    }
  } as unknown as AgentRepo
  const ack = (ok = true, reason?: string): Ack => ({ ok, ...(reason ? { reason } : {}) })
  const appliedRevisions = new Map<string, bigint>()
  let targetDetachCount = 0
  const control = {
    agentDetach: async (daemonId: string, value: AgentDetach, orgId?: string) => {
      calls.push(`detach:${daemonId}`)
      detaches.push(value)
      frameOrgs.push(orgId)
      if (daemonId === SOURCE && targetDetachCount === 0 && opts.waitSourceDetach) {
        opts.sourceDetachStarted?.()
        await opts.waitSourceDetach
      }
      if (daemonId === TARGET) {
        targetDetachCount += 1
        if (opts.failRollbackTargetDetach && targetDetachCount > 1) return ack(false, 'still running')
      }
      return ack()
    },
    agentActivate: async (daemonId: string, value: AgentActivate, orgId?: string) => {
      calls.push(`activate:${daemonId}`)
      activations.push(value)
      frameOrgs.push(orgId)
      // The target's own revision fence, which the CP cannot see and must not violate: a bundle
      // older than the one this daemon already applied activates stale credentials and is refused.
      // A rejected activation still leaves its spec applied, so a rollback has to be newer.
      const incoming = BigInt(value.spec.configRevision ?? '0')
      const seen = appliedRevisions.get(daemonId) ?? -1n
      if (incoming < seen) {
        return ack(false, `agent/activate: spec revision ${incoming} is not newer than the applied configuration`)
      }
      appliedRevisions.set(daemonId, incoming)
      if (value.reconcileWorkspace && opts.rejectWorkspaceActivate && activations.length === 1) {
        // A grant landing while the rejected activation was in flight: the rollback CAS below
        // then commits on top of ITS revision.
        if (opts.grantDuringWorkspaceActivate) {
          grants = [...grants, opts.grantDuringWorkspaceActivate]
          current = { ...current, configRevision: current.configRevision + 1n }
        }
        return ack(false, 'clone failed')
      }
      if (value.reconcileWorkspace && opts.rejectWorkspaceRestore && activations.length === 2) {
        return ack(false, 'workspace is not empty')
      }
      if (daemonId === TARGET && activations.filter((a) => a.agentId === AGENT).length === 1) {
        if (opts.changeBundleAfterFirstActivate) cronRows = [{ ...cron, schedule: '5 * * * *' }]
        if (opts.moveOwnershipAfterFirstActivate) current = agent(SOURCE)
      }
      if (daemonId === TARGET && opts.failTargetActivate) return ack(false, 'cannot start')
      return ack()
    },
    agentUpsert: async (daemonId: string, value: AgentUpsert, orgId?: string) => {
      calls.push(`upsert:${daemonId}`)
      upserts.push(value)
      frameOrgs.push(orgId)
    }
  } as unknown as ControlSender
  const service = new AgentMoveService({
    agents: repo,
    integrations: { listForAgent: async () => [integration] } as unknown as ConstructorParameters<
      typeof AgentMoveService
    >[0]['integrations'],
    integrationChannels: { listForIntegration: async () => [] } as unknown as ConstructorParameters<
      typeof AgentMoveService
    >[0]['integrationChannels'],
    bots: { getUnscoped: async () => bot } as unknown as ConstructorParameters<typeof AgentMoveService>[0]['bots'],
    botSecrets: {
      get: async () => ({ botToken: 'xoxb-test', appToken: 'xapp-test' })
    } as unknown as ConstructorParameters<typeof AgentMoveService>[0]['botSecrets'],
    platforms: PLATFORMS,
    // The real assembler over a fake store — exercises project()/secretsOf() as prod does.
    specs: new AgentSpecAssembler(
      {
        get: async () => ({}),
        merge: async () => {},
        keys: async () => new Map()
      } as unknown as ConstructorParameters<typeof AgentSpecAssembler>[0],
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      // Reads `grants` on every call, so a mid-move write is observable to a re-read.
      {
        listForAgent: async () => grants.map((grant) => ({ ...grant, access: 'read' }))
      } as unknown as ConstructorParameters<typeof AgentSpecAssembler>[7]
    ),
    crons: { listForAgent: async () => cronRows } as unknown as ConstructorParameters<
      typeof AgentMoveService
    >[0]['crons'],
    assignments: {
      releaseForAgent: async (_agentId: string, daemonId: string) => {
        calls.push(`release:${daemonId}`)
        return [SESSION_KEY]
      }
    } as unknown as ConstructorParameters<typeof AgentMoveService>[0]['assignments'],
    control,
    hooks: { rebroadcastForAgent: async () => void calls.push('hooks') } as unknown as HookService,
    httpBot: { syncBot: async () => void calls.push('http') } as unknown as HttpBotOrchestrator,
    collabRoutes: { broadcast: async () => void calls.push('collab') } as unknown as CollabRoutesService,
    mutations,
    sessionOwners: { releaseSession: (key) => void releasedLive.push(key as typeof SESSION_KEY) },
    ...(opts.sets
      ? {
          memberSets: {
            setIdOf: async (daemonId: string) => opts.sets!.setIdOf[daemonId] ?? null,
            memberIdsOf: async (setId: string) => opts.sets!.members[setId] ?? []
          }
        }
      : {}),
    ...(opts.readyDaemons
      ? {
          liveness: {
            get: (daemonId: string) =>
              opts.readyDaemons!.includes(daemonId) ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined
          }
        }
      : {})
  })
  return { service, calls, activations, upserts, detaches, frameOrgs, mutations, releasedLive, current: () => current }
}

describe('AgentMoveService', () => {
  it('reconciles workspace materialization during placement repair', async () => {
    const t = make({ workspace: GITHUB_WORKSPACE })

    await expect(t.service.ensureActive(t.current())).resolves.toMatchObject({ daemonId: SOURCE })
    expect(t.activations).toHaveLength(1)
    expect(t.activations[0]?.reconcileWorkspace).toBe(true)
  })

  it('scopes every move frame to the agent org, so an install-wide member accepts it', async () => {
    // A pool member's connection carries no org and neither `{agentId, moveId}`
    // nor an agent it has never installed can supply one, so an unscoped frame is
    // refused with SCOPE_DENIED before it leaves the CP.
    const t = make()
    await t.service.move(t.current(), onDaemon(TARGET))
    expect(t.frameOrgs.length).toBeGreaterThan(0)
    expect(t.frameOrgs.every((orgId) => orgId === ORG)).toBe(true)
  })

  it('hard-cuts the source, bootstraps the complete target bundle, and activates last', async () => {
    const t = make()
    const moved = await t.service.move(t.current(), onDaemon(TARGET))
    expect(moved.daemonId).toBe(TARGET)
    expect(t.calls).toEqual([
      `detach:${SOURCE}`,
      `release:${SOURCE}`,
      `detach:${TARGET}`,
      `activate:${TARGET}`,
      'hooks',
      'collab'
    ])
    expect(t.activations).toHaveLength(1)
    expect(t.activations[0]).toMatchObject({
      agentId: AGENT,
      spec: { name: 'mover', runtime: 'claude' },
      integrations: [{ integrationId: INTEGRATION, agentId: AGENT }],
      crons: [{ cronId: CRON, agentId: AGENT }]
    })
    expect(t.detaches[0]).toMatchObject({ agentId: AGENT, discardActiveTurns: true })
    expect(t.detaches[1]?.moveId).toBe(t.activations[0]?.moveId)
    expect(t.releasedLive).toEqual([SESSION_KEY])
  })

  it('drains a scratch agent and reconciles the GitHub workspace materialization', async () => {
    const t = make()
    const converted = await t.service.setWorkspace(t.current(), GITHUB_WORKSPACE, WORKSPACE_REPO_ID)

    expect(converted.workspace).toEqual(GITHUB_WORKSPACE)
    expect(t.detaches).toHaveLength(1)
    expect(t.detaches[0]).toMatchObject({ agentId: AGENT })
    expect(t.detaches[0]?.requireEmptyWorkspace).toBeUndefined()
    expect(t.activations).toHaveLength(1)
    expect(t.activations[0]).toMatchObject({
      agentId: AGENT,
      reconcileWorkspace: true,
      // The assembled spec carries the host-neutral arm; the legacy downgrade is per-peer,
      // at the transmit site this stub replaces.
      spec: { workspace: { mode: 'git', gitRepo: GITHUB_WORKSPACE.gitRepo, credential: { provider: 'github' } } }
    })
    expect(t.detaches[0]?.moveId).toBe(t.activations[0]?.moveId)
    // The trailing upsert re-projects the spec after the redundant-grant cleanup, which
    // runs (and advances the revision) only once the activation has been accepted.
    expect(t.calls).toEqual([`detach:${SOURCE}`, `activate:${SOURCE}`, `upsert:${SOURCE}`, 'hooks', 'collab'])
  })

  it('re-reads the repository allowlist after the workspace CAS so the activation matches its revision', async () => {
    const t = make({ grantDuringWorkspaceCas: { repoFullName: 'example-co/shared-library', repoId: 815n } })
    const before = t.current().configRevision

    await t.service.setWorkspace(t.current(), GITHUB_WORKSPACE, WORKSPACE_REPO_ID)

    // The pre-detach snapshot saw no grant; shipping that list at the post-CAS revision
    // would be the equal-revision/different-content violation the daemon refuses forever.
    expect(t.activations).toHaveLength(1)
    expect(t.activations[0]?.spec.workspace).toMatchObject({
      additionalRepos: [{ repoFullName: 'example-co/shared-library', repoId: '815' }]
    })
    expect(BigInt(t.activations[0]!.spec.configRevision!)).toBeGreaterThan(before)
  })

  it('re-reads the repository allowlist after the rollback CAS as well', async () => {
    const t = make({
      rejectWorkspaceActivate: true,
      grantDuringWorkspaceActivate: { repoFullName: 'example-co/shared-library', repoId: 815n }
    })

    await expect(t.service.setWorkspace(t.current(), GITHUB_WORKSPACE, WORKSPACE_REPO_ID)).rejects.toThrow(
      'workspace edit rejected: clone failed'
    )

    // The restore activates the post-rollback revision, which sits above the grant's — so it
    // has to carry the grant too, or the next roster repeats that revision with other content.
    expect(t.activations).toHaveLength(2)
    expect(t.activations[1]?.spec.workspace).toMatchObject({
      additionalRepos: [{ repoFullName: 'example-co/shared-library', repoId: '815' }]
    })
    expect(t.activations[1]?.spec.configRevision).toBe(t.current().configRevision.toString())
  })

  it('re-projects the spec after the redundant-grant cleanup that follows the activation', async () => {
    const redundantGrant = { repoFullName: 'acme/infra', repoId: WORKSPACE_REPO_ID }
    const t = make({ redundantGrant })

    await t.service.setWorkspace(t.current(), GITHUB_WORKSPACE, WORKSPACE_REPO_ID)

    // The activation still listed the grant — cleanup runs after it — so without this push the
    // daemon would keep the new PRIMARY repository as an additional one until it reconnected.
    expect(t.activations[0]?.spec.workspace).toMatchObject({
      additionalRepos: [redundantGrant.repoFullName].map((r) => ({ repoFullName: r }))
    })
    expect(t.upserts).toHaveLength(1)
    expect(t.upserts[0]?.spec.workspace).toMatchObject({ additionalRepos: [] })
    expect(t.upserts[0]?.spec.configRevision).toBe(t.current().configRevision.toString())
    expect(BigInt(t.upserts[0]!.spec.configRevision!)).toBeGreaterThan(BigInt(t.activations[0]!.spec.configRevision!))
  })

  it('reconciles an access edit so the daemon can preserve the matching checkout', async () => {
    const t = make({ workspace: GITHUB_WORKSPACE })
    const readOnly = {
      ...GITHUB_WORKSPACE,
      credential: { ...GITHUB_WORKSPACE.credential, access: 'read' as const }
    }

    const edited = await t.service.setWorkspace(t.current(), readOnly, WORKSPACE_REPO_ID)

    expect(edited.workspace).toEqual(readOnly)
    expect(t.detaches).toHaveLength(1)
    expect(t.detaches[0]?.requireEmptyWorkspace).toBeUndefined()
    expect(t.activations).toHaveLength(1)
    expect(t.activations[0]?.prepareWorkspace).toBeUndefined()
    expect(t.activations[0]?.reconcileWorkspace).toBe(true)
  })

  it('persists a worktree-only workspace edit', async () => {
    const shared = { ...GITHUB_WORKSPACE, isolation: 'shared' as const }
    const session = { ...GITHUB_WORKSPACE, isolation: 'session' as const }
    const t = make({ workspace: shared })

    const edited = await t.service.setWorkspace(t.current(), session, WORKSPACE_REPO_ID)

    expect(edited.workspace).toEqual(session)
    expect(t.detaches).toHaveLength(1)
    expect(t.activations).toHaveLength(1)
    expect(t.activations[0]?.spec.workspace).toMatchObject({ isolation: 'session' })
    expect(t.activations[0]?.reconcileWorkspace).toBe(true)
  })

  it('allows a GitHub workspace to switch back to scratch', async () => {
    const t = make({ workspace: GITHUB_WORKSPACE })

    await expect(t.service.setWorkspace(t.current(), { mode: 'scratch' })).resolves.toMatchObject({
      workspace: { mode: 'scratch' }
    })
    expect(t.activations[0]?.reconcileWorkspace).toBe(true)
  })

  it('rolls the database and daemon back to scratch after a known clone rejection', async () => {
    const t = make({ rejectWorkspaceActivate: true })

    // The rejection itself, not a fail-closed report of a rollback that never landed. The daemon
    // keeps the applied revision of the bundle it rejected, so restoring the pre-edit ROW would be
    // refused as stale — and the agent would stay staged and offline with its edit undone in the
    // database only. The reason the daemon gave rides along, or an operator sees neither failure.
    await expect(t.service.setWorkspace(t.current(), GITHUB_WORKSPACE, WORKSPACE_REPO_ID)).rejects.toThrow(
      'workspace edit rejected: clone failed'
    )
    expect(t.current().workspace).toEqual({ mode: 'scratch' })
    expect(t.activations).toHaveLength(2)
    expect(t.activations[0]?.reconcileWorkspace).toBe(true)
    expect(t.activations[1]?.reconcileWorkspace).toBe(true)
    expect(t.activations[1]?.spec.workspace).toEqual({
      mode: 'scratch',
      isolation: 'shared',
      gitCredential: 'github-app',
      additionalRepos: []
    })
    expect(BigInt(t.activations[1]!.spec.configRevision!)).toBeGreaterThan(
      BigInt(t.activations[0]!.spec.configRevision!)
    )
  })

  it('reports both failures when the restoration is refused too', async () => {
    // Fail-closed is the right outcome once the original workspace cannot be brought back — but the
    // message an operator reads has to name the rejection that started it, which was dropped.
    const t = make({ rejectWorkspaceActivate: true, rejectWorkspaceRestore: true })

    await expect(t.service.setWorkspace(t.current(), GITHUB_WORKSPACE, WORKSPACE_REPO_ID)).rejects.toThrow(
      'workspace activation rejection (clone failed) and the original workspace could not be reactivated'
    )
  })

  it('continues from durable GitHub state when the persistence response is lost after commit', async () => {
    const t = make({ workspacePersistenceFailsAfterCommit: true })

    await expect(t.service.setWorkspace(t.current(), GITHUB_WORKSPACE, WORKSPACE_REPO_ID)).resolves.toMatchObject({
      workspace: GITHUB_WORKSPACE
    })
    expect(t.activations).toHaveLength(1)
    expect(t.activations[0]?.reconcileWorkspace).toBe(true)
  })

  it('reactivates scratch when workspace persistence fails before commit', async () => {
    const t = make({ workspacePersistenceFailsBeforeCommit: true })

    await expect(t.service.setWorkspace(t.current(), GITHUB_WORKSPACE, WORKSPACE_REPO_ID)).rejects.toThrow(
      'failed to persist the workspace settings'
    )
    expect(t.current().workspace).toEqual({ mode: 'scratch' })
    expect(t.activations).toHaveLength(1)
    expect(t.activations[0]?.reconcileWorkspace).toBe(true)
  })

  it('repairs an unplaced conversion whose database response was lost after commit', async () => {
    const t = make({ unplaced: true, workspacePersistenceFailsAfterCommit: true })

    await expect(t.service.setWorkspace(t.current(), GITHUB_WORKSPACE, WORKSPACE_REPO_ID)).resolves.toMatchObject({
      daemonId: null,
      workspace: GITHUB_WORKSPACE
    })
    expect(t.detaches).toEqual([])
    expect(t.activations).toEqual([])
  })

  it('on target activation failure, confirms target detach then restores the full source bundle before activate', async () => {
    const t = make({ failTargetActivate: true })
    await expect(t.service.move(t.current(), onDaemon(TARGET))).rejects.toBeInstanceOf(AgentMoveFailed)
    expect(t.current().daemonId).toBe(SOURCE)
    expect(t.calls).toEqual([
      `detach:${SOURCE}`,
      `release:${SOURCE}`,
      `detach:${TARGET}`,
      `activate:${TARGET}`,
      `detach:${TARGET}`,
      `detach:${SOURCE}`,
      `activate:${SOURCE}`
    ])
  })

  it('fails closed when target detach is not acknowledged: DB stays on target and source is not restored', async () => {
    const t = make({ failTargetActivate: true, failRollbackTargetDetach: true })
    await expect(t.service.move(t.current(), onDaemon(TARGET))).rejects.toThrow('placement remains on target')
    expect(t.current().daemonId).toBe(TARGET)
    expect(t.calls).not.toContain(`activate:${SOURCE}`)
  })

  it('restores the full source bundle after a CAS miss', async () => {
    const t = make({ casMiss: true })
    await expect(t.service.move(t.current(), onDaemon(TARGET))).rejects.toThrow('changed concurrently')
    expect(t.calls).toEqual([`detach:${SOURCE}`, `release:${SOURCE}`, `detach:${SOURCE}`, `activate:${SOURCE}`])
  })

  it('re-stages with a fresh token when the bundle changes across activate ACK', async () => {
    const t = make({ changeBundleAfterFirstActivate: true })
    await expect(t.service.move(t.current(), onDaemon(TARGET))).resolves.toMatchObject({ daemonId: TARGET })

    const targetActivations = t.activations.filter((_value, index) => index < 2)
    expect(targetActivations.map((value) => value.crons[0]?.schedule)).toEqual(['0 0 * * *', '5 * * * *'])
    expect(targetActivations[0]?.moveId).not.toBe(targetActivations[1]?.moveId)
    expect(
      t.detaches
        .filter((_value, index) => index > 0)
        .slice(0, 2)
        .map((value) => value.moveId)
    ).toEqual(targetActivations.map((value) => value.moveId))
  })

  it('waits behind the interrupted mutation then resumes its exact staged token', async () => {
    const t = make()
    const releaseInterrupted = t.mutations.tryBeginMove(AGENT)!

    const recovery = t.service.recoverStaged(AGENT, SOURCE, STAGED_MOVE)
    await Promise.resolve()
    expect(t.activations).toEqual([])

    releaseInterrupted()
    await recovery
    expect(t.detaches).toEqual([])
    expect(t.activations).toHaveLength(1)
    expect(t.activations[0]).toMatchObject({
      agentId: AGENT,
      moveId: STAGED_MOVE,
      reconcileWorkspace: true
    })
    expect(t.calls).toEqual([`activate:${SOURCE}`, 'hooks', 'collab'])
  })

  it('supersedes a staged token when its one-shot workspace guard rejects resume', async () => {
    const t = make({ rejectWorkspaceActivate: true })

    await t.service.recoverStaged(AGENT, SOURCE, STAGED_MOVE)
    expect(t.activations).toHaveLength(2)
    expect(t.activations[0]?.moveId).toBe(STAGED_MOVE)
    expect(t.detaches).toHaveLength(1)
    expect(t.detaches[0]?.moveId).toBe(t.activations[1]?.moveId)
    expect(t.activations[1]?.moveId).not.toBe(STAGED_MOVE)
  })

  it('serializes concurrent moves and rejects mutations while the first move holds the gate', async () => {
    let releaseSource!: () => void
    let markStarted!: () => void
    const waitSourceDetach = new Promise<void>((resolve) => (releaseSource = resolve))
    const sourceDetachStarted = new Promise<void>((resolve) => (markStarted = resolve))
    const t = make({ waitSourceDetach, sourceDetachStarted: markStarted })

    const first = t.service.move(t.current(), onDaemon(TARGET))
    await sourceDetachStarted
    await expect(t.service.move(t.current(), onDaemon(TARGET))).rejects.toBeInstanceOf(AgentMoveConflict)
    expect(t.mutations.tryBeginMutation(AGENT)).toBeNull()
    releaseSource()
    await expect(first).resolves.toMatchObject({ daemonId: TARGET })
  })

  it('detaches target and fails closed when DB ownership changes after activation', async () => {
    const t = make({ moveOwnershipAfterFirstActivate: true })
    await expect(t.service.move(t.current(), onDaemon(TARGET))).rejects.toThrow('placement changed during move')
    expect(t.calls.at(-1)).toBe(`detach:${TARGET}`)
    expect(t.calls).not.toContain(`activate:${SOURCE}`)
  })

  it('a set commit broadcasts a token-less unstage to live members the move never staged (#1093)', async () => {
    const t = make({
      sets: { setIdOf: { [MEMBER]: SET }, members: { [SET]: [MEMBER, OFFLINE_MEMBER] } },
      readyDaemons: [MEMBER]
    })
    await expect(t.service.move(t.current(), onSet(SET))).resolves.toBeDefined()

    // The machine source stays fenced; the live member's possible stale fence is released token-less.
    expect(t.calls).not.toContain(`activate:${SOURCE}`)
    expect(t.calls).not.toContain(`activate:${OFFLINE_MEMBER}`)
    expect(t.calls).toContain(`activate:${MEMBER}`)
    expect(t.activations).toHaveLength(1)
    expect(t.activations[0]?.agentId).toBe(AGENT)
    expect(t.activations[0]?.moveId).toBeUndefined()
  })

  it('a staged source that is itself a member keeps its exact token and is not broadcast to twice', async () => {
    const t = make({
      sets: { setIdOf: { [SOURCE]: SET }, members: { [SET]: [SOURCE] } },
      readyDaemons: [SOURCE]
    })
    await expect(t.service.move(t.current(), onSet(SET))).resolves.toBeDefined()

    expect(t.activations).toHaveLength(1)
    expect(t.activations[0]?.moveId).toBe(t.detaches[0]?.moveId)
  })

  it('reconnect recovery releases a reported stale fence for an eligible member that serves nothing', async () => {
    const t = make({
      placement: { placementKind: 'set', setId: SET, daemonId: null },
      sets: { setIdOf: { [MEMBER]: SET }, members: { [SET]: [MEMBER] } },
      readyDaemons: [MEMBER]
    })
    await t.service.recoverStaged(AGENT, MEMBER, STAGED_MOVE)

    // Token-less, exactly like the commit broadcast: `mayAct` was false, so the reporter releases
    // its fence without being told to run the agent — the daemon leaves the host down (#1093).
    expect(t.detaches).toEqual([])
    expect(t.activations).toHaveLength(1)
    expect(t.activations[0]).toMatchObject({ agentId: AGENT })
    expect(t.activations[0]?.moveId).toBeUndefined()
  })

  it('reconnect recovery leaves a fence armed when the reporter is not an eligible holder', async () => {
    // A daemon in no set reporting a fence for a set-placed agent stays fenced.
    const nonMember = make({
      placement: { placementKind: 'set', setId: SET, daemonId: null },
      sets: { setIdOf: {}, members: { [SET]: [] } },
      readyDaemons: []
    })
    await nonMember.service.recoverStaged(AGENT, SOURCE, STAGED_MOVE)
    expect(nonMember.activations).toEqual([])

    // A member reporting a fence for a MACHINE-placed agent stays fenced too.
    const pinned = make({
      sets: { setIdOf: { [MEMBER]: SET }, members: { [SET]: [MEMBER] } },
      readyDaemons: [MEMBER]
    })
    await pinned.service.recoverStaged(AGENT, MEMBER, STAGED_MOVE)
    expect(pinned.activations).toEqual([])
  })
})

/**
 * `bundleFor` is the `duty/fetch` reply. An AgentSpec only NAMES its MCP servers
 * and its memory connection, so a member that installs the bundle on a daemon the
 * agent is not placed on would come up referencing definitions it never received
 * (#979). Both now ride the bundle, through the SAME projector the reconnect
 * roster uses, scoped to this one agent's references.
 */
describe('AgentMoveService.bundleFor — the duty/fetch install bundle', () => {
  const PROVIDER = '88888888-8888-4888-8888-888888888888'
  const CONNECTION = '99999999-9999-4999-8999-999999999999'
  const INSTALLATION = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'

  function bundleService(over: { mcpServers?: string[]; connectionId?: string } = {}) {
    const record = {
      ...agent(SOURCE),
      mcpServers: over.mcpServers ?? [],
      memory: over.connectionId ? { provider: 'external', connectionId: over.connectionId } : null
    } as AgentRecord
    const service = new AgentMoveService({
      agents: { getUnscoped: async () => record } as unknown as AgentRepo,
      integrations: { listForAgent: async () => [] } as unknown as ConstructorParameters<
        typeof AgentMoveService
      >[0]['integrations'],
      integrationChannels: { listForIntegration: async () => [] } as unknown as ConstructorParameters<
        typeof AgentMoveService
      >[0]['integrationChannels'],
      bots: { getUnscoped: async () => bot } as unknown as ConstructorParameters<typeof AgentMoveService>[0]['bots'],
      botSecrets: { get: async () => ({}) } as unknown as ConstructorParameters<
        typeof AgentMoveService
      >[0]['botSecrets'],
      platforms: PLATFORMS,
      specs: new AgentSpecAssembler({
        get: async () => ({}),
        merge: async () => {},
        keys: async () => new Map()
      } as unknown as ConstructorParameters<typeof AgentSpecAssembler>[0]),
      crons: { listForAgent: async () => [] } as unknown as ConstructorParameters<typeof AgentMoveService>[0]['crons'],
      assignments: {} as unknown as ConstructorParameters<typeof AgentMoveService>[0]['assignments'],
      mcp: {
        providers: { listForOrg: async () => [{ id: PROVIDER, orgId: ORG, name: 'docs' }] },
        grants: { activeForProvider: async () => [{ id: 'g1', key: 'oct_docs', createdAt: new Date(2_000) }] },
        relayRoster: { entries: async () => [{ relayId: 'r1', name: 'r1', url: 'wss://relay.example.test' }] }
      } as unknown as ConstructorParameters<typeof AgentMoveService>[0]['mcp'],
      memory: {
        connections: {
          get: async (_orgId: string, id: string) =>
            id === CONNECTION
              ? { id: CONNECTION, orgId: ORG, installationId: INSTALLATION, revision: 1, config: {} }
              : null
        },
        installations: {
          get: async () => ({
            id: INSTALLATION,
            pluginId: 'ai.example.memory',
            transport: 'stdio',
            commandRef: 'operator-mem0',
            expectedManifestDigest: `sha256:${'a'.repeat(64)}`,
            secretHeaders: []
          })
        },
        secrets: { get: async () => ({}), keys: async () => [] },
        grants: { activeForConnection: async () => [] },
        relayRoster: { entries: async () => [] }
      } as unknown as ConstructorParameters<typeof AgentMoveService>[0]['memory'],
      control: {} as unknown as ControlSender,
      hooks: {} as unknown as HookService,
      httpBot: {} as unknown as HttpBotOrchestrator,
      collabRoutes: {} as unknown as CollabRoutesService,
      mutations: new AgentMutationGate(),
      sessionOwners: { releaseSession: () => {} }
    })
    return { service, record }
  }

  it('carries the proxy def for every MCP server the spec names', async () => {
    const { service, record } = bundleService({ mcpServers: ['docs'] })
    const bundle = await service.bundleFor(record)
    expect(bundle.spec.mcpServers).toEqual(['docs'])
    // Not just present — the grant-bearing proxy def, so the holder can actually call it.
    expect(bundle.mcpServers).toEqual([
      expect.objectContaining({
        name: 'docs',
        url: `https://relay.example.test/mcp/${PROVIDER}`,
        headers: [{ name: 'Authorization', value: 'Bearer oct_docs' }]
      })
    ])
  })

  it('carries the external-memory connection the spec binds', async () => {
    const { service, record } = bundleService({ connectionId: CONNECTION })
    const bundle = await service.bundleFor(record)
    expect(bundle.memoryConnections.map((c) => c.connectionId)).toEqual([CONNECTION])
  })

  it('an agent that names neither gets neither — the bundle is scoped to its references', async () => {
    const { service, record } = bundleService()
    const bundle = await service.bundleFor(record)
    expect(bundle.mcpServers).toEqual([])
    expect(bundle.memoryConnections).toEqual([])
  })
})
