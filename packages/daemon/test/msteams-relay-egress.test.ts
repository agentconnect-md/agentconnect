// A deployment Teams app's row sends through the relay (teams-integration.md §8.5): no secret, no token request, tickets kept across restarts.
import { describe, expect, it } from 'vitest'
import { IntegrationMsTeamsConfig, type RdPlatformReply, type WireMsTeamsCall } from '@agentconnect.md/protocol'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import type { ConversationMemory } from '../src/platforms/conversation-memory.js'
import { MsTeamsApiError, msTeamsTokenEndpoint, type MsTeamsRelayPort } from '../src/platforms/msteams/api.js'
import { MsTeamsConnection, msTeamsConnKey } from '../src/platforms/msteams/connection.js'

const ZERO = '00000000-0000-0000-0000-000000000000'
const BOT_ID = '33333333-3333-4333-8333-333333333333'
const SERVICE_URL = `https://smba.trafficmanager.net/amer/${ZERO}/`
const TEAM = '19:example-team@thread.tacv2'
const CHANNEL = '19:example-design@thread.tacv2'
const RELAY_CONFIG = { appId: ZERO, tenantId: ZERO, egress: 'relay' as const, botId: BOT_ID }

function channelPost(ticket?: string, teamTicket?: string): NormalizedMessage {
  return {
    platform: 'msteams',
    channel: CHANNEL,
    isDm: false,
    sender: { id: '29:sender', isBot: false },
    adapterExt: {
      msteams: {
        serviceUrl: SERVICE_URL,
        conversationId: `${CHANNEL};messageid=1700000000000`,
        teamId: TEAM,
        ...(ticket ? { ticket } : {}),
        ...(teamTicket ? { teamTicket } : {})
      }
    }
  } as unknown as NormalizedMessage
}

function relay(answer: (call: WireMsTeamsCall) => RdPlatformReply) {
  const sent: WireMsTeamsCall[] = []
  const port: MsTeamsRelayPort = {
    request: async (botId, call) => {
      expect(botId).toBe(BOT_ID)
      sent.push(call)
      return answer(call)
    }
  }
  return { port, sent }
}

function memoryOf(rows: { id: string; facts: unknown }[] = []) {
  const saved = new Map<string, unknown>()
  const memory: ConversationMemory = {
    load: async () => rows,
    save: async (id, facts) => {
      saved.set(id, facts)
    }
  }
  return { memory, saved }
}

function connection(port: MsTeamsRelayPort | undefined, memory?: ConversationMemory, fetched: string[] = []) {
  const fetchImpl = (async (url: unknown) => {
    fetched.push(String(url))
    return new Response(null, { status: 500 })
  }) as typeof fetch
  return new MsTeamsConnection({
    group: {
      key: msTeamsConnKey(RELAY_CONFIG),
      agentId: 'a',
      integrationId: 'i',
      config: RELAY_CONFIG,
      integrations: []
    },
    fetchImpl,
    sendIntervalMs: 0,
    sleep: async () => {},
    ...(port ? { relay: port } : {}),
    ...(memory ? { memory } : {})
  })
}

describe('the msteams spec', () => {
  it('takes either an own bot’s secret or the relay with its bot row, never neither', () => {
    expect(IntegrationMsTeamsConfig.safeParse(RELAY_CONFIG).success).toBe(true)
    expect(IntegrationMsTeamsConfig.safeParse({ appId: ZERO, tenantId: ZERO, clientSecret: 's' }).success).toBe(true)
    expect(IntegrationMsTeamsConfig.safeParse({ appId: ZERO, tenantId: ZERO }).success).toBe(false)
    expect(IntegrationMsTeamsConfig.safeParse({ appId: ZERO, tenantId: ZERO, egress: 'relay' }).success).toBe(false)
  })

  it('keys a relay row by its bot row, apart from any secret', () => {
    expect(msTeamsConnKey(RELAY_CONFIG)).not.toBe(msTeamsConnKey({ ...RELAY_CONFIG, botId: ZERO }))
  })
})

describe('a relay-egress Teams connection', () => {
  it('starts with no token request and posts through the relay with the conversation’s ticket', async () => {
    const fetched: string[] = []
    const { port, sent } = relay(() => ({ outcome: 'ok', payload: { status: 201, body: { id: 'act-1' } } }))
    const conn = connection(port, undefined, fetched)
    await conn.start()
    conn.noteMessage(channelPost('t1.channel.mac', 't1.team.mac'))
    expect(await conn.postMessage(CHANNEL, 'hello', '1700000000000')).toBe('act-1')
    expect(sent).toEqual([
      {
        op: 'post-activity',
        ticket: 't1.channel.mac',
        conversationId: `${CHANNEL};messageid=1700000000000`,
        activity: { type: 'message', textFormat: 'extendedmarkdown', text: 'hello' }
      }
    ])
    expect(fetched.some((url) => url === msTeamsTokenEndpoint(ZERO))).toBe(false)
    expect(fetched).toEqual([])
  })

  it('reads a team with the team’s ticket and remembers both tickets across a restart', async () => {
    const { memory, saved } = memoryOf()
    const first = connection(relay(() => ({ outcome: 'ok', payload: { status: 200, body: {} } })).port, memory)
    await first.start()
    first.noteMessage(channelPost('t1.channel.mac', 't1.team.mac'))
    await first.flush()
    expect(saved.get(CHANNEL)).toMatchObject({ ticket: 't1.channel.mac', teamTicket: 't1.team.mac' })

    const { port, sent } = relay((call) =>
      call.op === 'get-team'
        ? { outcome: 'ok', payload: { status: 200, body: { name: 'Example Team' } } }
        : { outcome: 'refused', reason: 'unexpected' }
    )
    const again = connection(port, memoryOf([...saved].map(([id, facts]) => ({ id, facts }))).memory)
    await again.start()
    expect(await again.spaceOf(CHANNEL)).toEqual({ id: TEAM, name: 'Example Team' })
    expect(sent).toEqual([{ op: 'get-team', ticket: 't1.team.mac', teamId: TEAM }])
  })

  it('cannot send to a conversation from before its row was ticketed, and never falls back to a token', async () => {
    const fetched: string[] = []
    const { port, sent } = relay(() => ({ outcome: 'ok', payload: { status: 201, body: { id: 'x' } } }))
    const conn = connection(port, undefined, fetched)
    conn.noteMessage(channelPost())
    const err = (await conn.postMessage(CHANNEL, 'hello').catch((e: unknown) => e)) as MsTeamsApiError
    expect(err.kind).toBe('forbidden')
    expect(sent).toEqual([])
    expect(fetched).toEqual([])
  })

  it('fails closed without a relay', async () => {
    const conn = connection(undefined)
    conn.noteMessage(channelPost('t1.channel.mac'))
    const err = (await conn.postMessage(CHANNEL, 'hello').catch((e: unknown) => e)) as MsTeamsApiError
    expect(err).toBeInstanceOf(MsTeamsApiError)
    expect(err.kind).toBe('unavailable')
  })
})
