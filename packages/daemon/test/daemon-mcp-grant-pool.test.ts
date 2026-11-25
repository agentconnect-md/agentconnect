import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { agentHostKey, sessionHostKey } from '../src/acp/host-key.js'
import { coordinatorCoordinate } from '../src/session/append-coordinate.js'
import type { ResolvedRuntimeCatalog } from '../src/runtimes/registry.js'
import { LocalStore } from '../src/store/local-store.js'

// A pool daemon with key-server model sessions attaches a restricted MCP server on each session's own host (mcp-tool-permissions.md §7.2, §8).

const AGENT = 'bot-a'
const KEY = 'mcpg_pool_session_key'
const DEF = {
  transport: 'http' as const,
  url: 'https://relay.example.test/mcp/00000000-0000-4000-8000-000000000001',
  headers: [{ name: 'Authorization', value: `Bearer ${KEY}` }],
  args: [],
  env: []
}
const DECISIONS = { allow: [], approval: ['read_wiki', 'ask_question', 'read_structure'], ask: [], block: [] }

const dirs: string[] = []
const daemons: Daemon[] = []
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => undefined)
})
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function catalog(): ResolvedRuntimeCatalog {
  const absent = { command: 'claude-agent-acp', args: [], env: [] }
  return {
    entries: {
      claude: { runtime: absent, source: 'registry', name: 'Claude Code', version: '1.0.0', skillsAgentId: 'claude' }
    },
    runtimes: { claude: absent }
  }
}

async function poolDaemon(): Promise<{ d: any; built: any[] }> {
  const root = mkdtempSync(join(tmpdir(), 'ac-mcpg-pool-'))
  dirs.push(root)
  writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 1, controlPlane: { enabled: false } }))
  writeFileSync(join(root, 'k8s-runtimes.json'), JSON.stringify({ runtimes: [{ id: 'claude' }] }))
  let keys = 0
  const daemon = new Daemon({
    root,
    k8s: true,
    keyServerClient: {
      issue: vi.fn(async () => ({ keyId: `key-${++keys}`, key: `model-key-${keys}`, requestedAtMs: Date.now() })),
      revoke: vi.fn(async () => {})
    } as never,
    openDataPlane: async () =>
      ({
        store: await LocalStore.open(':memory:'),
        transcripts: {},
        close: async () => {}
      }) as never,
    startK8sPlane: async () =>
      ({
        driver: { claimName: (id: string) => `agent-${id}` },
        memberId: 'member-under-test',
        runtimeImage: async () => 'runtime-sandbox:test',
        listener: { listeningPort: () => 0 },
        workspacesOffDisk: true,
        gitRunnerFor: () => undefined,
        launched: () => [],
        adoptUntracked: async () => [],
        armedIn: async () => false,
        suspendIdle: async () => 'absent',
        suspendStalled: async () => 'absent',
        discardAgent: async () => {},
        spawnFor: () => ({}),
        sandboxBound: () => false,
        stop: async () => {}
      }) as never,
    startControlPlane: vi.fn(() => Promise.resolve()) as never,
    resolveCatalog: async () => catalog()
  })
  daemons.push(daemon)
  await daemon.start()
  const d = daemon as any
  expect(d.modelSessions.enabled).toBe(true)
  d.agents.set(AGENT, {
    id: AGENT,
    name: AGENT,
    status: 'active',
    runtime: 'claude',
    integrations: [],
    mcpServers: ['deepwiki'],
    dir: join(root, 'agents', AGENT),
    workspace: { mode: 'scratch', path: '/agent' },
    output: { mode: 'medium' }
  })
  d.orgForAgent = () => 'org-a'
  d.cpAgents = { orgForAgent: () => 'org-a' }
  // The pod's preparation is the plane's suite; these launches start where a pool session does.
  d.prepareAgentWorkspace = async () => '/agent'
  d.coordinatorDir = async () => '/agent/.agentconnect/coordinator'
  // Each launch is the real one; its runtime never spawns.
  const built: any[] = []
  const build = d.buildAcpHost.bind(d)
  d.buildAcpHost = (...args: unknown[]) => {
    const result = build(...args)
    result.host.start = async () => {}
    result.host.stop = async () => {}
    built.push(result.host)
    return result
  }
  return { d, built }
}

/** The servers a session's `session/new` would carry. */
function sessionServers(d: any, sessionKey: string, thread: string): any[] {
  return d.sessions.deps
    .toolContextFor({
      agent: d.agents.get(AGENT),
      platform: 'slack',
      channel: 'C1',
      thread,
      deliveryThread: thread,
      integrationId: 'integration-a',
      isDm: false,
      sessionKey
    })
    .mcpServers()
}

