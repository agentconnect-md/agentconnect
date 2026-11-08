// A deployment Google Chat app's row sends through the relay (google-chat-integration.md §10.10): no key, no token request, and no other way out.
import { describe, expect, it } from 'vitest'
import {
  GOOGLE_CHAT_RELAY_EGRESS_V1_FEATURE,
  IntegrationGoogleChatConfig,
  type RdPlatformReply,
  type RdPlatformRequest,
  type WireGoogleChatCall
} from '@agentconnect.md/protocol'
import {
  GoogleChatApiError,
  GoogleChatConnection,
  googleChatConnKey,
  type ConsolidatedGoogleChatGroup
} from '../src/platforms/googlechat/connection.js'
import { googleChatPlatformModule } from '../src/platforms/googlechat/relay-ingress.js'
import { PlatformRelayUnsent, type PlatformRelay } from '../src/platforms/platform-relay.js'

const BOT_ID = '33333333-3333-4333-8333-333333333333'
const SPACE = 'spaces/EXAMPLE_SPACE'
const CUSTOMER = 'customers/C0000000001'
const RELAY_CONFIG = {
  projectId: 'example-project',
  projectNumber: '100000000000',
  tenantIds: [CUSTOMER],
  egress: 'relay' as const,
  botId: BOT_ID
}
const OWN_CONFIG = { projectId: 'own-project', projectNumber: '200000000000', serviceAccountKey: '{}' }

const answers = (status: number, body?: Record<string, unknown>): RdPlatformReply => ({
  outcome: 'ok',
  payload: { status, ...(body ? { body } : {}) }
})

// A relay that answers a Space read as the fence needs it, and everything else with `answer`.
function relay(answer: (call: WireGoogleChatCall) => RdPlatformReply | Promise<RdPlatformReply>) {
  const sent: WireGoogleChatCall[] = []
  const port: PlatformRelay = {
    request: async (req: RdPlatformRequest) => {
      expect(req.platformId).toBe('googlechat')
      expect(req.botId).toBe(BOT_ID)
      const call = req.payload as WireGoogleChatCall
      sent.push(call)
      if (call.op === 'get-space')
        return answers(200, { name: call.space, spaceType: 'SPACE', customer: CUSTOMER, displayName: 'Example' })
      return await answer(call)
    }
  }
  return { port, sent }
}

function connection(port: PlatformRelay | undefined, fetched: string[] = []) {
  const fetchImpl = (async (url: unknown) => {
    fetched.push(String(url))
    return new Response(null, { status: 500 })
  }) as typeof fetch
  const group: ConsolidatedGoogleChatGroup = {
    key: googleChatConnKey(RELAY_CONFIG),
    agentId: 'a',
    integrationId: 'i',
    config: RELAY_CONFIG,
    integrations: []
  }
  return new GoogleChatConnection({
    group,
    fetchImpl,
    sendIntervalMs: 0,
    sleep: async () => {},
    random: () => 0,
    ...(port ? { relay: port } : {})
  })
}

const failure = async (work: Promise<unknown>) => (await work.catch((err: unknown) => err)) as GoogleChatApiError
const writes = (sent: WireGoogleChatCall[]) => sent.filter((call) => call.op !== 'get-space')

describe('the googlechat spec', () => {
  it('takes either an own app’s key or the relay with its bot row and customer, never neither', () => {
    const parse = (config: unknown) => IntegrationGoogleChatConfig.safeParse(config).success
    expect(parse(RELAY_CONFIG)).toBe(true)
    expect(parse(OWN_CONFIG)).toBe(true)
    expect(parse({ ...OWN_CONFIG, serviceAccountKey: undefined })).toBe(false)
    expect(parse({ ...RELAY_CONFIG, botId: undefined })).toBe(false)
    expect(parse({ ...RELAY_CONFIG, tenantIds: [] })).toBe(false)
    expect(parse({ ...RELAY_CONFIG, tenantIds: undefined })).toBe(false)
  })

  it('keys a relay row by its bot row, apart from any key', () => {
    expect(googleChatConnKey(RELAY_CONFIG)).not.toBe(
      googleChatConnKey({ ...RELAY_CONFIG, botId: OWN_CONFIG.projectId })
    )
    expect(googleChatConnKey(OWN_CONFIG)).not.toBe(googleChatConnKey({ ...OWN_CONFIG, serviceAccountKey: '{"a":1}' }))
  })

  it('is advertised by the Google Chat module, not by daemon core', () => {
    expect(googleChatPlatformModule({} as never).registrationFeatures).toEqual([GOOGLE_CHAT_RELAY_EGRESS_V1_FEATURE])
  })
})

