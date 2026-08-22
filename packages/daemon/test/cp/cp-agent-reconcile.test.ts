import { describe, it, expect, vi } from 'vitest'
import { chmodSync, cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../../src/daemon.js'
import {
  agentRemovalTombstones,
  detachedAgentDir,
  findAgentFileById,
  markAgentRemoval,
  readAgentMoveStage,
  stageAgentMove,
  stagedAgentDir
} from '../../src/agents/write-agent.js'
import { RegisterReq, type AgentSpec, type DutyGrantEntry } from '@agentconnect.md/protocol'
import { agentRemovalObligationsDir } from '../../src/paths.js'
import { fakeSlackAppFactory } from '../fakes/slack-app.js'

const MOVE_ID = '77777777-7777-4777-8777-777777777777'
const MOVE_ID_2 = '88888888-8888-4888-8888-888888888888'
const MOVE_ID_3 = '99999999-9999-4999-8999-999999999999'
const MOVE_ID_4 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const GROUP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function root1(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-cpagent-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: [] } }
    })
  )
  return root
}
function writeAgent(root: string, id: string) {
  const adir = join(root, 'agents', id)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id,
      name: id,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'ws') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
}

// A daemon whose hosts are inert stubs; every started host is recorded so tests
// can assert restarts (stop() called + dropped from the hosts map).
function makeDaemon(root: string) {
  const hosts: Array<{ id: string; stop: ReturnType<typeof vi.fn> }> = []
  const daemon = new Daemon({
    slackAppFactory: fakeSlackAppFactory(),
    root,
    hostFactory: (agent) => {
      const h = {
        id: agent.id,
        start: vi.fn().mockResolvedValue(undefined),
        newSession: vi.fn(),
        prompt: vi.fn(),
        cancel: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined)
      }
      hosts.push(h)
      return h as any
    }
  })
  return { daemon, hosts }
}

const seam = (d: Daemon) => (d as any).cpConfigApply()

/** Make the daemon a duty-governed pool member — `frame` scope is what `dutyEnforced()` reads. */
function poolMember(daemon: Daemon, client: Record<string, unknown> = {}) {
  ;(daemon as any).cpClient = {
    organizationScope: () => 'frame',
    memberSet: () => ({ setId: '9f11e5e7-0000-4000-8000-000000000001', name: 'Cloud' }),
    stop: async () => {},
    releaseDuties: vi.fn(async () => {}),
    reportDutiesNow: vi.fn(() => {}),
    emitMemoryConnectionFacts: vi.fn(() => {}),
    ...client
  }
}

/** A grant for one agent, unstamped so `dutyBundleIsStale` falls back to presence. */
const dutyGrant = (agentId: string): DutyGrantEntry => ({
  groupId: GROUP_ID,
  orgId: 'org-1',
  term: '1',
  members: [{ kind: 'agent', refId: agentId }]
})

const DUTY_BUNDLE = {
  agentId: 'bot-a',
  spec: { orgId: 'org-1', name: 'bot-a', runtime: 'claude' },
  integrations: [],
  crons: []
}