describe('a pool daemon with key-server model sessions and a restricted MCP grant', () => {
  it('attaches the server on a coordinator’s and a task’s own host once its pod shim reports the route', async () => {
    const { d, built } = await poolDaemon()
    d.cpMcpDefs.upsert('org-a', 'deepwiki', DEF, Date.now(), AGENT, DECISIONS)
    const coordinatorThread = coordinatorCoordinate(1_700_000_000_000)
    const sessions = [
      { key: `slack:C1:${coordinatorThread}:${AGENT}`, thread: coordinatorThread, model: 'claude-sonnet-4-5' },
      { key: `slack:C1:1700000000.000200:${AGENT}`, thread: '1700000000.000200', model: 'claude-opus-4-1' }
    ]
    for (const session of sessions) {
      await d.modelSessions.ensure(d.agents.get(AGENT), session.key, session.model)
      const host = built.at(-1)
      expect(JSON.stringify(host.opts.env)).not.toContain(KEY)
      // A host the pool started for this session alone is the one its route is recorded for.
      expect(d.hostKeyFor(AGENT, session.key)).toBe(agentHostKey(AGENT))
      expect(d.sessionOwnerKey(AGENT, session.key)).toBe(sessionHostKey(AGENT, session.key))
      host.opts.mcpGrant.routed('routed')
      const warn = vi.spyOn(d.log, 'warn')
      const servers = sessionServers(d, session.key, session.thread)
      const attached = servers.find((server) => server.name === 'deepwiki')
      expect(attached).toBeDefined()
      expect(JSON.stringify(attached)).not.toContain(KEY)
      expect(attached.headers[0].value).toMatch(/^Bearer acph1_/)
      expect(warn.mock.calls.flat().join('\n')).not.toContain('is not attached')
      warn.mockRestore()
    }
  })

  it('respawns, once idle, the pod hosts launched before the grant, and attaches the server on their successors', async () => {
    const { d, built } = await poolDaemon()
    const agent = d.agents.get(AGENT)
    const coordinatorThread = coordinatorCoordinate(1_700_000_000_000)
    const coordinator = `slack:C1:${coordinatorThread}:${AGENT}`
    const task = `slack:C1:1700000000.000200:${AGENT}`
    await d.modelSessions.ensure(agent, coordinator, 'claude-sonnet-4-5')
    await d.modelSessions.ensure(agent, task, 'claude-opus-4-1')
    const { host: podHost } = d.buildAcpHost(agent, d.cfg, {
      hostKey: agentHostKey(AGENT),
      strategy: 'host',
      cwd: '/agent'
    })
    d.hosts.set(agentHostKey(AGENT), podHost)
    d.hostStartedAt.set(agentHostKey(AGENT), d.clock.now())
    for (const key of [agentHostKey(AGENT), sessionHostKey(AGENT, coordinator), sessionHostKey(AGENT, task)])
      expect(d.mcpGrantHostRoutes.get(key)).toEqual({ refusal: expect.stringMatching(/restarts$/), relays: [] })
    const stopped: string[] = []
    d.stopHostByKey = async (key: string) => {
      stopped.push(key)
      d.hosts.delete(key)
    }
    const release = vi.spyOn(d.modelSessions, 'release')
    const interrupt = vi.spyOn(d, 'interruptTurn')
    // The task's dispatch is in flight; the coordinator and the agent's pod host are idle.
    d.activeDispatchDoneByKey.set(task, Promise.resolve())
    d.cpMcpDefs.upsert('org-a', 'deepwiki', DEF, Date.now(), AGENT, DECISIONS)
    d.onMcpDefsChanged()
    await d.sweepIdle()
    expect(release.mock.calls.map(([key]) => key)).toEqual([coordinator])
    expect(stopped).toEqual([agentHostKey(AGENT)])
    expect(d.modelSessions.hostForSessionKey(task)).toBeDefined()
    d.activeDispatchDoneByKey.delete(task)
    await d.sweepIdle()
    expect(release.mock.calls.map(([key]) => key)).toEqual([coordinator, task])
    expect(interrupt).not.toHaveBeenCalled()
    // Each successor launches with the route, and attaches the server once its shim reports it.
    for (const [key, thread, model] of [
      [coordinator, coordinatorThread, 'claude-sonnet-4-5'],
      [task, '1700000000.000200', 'claude-opus-4-1']
    ] as const) {
      await d.modelSessions.ensure(agent, key, model)
      expect(d.mcpGrantHostRoutes.get(sessionHostKey(AGENT, key))?.relays).toEqual(['relay.example.test'])
      built.at(-1).opts.mcpGrant.routed('routed')
      expect(sessionServers(d, key, thread).map((server) => server.name)).toContain('deepwiki')
    }
  })
})
