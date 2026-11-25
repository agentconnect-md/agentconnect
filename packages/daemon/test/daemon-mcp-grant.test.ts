import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { MCP_TOOL_APPROVAL_V1_FEATURE, type AgentSpec } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { agentHostKey, sessionHostKey } from '../src/acp/host-key.js'
import { openPlaceholder, loadPlaceholderKey } from '../src/credential-proxy/placeholder.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

// A real daemon hands a restricted agent's sessions a placeholder for its `daemon`-custody MCP grant (mcp-tool-permissions.md §7.2, §8).

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORG = 'org-a'
const KEY = 'mcpg_daemon_custody_key'
const DEF = {
  transport: 'http' as const,
  url: 'https://relay.example.test/mcp/00000000-0000-4000-8000-000000000001',
  headers: [{ name: 'Authorization', value: `Bearer ${KEY}` }],
  args: [],
  env: []
}
const DECISIONS = { allow: ['read_note'], approval: ['write_note'], ask: [], block: [] }

const dirs: string[] = []
const daemons: Daemon[] = []
const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy }
delete process.env.HTTPS_PROXY
delete process.env.https_proxy
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => undefined)
})
afterAll(() => {
  for (const [name, value] of Object.entries(saved)) if (value !== undefined) process.env[name] = value
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

async function restrictedAgent(blockProxy = false, grant = true): Promise<{ d: any; root: string }> {
  const root = realpathSync(mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'acmg-')))
  dirs.push(root)
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: [] } }
    })
  )
  if (blockProxy) writeFileSync(join(root, 'credential-proxy'), 'not a directory')
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, probeRuntimes: async () => [] })
  daemons.push(daemon)
  await daemon.start()
  const d = daemon as any
  d.orgForAgent = () => ORG
  const spec = {
    name: 'restricted',
    runtime: 'claude',
    mcpServers: ['probe'],
    workspace: { mode: 'scratch', isolation: 'shared', additionalRepos: [] }
  } as unknown as AgentSpec
  expect(await d.cpConfigApply().applyAgentUpsert({ agentId: AGENT, spec })).toEqual({ ok: true })
  if (grant) d.cpMcpDefs.upsert(ORG, 'probe', DEF, Date.now(), AGENT, DECISIONS)
  return { d, root }
}

