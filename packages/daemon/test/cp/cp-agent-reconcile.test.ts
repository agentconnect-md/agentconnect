import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../../src/daemon.js'
import { detachedAgentDir, readAgentMoveStage, stageAgentMove, stagedAgentDir } from '../../src/agents/write-agent.js'
import { RegisterReq, type AgentSpec } from '@agentconnect.md/protocol'

const MOVE_ID = '77777777-7777-4777-8777-777777777777'
const MOVE_ID_2 = '88888888-8888-4888-8888-888888888888'
const MOVE_ID_3 = '99999999-9999-4999-8999-999999999999'
const MOVE_ID_4 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

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

describe('Daemon CP agent → disk + reconcile', () => {
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

  it('writes a CP spec onto the matching file agent.json (merge), keeping file runtime/workspace', async () => {
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
    expect(JSON.parse(readFileSync(join(root, 'agents', 'bot-a', 'agent.json'), 'utf8')).origin).toBe('cp')
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

  it('CREATES a new agent.json for a spec with no on-disk base; remove deletes it', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()

    // A CP spec for an id with no on-disk base now creates a runnable agent.json.
    await seam(daemon).applyAgentUpsert({ agentId: 'ghost', spec: { name: 'ghost' } as AgentSpec })
    expect(existsSync(join(root, 'agents', 'ghost', 'agent.json'))).toBe(true)
    expect((daemon as any).agents.has('ghost')).toBe(true) // runnable, not degraded
    expect((daemon as any).cpDegradedScopes()).not.toContain('ghost')

    // agent/remove deletes the on-disk dir → reconcile drops it from the live set.
    seam(daemon).applyAgentRemove('ghost')
    await daemon.reconcile()
    expect(existsSync(join(root, 'agents', 'ghost'))).toBe(false)
    expect((daemon as any).agents.has('ghost')).toBe(false)
    await daemon.stop()
  })

  it('detach drains/stops, archives the whole root, invalidates git creds, and activate restores + warms it', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    mkdirSync(join(root, 'agents', 'bot-a', 'memory'), { recursive: true })
    writeFileSync(join(root, 'agents', 'bot-a', 'memory', 'keep.md'), 'local-memory')
    const { daemon, hosts } = makeDaemon(root)
    await daemon.start()
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
    expect(
      readFileSync(join(detachedAgentDir(join(root, 'agents'), 'bot-a'), 'agent', 'memory', 'keep.md'), 'utf8')
    ).toBe('local-memory')

    const staleIntegration = {
      integrationId: 'stale-int',
      agentId: 'bot-a',
      platform: 'slack',
      slack: {
        mode: 'direct',
        botToken: 'must-not-return',
        appToken: 'xapp-stale',
        allowedUserIds: [],
        bindRules: []
      }
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
    seam(daemon).applyReconcileSnapshot({
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
    expect(
      readFileSync(join(detachedAgentDir(join(root, 'agents'), 'bot-a'), 'agent', 'agent.json'), 'utf8')
    ).not.toContain('must-not-return')

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

  it('detach waits a pre-pending dispatch lease before archiving and closing its final token', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()

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
        slack: { mode: 'direct', appToken: 'xapp-only', botToken: 'xoxb-only' }
      }
    ]
    ;(daemon as any).connections = [connection]
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
    expect(existsSync(join(root, 'agents', 'bot-a', 'agent.json'))).toBe(true)

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
    ;(daemon as any).mcpServerDefs.remote = { transport: 'http', url: 'https://mcp.invalid' }
    ;(daemon as any).runtimeMcpCaps.set('claude', { http: false, sse: false })
    await expect(
      seam(daemon).applyAgentActivate({
        agentId: 'ghost',
        moveId: MOVE_ID_3,
        spec: { name: 'ghost', runtime: 'claude', mcpServers: ['remote'] },
        integrations: [],
        crons: []
      })
    ).resolves.toEqual({
      ok: false,
      reason: 'agent/activate: MCP server "remote" needs unsupported http transport on runtime "claude"'
    })

    await seam(daemon).applyAgentDetach({ agentId: 'ghost', moveId: MOVE_ID_4 })
    ;(daemon as any).runtimeModels.set('claude', ['supported-model'])
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
    seam(daemon).applyReconcileSnapshot(snap)
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
    expect(existsSync(join(detachedAgentDir(join(root, 'agents'), 'stale-cp'), 'agent', 'agent.json'))).toBe(true)
    expect(existsSync(join(root, 'agents', 'deleted-cp'))).toBe(false)
    expect(existsSync(detachedAgentDir(join(root, 'agents'), 'deleted-cp'))).toBe(false)
    expect((daemon as any).drainingAgents.has('deleted-cp')).toBe(true)
    expect((daemon as any).agents.has('local-only')).toBe(true)
    expect(existsSync(join(root, 'agents', 'local-only', 'agent.json'))).toBe(true)
    await daemon.stop()
  })

  it('revives a reconnect-dropped agent when a later roster re-adds it', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const { daemon } = makeDaemon(root)
    await daemon.start()
    const clearDenied = vi.spyOn((daemon as any).gitCreds, 'clearDenied')

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
        integrations: []
      }
    })
    await daemon.reconcile()
    expect((daemon as any).drainingAgents.has('bot-a')).toBe(true)
    await expect((daemon as any).ensureHostAsync('bot-a')).rejects.toThrow('agent is draining')

    seam(daemon).applyReconcileSnapshot({
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
