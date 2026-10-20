import { describe, expect, it, vi } from 'vitest'
import type { ComputerChannelGrantResult } from '@agentconnect.md/protocol'
import { ComputerChannel, ComputerChannelError } from '../../src/computer/data-plane.js'

const COMPUTER = '00000000-0000-4000-8000-000000000001'
const AGENT = '00000000-0000-4000-8000-0000000000bb'
const R1 = { relayId: '11111111-1111-4111-8111-111111111111', url: 'wss://relay-1.example.com/rd/ws' }
const R2 = { relayId: '22222222-2222-4222-8222-222222222222', url: 'wss://relay-2.example.com/rd/ws' }
const T0 = 1_760_000_000_000

const granted = (token: string, expiresInMs = 120_000): ComputerChannelGrantResult => ({
  granted: true,
  token,
  expiresAt: new Date(T0 + expiresInMs).toISOString(),
  mode: 'control',
  relays: [R1, R2]
})

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup(responses: Array<(url: string, init: RequestInit) => Response | Promise<Response>>) {
  let now = T0
  let n = 0
  const grants = { computerChannelGrant: vi.fn(async () => granted(`token-${++n}`)) }
  const calls: Array<{ url: string; auth: string | null }> = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') })
    const next = responses.shift()
    if (!next) throw new Error('unexpected request')
    return next(String(url), init ?? {})
  })
  const channel = new ComputerChannel({
    grants,
    target: { computerId: COMPUTER, agentId: AGENT, sessionId: 'sess-1', orgId: 'org_1' },
    fetch: fetchImpl as unknown as typeof fetch,
    now: () => now
  })
  return { channel, grants, calls, advance: (ms: number) => (now += ms) }
}

const post = (channel: ComputerChannel) => channel.fetch('http://ignored/mcp', { method: 'POST', body: '{}' })

describe('ComputerChannel', () => {
  it("sends with the session's token to a relay that has the Computer, and prefers it next time", async () => {
    const { channel, grants, calls } = setup([
      () => json(503, { error: 'computer_not_attached' }),
      () => json(200, { ok: 1 }),
      () => json(200, { ok: 2 })
    ])
    expect((await post(channel)).status).toBe(200)
    expect(calls.map((c) => c.url)).toEqual([
      `https://relay-1.example.com/cr/computers/${COMPUTER}/mcp`,
      `https://relay-2.example.com/cr/computers/${COMPUTER}/mcp`
    ])
    expect(calls[0]?.auth).toBe('Bearer token-1')
    await post(channel)
    expect(calls[2]?.url).toContain('relay-2')
    expect(grants.computerChannelGrant).toHaveBeenCalledTimes(1)
    expect(grants.computerChannelGrant).toHaveBeenCalledWith(
      { computerId: COMPUTER, agentId: AGENT, sessionId: 'sess-1' },
      'org_1'
    )
  })

  it('renews the token before it lapses and once when the desktop refuses it', async () => {
    const { channel, grants, calls, advance } = setup([
      () => json(200, {}),
      () => json(401, { error: 'unauthorized' }),
      () => json(200, {})
    ])
    await post(channel)
    advance(100_000)
    expect((await post(channel)).status).toBe(200)
    expect(calls.map((c) => c.auth)).toEqual(['Bearer token-1', 'Bearer token-2', 'Bearer token-3'])
    expect(grants.computerChannelGrant).toHaveBeenCalledTimes(3)
  })

  it("answers the MCP client's standalone-stream GET itself, without a grant or a relay", async () => {
    const { channel, grants, calls } = setup([])
    const res = await channel.fetch('http://ignored/mcp', { method: 'GET', headers: { accept: 'text/event-stream' } })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST, DELETE')
    expect(calls).toHaveLength(0)
    expect(grants.computerChannelGrant).not.toHaveBeenCalled()
  })

  it('tries the next relay only when the request provably never left', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
    const first = setup([
      () => {
        throw refused
      },
      () => json(200, {})
    ])
    expect((await post(first.channel)).status).toBe(200)
    // A reset may have reached the desktop: never replayed.
    const second = setup([
      () => {
        throw reset
      }
    ])
    await expect(post(second.channel)).rejects.toBe(reset)
    expect(second.calls).toHaveLength(1)
  })

  it('fails definitely when no relay holds the Computer or the CP refuses', async () => {
    const { channel } = setup([
      () => json(503, { error: 'computer_not_attached' }),
      () => json(503, { error: 'computer_not_attached' })
    ])
    await expect(post(channel)).rejects.toMatchObject({ code: 'not_attached' })
    const denied = new ComputerChannel({
      grants: { computerChannelGrant: async () => ({ granted: false, code: 'denied', message: 'not granted' }) },
      target: { computerId: COMPUTER, agentId: AGENT, sessionId: 'sess-1' }
    })
    await expect(denied.grant()).rejects.toBeInstanceOf(ComputerChannelError)
  })
})