describe('a daemon holding a daemon-custody MCP grant', () => {
  it('advertises approvals, routes a host session through the proxy, and hands it a placeholder, never the key', async () => {
    const { d, root } = await restrictedAgent()
    expect(d.registrationFeatures()).toContain(MCP_TOOL_APPROVAL_V1_FEATURE)
    const host = d.ensureHost(agentHostKey(AGENT), d.cfg)
    const env = host.opts.env as Record<string, string>
    expect(env.HTTPS_PROXY).toBe(d.credentialProxy.proxy.loopbackUrl())
    expect(env.NO_PROXY?.split(',')).not.toContain('relay.example.test')
    expect(JSON.stringify(env)).not.toContain(KEY)
    expect(d.mcpGrantHostRoutes.get(agentHostKey(AGENT))).toEqual({
      refusal: undefined,
      relays: ['relay.example.test']
    })
    const agent = d.agents.get(AGENT)
    const granted = d.sessionMcpGrant(agent, 'session-1', 'probe', d.mcpDefsForAgent(AGENT).probe)
    expect(JSON.stringify(granted)).not.toContain(KEY)
    const placeholder = granted.headers[0].value.replace(/^Bearer /, '')
    expect(openPlaceholder(loadPlaceholderKey(join(root, 'credential-proxy', 'placeholder.key')), placeholder)).toEqual(
      {
        agentId: AGENT,
        hosts: ['relay.example.test'],
        kind: 'mcp-grant',
        mcpProvider: 'probe',
        session: 'session-1'
      }
    )
  })

  it('hands a VM session the placeholder, and keeps the provider off an srt session placed on an executor', async () => {
    const { d } = await restrictedAgent()
    d.sessionStrategies.set('session-vm', 'microsandbox')
    const vm = d.sessionMcpGrant(d.agents.get(AGENT), 'session-vm', 'probe', d.mcpDefsForAgent(AGENT).probe)
    expect(vm.headers[0].value).toMatch(/^Bearer acph1_/)
    const realPlane = d.executorPlane
    try {
      d.executorPlane = {
        placementOf: (key: string) =>
          key === 'session-srt' ? { strategy: 'srt', executorDaemonId: 'executor-example' } : undefined
      }
      const srt = d.sessionMcpGrant(d.agents.get(AGENT), 'session-srt', 'probe', d.mcpDefsForAgent(AGENT).probe)
      expect(srt).toEqual({ refused: expect.stringContaining('the srt shim of daemon executor-example') })
    } finally {
      d.executorPlane = realPlane
    }
  })

  it('routes an executor-placed host session through its shim’s mcp-grant tunnel, attached only once that shim reports it', async () => {
    const { d, root } = await restrictedAgent()
    const agent = d.agents.get(AGENT)
    const sessionKey = 'slack:T1:C1:1700000000.000100'
    const placed = {
      agentId: AGENT,
      sessionKey,
      leaf: 'leaf-example',
      subject: `${AGENT}/session-example`,
      executorDaemonId: 'executor-example',
      strategy: 'host'
    }
    const realPlane = d.executorPlane
    try {
      d.executorPlane = {
        placementOf: (key: string) => (key === sessionKey ? placed : undefined),
        homeFor: () => '/home/agent/executor-home',
        rootsFor: () => ({ runtimeRoot: '/home/agent/executor-run', missingHelpers: [] }),
        codexStateFor: () => undefined,
        runtimeDefFor: () => undefined,
        codehostProxyFor: () => undefined,
        spawnFor: () => ({})
      }
      const hostKey = sessionHostKey(AGENT, sessionKey)
      const { host } = d.buildAcpHost(agent, d.cfg, { hostKey, strategy: 'host', cwd: agent.workspace.path })
      // The launch holds no route until its shim answers; the spawn applies it and reports back.
      expect(host.opts.env.HTTPS_PROXY).toBeUndefined()
      expect(JSON.stringify(host.opts.env)).not.toContain(KEY)
      expect(host.opts.mcpGrant.noProxy.split(',')).not.toContain('relay.example.test')
      expect(d.mcpGrantHostRoutes.get(hostKey)?.refusal).toContain('the host shim of daemon executor-example')
      host.opts.mcpGrant.routed('unserved')
      expect(d.mcpGrantHostRoutes.get(hostKey)?.refusal).toBe(
        'the host shim of daemon executor-example does not carry the mcp-grant route; upgrade that shim to use this provider'
      )
      host.opts.mcpGrant.routed('routed')
      expect(d.mcpGrantHostRoutes.get(hostKey)).toEqual({ refusal: undefined, relays: ['relay.example.test'] })
      // Its shim is asked for the tunnel to the agent's own mcp-grant socket; an srt session's is not.
      expect(d.tunnelsForPlaced(AGENT, placed)).toContain('mcp-grant')
      expect(d.tunnelsForPlaced(AGENT, { ...placed, strategy: 'microsandbox' })).toContain('mcp-grant')
      expect(d.tunnelsForPlaced(AGENT, { ...placed, strategy: 'srt' })).not.toContain('mcp-grant')
      expect(d.tunnelListenOptions(AGENT, 'mcp-grant')).toEqual({
        routes: ['relay.example.test:443'],
        ca: d.credentialProxy.ca.certPem
      })
      expect(d.tunnelSocketPath(root, 'mcp-grant', AGENT)).toBe(d.credentialProxy.proxy.mcpGrantTunnelSocketFor(AGENT))
    } finally {
      d.executorPlane = realPlane
    }
  })

  it('without its credential proxy advertises no approvals, so it is sent a runtime-custody grant instead', async () => {
    const { d } = await restrictedAgent(true)
    expect(d.credentialProxy).toBeUndefined()
    expect(d.registrationFeatures()).not.toContain(MCP_TOOL_APPROVAL_V1_FEATURE)
    expect(d.sessionMcpGrant(d.agents.get(AGENT), 'session-1', 'probe', DEF)).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')(
    'respawns, once idle, each host, srt, VM and executor host launched before the grant, never cutting a turn',
    async () => {
      const { d } = await restrictedAgent(false, false)
      const agent = d.agents.get(AGENT)
      // A local srt and VM launch need a mechanism and a VM manager this test host may lack; their launches are what is asserted.
      d.assertStrategyRunnable = () => undefined
      d.sandboxMechanism = 'bwrap'
      d.microsandboxFailure = undefined
      d.microsandbox = { driverFor: () => ({}), environment: () => undefined, suspendIdle: async () => {} }
      d.microsandboxCatalog = d.runtimeCatalog
      d.microsandboxTable = { mcpBridge: { command: 'node', args: ['/image/mcp-bridge.js'] } }
      const placed = (strategy: string, sessionKey: string) => ({
        agentId: AGENT,
        sessionKey,
        leaf: `leaf-${strategy}`,
        subject: `${AGENT}/session-${strategy}`,
        executorDaemonId: 'executor-example',
        strategy
      })
      const placements = new Map([
        ['slack:T1:C1:1700000000.000401', placed('host', 'slack:T1:C1:1700000000.000401')],
        ['slack:T1:C1:1700000000.000402', placed('microsandbox', 'slack:T1:C1:1700000000.000402')]
      ])
      Object.assign(d.executorPlane, {
        placementOf: (key: string) => placements.get(key),
        homeFor: () => '/home/agent/executor-home',
        rootsFor: () => ({ runtimeRoot: '/home/agent/executor-run', missingHelpers: [] }),
        codexStateFor: () => undefined,
        runtimeDefFor: () => undefined,
        codehostProxyFor: () => undefined,
        spawnFor: () => ({})
      })
      // Neither the launches nor the held work ran, so none is left for the daemon's stop to wait on.
      try {
        const launches = [
          { hostKey: agentHostKey(AGENT), strategy: 'host' },
          { hostKey: sessionHostKey(AGENT, 'slack:T1:C1:1700000000.000300'), strategy: 'srt' },
          { hostKey: sessionHostKey(AGENT, 'slack:T1:C1:1700000000.000301'), strategy: 'microsandbox' },
          { hostKey: sessionHostKey(AGENT, 'slack:T1:C1:1700000000.000401'), strategy: 'host' },
          { hostKey: sessionHostKey(AGENT, 'slack:T1:C1:1700000000.000402'), strategy: 'microsandbox' }
        ]
        for (const launch of launches) {
          const { host } = d.buildAcpHost(agent, d.cfg, { ...launch, cwd: agent.workspace.path })
          d.hosts.set(launch.hostKey, host)
          d.hostStartedAt.set(launch.hostKey, d.clock.now())
          expect(d.mcpGrantHostRoutes.get(launch.hostKey)).toEqual({
            refusal: expect.stringMatching(/restarts$/),
            relays: []
          })
        }
        const stopped: string[] = []
        d.stopHostByKey = async (key: string) => {
          stopped.push(key)
          d.hosts.delete(key)
        }
        const interrupt = vi.spyOn(d, 'interruptTurn')
        // Every host was just launched, so only a missing route makes the sweep reclaim one.
        await d.sweepIdle()
        expect(stopped).toEqual([])
        // The shared host serves a dispatch, the srt session admits a message, and the VM runs background work past the lifetime ceiling.
        const srtKey = 'slack:T1:C1:1700000000.000300'
        const vmHost = launches[2]!.hostKey
        d.activeDispatchesByAgent.set(AGENT, new Set([Promise.resolve()]))
        d.inflight.add(srtKey)
        d.cfg.limits.agentMaxLifetimeMs = 0
        d.hostStartedAt.set(vmHost, d.clock.now() - 1)
        let background = true
        const liveSdkWork = d.hostHasLiveSdkWork.bind(d)
        d.hostHasLiveSdkWork = (key: string) => (key === vmHost && background) || liveSdkWork(key)
        d.cpMcpDefs.upsert(ORG, 'probe', DEF, Date.now(), AGENT, DECISIONS)
        d.onMcpDefsChanged()
        await d.sweepIdle()
        expect(stopped.sort()).toEqual(
          launches
            .slice(3)
            .map((launch) => launch.hostKey)
            .sort()
        )
        d.activeDispatchesByAgent.delete(AGENT)
        d.inflight.delete(srtKey)
        background = false
        await d.sweepIdle()
        expect(stopped).toEqual(expect.arrayContaining([agentHostKey(AGENT), sessionHostKey(AGENT, srtKey), vmHost]))
        expect(interrupt).not.toHaveBeenCalled()
        // A launch holding the grant's route is left alone.
        const { host } = d.buildAcpHost(agent, d.cfg, { ...launches[0], cwd: agent.workspace.path })
        d.hosts.set(agentHostKey(AGENT), host)
        d.hostStartedAt.set(agentHostKey(AGENT), d.clock.now())
        expect(d.mcpGrantHostRoutes.get(agentHostKey(AGENT))).toEqual({
          refusal: undefined,
          relays: ['relay.example.test']
        })
        d.onMcpDefsChanged()
        stopped.length = 0
        await d.sweepIdle()
        expect(stopped).toEqual([])
      } finally {
        d.hosts.clear()
        d.activeDispatchesByAgent.clear()
        d.inflight.clear()
      }
    }
  )
})
