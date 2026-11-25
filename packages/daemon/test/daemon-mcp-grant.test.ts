import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
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

async function restrictedAgent(blockProxy = false): Promise<{ d: any; root: string }> {
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
  d.cpMcpDefs.upsert(ORG, 'probe', DEF, Date.now(), AGENT, DECISIONS)
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
    expect(d.mcpGrantHostRoutes.get(agentHostKey(AGENT))).toEqual({ refusal: undefined })
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
      expect(d.mcpGrantHostRoutes.get(hostKey)).toEqual({ refusal: undefined })
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
})