describe('a relay-egress Google Chat connection', () => {
  it('starts with no token request and creates through the relay under its client id', async () => {
    const fetched: string[] = []
    const { port, sent } = relay(() =>
      answers(200, { name: `${SPACE}/messages/client-1`, sender: { name: 'users/9' }, text: 'hello' })
    )
    const conn = connection(port, fetched)
    await conn.start()
    const created = await conn.createMessage({ space: SPACE, clientId: 'client-1', text: 'hello' })
    expect(created).toMatchObject({ name: `${SPACE}/messages/client-1`, text: 'hello' })
    expect(conn.botUserId).toBe('users/9')
    expect(writes(sent)).toEqual([
      { op: 'create-message', space: SPACE, messageId: 'client-1', requestId: 'client-1', text: 'hello' }
    ])
    expect(fetched).toEqual([])
  })

  it('sends every operation it has as the fixed call the relay builds from', async () => {
    const { port, sent } = relay((call) => {
      if (call.op === 'find-direct-message') return answers(200, { name: 'spaces/EXAMPLE_DM' })
      if (call.op === 'list-spaces')
        return answers(200, { spaces: [{ name: SPACE, spaceType: 'SPACE', customer: CUSTOMER }] })
      return answers(200, { memberships: [{ member: { name: 'users/1', type: 'HUMAN' } }] })
    })
    const conn = connection(port)
    const message = `${SPACE}/messages/m1`
    await conn.patchMessage(message, 'edit')
    await conn.patchCards(message, [{ cardId: 'c' }])
    await conn.deleteOwnMessage(message)
    await conn.getMessage(message)
    await conn.directMessagePerson(SPACE)
    expect(await conn.findDirectMessage('users/1')).toBe('spaces/EXAMPLE_DM')
    expect(await conn.listChannels()).toEqual([{ id: SPACE, isPrivate: false }])
    expect(writes(sent).map((call) => call.op)).toEqual([
      'patch-text',
      'patch-cards',
      'delete-message',
      'get-message',
      'list-dm-humans',
      'find-direct-message',
      'list-spaces'
    ])
  })

  it('pages through members using the relay alone, including a genuinely empty result', async () => {
    const fetched: string[] = []
    const { port, sent } = relay((call) => {
      expect(call.op).toBe('list-members')
      if (call.op !== 'list-members') throw new Error('unexpected operation')
      if (call.space === 'spaces/EMPTY') return answers(200, { memberships: [] })
      return answers(200, {
        memberships: [{ member: { name: call.pageToken ? 'users/2' : 'users/1', type: 'HUMAN' } }],
        ...(call.pageToken ? {} : { nextPageToken: 'next' })
      })
    })
    const conn = connection(port, fetched)
    expect(await conn.listMembers(SPACE)).toEqual([
      { id: 'users/1', isBot: false },
      { id: 'users/2', isBot: false }
    ])
    expect(await conn.listMembers('spaces/EMPTY')).toEqual([])
    expect(sent).toEqual([
      { op: 'list-members', space: SPACE },
      { op: 'list-members', space: SPACE, pageToken: 'next' },
      { op: 'list-members', space: 'spaces/EMPTY' }
    ])
    expect(fetched).toEqual([])
  })

  it('does not fall back to direct reads when a relay refuses the membership operation', async () => {
    const fetched: string[] = []
    const { port, sent } = relay(() => ({ outcome: 'refused', reason: 'invalid' }))
    await expect(connection(port, fetched).listMembers(SPACE)).rejects.toBeInstanceOf(GoogleChatApiError)
    expect(sent).toHaveLength(1)
    expect(fetched).toEqual([])
  })

  it('fails closed without a relay: nothing is sent, and no token is asked for', async () => {
    const fetched: string[] = []
    const conn = connection(undefined, fetched)
    await conn.start()
    const err = await failure(conn.createMessage({ space: SPACE, clientId: 'client-1', text: 'hello' }))
    expect(err).toBeInstanceOf(GoogleChatApiError)
    expect(err.kind).toBe('unavailable')
    expect(err.unsent).toBe(true)
    expect(fetched).toEqual([])
  })

  it('reads the relay’s tenant refusal as the fence’s, and does not repeat it', async () => {
    const { port, sent } = relay(() => ({ outcome: 'refused', reason: 'tenant_refused' }))
    const err = await failure(connection(port).patchMessage(`${SPACE}/messages/m1`, 'edit'))
    expect(err.kind).toBe('tenant_refused')
    expect(writes(sent)).toHaveLength(1)
  })

  it('asks again, a bounded number of times, after a refusal assignment lag can explain', async () => {
    let refusals = 2
    const { port, sent } = relay(() =>
      refusals-- > 0
        ? { outcome: 'refused', reason: 'not_member', retryable: true }
        : answers(200, { name: `${SPACE}/messages/client-1` })
    )
    await connection(port).createMessage({ space: SPACE, clientId: 'client-1', text: 'hello' })
    expect(writes(sent)).toHaveLength(3)
    const refusing = relay(() => ({ outcome: 'refused', reason: 'not_member', retryable: true }))
    const err = await failure(connection(refusing.port).patchMessage(`${SPACE}/messages/m1`, 'edit'))
    expect(err.unsent).toBe(true)
    expect(writes(refusing.sent)).toHaveLength(3)
  })

  it('reads a request the relay left unanswered as one that may have landed, and looks before sending again', async () => {
    const ops: string[] = []
    const port: PlatformRelay = {
      request: async ({ payload }) => {
        const call = payload as WireGoogleChatCall
        ops.push(call.op)
        if (call.op === 'get-space') return answers(200, { spaceType: 'SPACE', customer: CUSTOMER })
        if (call.op === 'create-message') throw new Error('rd/platform/request timed out')
        return answers(200, { name: `${SPACE}/messages/client-1`, text: 'hello' })
      }
    }
    const created = await connection(port).createMessage({ space: SPACE, clientId: 'client-1', text: 'hello' })
    expect(created).toMatchObject({ name: `${SPACE}/messages/client-1` })
    expect(ops).toEqual(['get-space', 'create-message', 'get-message'])
  })

  it('never sends again a create that may have landed, whatever the read-back finds', async () => {
    for (const lost of [
      () => {
        throw new Error('rd/platform/request timed out')
      },
      () => answers(504),
      () => answers(503)
    ]) {
      const ops: string[] = []
      const port: PlatformRelay = {
        request: async ({ payload }) => {
          const call = payload as WireGoogleChatCall
          ops.push(call.op)
          if (call.op === 'get-space') return answers(200, { spaceType: 'SPACE', customer: CUSTOMER })
          if (call.op === 'get-message') return answers(404)
          return lost()
        }
      }
      const err = await failure(connection(port).createMessage({ space: SPACE, clientId: 'client-1', text: 'hello' }))
      expect(err).toBeInstanceOf(GoogleChatApiError)
      expect(ops).toEqual(['get-space', 'create-message', 'get-message'])
    }
  })

  it('posts chrome once when its answer is lost', async () => {
    const { port, sent } = relay(() => answers(504))
    await failure(connection(port).postChrome(SPACE, undefined, 'notice'))
    expect(writes(sent)).toHaveLength(1)
    expect(writes(sent)[0]).toMatchObject({ op: 'create-message', space: SPACE, text: 'notice' })
  })

  it('sends again a create the relay says never went out', async () => {
    let refusals = 1
    const { port, sent } = relay(() =>
      refusals-- > 0 ? { outcome: 'unavailable', reason: 'deadline' } : answers(200, { name: `${SPACE}/messages/m` })
    )
    await connection(port).createMessage({ space: SPACE, clientId: 'client-1', text: 'hello' })
    expect(writes(sent).filter((call) => call.op === 'create-message')).toHaveLength(2)
  })

  it('walks no further when no relay can take a call', async () => {
    const port: PlatformRelay = {
      request: async () => {
        throw new PlatformRelayUnsent('no READY relay serves platform requests')
      }
    }
    const err = await failure(connection(port).getChannelInfo(SPACE))
    expect(err.unsent).toBe(true)
    expect(err.kind).toBe('unavailable')
  })

  it('stops waiting for the relay when the caller’s signal fires', async () => {
    const port: PlatformRelay = { request: () => new Promise(() => {}) }
    const err = await failure(connection(port).getChannelInfo(SPACE, { signal: AbortSignal.timeout(5) }))
    expect(err.kind).toBe('ambiguous')
  })
})
