import { describe, expect, it } from 'vitest'
import type { Ack, AgentActivate, AgentDetach } from '@agentconnect.md/protocol'
import { AgentId, BotId, CronId, DaemonId, IntegrationId, OrgId } from '../domain/ids.js'
import type {
  AgentRecord,
  AgentRepo,
  AgentWorkspace,
  BotRecord,
  CronRecord,
  GithubAgentWorkspace,
  IntegrationRecord
} from '../persistence/ports.js'
import type { ControlSender } from './outbound.js'
import type { HookService } from '../hooks/hook.service.js'
import type { HttpBotOrchestrator } from './httpBot.js'
import type { CollabRoutesService } from './collabRoutes.service.js'
import { AgentMoveConflict, AgentMoveFailed, AgentMoveService } from './agentMove.js'
import { AgentSpecAssembler } from './agentSpecAssembler.js'
import { AgentMutationGate } from './agentMutationGate.js'

const AGENT = AgentId('11111111-1111-4111-8111-111111111111')
const SOURCE = DaemonId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
const TARGET = DaemonId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
const INTEGRATION = IntegrationId('22222222-2222-4222-8222-222222222222')
const BOT = BotId('33333333-3333-4333-8333-333333333333')
const CRON = CronId('44444444-4444-4444-8444-444444444444')
const MODIFIED_AT = new Date('2026-07-11T00:00:00.000Z')
const SESSION_KEY = { platform: 'slack' as const, channel: 'C-move', thread: 'T-move' }
const WORKSPACE_REPO_ID = 4242n
const STAGED_MOVE = '77777777-7777-4777-8777-777777777777'
const GITHUB_WORKSPACE = {
  mode: 'github',
  gitRepo: 'https://github.com/acme/repo.git',
  gitBranch: 'main',
  installationId: '66666666-6666-4666-8666-666666666666',
  gitAccess: 'write'
} satisfies GithubAgentWorkspace

function agent(daemonId: string | null): AgentRecord {
  return {
    id: AGENT,
    orgId: OrgId('55555555-5555-4555-8555-555555555555'),
    name: 'mover',
    displayName: null,
    builtin: false,
    description: null,
    runtime: 'claude',
    model: null,
    reasoningEffort: null,
    outputMode: null,
    fastMode: null,
    permissionMode: null,
    pause: null,
    env: {},
    mcpServers: [],
    memory: null,
    status: daemonId ? 'active' : 'inactive',
    daemonId: daemonId ? DaemonId(daemonId) : null,
    workspace: { mode: 'scratch' },
    capabilities: [],
    createdAt: new Date(),
    createdBy: null,
    createdByUserId: null,
    visibility: 'org',
    sharedWith: [],
    callPolicy: 'all',
    allowedCallerAgentIds: [],
    lastModifiedAt: MODIFIED_AT,
    lastModifiedBy: null,
    configRevision: 0n
  }
}

const integration = {
  id: INTEGRATION,
  orgId: OrgId('55555555-5555-4555-8555-555555555555'),
  agentId: AGENT,
  botId: BOT,
  platform: 'slack',
  name: 'Slack',
  status: 'active',
  createdAt: new Date()
} satisfies IntegrationRecord

const bot = {
  id: BOT,
  orgId: OrgId('55555555-5555-4555-8555-555555555555'),
  platform: 'slack',
  name: 'Slack',
  prebuilt: false,
  slackAppId: null,
  discordAppId: null,
  shareable: false,
  relayId: null,
  createdBy: null,
  lastUsedAt: null,
  lastAgentName: null,
  agentIds: [AGENT],
  inUseByAgentId: AGENT,
  createdAt: new Date()
} satisfies BotRecord

const cron = {
  id: CRON,
  orgId: OrgId('55555555-5555-4555-8555-555555555555'),
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
  lastModifiedBy: null,
  configRevision: 0n
} satisfies CronRecord