describe('Daemon CP agent → memory + reconcile', () => {
  it('keeps a corrupt move tombstone fail-closed without poisoning reconnect registration', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const stageDir = stagedAgentDir(join(root, 'agents'), 'bot-a')
    mkdirSync(stageDir, { recursive: true })
    writeFileSync(join(stageDir, 'metadata.json'), '{')

    const { daemon } = makeDaemon(root)
    await daemon.start()

    expect((daemon as any).drainingAgents.has('bot-a')).toBe(true)
    const localState = (daemon as any).cpLocalState()
    expect(localState.stagedAgents).toEqual([{ agentId: 'bot-a' }])
    expect(
      RegisterReq.safeParse({
        host: 'test',
        capabilities: { platforms: [], runtimes: [], acp: true },
        maxAgents: 1,
        localState
      }).success
    ).toBe(true)
    await daemon.stop()
  })

  it('deletes the matching agent.json and keeps the effective CP spec in memory', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()

    await seam(daemon).applyAgentUpsert({
      agentId: 'bot-a',
      spec: { name: 'CP Helper', model: 'opus', description: 'be terse' } as AgentSpec
    })

    const eff = (daemon as any).agents.get('bot-a')
    expect(eff.name).toBe('CP Helper')
    expect(eff.description).toBe('be terse')
    expect(eff.runtimeOverrides.model).toBe('opus')
    expect(eff.runtime).toBe('claude') // file-supplied, preserved on merge
    expect(eff.workspace.path).toBe(join(root, 'agents', 'bot-a', 'ws')) // path preserved
    expect(existsSync(join(root, 'agents', 'bot-a', 'agent.json'))).toBe(false)
    expect(readFileSync(join(root, 'agents', 'bot-a', '.cp-agent-id'), 'utf8').trim()).toBe('bot-a')
    expect((daemon as any).cpLocalState().agents).toEqual([{ agentId: 'bot-a', origin: 'cp' }])
    await daemon.stop()
  })

  it('restarts a running host when the applied spec changes', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon, hosts } = makeDaemon(root)
    await daemon.start()

    // Boot + cache a host.
    await (daemon as any).ensureHostAsync('bot-a')
    expect((daemon as any).hosts.has('bot-a')).toBe(true)
    const first = hosts.at(-1)!

    // A spec change must tear the cached host down so the next message rebuilds it.
    await seam(daemon).applyAgentUpsert({ agentId: 'bot-a', spec: { name: 'bot-a', model: 'opus' } as AgentSpec })
    expect(first.stop).toHaveBeenCalledTimes(1)
    expect((daemon as any).hosts.has('bot-a')).toBe(false)
    await daemon.stop()
  })

  it('does NOT restart when an unrelated reconcile leaves the config unchanged', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon, hosts } = makeDaemon(root)
    await daemon.start()
    await (daemon as any).ensureHostAsync('bot-a')
    const first = hosts.at(-1)!

    await daemon.reconcile() // no config change
    expect(first.stop).not.toHaveBeenCalled()
    expect((daemon as any).hosts.has('bot-a')).toBe(true)
    await daemon.stop()
  })

  it('creates a runnable memory-only agent for a spec with no on-disk base; remove deletes its data root', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()

    // A CP spec creates only a secret-free data-root marker.
    await seam(daemon).applyAgentUpsert({ agentId: 'ghost', spec: { name: 'ghost' } as AgentSpec })
    expect(existsSync(join(root, 'agents', 'ghost', 'agent.json'))).toBe(false)
    expect(readFileSync(join(root, 'agents', 'ghost', '.cp-agent-id'), 'utf8').trim()).toBe('ghost')
    expect((daemon as any).agents.has('ghost')).toBe(true) // runnable, not degraded
    expect((daemon as any).cpDegradedScopes()).not.toContain('ghost')

    // agent/remove deletes the on-disk dir → reconcile drops it from the live set.
    await seam(daemon).applyAgentRemove('ghost')
    await daemon.reconcile()
    expect(existsSync(join(root, 'agents', 'ghost'))).toBe(false)
    expect((daemon as any).agents.has('ghost')).toBe(false)
    await daemon.stop()
  })

  it('reports marker-only CP ownership after restart and accepts an offline remove', async () => {
    const root = root1()
    const first = makeDaemon(root).daemon
    await first.start()
    await seam(first).applyAgentUpsert({ agentId: 'stale-cp', spec: { name: 'stale-cp' } as AgentSpec })
    writeFileSync(join(root, 'agents', 'stale-cp', 'workspace-data'), 'keep')
    await first.stop()

    const restarted = makeDaemon(root).daemon
    await restarted.start()
    expect((restarted as any).agents.has('stale-cp')).toBe(false)
    expect((restarted as any).cpLocalState().agents).toContainEqual({ agentId: 'stale-cp', origin: 'cp' })

    await seam(restarted).applyAgentRemove('stale-cp')
    expect(existsSync(join(root, 'agents', 'stale-cp'))).toBe(false)
    await restarted.stop()
  })

  it('detach drains/stops, archives the whole root, invalidates git creds, and activate restores + warms it', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    mkdirSync(join(root, 'agents', 'bot-a', 'memory'), { recursive: true })
    writeFileSync(join(root, 'agents', 'bot-a', 'memory', 'keep.md'), 'local-memory')
    const { daemon, hosts } = makeDaemon(root)
    await daemon.start()
    await seam(daemon).applyAgentUpsert({
      agentId: 'bot-a',
      spec: { name: 'bot-a', runtime: 'claude' } as AgentSpec
    })
    await (daemon as any).ensureHostAsync('bot-a')
    const first = hosts.at(-1)!
    const removeCred = vi.spyOn((daemon as any).gitCreds, 'remove')

    await expect(seam(daemon).applyAgentDetach({ agentId: 'bot-a', moveId: MOVE_ID })).resolves.toEqual({ ok: true })
    expect(first.stop).toHaveBeenCalledTimes(1)
    expect(removeCred).toHaveBeenCalledWith('bot-a')
    expect((daemon as any).agents.has('bot-a')).toBe(false)
    expect((daemon as any).drainingAgents.has('bot-a')).toBe(true)
    expect(existsSync(stagedAgentDir(join(root, 'agents'), 'bot-a'))).toBe(true)
    expect((daemon as any).cpLocalState().stagedAgents).toEqual([{ agentId: 'bot-a', moveId: MOVE_ID }])
    expect(readFileSync(join(root, 'agents', 'bot-a', 'memory', 'keep.md'), 'utf8')).toBe('local-memory')

    const staleIntegration = {
      integrationId: 'stale-int',
      agentId: 'bot-a',
      platform: 'slack',
      core: { mode: 'direct', bindRules: [] },
      config: { botToken: 'must-not-return', appToken: 'xapp-stale' }
    }
    const staleCron = {
      cronId: 'stale-cron',
      agentId: 'bot-a',
      schedule: '0 * * * *',
      trigger: 'stale',
      enabled: true
    }
    // A source-side register/ok or live EVT racing detach→CAS must not restore
    // the archived root or credentials. Atomic activate is the only re-entry.
    await seam(daemon).applyAgentUpsert({ agentId: 'bot-a', spec: { name: 'stale', runtime: 'claude' } as AgentSpec })
    seam(daemon).applyIntegrationUpsert(staleIntegration)
    seam(daemon).upsertCron(staleCron)
    await seam(daemon).applyReconcileSnapshot({
      routingEpoch: 1,
      assignments: [],
      agents: [{ agentId: 'bot-a', name: 'stale', runtime: 'claude' }],
      integrations: [staleIntegration],
      crons: [staleCron],
      leases: [],
      relays: [],
      collabRoutes: { generation: 0, channels: [] },
      drop: { assignments: [], crons: [] }
    })
    await daemon.reconcile()
    expect(existsSync(join(root, 'agents', 'bot-a', 'agent.json'))).toBe(false)
    expect(existsSync(join(root, 'agents', 'bot-a', 'agent.json'))).toBe(false)

    const activation = {
      agentId: 'bot-a',
      moveId: MOVE_ID,
      spec: { name: 'bot-a', runtime: 'claude' },
      integrations: [],
      crons: []
    }
    await expect(seam(daemon).applyAgentActivate(activation)).resolves.toEqual({ ok: true })
    expect((daemon as any).agents.has('bot-a')).toBe(true)
    expect((daemon as any).hosts.has('bot-a')).toBe(true) // activate proves ACP can start before ACK
    expect((daemon as any).drainingAgents.has('bot-a')).toBe(false)
    expect(readAgentMoveStage(join(root, 'agents'), 'bot-a')).toEqual({ moveId: MOVE_ID, state: 'committed' })
    expect((daemon as any).cpLocalState().stagedAgents).toEqual([])
    expect(readFileSync(join(root, 'agents', 'bot-a', 'memory', 'keep.md'), 'utf8')).toBe('local-memory')
    expect(existsSync(detachedAgentDir(join(root, 'agents'), 'bot-a'))).toBe(false)
    // ACK-loss retransmit: committed metadata makes the identical activate a no-op ACK.
    await expect(seam(daemon).applyAgentActivate(activation)).resolves.toEqual({ ok: true })
    await daemon.stop()
  })

  it('hard cutover uses immediate quiescence instead of the graceful drain', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()
    await seam(daemon).applyAgentUpsert({
      agentId: 'bot-a',
      spec: { name: 'bot-a', runtime: 'claude' } as AgentSpec
    })
    const drain = vi.spyOn(daemon as any, 'drainScope')
    const interrupt = vi.spyOn(daemon as any, 'interruptAgentTurns')
    let releaseRevoke!: () => void
    let markRevokeStarted!: () => void
    const revokeBlocked = new Promise<void>((resolve) => (releaseRevoke = resolve))
    const revokeStarted = new Promise<void>((resolve) => (markRevokeStarted = resolve))
    vi.spyOn((daemon as any).webchatMcpRevocations, 'revokeRemoteWebchatGrantsForAgent').mockImplementationOnce(
      async () => {
        markRevokeStarted()
        await revokeBlocked
      }
    )

    const detaching = seam(daemon).applyAgentDetach({
      agentId: 'bot-a',
      moveId: MOVE_ID,
      discardActiveTurns: true
    })
    await revokeStarted

    expect(drain).not.toHaveBeenCalled()
    expect(interrupt).toHaveBeenCalledWith('bot-a', 'stop')
    releaseRevoke()
    await expect(detaching).resolves.toEqual({ ok: true })
    await daemon.stop()
  })

  it('rejects scratch conversion when the drained workspace is non-empty and reopens the agent gate', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const workspace = join(root, 'agents', 'bot-a', 'ws')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'keep.txt'), 'preserve me')
    const { daemon } = makeDaemon(root)
    await daemon.start()

    await expect(
      seam(daemon).applyAgentDetach({ agentId: 'bot-a', moveId: MOVE_ID, requireEmptyWorkspace: true })
    ).resolves.toEqual({
      ok: false,
      reason: 'agent/detach: scratch workspace is not empty; remove or move its files before converting'
    })
    expect((daemon as any).agents.has('bot-a')).toBe(true)
    expect((daemon as any).drainingAgents.has('bot-a')).toBe(false)
    expect((daemon as any).moveStagedAgents.has('bot-a')).toBe(false)
    expect(existsSync(stagedAgentDir(join(root, 'agents'), 'bot-a'))).toBe(false)
    expect(readFileSync(join(workspace, 'keep.txt'), 'utf8')).toBe('preserve me')
    await daemon.stop()
  })

  it('repairs a conversion that crashed after the checkout swap but before move commit', async () => {
    const root = root1()
    const agentDir = join(root, 'agents', 'bot-a')
    const workspace = join(agentDir, 'ws')
    mkdirSync(join(workspace, '.git'), { recursive: true })
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({
        id: 'bot-a',
        name: 'bot-a',
        status: 'active',
        runtime: 'claude',
        workspace: {
          mode: 'git-repo',
          path: workspace,
          gitRepo: 'https://github.com/acme/repo.git',
          gitBranch: 'main'
        },
        integrations: [],
        output: { mode: 'medium' }
      })
    )
    stageAgentMove(join(root, 'agents'), 'bot-a', MOVE_ID, true)

    const { daemon } = makeDaemon(root)
    await daemon.start()
    expect(readAgentMoveStage(join(root, 'agents'), 'bot-a')).toEqual({
      moveId: MOVE_ID,
      state: 'staging',
      requireEmptyWorkspace: true
    })

    // A repair is a fresh generic move. Its new durable fence supersedes the
    // conversion-only empty check before activation sees the checkout that the
    // previous attempt already installed.
    await expect(seam(daemon).applyAgentDetach({ agentId: 'bot-a', moveId: MOVE_ID_2 })).resolves.toEqual({ ok: true })
    expect(readAgentMoveStage(join(root, 'agents'), 'bot-a')).toEqual({ moveId: MOVE_ID_2, state: 'staging' })
    await expect(
      seam(daemon).applyAgentActivate({
        agentId: 'bot-a',
        moveId: MOVE_ID_2,
        prepareWorkspace: true,
        spec: {
          name: 'bot-a',
          runtime: 'claude',
          workspace: {
            mode: 'github',
            gitRepo: 'https://github.com/acme/repo.git',
            branch: 'main'
          }
        },
        integrations: [],
        crons: []
      })
    ).resolves.toEqual({ ok: true })
    expect(existsSync(join(workspace, '.git'))).toBe(true)
    expect(readAgentMoveStage(join(root, 'agents'), 'bot-a')).toEqual({ moveId: MOVE_ID_2, state: 'committed' })
    await daemon.stop()
  })

  it('removes only UUID-named conversion clone leftovers at startup', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const workspace = join(root, 'agents', 'bot-a', 'ws')
    const stale = `${workspace}.clone-${MOVE_ID}`
    const operatorDir = `${workspace}.clone-keep-me`
    mkdirSync(stale, { recursive: true })
    mkdirSync(operatorDir, { recursive: true })
    writeFileSync(join(stale, 'partial-pack'), 'incomplete')
    writeFileSync(join(operatorDir, 'keep.txt'), 'operator data')

    const { daemon } = makeDaemon(root)
    await daemon.start()
    expect(existsSync(stale)).toBe(false)
    expect(readFileSync(join(operatorDir, 'keep.txt'), 'utf8')).toBe('operator data')
    await daemon.stop()
  })

  it('detach on an absent destination arms an idempotent staging gate until activate succeeds', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()

    await expect(seam(daemon).applyAgentDetach({ agentId: 'ghost', moveId: MOVE_ID })).resolves.toEqual({ ok: true })
    await expect(seam(daemon).applyAgentDetach({ agentId: 'ghost', moveId: MOVE_ID })).resolves.toEqual({ ok: true })
    expect((daemon as any).drainingAgents.has('ghost')).toBe(true)

    await expect(
      seam(daemon).applyAgentActivate({
        agentId: 'ghost',
        moveId: MOVE_ID_2,
        spec: { name: 'ghost', runtime: 'claude' },
        integrations: [],
        crons: []
      })
    ).resolves.toEqual({ ok: false, reason: 'agent/activate: staging fence is missing or superseded' })

    // The absent destination remains out of the effective roster until activate
    // atomically writes the bundle and proves the host can start.
    expect((daemon as any).agents.has('ghost')).toBe(false)
    expect((daemon as any).drainingAgents.has('ghost')).toBe(true)

    const activation = {
      agentId: 'ghost',
      moveId: MOVE_ID,
      spec: { name: 'ghost', runtime: 'claude' },
      integrations: [],
      crons: []
    }
    const firstActivation = seam(daemon).applyAgentActivate(activation)
    const duplicateActivation = seam(daemon).applyAgentActivate(activation)
    expect(duplicateActivation).toBe(firstActivation)
    await expect(firstActivation).resolves.toEqual({ ok: true })
    expect((daemon as any).drainingAgents.has('ghost')).toBe(false)
    await daemon.stop()
  })

  it('a token-less activate releases a stale staging fence by committing the stored token (#1093)', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon, hosts } = makeDaemon(root)
    await daemon.start()
    // The fence a pool member keeps after sourcing a move onto a machine (pool → machine …).
    await expect(seam(daemon).applyAgentDetach({ agentId: 'bot-a', moveId: MOVE_ID })).resolves.toEqual({ ok: true })
    expect((daemon as any).cpLocalState().stagedAgents).toEqual([{ agentId: 'bot-a', moveId: MOVE_ID }])

    // … → pool: the CP commits the set placement and broadcasts an activate with NO move token.
    await expect(
      seam(daemon).applyAgentActivate({
        agentId: 'bot-a',
        spec: { name: 'bot-a', runtime: 'claude' },
        integrations: [],
        crons: []
      })
    ).resolves.toEqual({ ok: true })
    expect((daemon as any).agents.has('bot-a')).toBe(true)
    expect((daemon as any).moveStagedAgents.has('bot-a')).toBe(false)
    expect((daemon as any).drainingAgents.has('bot-a')).toBe(false)
    expect(readAgentMoveStage(join(root, 'agents'), 'bot-a')).toEqual({ moveId: MOVE_ID, state: 'committed' })
    expect((daemon as any).cpLocalState().stagedAgents).toEqual([])
    expect(hosts.length).toBeGreaterThan(0) // activation proved ACP can start before the ACK
    await daemon.stop()
  })

  it('a token-less activate on a member that holds no duty releases the fence without a host (#1093)', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon, hosts } = makeDaemon(root)
    await daemon.start()
    const fetchDutyAgent = vi.fn(async () => ({ bundle: DUTY_BUNDLE }))
    poolMember(daemon, { fetchDutyAgent })
    expect((daemon as any).servesAgent('bot-a')).toBe(false)

    await expect(seam(daemon).applyAgentDetach({ agentId: 'bot-a', moveId: MOVE_ID })).resolves.toEqual({ ok: true })
    await expect(
      seam(daemon).applyAgentActivate({
        agentId: 'bot-a',
        spec: { name: 'bot-a', runtime: 'claude' },
        integrations: [],
        crons: []
      })
    ).resolves.toEqual({ ok: true })

    // The fence is cleared and the replica is current …
    expect((daemon as any).moveStagedAgents.has('bot-a')).toBe(false)
    expect((daemon as any).drainingAgents.has('bot-a')).toBe(false)
    expect(readAgentMoveStage(join(root, 'agents'), 'bot-a')).toEqual({ moveId: MOVE_ID, state: 'committed' })
    expect((daemon as any).agents.has('bot-a')).toBe(true)
    // … and NOTHING runs here: a non-holder host would bind the agent's exclusive sandbox channel,
    // leaving whichever member the ledger picks authorized for ingress but unable to bind.
    await (daemon as any).flushReconcile()
    expect(hosts).toEqual([])
    expect((daemon as any).hosts.has('bot-a')).toBe(false)

    // The duty grant is what starts it, and the current replica makes that install a no-fetch.
    await (daemon as any).dutyCoordinator.admitDutyGrants([dutyGrant('bot-a')])
    expect(fetchDutyAgent).not.toHaveBeenCalled()
    expect((daemon as any).servesAgent('bot-a')).toBe(true)
    await (daemon as any).ensureHostAsync('bot-a')
    expect(hosts.map((h) => h.id)).toEqual(['bot-a'])
    await daemon.stop()
  })

  it('a token-less activate still proves its host on the member that holds the duty', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon, hosts } = makeDaemon(root)
    await daemon.start()
    poolMember(daemon)
    ;(daemon as any).duties.applyGrant([dutyGrant('bot-a')]) // this member holds the agent's duty
    expect((daemon as any).servesAgent('bot-a')).toBe(true)

    await expect(seam(daemon).applyAgentDetach({ agentId: 'bot-a', moveId: MOVE_ID })).resolves.toEqual({ ok: true })
    await expect(
      seam(daemon).applyAgentActivate({
        agentId: 'bot-a',
        spec: { name: 'bot-a', runtime: 'claude' },
        integrations: [],
        crons: []
      })
    ).resolves.toEqual({ ok: true })

    expect((daemon as any).moveStagedAgents.has('bot-a')).toBe(false)
    expect(hosts.map((h) => h.id)).toEqual(['bot-a']) // the holder proves ACP before the ACK
    await daemon.stop()
  })

  it('a revoke landing mid-activation keeps the unstaged host down (#1093)', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon, hosts } = makeDaemon(root)
    await daemon.start()
    poolMember(daemon)
    ;(daemon as any).duties.applyGrant([dutyGrant('bot-a')]) // holds the duty when the frame arrives
    await expect(seam(daemon).applyAgentDetach({ agentId: 'bot-a', moveId: MOVE_ID })).resolves.toEqual({ ok: true })
    expect((daemon as any).servesAgent('bot-a')).toBe(true)

    // Land the revoke inside the activation's OWN reconcile — after the bundle apply (the agent is
    // already unstaged there), before the host start. Awaited interleave, no timers, no sleeps.
    const reconcile = (daemon as any).flushReconcile.bind(daemon)
    let landed = false
    ;(daemon as any).flushReconcile = async () => {
      await reconcile()
      if (landed || (daemon as any).moveStagedAgents.has('bot-a')) return
      landed = true
      ;(daemon as any).dutyCoordinator.applyDutyRevoke([{ groupId: GROUP_ID, reason: 'superseded' }])
    }

    await expect(
      seam(daemon).applyAgentActivate({
        agentId: 'bot-a',
        spec: { name: 'bot-a', runtime: 'claude' },
        integrations: [],
        crons: []
      })
    ).resolves.toEqual({ ok: true })

    // The fence is still released — losing the duty is not a reason to keep a stale fence armed …
    expect(landed).toBe(true) // the interleave really happened
    expect((daemon as any).moveStagedAgents.has('bot-a')).toBe(false)
    expect(readAgentMoveStage(join(root, 'agents'), 'bot-a')).toEqual({ moveId: MOVE_ID, state: 'committed' })
    // … and the host stays down: holdership is re-read at the start boundary, not captured before it.
    expect((daemon as any).servesAgent('bot-a')).toBe(false)
    expect(hosts).toEqual([])
    expect((daemon as any).hosts.has('bot-a')).toBe(false)
    await daemon.stop()
  })

  it('a token-less activate with no staging fence acknowledges without applying anything', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon, hosts } = makeDaemon(root)
    await daemon.start()

    await expect(
      seam(daemon).applyAgentActivate({
        agentId: 'bot-a',
        spec: { name: 'renamed', runtime: 'claude' },
        integrations: [],
        crons: []
      })
    ).resolves.toEqual({ ok: true })
    expect((daemon as any).agents.get('bot-a').name).toBe('bot-a') // the bundle was NOT applied
    expect(existsSync(stagedAgentDir(join(root, 'agents'), 'bot-a'))).toBe(false)

    await expect(
      seam(daemon).applyAgentActivate({
        agentId: 'ghost',
        spec: { name: 'ghost', runtime: 'claude' },
        integrations: [],
        crons: []
      })
    ).resolves.toEqual({ ok: true })
    expect((daemon as any).agents.has('ghost')).toBe(false)
    expect(hosts).toEqual([])
    await daemon.stop()
  })

  it('a token-less activate never resurrects a removal-tombstoned agent', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    stageAgentMove(join(root, 'agents'), 'bot-a', MOVE_ID)
    markAgentRemoval(join(root, 'agents'), 'bot-a', agentRemovalObligationsDir(root))
    const { daemon } = makeDaemon(root)
    await daemon.start()

    await expect(
      seam(daemon).applyAgentActivate({
        agentId: 'bot-a',
        spec: { name: 'bot-a', runtime: 'claude' },
        integrations: [],
        crons: []
      })
    ).resolves.toEqual({ ok: false, reason: 'agent/activate: a removal tombstone owns this agent' })
    expect((daemon as any).agents.has('bot-a')).toBe(false)
    expect((daemon as any).moveStagedAgents.has('bot-a')).toBe(true)
    expect(agentRemovalTombstones(join(root, 'agents'), agentRemovalObligationsDir(root)).has('bot-a')).toBe(true)
    await daemon.stop()
  })

  it('keeps a newer removal gate latched while an older activation is preparing', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()
    await expect(seam(daemon).applyAgentDetach({ agentId: 'bot-a', moveId: MOVE_ID })).resolves.toEqual({ ok: true })

    const realPreparation = (daemon as any).runAgentWorkspacePreparation.bind(daemon)
    let releasePreparation!: () => void
    const blocked = new Promise<void>((resolve) => (releasePreparation = resolve))
    let markPreparationEntered!: () => void
    const entered = new Promise<void>((resolve) => (markPreparationEntered = resolve))
    vi.spyOn(daemon as any, 'runAgentWorkspacePreparation').mockImplementationOnce(async (agent: unknown) => {
      markPreparationEntered()
      await blocked
      return realPreparation(agent)
    })

    const activating = seam(daemon).applyAgentActivate({
      agentId: 'bot-a',
      moveId: MOVE_ID,
      spec: { name: 'bot-a', runtime: 'claude' },
      integrations: [],
      crons: []
    })
    await entered
    const removing = Promise.resolve(seam(daemon).applyAgentRemove('bot-a'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect((daemon as any).agentRemovalPending('bot-a')).toBe(true)
    expect((daemon as any).drainingAgents.has('bot-a')).toBe(true)

    releasePreparation()
    await expect(activating).resolves.toEqual({ ok: false, reason: 'agent/activate: superseded by agent removal' })
    expect((daemon as any).drainingAgents.has('bot-a')).toBe(true)
    await removing
    expect(existsSync(join(root, 'agents', 'bot-a'))).toBe(false)
    expect((daemon as any).drainingAgents.has('bot-a')).toBe(true)
    await daemon.stop()
  })

  it('detach waits a pre-pending dispatch lease before archiving and closing its final token', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()
    await seam(daemon).applyAgentUpsert({
      agentId: 'bot-a',
      spec: { name: 'bot-a', runtime: 'claude' } as AgentSpec
    })

    const connection = {
      appToken: 'xapp-only',
      botToken: 'xoxb-only',
      stop: vi.fn().mockResolvedValue(undefined)
    }
    const live = (daemon as any).agents.get('bot-a')
    live.integrations = [
      {
        id: 'int-only',
        platform: 'slack',
        core: { mode: 'direct' },
        config: { appToken: 'xapp-only', botToken: 'xoxb-only' }
      }
    ]
    ;(daemon as any).connections.slackPool.add(connection)
    ;(daemon as any).connByIntegration.set('int-only', connection)
    const releaseDispatch = (daemon as any).beginActiveDispatch('bot-a') as () => void

    let settled = false
    const firstDetach = seam(daemon).applyAgentDetach({ agentId: 'bot-a', moveId: MOVE_ID })
    const duplicateDetach = seam(daemon).applyAgentDetach({ agentId: 'bot-a', moveId: MOVE_ID })
    expect(duplicateDetach).toBe(firstDetach)
    const detach = firstDetach.then((ack: unknown) => {
      settled = true
      return ack
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(connection.stop).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'agents', 'bot-a', '.cp-agent-id'))).toBe(true)

    releaseDispatch()
    await expect(detach).resolves.toEqual({ ok: true })
    expect(connection.stop).toHaveBeenCalledTimes(1)
    expect(existsSync(join(root, 'agents', 'bot-a', 'agent.json'))).toBe(false)
    await daemon.stop()
  })

  it('activate enforces maxAgents again at the daemon to close concurrent-move capacity races', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()
    ;(daemon as any).cfg.limits.maxAgents = 1

    await expect(seam(daemon).applyAgentDetach({ agentId: 'ghost', moveId: MOVE_ID })).resolves.toEqual({ ok: true })
    await expect(
      seam(daemon).applyAgentActivate({
        agentId: 'ghost',
        moveId: MOVE_ID,
        spec: { name: 'ghost', runtime: 'claude' },
        integrations: [],
        crons: []
      })
    ).resolves.toEqual({ ok: false, reason: 'agent/activate: daemon capacity 1/1 is full' })
    expect((daemon as any).drainingAgents.has('ghost')).toBe(true)
    expect((daemon as any).moveStagedAgents.has('ghost')).toBe(true)
    expect(existsSync(join(root, 'agents', 'ghost', 'agent.json'))).toBe(false)
    await daemon.stop()
  })

  it('reserves capacity synchronously across concurrent activations for different agents', async () => {
    const root = root1()
    const { daemon } = makeDaemon(root)
    await daemon.start()
    ;(daemon as any).cfg.limits.maxAgents = 1
    await Promise.all([
      seam(daemon).applyAgentDetach({ agentId: 'ghost-a', moveId: MOVE_ID }),
      seam(daemon).applyAgentDetach({ agentId: 'ghost-b', moveId: MOVE_ID_2 })
    ])

    const [a, b] = await Promise.all([
      seam(daemon).applyAgentActivate({
        agentId: 'ghost-a',
        moveId: MOVE_ID,
        spec: { name: 'ghost-a', runtime: 'claude' },
        integrations: [],
        crons: []
      }),
      seam(daemon).applyAgentActivate({
        agentId: 'ghost-b',
        moveId: MOVE_ID_2,
        spec: { name: 'ghost-b', runtime: 'claude' },
        integrations: [],
        crons: []
      })
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect([a, b].find((ack) => !ack.ok)?.reason).toContain('daemon capacity 1/1 is full')
    expect((daemon as any).agents.size).toBe(1)
    await daemon.stop()
  })

  it('activate terminal-verifies MCP definitions/transports and probed model availability', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()

    await seam(daemon).applyAgentDetach({ agentId: 'ghost', moveId: MOVE_ID_2 })
    await expect(
      seam(daemon).applyAgentActivate({
        agentId: 'ghost',
        moveId: MOVE_ID_2,
        spec: { name: 'ghost', runtime: 'claude', mcpServers: ['missing'] },
        integrations: [],
        crons: []
      })
    ).resolves.toEqual({ ok: false, reason: 'agent/activate: MCP server "missing" is not configured on this daemon' })

    await seam(daemon).applyAgentDetach({ agentId: 'ghost', moveId: MOVE_ID_3 })
    ;(daemon as any).cpMcpDefs.upsert('org-a', 'remote', { transport: 'http', url: 'https://mcp.invalid' })
    ;(daemon as any).runtimeFacts.mcpCaps.set('claude', { http: false, sse: false })
    await expect(
      seam(daemon).applyAgentActivate({
        agentId: 'ghost',
        moveId: MOVE_ID_3,
        spec: { orgId: 'org-a', name: 'ghost', runtime: 'claude', mcpServers: ['remote'] },
        integrations: [],
        crons: []
      })
    ).resolves.toEqual({
      ok: false,
      reason: 'agent/activate: MCP server "remote" needs unsupported http transport on runtime "claude"'
    })

    await seam(daemon).applyAgentDetach({ agentId: 'ghost', moveId: MOVE_ID_4 })
    ;(daemon as any).runtimeFacts.models.set('claude', ['supported-model'])
    await expect(
      seam(daemon).applyAgentActivate({
        agentId: 'ghost',
        moveId: MOVE_ID_4,
        spec: { name: 'ghost', runtime: 'claude', model: 'missing-model', mcpServers: [] },
        integrations: [],
        crons: []
      })
    ).resolves.toEqual({
      ok: false,
      reason: 'agent/activate: model "missing-model" is not offered by runtime "claude"'
    })
    expect((daemon as any).moveStagedAgents.has('ghost')).toBe(true)
    await daemon.stop()
  })

  it('persists committed move idempotency across daemon restart for an ACK-loss retry', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const first = makeDaemon(root).daemon
    await first.start()
    const activation = {
      agentId: 'bot-a',
      moveId: MOVE_ID,
      spec: { name: 'bot-a', runtime: 'claude' },
      integrations: [],
      crons: []
    }
    await seam(first).applyAgentDetach({ agentId: 'bot-a', moveId: MOVE_ID })
    await expect(seam(first).applyAgentActivate(activation)).resolves.toEqual({ ok: true })
    await first.stop()

    const reborn = makeDaemon(root).daemon
    await reborn.start()
    expect((reborn as any).moveStagedAgents.has('bot-a')).toBe(false)
    await expect(seam(reborn).applyAgentActivate(activation)).resolves.toEqual({ ok: true })
    await reborn.stop()
  })

  it('converges the register/ok roster: merges present specs, does NOT prune absent ones', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()

    await seam(daemon).applyAgentUpsert({ agentId: 'bot-a', spec: { name: 'old', model: 'sonnet' } as AgentSpec })
    await daemon.reconcile()

    // A reconcile snapshot re-specs bot-a. bot-b is on disk but absent from the roster.
    writeAgent(root, 'bot-b')
    await daemon.reconcile()
    const snap = {
      routingEpoch: 1,
      assignments: [],
      agents: [{ agentId: 'bot-a', name: 'roster', model: 'opus' }],
      crons: [],
      leases: [],
      drop: { assignments: [], crons: [] }
    }
    await seam(daemon).applyReconcileSnapshot(snap)
    await daemon.reconcile()

    expect((daemon as any).agents.get('bot-a').runtimeOverrides.model).toBe('opus')
    // bot-b absent from roster but NOT pruned (deletion only via agent/remove).
    expect(existsSync(join(root, 'agents', 'bot-b', 'agent.json'))).toBe(true)
    expect((daemon as any).agents.has('bot-b')).toBe(true)
    await daemon.stop()
  })

  it('applies ownership-authorized detach/remove drops without pruning local-only agents', async () => {
    const root = root1()
    writeAgent(root, 'stale-cp')
    writeAgent(root, 'deleted-cp')
    writeAgent(root, 'local-only')
    const { daemon, hosts } = makeDaemon(root)
    await daemon.start()
    await seam(daemon).applyAgentUpsert({
      agentId: 'stale-cp',
      spec: { name: 'stale-cp', runtime: 'claude' } as AgentSpec
    })
    await seam(daemon).applyAgentUpsert({
      agentId: 'deleted-cp',
      spec: { name: 'deleted-cp', runtime: 'claude' } as AgentSpec
    })
    await (daemon as any).ensureHostAsync('stale-cp')
    const staleHost = hosts.at(-1)!

    await seam(daemon).applyReconcileSnapshot({
      routingEpoch: 1,
      assignments: [],
      agents: [],
      integrations: [],
      crons: [],
      leases: [],
      drop: {
        assignments: [],
        crons: [],
        agents: [
          { agentId: 'stale-cp', action: 'detach' },
          { agentId: 'deleted-cp', action: 'remove' }
        ],
        integrations: []
      }
    })
    await daemon.reconcile()

    expect(staleHost.stop).toHaveBeenCalledTimes(1)
    expect((daemon as any).agents.has('stale-cp')).toBe(false)
    expect(existsSync(join(root, 'agents', 'stale-cp', 'agent.json'))).toBe(false)
    expect(existsSync(join(root, 'agents', 'stale-cp', '.cp-agent-id'))).toBe(true)
    expect(existsSync(detachedAgentDir(join(root, 'agents'), 'stale-cp'))).toBe(false)
    expect(existsSync(join(root, 'agents', 'deleted-cp'))).toBe(false)
    expect(existsSync(detachedAgentDir(join(root, 'agents'), 'deleted-cp'))).toBe(false)
    expect((daemon as any).drainingAgents.has('deleted-cp')).toBe(true)
    expect((daemon as any).agents.has('local-only')).toBe(true)
    expect(existsSync(join(root, 'agents', 'local-only', 'agent.json'))).toBe(true)
    await daemon.stop()
  })

  it('does not revive memory-only CP crons after detach, restart, and roster re-add', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const first = makeDaemon(root).daemon
    await first.start()
    await seam(first).applyAgentUpsert({
      agentId: 'bot-a',
      spec: { name: 'bot-a', runtime: 'claude' } as AgentSpec
    })
    seam(first).upsertCron({
      cronId: 'stale-cp',
      agentId: 'bot-a',
      schedule: '0 * * * *',
      trigger: 'stale',
      enabled: true
    })
    await seam(first).applyReconcileSnapshot({
      routingEpoch: 1,
      assignments: [],
      agents: [],
      integrations: [],
      crons: [],
      leases: [],
      drop: {
        assignments: [],
        crons: [],
        agents: [{ agentId: 'bot-a', action: 'detach' }],
        integrations: []
      }
    })
    await first.stop()

    const reborn = makeDaemon(root).daemon
    await reborn.start()
    await seam(reborn).applyReconcileSnapshot({
      routingEpoch: 2,
      assignments: [],
      agents: [{ agentId: 'bot-a', name: 'bot-a', runtime: 'claude' }],
      integrations: [],
      crons: [],
      leases: [],
      drop: { assignments: [], crons: [], agents: [], integrations: [] }
    })

    expect(findAgentFileById(join(root, 'agents'), 'bot-a')).toBeUndefined()
    expect((reborn as any).agents.get('bot-a')?.crons).toEqual([])
    await reborn.stop()
  })

  it('admits agent drops before an unrelated fallible snapshot convergence step', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()
    await seam(daemon).applyAgentUpsert({
      agentId: 'bot-a',
      spec: { name: 'bot-a', runtime: 'claude' } as AgentSpec
    })
    vi.spyOn((daemon as any).cpIntegrations, 'remove').mockImplementationOnce(() => {
      throw new Error('integration drop failed')
    })

    await expect(
      seam(daemon).applyReconcileSnapshot({
        routingEpoch: 1,
        assignments: [],
        agents: [],
        integrations: [],
        crons: [],
        leases: [],
        drop: {
          assignments: [],
          crons: [],
          agents: [{ agentId: 'bot-a', action: 'remove' }],
          integrations: ['stale-integration']
        }
      })
    ).rejects.toThrow('integration drop failed')

    expect(existsSync(join(root, 'agents', 'bot-a', 'agent.json'))).toBe(false)
    expect((daemon as any).drainingAgents.has('bot-a')).toBe(true)
    expect((daemon as any).cpDroppedAgents.has('bot-a')).toBe(true)
    await daemon.stop()
  })

  it('does not archive a reconnect-dropped agent while workspace preparation is still running', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon, hosts } = makeDaemon(root)
    await daemon.start()
    await seam(daemon).applyAgentUpsert({
      agentId: 'bot-a',
      spec: { name: 'bot-a', runtime: 'claude' } as AgentSpec
    })
    await (daemon as any).ensureHostAsync('bot-a')
    const host = hosts.at(-1)!
    const current = (daemon as any).agents.get('bot-a')

    const realPreparation = (daemon as any).runAgentWorkspacePreparation.bind(daemon)
    let releasePreparation!: () => void
    const blocked = new Promise<void>((resolve) => (releasePreparation = resolve))
    let markPreparationEntered!: () => void
    const entered = new Promise<void>((resolve) => (markPreparationEntered = resolve))
    vi.spyOn(daemon as any, 'runAgentWorkspacePreparation').mockImplementationOnce(async (agent: unknown) => {
      markPreparationEntered()
      await blocked
      return realPreparation(agent)
    })
    const preparing = (daemon as any).prepareAgentWorkspace(current, host) as Promise<string>
    await entered

    let applied = false
    const applying = Promise.resolve(
      seam(daemon).applyReconcileSnapshot({
        routingEpoch: 1,
        assignments: [],
        agents: [],
        integrations: [],
        crons: [],
        leases: [],
        drop: {
          assignments: [],
          crons: [],
          agents: [{ agentId: 'bot-a', action: 'detach' }],
          integrations: []
        }
      })
    ).then(() => {
      applied = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(applied).toBe(false)
    expect(existsSync(join(root, 'agents', 'bot-a', '.cp-agent-id'))).toBe(true)
    expect(existsSync(detachedAgentDir(join(root, 'agents'), 'bot-a'))).toBe(false)

    releasePreparation()
    await preparing
    await applying
    expect(existsSync(join(root, 'agents', 'bot-a', 'agent.json'))).toBe(false)
    expect(existsSync(join(root, 'agents', 'bot-a', '.cp-agent-id'))).toBe(true)
    expect(existsSync(detachedAgentDir(join(root, 'agents'), 'bot-a'))).toBe(false)
    await daemon.reconcile()
    await daemon.stop()
  })

  it('does not remove an agent while an eager workspace prefetch is still running', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()
    await seam(daemon).applyAgentUpsert({
      agentId: 'bot-a',
      spec: { name: 'bot-a', runtime: 'claude' } as AgentSpec
    })
    const current = (daemon as any).agents.get('bot-a')
    const removeAgent = vi.spyOn((daemon as any).cpAgents, 'remove')
    const workspace = join(root, 'agents', 'bot-a', 'ws')

    let releasePrefetch!: () => void
    const blocked = new Promise<void>((resolve) => (releasePrefetch = resolve))
    let markPrefetchEntered!: () => void
    const entered = new Promise<void>((resolve) => (markPrefetchEntered = resolve))
    vi.spyOn(daemon as any, 'runAgentWorkspacePrefetch').mockImplementationOnce(async () => {
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, 'early-prefetch'), 'cloning')
      markPrefetchEntered()
      await blocked
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, 'late-prefetch'), 'cloned')
    })
    const prefetchClone = (daemon as any).prefetchClone.bind(daemon)
    prefetchClone(current)
    await entered

    let removed = false
    const removing = Promise.resolve(seam(daemon).applyAgentRemove('bot-a')).then(() => {
      removed = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(removed).toBe(false)
    expect((daemon as any).workspacePreparationTails.has('bot-a')).toBe(true)
    expect(existsSync(join(workspace, 'early-prefetch'))).toBe(true)
    expect(removeAgent).not.toHaveBeenCalled()

    releasePrefetch()
    await removing
    expect(removeAgent).toHaveBeenCalledOnce()
    expect(existsSync(join(root, 'agents', 'bot-a'))).toBe(false)
    expect((daemon as any).workspacePreparationTails.has('bot-a')).toBe(false)
    await daemon.reconcile()
    await daemon.stop()
  })

  it('does not remove an agent while an accepted Dream skill publication owns the workspace write fence', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()
    await seam(daemon).applyAgentUpsert({
      agentId: 'bot-a',
      spec: { name: 'bot-a', runtime: 'claude' } as AgentSpec
    })
    const removeAgent = vi.spyOn((daemon as any).cpAgents, 'remove')

    let releasePublication!: () => void
    const blocked = new Promise<void>((resolve) => (releasePublication = resolve))
    let markPublicationEntered!: () => void
    const entered = new Promise<void>((resolve) => (markPublicationEntered = resolve))
    const agentDir = join(root, 'agents', 'bot-a')
    const publishing = (daemon as any).withWorkspaceFileWrite('bot-a', async () => {
      mkdirSync(join(agentDir, 'skills'), { recursive: true })
      writeFileSync(join(agentDir, 'skills', 'early-publication'), 'accepted')
      markPublicationEntered()
      await blocked
      // Accepted Dream publication writes several daemon-owned files under the
      // agent root. This late marker makes a missing fence deterministically
      // recreate the released path after agent/remove has already returned.
      mkdirSync(join(agentDir, 'skills'), { recursive: true })
      writeFileSync(join(agentDir, 'skills', 'late-publication'), 'accepted')
    }) as Promise<void>
    await entered

    let removed = false
    const removing = Promise.resolve(seam(daemon).applyAgentRemove('bot-a')).then(() => {
      removed = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(removed).toBe(false)
    expect(existsSync(join(agentDir, '.cp-agent-id'))).toBe(true)
    expect(existsSync(join(agentDir, 'skills', 'early-publication'))).toBe(true)
    expect(removeAgent).not.toHaveBeenCalled()

    releasePublication()
    await publishing
    await removing
    expect(removeAgent).toHaveBeenCalledOnce()
    expect(existsSync(agentDir)).toBe(false)
    await daemon.reconcile()
    await daemon.stop()
  })

  it('serializes a newer agent upsert behind a blocked removal and preserves the new root', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()
    await seam(daemon).applyAgentUpsert({
      agentId: 'bot-a',
      spec: { name: 'old', runtime: 'claude' } as AgentSpec
    })

    let releaseWrite!: () => void
    const blocked = new Promise<void>((resolve) => (releaseWrite = resolve))
    let markWriteEntered!: () => void
    const entered = new Promise<void>((resolve) => (markWriteEntered = resolve))
    const writing = (daemon as any).withWorkspaceFileWrite('bot-a', async () => {
      markWriteEntered()
      await blocked
    }) as Promise<void>
    await entered

    let removed = false
    const removing = Promise.resolve(seam(daemon).applyAgentRemove('bot-a')).then(() => {
      removed = true
    })
    let upserted = false
    const upserting = seam(daemon)
      .applyAgentUpsert({
        agentId: 'bot-a',
        spec: { name: 'new', runtime: 'claude' } as AgentSpec
      })
      .then((ack: { ok: boolean }) => {
        upserted = true
        return ack
      })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(removed).toBe(false)
    expect(upserted).toBe(false)
    expect((daemon as any).drainingAgents.has('bot-a')).toBe(true)

    releaseWrite()
    await writing
    await removing
    await expect(upserting).resolves.toEqual({ ok: true })
    expect(findAgentFileById(join(root, 'agents'), 'bot-a')).toBeUndefined()
    expect(readFileSync(join(root, 'agents', 'new', '.cp-agent-id'), 'utf8').trim()).toBe('bot-a')
    expect((daemon as any).agents.get('bot-a')?.name).toBe('new')
    expect((daemon as any).drainingAgents.has('bot-a')).toBe(false)
    expect((daemon as any).cpDroppedAgents.has('bot-a')).toBe(false)
    await daemon.stop()
  })

  it('retains the crash tombstone when a newer removal supersedes an intervening upsert', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()

    const registry = (daemon as any).cpAgents
    const realRemove = registry.remove.bind(registry)
    vi.spyOn(registry, 'remove')
      .mockImplementationOnce(() => {})
      .mockImplementation(realRemove)
    const realQuiesce = (daemon as any).quiesceAgentWorkspaceAuthority.bind(daemon)
    let quiesceCalls = 0
    let releaseSecond!: () => void
    const secondBlocked = new Promise<void>((resolve) => (releaseSecond = resolve))
    let markSecondEntered!: () => void
    const secondEntered = new Promise<void>((resolve) => (markSecondEntered = resolve))
    vi.spyOn(daemon as any, 'quiesceAgentWorkspaceAuthority').mockImplementation(async (agentId: unknown) => {
      quiesceCalls += 1
      if (quiesceCalls === 2) {
        markSecondEntered()
        await secondBlocked
      }
      await realQuiesce(agentId)
    })

    const firstRemoval = Promise.resolve(seam(daemon).applyAgentRemove('bot-a'))
    const interveningUpsert = seam(daemon).applyAgentUpsert({
      agentId: 'bot-a',
      spec: { name: 'new', runtime: 'claude' } as AgentSpec
    })
    const secondRemoval = Promise.resolve(seam(daemon).applyAgentRemove('bot-a'))

    await firstRemoval
    await expect(interveningUpsert).resolves.toEqual({ ok: false, reason: 'agent is pending removal' })
    await secondEntered
    expect(existsSync(join(root, 'agents', 'bot-a', 'agent.json'))).toBe(true)
    expect(agentRemovalTombstones(join(root, 'agents'))).toEqual(new Set(['bot-a']))

    // Model the exact crash image while removal #2 is admitted but has not run:
    // a stale root plus the still-owned durable marker must restart dark.
    const crashRoot = root1()
    writeAgent(crashRoot, 'bot-a')
    cpSync(join(root, 'agents', '.removed'), join(crashRoot, 'agents', '.removed'), { recursive: true })
    const reborn = makeDaemon(crashRoot).daemon
    await reborn.start()
    expect((reborn as any).agents.has('bot-a')).toBe(false)
    expect((reborn as any).drainingAgents.has('bot-a')).toBe(true)
    expect((reborn as any).cpLocalState().agents).toContainEqual({ agentId: 'bot-a', origin: 'cp' })
    await reborn.stop()

    releaseSecond()
    await secondRemoval
    expect(agentRemovalTombstones(join(root, 'agents'))).toEqual(new Set())
    await daemon.stop()
  })

  it('keeps a newer stop gate closed when an older queued launch reaches the lifecycle lane', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon, hosts } = makeDaemon(root)
    await daemon.start()

    let releaseOlder!: () => void
    const olderBlocked = new Promise<void>((resolve) => (releaseOlder = resolve))
    let markOlderEntered!: () => void
    const olderEntered = new Promise<void>((resolve) => (markOlderEntered = resolve))
    const older = (daemon as any).queueAgentLifecycle('bot-a', async () => {
      markOlderEntered()
      await olderBlocked
    }) as Promise<void>
    await olderEntered

    const launching = seam(daemon).applyAgentLaunch({
      agentId: 'bot-a',
      runtime: 'claude',
      workspaceId: 'workspace-a',
      capabilities: [],
      spec: { name: 'bot-a' },
      mode: 'long_lived'
    })
    const stopping = seam(daemon).applyAgentStop({
      agentId: 'bot-a',
      launchId: 'launch-a',
      reason: 'rebalance'
    })

    expect((daemon as any).drainingAgents.has('bot-a')).toBe(true)
    expect((daemon as any).pendingAgentDrains.get('bot-a')?.count).toBe(1)
    releaseOlder()
    await older
    await expect(launching).rejects.toThrow(/superseded by a newer agent drain/)
    await expect(stopping).resolves.toEqual({ ok: true })
    expect(hosts).toHaveLength(0)
    expect((daemon as any).drainingAgents.has('bot-a')).toBe(true)
    expect((daemon as any).pendingAgentDrains.has('bot-a')).toBe(false)
    await daemon.stop()
  })

  it('keeps later upserts fail-closed after destructive removal cleanup fails', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()
    await seam(daemon).applyAgentUpsert({
      agentId: 'bot-a',
      spec: { name: 'old', runtime: 'claude' } as AgentSpec
    })
    vi.spyOn(daemon as any, 'quiesceAgentWorkspaceAuthority').mockRejectedValueOnce(new Error('cleanup failed'))

    await expect(seam(daemon).applyAgentRemove('bot-a')).rejects.toThrow('cleanup failed')
    await expect(
      seam(daemon).applyAgentUpsert({
        agentId: 'bot-a',
        spec: { name: 'must-not-land', runtime: 'claude' } as AgentSpec
      })
    ).rejects.toThrow(/blocked by an earlier failed remove cleanup/)
    await expect(
      seam(daemon).applyAgentStop({ agentId: 'bot-a', launchId: 'launch-a', reason: 'rebalance' })
    ).rejects.toThrow(/blocked by an earlier failed remove cleanup/)

    expect((daemon as any).drainingAgents.has('bot-a')).toBe(true)
    expect((daemon as any).cpDroppedAgents.has('bot-a')).toBe(true)
    expect((daemon as any).agentLifecycleFailures.get('bot-a')?.owner).toBe('remove')
    expect(existsSync(join(root, 'agents', 'bot-a', 'agent.json'))).toBe(false)
    expect((daemon as any).agents.get('bot-a')?.name).toBe('old')
    // A later destructive retry is the explicit recovery path.
    await expect(seam(daemon).applyAgentRemove('bot-a')).resolves.toBeUndefined()
    await daemon.stop()
  })

  it('uses the daemon-root mirror when the agentsDir marker store is unavailable', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon, hosts } = makeDaemon(root)
    await daemon.start()
    await seam(daemon).applyAgentUpsert({
      agentId: 'bot-a',
      spec: { name: 'bot-a', runtime: 'claude' } as AgentSpec
    })
    await (daemon as any).ensureHostAsync('bot-a')
    expect(hosts).toHaveLength(1)
    // Make the tombstone parent a regular file so its hashed child cannot be created.
    writeFileSync(join(root, 'agents', '.removed'), 'blocked')

    await expect(seam(daemon).applyAgentRemove('bot-a')).resolves.toBeUndefined()
    expect((daemon as any).drainingAgents.has('bot-a')).toBe(true)
    expect((daemon as any).cpDroppedAgents.has('bot-a')).toBe(true)
    // The daemon-root mirror admitted removal, so cleanup can delete the root
    // and the reserved local path need not weaken the durable fence.
    expect(existsSync(join(root, 'agents', 'bot-a', 'agent.json'))).toBe(false)
    expect(hosts[0]!.stop).toHaveBeenCalledOnce()
    expect((daemon as any).hosts.has('bot-a')).toBe(false)
    expect((daemon as any).agentLifecycleFailures.has('bot-a')).toBe(false)
    await expect((daemon as any).ensureHostAsync('bot-a')).rejects.toThrow(/draining/)
    await daemon.stop()
  })

  it('recovers a stale root from the daemon-root mirror when the local store is blocked', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const first = makeDaemon(root).daemon
    await first.start()
    writeFileSync(join(root, 'agents', '.removed'), 'blocked')
    vi.spyOn(first as any, 'quiesceAgentWorkspaceAuthority').mockRejectedValueOnce(new Error('cleanup failed'))

    await expect(seam(first).applyAgentRemove('bot-a')).rejects.toThrow('cleanup failed')
    expect(existsSync(join(root, 'agents', 'bot-a', 'agent.json'))).toBe(true)
    await first.stop()

    const reborn = makeDaemon(root).daemon
    await expect(reborn.start()).resolves.toBeUndefined()
    expect((reborn as any).agents.has('bot-a')).toBe(false)
    expect((reborn as any).drainingAgents.has('bot-a')).toBe(true)
    expect((reborn as any).removedAgentTombstones.has('bot-a')).toBe(true)
    await reborn.stop()
  })

  it('uses a durable root delete as the fence when both marker stores fail', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon, hosts } = makeDaemon(root)
    await daemon.start()
    await seam(daemon).applyAgentUpsert({
      agentId: 'bot-a',
      spec: { name: 'bot-a', runtime: 'claude' } as AgentSpec
    })
    await (daemon as any).ensureHostAsync('bot-a')
    expect(hosts).toHaveLength(1)
    // Both reserved marker paths are regular files, so neither mirror can
    // publish. agentsDir itself remains writable, allowing the fsynced root
    // deletion to become the durable removal fence.
    writeFileSync(join(root, 'agents', '.removed'), 'blocked')
    writeFileSync(agentRemovalObligationsDir(root), 'blocked')

    await expect(seam(daemon).applyAgentRemove('bot-a')).resolves.toBeUndefined()
    expect(hosts[0]!.stop).toHaveBeenCalledOnce()
    expect(existsSync(join(root, 'agents', 'bot-a', 'agent.json'))).toBe(false)
    expect((daemon as any).drainingAgents.has('bot-a')).toBe(true)
    expect((daemon as any).agentLifecycleFailures.has('bot-a')).toBe(false)
    await daemon.stop()
  })

  it.skipIf(process.platform === 'win32')(
    'keeps restart dark when the daemon-root mirror is read-only but the agentsDir mirror succeeds',
    async () => {
      const root = root1()
      writeAgent(root, 'bot-a')
      const obligationDir = agentRemovalObligationsDir(root)
      mkdirSync(obligationDir, { recursive: true })
      chmodSync(obligationDir, 0o555)
      try {
        const first = makeDaemon(root).daemon
        await first.start()
        vi.spyOn(first as any, 'quiesceAgentWorkspaceAuthority').mockRejectedValueOnce(new Error('cleanup failed'))

        await expect(seam(first).applyAgentRemove('bot-a')).rejects.toThrow('cleanup failed')
        expect(agentRemovalTombstones(join(root, 'agents'))).toEqual(new Set(['bot-a']))
        expect(existsSync(join(root, 'agents', 'bot-a', 'agent.json'))).toBe(true)
        await first.stop()

        const reborn = makeDaemon(root).daemon
        await reborn.start()
        expect((reborn as any).agents.has('bot-a')).toBe(false)
        expect((reborn as any).drainingAgents.has('bot-a')).toBe(true)
        await reborn.stop()
      } finally {
        chmodSync(obligationDir, 0o700)
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps a read-only custom agentsDir removal dark across restart via the daemon-root obligation',
    async () => {
      const root = root1()
      writeAgent(root, 'bot-a')
      const agentsDir = join(root, 'agents')
      const { daemon, hosts } = makeDaemon(root)
      await daemon.start()
      await (daemon as any).ensureHostAsync('bot-a')
      expect(hosts).toHaveLength(1)
      vi.spyOn((daemon as any).cpAgents, 'remove').mockImplementationOnce(() => {
        throw new Error('EACCES: agentsDir is read-only')
      })

      chmodSync(agentsDir, 0o555)
      try {
        await expect(seam(daemon).applyAgentRemove('bot-a')).rejects.toThrow()
        expect(hosts[0]!.stop).toHaveBeenCalledOnce()
        expect(existsSync(join(agentsDir, 'bot-a', 'agent.json'))).toBe(true)
        expect(agentRemovalTombstones(agentsDir, agentRemovalObligationsDir(root))).toEqual(new Set(['bot-a']))
        await daemon.stop()

        const reborn = makeDaemon(root).daemon
        await reborn.start()
        expect((reborn as any).agents.has('bot-a')).toBe(false)
        expect((reborn as any).drainingAgents.has('bot-a')).toBe(true)
        expect((reborn as any).cpLocalState().agents).toContainEqual({ agentId: 'bot-a', origin: 'cp' })
        await reborn.stop()
      } finally {
        chmodSync(agentsDir, 0o700)
      }
    }
  )

  it('keeps opaque snapshot drop ids confined outside recursive lifecycle paths', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'sentinel'), 'keep')
    const { daemon } = makeDaemon(root)
    await daemon.start()
    const hostileId = '../outside'

    await expect(
      seam(daemon).applyReconcileSnapshot({
        routingEpoch: 1,
        assignments: [],
        agents: [],
        integrations: [],
        crons: [],
        leases: [],
        drop: {
          assignments: [],
          crons: [],
          agents: [{ agentId: hostileId, action: 'remove' }],
          integrations: []
        }
      })
    ).rejects.toThrow(/agent id is unsafe/)

    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('keep')
    expect(agentRemovalTombstones(join(root, 'agents'))).toEqual(new Set([hostileId]))
    expect((daemon as any).drainingAgents.has(hostileId)).toBe(true)
    await daemon.stop()
  })

  it('keeps a failed CP removal tombstoned across restart until authoritative re-add', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const first = makeDaemon(root).daemon
    await first.start()
    await seam(first).applyAgentUpsert({
      agentId: 'bot-a',
      spec: { name: 'bot-a', runtime: 'claude' } as AgentSpec
    })
    vi.spyOn(first as any, 'quiesceAgentWorkspaceAuthority').mockRejectedValueOnce(new Error('cleanup failed'))

    await expect(seam(first).applyAgentRemove('bot-a')).rejects.toThrow('cleanup failed')
    expect(agentRemovalTombstones(join(root, 'agents'))).toEqual(new Set(['bot-a']))
    expect(existsSync(join(root, 'agents', 'bot-a', 'agent.json'))).toBe(false)
    await first.stop()

    const reborn = makeDaemon(root).daemon
    await reborn.start()
    expect((reborn as any).agents.has('bot-a')).toBe(false)
    expect((reborn as any).drainingAgents.has('bot-a')).toBe(true)
    await expect((reborn as any).ensureHostAsync('bot-a')).rejects.toThrow(/draining/)

    await expect(
      seam(reborn).applyAgentUpsert({
        agentId: 'bot-a',
        spec: { name: 'bot-a', runtime: 'claude' } as AgentSpec
      })
    ).resolves.toEqual({ ok: true })
    expect(agentRemovalTombstones(join(root, 'agents'))).toEqual(new Set())
    expect((reborn as any).agents.has('bot-a')).toBe(true)
    expect((reborn as any).drainingAgents.has('bot-a')).toBe(false)
    expect((reborn as any).agents.get('bot-a')?.integrations).toEqual([])
    expect((reborn as any).agents.get('bot-a')?.crons).toEqual([])
    expect(existsSync(join(root, 'agents', 'bot-a', 'agent.json'))).toBe(false)
    await reborn.stop()
  })

  it('does not reopen a tombstoned agent when any marker mirror has an ambiguous clear', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    markAgentRemoval(join(root, 'agents'), 'bot-a', agentRemovalObligationsDir(root))
    const { daemon } = makeDaemon(root)
    await daemon.start()

    const localStore = join(root, 'agents', '.removed')
    rmSync(localStore, { recursive: true })
    writeFileSync(localStore, 'ambiguous')
    await expect(
      seam(daemon).applyAgentUpsert({
        agentId: 'bot-a',
        spec: { name: 'bot-a', runtime: 'claude' } as AgentSpec
      })
    ).rejects.toThrow(/cannot clear agent .* removal tombstone for re-add/)

    expect((daemon as any).removedAgentTombstones.has('bot-a')).toBe(true)
    expect((daemon as any).drainingAgents.has('bot-a')).toBe(true)
    expect((daemon as any).agents.has('bot-a')).toBe(false)
    await daemon.stop()

    // The failed clear must retain the canonical restart fence.
    const reborn = makeDaemon(root).daemon
    await expect(reborn.start()).resolves.toBeUndefined()
    expect((reborn as any).removedAgentTombstones.has('bot-a')).toBe(true)
    expect((reborn as any).agents.has('bot-a')).toBe(false)
    await reborn.stop()
  })

  it('lets the matching stop retry clear its failure latch before a later launch', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon, hosts } = makeDaemon(root)
    await daemon.start()
    vi.spyOn(daemon as any, 'stopAgent')
      .mockRejectedValueOnce(new Error('stop failed'))
      .mockResolvedValueOnce(undefined)

    const stop = { agentId: 'bot-a', launchId: 'launch-a', reason: 'rebalance' }
    await expect(seam(daemon).applyAgentStop(stop)).rejects.toThrow('stop failed')
    expect((daemon as any).agentLifecycleFailures.get('bot-a')?.owner).toBe('stop')
    await expect(seam(daemon).applyAgentStop(stop)).resolves.toEqual({ ok: true })
    expect((daemon as any).agentLifecycleFailures.has('bot-a')).toBe(false)

    await expect(
      seam(daemon).applyAgentLaunch({
        agentId: 'bot-a',
        runtime: 'claude',
        workspaceId: 'workspace-a',
        capabilities: [],
        spec: { name: 'bot-a' },
        mode: 'long_lived'
      })
    ).resolves.toMatchObject({ agentId: 'bot-a', runtime: 'claude' })
    expect(hosts).toHaveLength(1)
    expect((daemon as any).drainingAgents.has('bot-a')).toBe(false)
    await daemon.stop()
  })

  it('lets stronger removal recover a failed stop without leaking its admission reservation', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()
    await seam(daemon).applyAgentUpsert({
      agentId: 'bot-a',
      spec: { name: 'bot-a', runtime: 'claude' } as AgentSpec
    })
    vi.spyOn(daemon as any, 'stopAgent')
      .mockRejectedValueOnce(new Error('stop failed'))
      .mockResolvedValue(undefined)

    await expect(
      seam(daemon).applyAgentStop({ agentId: 'bot-a', launchId: 'launch-a', reason: 'rebalance' })
    ).rejects.toThrow('stop failed')
    expect((daemon as any).agentLifecycleFailures.get('bot-a')?.owner).toBe('stop')

    await expect(seam(daemon).applyAgentRemove('bot-a')).resolves.toBeUndefined()
    expect((daemon as any).pendingAgentRemovals.has('bot-a')).toBe(false)
    expect((daemon as any).agentLifecycleFailures.has('bot-a')).toBe(false)
    expect(existsSync(join(root, 'agents', 'bot-a', 'agent.json'))).toBe(false)

    // An ACK-loss retry remains idempotent and must not accumulate a phantom
    // reservation that permanently blocks a future authoritative re-add.
    await expect(seam(daemon).applyAgentRemove('bot-a')).resolves.toBeUndefined()
    expect((daemon as any).pendingAgentRemovals.has('bot-a')).toBe(false)
    await daemon.stop()
  })

  it('revives a reconnect-dropped agent when a later roster re-adds it', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()
    const clearDenied = vi.spyOn((daemon as any).gitCreds, 'clearDenied')

    await seam(daemon).applyReconcileSnapshot({
      routingEpoch: 1,
      assignments: [],
      agents: [],
      integrations: [],
      crons: [],
      leases: [],
      drop: {
        assignments: [],
        crons: [],
        agents: [{ agentId: 'bot-a', action: 'remove' }],
        integrations: []
      }
    })
    await daemon.reconcile()
    expect((daemon as any).drainingAgents.has('bot-a')).toBe(true)
    await expect((daemon as any).ensureHostAsync('bot-a')).rejects.toThrow('agent is draining')

    await seam(daemon).applyReconcileSnapshot({
      routingEpoch: 1,
      assignments: [],
      agents: [{ agentId: 'bot-a', name: 'bot-a', runtime: 'claude' }],
      integrations: [],
      crons: [],
      leases: [],
      drop: { assignments: [], crons: [], agents: [], integrations: [] }
    })
    await daemon.reconcile()

    expect((daemon as any).drainingAgents.has('bot-a')).toBe(false)
    expect(clearDenied).toHaveBeenCalledWith('bot-a')
    await expect((daemon as any).ensureHostAsync('bot-a')).resolves.toBeDefined()
    await daemon.stop()
  })

  it('revives a reconnect-dropped agent when a later live upsert re-adds it', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()
    const clearDenied = vi.spyOn((daemon as any).gitCreds, 'clearDenied')

    await seam(daemon).applyReconcileSnapshot({
      routingEpoch: 1,
      assignments: [],
      agents: [],
      integrations: [],
      crons: [],
      leases: [],
      drop: {
        assignments: [],
        crons: [],
        agents: [{ agentId: 'bot-a', action: 'remove' }],
        integrations: []
      }
    })
    await daemon.reconcile()
    expect((daemon as any).drainingAgents.has('bot-a')).toBe(true)

    await seam(daemon).applyAgentUpsert({
      agentId: 'bot-a',
      spec: { name: 'bot-a', runtime: 'claude' } as AgentSpec
    })

    expect((daemon as any).drainingAgents.has('bot-a')).toBe(false)
    expect(clearDenied).toHaveBeenCalledWith('bot-a')
    await expect((daemon as any).ensureHostAsync('bot-a')).resolves.toBeDefined()
    await daemon.stop()
  })
})
