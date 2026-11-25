import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { MCP_TOOL_APPROVAL_V1_FEATURE, type AgentSpec } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { agentHostKey } from '../src/acp/host-key.js'
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
    expect(d.mcpGrantRoutedHosts.has(agentHostKey(AGENT))).toBe(true)
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

  it('keeps the provider off a session whose shim carries no mcp-grant route', async () => {
    const { d } = await restrictedAgent()
    d.sessionStrategies.set('session-vm', 'microsandbox')
    const granted = d.sessionMcpGrant(d.agents.get(AGENT), 'session-vm', 'probe', d.mcpDefsForAgent(AGENT).probe)
    expect(granted).toEqual({ refused: expect.stringContaining("its VM's shim does not carry the mcp-grant route") })
  })

  it('without its credential proxy advertises no approvals, so it is sent a runtime-custody grant instead', async () => {
    const { d } = await restrictedAgent(true)
    expect(d.credentialProxy).toBeUndefined()
    expect(d.registrationFeatures()).not.toContain(MCP_TOOL_APPROVAL_V1_FEATURE)
    expect(d.sessionMcpGrant(d.agents.get(AGENT), 'session-1', 'probe', DEF)).toBeUndefined()
  })
})
