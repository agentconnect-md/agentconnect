import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { RemoteWebchatGrantManager } from '../src/mcp/remote-webchat-grant.js'
import type { WebchatOutput, WebchatDone } from '@agentconnect.md/protocol'

/**
 * §13 integration coverage for remote MCP admission: the bearer-bearing
 * descriptor is attached through the REAL webchat dispatch path only when the
 * agent's runtime resolves to a validated adapter id with daemon-owned
 * catalog provenance — never inferred from a user-configured launch line,
 * even one shadowing the canonical id.
 */

const AGENT_ID = 'bot-a'
const CONV = '88888888-8888-4888-8888-888888888888'
const AUTHORITY = '11111111-1111-4111-8111-111111111111'
const GRANT = '33333333-3333-4333-8333-333333333333'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-rmcp-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      // A user-configured runtime that SHADOWS the validated canonical id: the
      // resolver marks it source 'user', which must never receive the bearer.
      runtimes: { 'claude-acp': { command: 'node', args: ['unused'] } }
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
      runtime: 'claude-acp',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

function fakeHost() {
  let onUpdate!: (sid: string, u: unknown) => void
  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-rmcp-1'),
    modelOptions: vi.fn(() => null),
    hasSession: vi.fn(() => true),
    prompt: vi.fn(async (sid: string) => {
      onUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } })
      return { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(async () => {}),
    forgetSession: vi.fn(),
    stop: vi.fn(async () => {})
  }
  const factory = (_agent: unknown, cb: (sid: string, u: unknown) => void) => {
    onUpdate = cb
    return host as never
  }
  return { factory, host }
}

function fakeGrantClient() {
  return {
    issueWebchatMcpGrant: vi.fn(async (input: Record<string, unknown>) => ({
      ...input,
      grantId: GRANT,
      grantRevision: 1,
      token: 'secret-token-that-is-longer-than-thirty-two-bytes',
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      mcpUrl: 'https://cp.example/api/v1/mcp'
    })),
    acceptWebchatMcpGrant: vi.fn(async (input: Record<string, unknown>) => ({ ...input, activated: true })),
    revokeWebchatMcpGrant: vi.fn(async (input: Record<string, unknown>) => ({ ...input, revoked: true }))
  }
}

async function runTurn(source: 'user' | 'registry') {
  const { factory, host } = fakeHost()
  const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
  await daemon.start()
  const client = fakeGrantClient()
  const anyDaemon = daemon as never as Record<string, any>
  anyDaemon.remoteWebchatGrants = new RemoteWebchatGrantManager(client as never)
  anyDaemon.runtimeMcpCaps.set('claude-acp', { http: true, sse: false })
  // The gate must read daemon-owned catalog provenance, not the launch line.
  anyDaemon.runtimeCatalog.entries['claude-acp'].source = source

  const outputs: WebchatOutput[] = []
  const dones: WebchatDone[] = []
  const turnId = '77777777-7777-4777-8777-777777777777'
  const msg = {
    msgId: `webchat:${CONV}:${turnId}`,
    traceId: turnId,
    source: 'user' as const,
    platform: 'webchat' as const,
    channel: CONV,
    sender: { id: 'alice', isBot: false },
    text: 'go',
    mentionedBots: [] as string[],
    isDm: true,
    trigger: 'dm' as const
  }
  await anyDaemon.dispatch(AGENT_ID, msg, undefined, {
    conversationId: CONV,
    turnId,
    sink: { output: (o: WebchatOutput) => outputs.push(o), done: (d: WebchatDone) => dones.push(d) },
    remoteMcp: {
      authorityId: AUTHORITY,
      authorityGeneration: 1,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString()
    }
  })
  await daemon.stop().catch(() => {})
  return { client, host, dones }
}

describe('remote MCP admission through the webchat dispatch path (§13)', () => {
  it('refuses the bearer for a user-configured runtime shadowing the validated id', async () => {
    const { client, host, dones } = await runTurn('user')
    expect(dones.length).toBe(1)
    expect(client.issueWebchatMcpGrant).not.toHaveBeenCalled()
    const mcpServers = (host.newSession.mock.calls[0]?.[1] ?? []) as Array<{ name?: string }>
    expect(mcpServers.some((s) => s?.name === 'agentconnect-admin')).toBe(false)
  }, 20_000)

  it('attaches the session-scoped descriptor only under daemon-owned registry provenance', async () => {
    const { client, host, dones } = await runTurn('registry')
    expect(dones.length).toBe(1)
    expect(client.issueWebchatMcpGrant).toHaveBeenCalledTimes(1)
    expect(client.acceptWebchatMcpGrant).toHaveBeenCalledTimes(1)
    const mcpServers = (host.newSession.mock.calls[0]?.[1] ?? []) as Array<{
      name?: string
      headers?: Array<{ name: string; value: string }>
    }>
    const descriptor = mcpServers.find((s) => s?.name === 'agentconnect-admin')
    expect(descriptor).toBeDefined()
    expect(descriptor?.headers?.[0]?.name).toBe('Authorization')
    // The descriptor rides ACP session configuration for the exact webchat
    // session — never prompt text (the fake host records the prompt input).
    const promptArgs = JSON.stringify(host.prompt.mock.calls)
    expect(promptArgs).not.toContain('secret-token-that-is-longer-than-thirty-two-bytes')
  }, 20_000)
})
