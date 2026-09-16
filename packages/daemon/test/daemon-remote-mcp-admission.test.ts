import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebchatDone, WebchatOutput } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { RemoteWebchatGrantManager } from '../src/mcp/remote-webchat-grant.js'

/**
 * Integration coverage for preset admin-MCP delivery through the real webchat
 * dispatch path. Runtime identity, launch provenance, ACP probe results, and OS
 * sandbox policy are deliberately absent from admission: the executable is
 * already inside the configured runtime boundary. The trusted preset marker and
 * CP-issued conversation entitlement are the only local attachment conditions.
 */

const AGENT_ID = 'bot-a'
const CONV = '88888888-8888-4888-8888-888888888888'
const AUTHORITY = '11111111-1111-4111-8111-111111111111'
const GRANT = '33333333-3333-4333-8333-333333333333'
const TOKEN = 'secret-token-that-is-longer-than-thirty-two-bytes'

it('does not revive a conversation-granted admin card through the organization provider host', async () => {
  const daemon = Object.create(Daemon.prototype) as any
  daemon.store = {
    getAppCard: vi.fn(async () => ({
      channel: CONV,
      thread: CONV,
      ts: '100',
      sender: AGENT_ID,
      body: JSON.stringify({
        appId: 'native-app',
        conversationId: CONV,
        server: 'agentconnect-admin',
        toolName: 'agentconnect-admin__configureIntegration',
        title: 'Configure integration'
      })
    }))
  }
  daemon.orgForAgent = vi.fn()
  expect(await daemon.reviveAppCard('native-app', CONV, {})).toBeUndefined()
  expect(daemon.orgForAgent).not.toHaveBeenCalled()
})