function make(
  opts: {
    failTargetActivate?: boolean
    failRollbackTargetDetach?: boolean
    casMiss?: boolean
    changeBundleAfterFirstActivate?: boolean
    moveOwnershipAfterFirstActivate?: boolean
    rejectWorkspaceActivate?: boolean
    workspacePersistenceFailsBeforeCommit?: boolean
    workspacePersistenceFailsAfterCommit?: boolean
    unplaced?: boolean
    workspace?: GithubAgentWorkspace
    workspaceRepoId?: bigint
    sourceDetachStarted?: () => void
    waitSourceDetach?: Promise<void>
  } = {}
) {
  let current: AgentRecord = {
    ...agent(opts.unplaced ? null : SOURCE),
    ...(opts.workspace ? { workspace: opts.workspace, workspaceRepoId: opts.workspaceRepoId ?? WORKSPACE_REPO_ID } : {})
  }
  let cronRows = [cron]
  const calls: string[] = []
  const activations: AgentActivate[] = []
  const detaches: AgentDetach[] = []
  const releasedLive: (typeof SESSION_KEY)[] = []
  const mutations = new AgentMutationGate()
  const repo = {
    get: async () => current,
    setWorkspace: async (
      _id: string,
      _expected: Date,
      _expectedMode: 'scratch' | 'github',
      workspace: AgentWorkspace,
      workspaceRepoId?: bigint
    ) => {
      if (opts.workspacePersistenceFailsBeforeCommit) throw new Error('database unavailable')
      current = {
        ...current,
        workspace,
        workspaceRepoId,
        lastModifiedAt: new Date(current.lastModifiedAt.getTime() + 1)
      }
      if (opts.workspacePersistenceFailsAfterCommit) throw new Error('database response lost')
      return current
    },
    restoreWorkspace: async (
      _id: string,
      _expected: Date,
      _expectedWorkspace: AgentWorkspace,
      _expectedWorkspaceRepoId: bigint | undefined,
      workspace: AgentRecord['workspace'],
      workspaceRepoId?: bigint
    ) => {
      current = {
        ...current,
        workspace,
        workspaceRepoId,
        lastModifiedAt: new Date(current.lastModifiedAt.getTime() + 1)
      }
      return current
    },
    setWorkspaceRepoId: async () => true,
    movePlacement: async (_id: string, expected: string | null, target: string | null) => {
      if (opts.casMiss || current.daemonId !== expected) return null
      current = agent(target)
      return current
    }
  } as unknown as AgentRepo
  const ack = (ok = true, reason?: string): Ack => ({ ok, ...(reason ? { reason } : {}) })
  let targetDetachCount = 0
  const control = {
    agentDetach: async (daemonId: string, value: AgentDetach) => {
      calls.push(`detach:${daemonId}`)
      detaches.push(value)
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
    agentActivate: async (daemonId: string, value: AgentActivate) => {
      calls.push(`activate:${daemonId}`)
      activations.push(value)
      if (value.reconcileWorkspace && opts.rejectWorkspaceActivate && activations.length === 1) {
        return ack(false, 'clone failed')
      }
      if (daemonId === TARGET && activations.filter((a) => a.agentId === AGENT).length === 1) {
        if (opts.changeBundleAfterFirstActivate) cronRows = [{ ...cron, schedule: '5 * * * *' }]
        if (opts.moveOwnershipAfterFirstActivate) current = agent(SOURCE)
      }
      if (daemonId === TARGET && opts.failTargetActivate) return ack(false, 'cannot start')
      return ack()
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
    bots: { get: async () => bot } as unknown as ConstructorParameters<typeof AgentMoveService>[0]['bots'],
    botSecrets: {
      get: async () => ({ botToken: 'xoxb-test', appToken: 'xapp-test' })
    } as unknown as ConstructorParameters<typeof AgentMoveService>[0]['botSecrets'],
    // The real assembler over a fake store — exercises project()/secretsOf() as prod does.
    specs: new AgentSpecAssembler({
      get: async () => ({}),
      merge: async () => {},
      keys: async () => new Map()
    } as unknown as ConstructorParameters<typeof AgentSpecAssembler>[0]),
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
    sessionOwners: { releaseSession: (key) => void releasedLive.push(key as typeof SESSION_KEY) }
  })
  return { service, calls, activations, detaches, mutations, releasedLive, current: () => current }
}

describe('AgentMoveService', () => {
  it('reconciles workspace materialization during placement repair', async () => {
    const t = make({ workspace: GITHUB_WORKSPACE })

    await expect(t.service.ensureActive(t.current())).resolves.toMatchObject({ daemonId: SOURCE })
    expect(t.activations).toHaveLength(1)
    expect(t.activations[0]?.reconcileWorkspace).toBe(true)
  })

  it('detaches source, bootstraps the complete target bundle, and activates last', async () => {
    const t = make()
    const moved = await t.service.move(t.current(), TARGET)
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
      spec: { workspace: { mode: 'github', gitRepo: GITHUB_WORKSPACE.gitRepo } }
    })
    expect(t.detaches[0]?.moveId).toBe(t.activations[0]?.moveId)
    expect(t.calls).toEqual([`detach:${SOURCE}`, `activate:${SOURCE}`, 'hooks', 'collab'])
  })

  it('reconciles an access edit so the daemon can preserve the matching checkout', async () => {
    const t = make({ workspace: GITHUB_WORKSPACE })
    const readOnly = { ...GITHUB_WORKSPACE, gitAccess: 'read' as const }

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

    await expect(t.service.setWorkspace(t.current(), GITHUB_WORKSPACE, WORKSPACE_REPO_ID)).rejects.toThrow(
      AgentMoveFailed
    )
    expect(t.current().workspace).toEqual({ mode: 'scratch' })
    expect(t.activations).toHaveLength(2)
    expect(t.activations[0]?.reconcileWorkspace).toBe(true)
    expect(t.activations[1]?.reconcileWorkspace).toBe(true)
    expect(t.activations[1]?.spec.workspace).toEqual({
      mode: 'scratch',
      isolation: 'shared',
      gitCredential: 'github-app'
    })
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
    await expect(t.service.move(t.current(), TARGET)).rejects.toBeInstanceOf(AgentMoveFailed)
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
    await expect(t.service.move(t.current(), TARGET)).rejects.toThrow('placement remains on target')
    expect(t.current().daemonId).toBe(TARGET)
    expect(t.calls).not.toContain(`activate:${SOURCE}`)
  })

  it('restores the full source bundle after a CAS miss', async () => {
    const t = make({ casMiss: true })
    await expect(t.service.move(t.current(), TARGET)).rejects.toThrow('changed concurrently')
    expect(t.calls).toEqual([`detach:${SOURCE}`, `release:${SOURCE}`, `detach:${SOURCE}`, `activate:${SOURCE}`])
  })

  it('re-stages with a fresh token when the bundle changes across activate ACK', async () => {
    const t = make({ changeBundleAfterFirstActivate: true })
    await expect(t.service.move(t.current(), TARGET)).resolves.toMatchObject({ daemonId: TARGET })

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

    const first = t.service.move(t.current(), TARGET)
    await sourceDetachStarted
    await expect(t.service.move(t.current(), TARGET)).rejects.toBeInstanceOf(AgentMoveConflict)
    expect(t.mutations.tryBeginMutation(AGENT)).toBeNull()
    releaseSource()
    await expect(first).resolves.toMatchObject({ daemonId: TARGET })
  })

  it('detaches target and fails closed when DB ownership changes after activation', async () => {
    const t = make({ moveOwnershipAfterFirstActivate: true })
    await expect(t.service.move(t.current(), TARGET)).rejects.toThrow('placement changed during move')
    expect(t.calls.at(-1)).toBe(`detach:${TARGET}`)
    expect(t.calls).not.toContain(`activate:${SOURCE}`)
  })
})