function scaffold(opts: { builtin: boolean; runInSandbox: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-rmcp-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      // An arbitrary user-defined ACP runtime proves descriptor delivery is not
      // inferred from a canonical id, package, version, provenance, or probe.
      runtimes: { 'arbitrary-acp': { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', AGENT_ID)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT_ID,
      name: AGENT_ID,
      status: 'active',
      runtime: 'arbitrary-acp',
      builtin: opts.builtin,
      runInSandbox: opts.runInSandbox,
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

function fakeHost(rejectAdminDescriptor = false, toolUpdates: unknown[] = []) {
  let onUpdate!: (sid: string, update: unknown) => void
  const selectedAgents: Array<{ builtin: boolean; runInSandbox: boolean; runtime: string }> = []
  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async (_cwd: string, mcpServers: Array<{ name?: string }>) => {
      if (rejectAdminDescriptor && mcpServers.some((server) => server.name === 'agentconnect-admin')) {
        throw new Error('runtime rejected HTTP MCP descriptor')
      }
      return 'acp-rmcp-1'
    }),
    modelOptions: vi.fn(() => null),
    hasSession: vi.fn(() => true),
    prompt: vi.fn(async (sid: string) => {
      for (const update of toolUpdates) await onUpdate(sid, update)
      onUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } })
      return { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(async () => {}),
    forgetSession: vi.fn(),
    stop: vi.fn(async () => {})
  }
  const factory = (
    agent: { builtin: boolean; runInSandbox: boolean; runtime: string },
    callback: (sid: string, update: unknown) => void
  ) => {
    selectedAgents.push(agent)
    onUpdate = callback
    return host as never
  }
  return { factory, host, selectedAgents }
}

function fakeGrantClient() {
  return {
    issueWebchatMcpGrant: vi.fn(async (input: Record<string, unknown>) => ({
      ...input,
      grantId: GRANT,
      grantRevision: 1,
      token: TOKEN,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      mcpUrl: 'https://cp.example/api/v1/mcp'
    })),
    acceptWebchatMcpGrant: vi.fn(async (input: Record<string, unknown>) => ({ ...input, activated: true })),
    revokeWebchatMcpGrant: vi.fn(async (input: Record<string, unknown>) => ({ ...input, revoked: true }))
  }
}

async function runTurn(opts: {
  builtin: boolean
  runInSandbox: boolean
  rejectAdminDescriptor?: boolean
  toolUpdates?: unknown[]
}) {
  const { factory, host, selectedAgents } = fakeHost(opts.rejectAdminDescriptor, opts.toolUpdates)
  const daemon = new Daemon({ root: scaffold(opts), hostFactory: factory as never })
  await daemon.start()
  const client = fakeGrantClient()
  const anyDaemon = daemon as never as Record<string, any>
  anyDaemon.remoteWebchatGrants = new RemoteWebchatGrantManager(client as never)

  const outputs: WebchatOutput[] = []
  const dones: WebchatDone[] = []
  const turnId = '77777777-7777-4777-8777-777777777777'
  await anyDaemon.dispatch(
    AGENT_ID,
    {
      msgId: `webchat:${CONV}:${turnId}`,
      traceId: turnId,
      source: 'user',
      platform: 'webchat',
      channel: CONV,
      sender: { id: 'alice', isBot: false },
      text: 'go',
      mentionedBots: [],
      isDm: true,
      trigger: 'dm'
    },
    undefined,
    {
      conversationId: CONV,
      turnId,
      sink: { output: (output: WebchatOutput) => outputs.push(output), done: (done: WebchatDone) => dones.push(done) },
      remoteMcp: {
        authorityId: AUTHORITY,
        authorityGeneration: 1,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString()
      }
    }
  )
  await daemon.stop().catch(() => {})
  return { client, host, selectedAgents, dones, outputs }
}

function adminDescriptor(host: ReturnType<typeof fakeHost>['host']) {
  const mcpServers = (host.newSession.mock.calls[0]?.[1] ?? []) as Array<{
    name?: string
    headers?: Array<{ name: string; value: string }>
  }>
  return mcpServers.find((server) => server.name === 'agentconnect-admin')
}

describe('preset admin MCP through the webchat dispatch path', () => {
  it('projects a direct HTTP tool result into one native card without proxying the admin call', async () => {
    const nativeUi = {
      resourceUri: 'ui://agentconnect/integration-setup',
      resourceVersion: 1,
      orgId: AUTHORITY,
      intent: { mode: 'create', provider: 'github' }
    }
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'direct-http-call',
      status: 'completed',
      rawInput: { server: 'agentconnect-admin', tool: 'configureIntegration', arguments: nativeUi.intent },
      rawOutput: { result: { structuredContent: nativeUi }, error: null }
    }
    const { host, outputs } = await runTurn({ builtin: true, runInSandbox: true, toolUpdates: [update, update] })
    expect(adminDescriptor(host)).toMatchObject({ type: 'http', url: 'https://cp.example/api/v1/mcp' })
    const cards = outputs.filter((output) => output.event?.kind === 'app')
    expect(cards).toHaveLength(1)
    expect(cards[0]?.event).toMatchObject({ nativeUi })
  })
  it.each([
    ['without an OS sandbox', false],
    ['with an OS sandbox', true]
  ] as const)('attaches to an arbitrary preset runtime %s', async (_label, runInSandbox) => {
    const { client, host, selectedAgents, dones } = await runTurn({ builtin: true, runInSandbox })

    expect(dones).toHaveLength(1)
    expect(selectedAgents[0]).toMatchObject({
      builtin: true,
      runInSandbox,
      runtime: 'arbitrary-acp'
    })
    expect(client.issueWebchatMcpGrant).toHaveBeenCalledTimes(1)
    expect(client.acceptWebchatMcpGrant).toHaveBeenCalledTimes(1)
    expect(adminDescriptor(host)?.headers).toEqual([{ name: 'Authorization', value: `Bearer ${TOKEN}` }])
    // The credential is ACP session configuration, never model prompt text.
    expect(JSON.stringify(host.prompt.mock.calls)).not.toContain(TOKEN)
  })

  it('does not attach when a non-preset agent is handed a forged entitlement', async () => {
    const { client, host, dones } = await runTurn({ builtin: false, runInSandbox: false })

    expect(dones).toHaveLength(1)
    expect(client.issueWebchatMcpGrant).not.toHaveBeenCalled()
    expect(adminDescriptor(host)).toBeUndefined()
  })

  it('keeps ordinary preset webchat running when the runtime rejects the admin descriptor', async () => {
    const { client, host, dones } = await runTurn({
      builtin: true,
      runInSandbox: true,
      rejectAdminDescriptor: true
    })

    expect(dones).toHaveLength(1)
    expect(client.issueWebchatMcpGrant).toHaveBeenCalledTimes(1)
    expect(host.newSession).toHaveBeenCalledTimes(2)
    expect(
      ((host.newSession.mock.calls[0]?.[1] ?? []) as Array<{ name?: string }>).some(
        (server) => server.name === 'agentconnect-admin'
      )
    ).toBe(true)
    const fallbackServers = (host.newSession.mock.calls[1]?.[1] ?? []) as Array<{ name?: string }>
    expect(fallbackServers.some((server) => server.name === 'agentconnect')).toBe(true)
    expect(fallbackServers.some((server) => server.name === 'agentconnect-admin')).toBe(false)
    expect(host.prompt).toHaveBeenCalledTimes(1)
  })
})
