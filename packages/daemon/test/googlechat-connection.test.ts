/** The Google Chat Layer-1 connection (google-chat-integration.md §5) against a fake Google: token, writes, retries, pacing, identity. */
import { describe, it, expect } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { jwtVerify } from 'jose'
import type { Agent, Integration } from '../src/agents/agent-schema.js'
import {
  consolidateGoogleChat,
  GoogleChatApiError,
  GoogleChatConnection,
  GOOGLE_CHAT_MARKUP,
  GOOGLE_TOKEN_ENDPOINT,
  googleChatConnKey,
  spaceOf,
  type ConsolidatedGoogleChatGroup
} from '../src/platforms/googlechat/connection.js'
import { GoogleChatWriteBudget } from '../src/platforms/googlechat/write-budget.js'

const PROJECT_NUMBER = '100000000000'
const SPACE = 'spaces/EXAMPLE_SPACE'
const DM = 'spaces/EXAMPLE_DM'
const THREAD = `${SPACE}/threads/EXAMPLE_THREAD`
const APP_USER = 'users/100000000000000000009'
const CLIENT_EMAIL = 'chat-app@example.test'
const START = Date.parse('2026-09-27T00:00:00.000Z')

// A throwaway RSA key pair, generated per test file: never a real credential.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const KEY_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'example-project',
  private_key_id: 'kid-1',
  private_key: PRIVATE_PEM,
  client_email: CLIENT_EMAIL
})

function integration(config: unknown, id = 'int-1'): Integration {
  return {
    id,
    platform: 'googlechat',
    core: {
      mode: 'shared',
      bindRules: [],
      mutedChannels: [],
      gated: false,
      sessionModes: [],
      decisions: { bindings: [], definitions: [] }
    },
    config
  } as Integration
}

function agent(id: string, config: unknown, integrationId = `int-${id}`): Agent {
  return { id, integrations: [integration(config, integrationId)] } as unknown as Agent
}

function group(overrides: Partial<ConsolidatedGoogleChatGroup['config']> = {}): ConsolidatedGoogleChatGroup {
  const config = {
    projectId: 'example-project',
    projectNumber: PROJECT_NUMBER,
    serviceAccountKey: KEY_JSON,
    ...overrides
  }
  return {
    key: googleChatConnKey(config),
    agentId: 'agent-1',
    integrationId: 'int-1',
    config,
    integrations: [{ agentId: 'agent-1', integrationId: 'int-1' }]
  }
}

interface Call {
  url: URL
  method: string
  headers: Record<string, string>
  body?: string
  at: number
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body
  } as unknown as Response
}

/** A wall clock the test drives; `sleep` advances it instead of waiting. */
function fakeClock(start = START) {
  let t = start
  const slept: number[] = []
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
    sleep: async (ms: number) => {
      slept.push(ms)
      t += ms
    },
    slept
  }
}

type Handler = (call: Call) => Response | Promise<Response>

/** Answers the token endpoint by default and routes Chat API calls to `handler`, recording everything. */
function harness(
  handler: Handler,
  opts: {
    sendIntervalMs?: number
    log?: string[]
    config?: Partial<ConsolidatedGoogleChatGroup['config']>
    budget?: GoogleChatWriteBudget
  } = {}
) {
  const clock = fakeClock()
  const calls: Call[] = []
  let tokens = 0
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      at: clock.now()
    }
    calls.push(call)
    if (url.toString() === GOOGLE_TOKEN_ENDPOINT) {
      tokens += 1
      return reply(200, { access_token: `tok-${tokens}`, expires_in: 3600, token_type: 'Bearer' })
    }
    return await handler(call)
  }) as typeof fetch
  const log = opts.log ?? []
  const logger = {
    trace: (m: string) => log.push(m),
    debug: (m: string) => log.push(m),
    info: (m: string) => log.push(m),
    warn: (m: string) => log.push(m),
    error: (m: string) => log.push(m)
  }
  const conn = new GoogleChatConnection({
    group: group(opts.config),
    log: logger,
    ...(opts.budget ? { budget: opts.budget } : {}),
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    sendIntervalMs: opts.sendIntervalMs ?? 0,
    random: () => 0,
    newRequestId: () => 'req-fixed'
  })
  const chatCalls = () => calls.filter((c) => c.url.toString() !== GOOGLE_TOKEN_ENDPOINT)
  const tokenCalls = () => calls.filter((c) => c.url.toString() === GOOGLE_TOKEN_ENDPOINT)
  return { conn, clock, calls, chatCalls, tokenCalls, log }
}

const created = (name: string, text = 'hi') => reply(200, { name, text, sender: { name: APP_USER, type: 'BOT' } })

describe('consolidation and identity', () => {
  it('groups by app AND key, so a rotated key is a different connection and a bad payload is skipped', () => {
    const a = agent('a', { projectId: 'example-project', projectNumber: PROJECT_NUMBER, serviceAccountKey: KEY_JSON })
    const rotated = agent('b', {
      projectId: 'example-project',
      projectNumber: PROJECT_NUMBER,
      serviceAccountKey: '{"k":2}'
    })
    const bad = agent('c', { projectId: 'example-project', projectNumber: 'nope', serviceAccountKey: KEY_JSON })
    const groups = consolidateGoogleChat([a, rotated, bad])
    expect(groups.size).toBe(2)
    expect([...groups.values()].map((g) => g.integrationId).sort()).toEqual(['int-a', 'int-b'])
    // The pool key never embeds the key material itself.
    for (const key of groups.keys()) expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  it('keys a row’s tenant into the connection, so two customer rows of one app never share a client', () => {
    const shared = { projectId: 'example-project', projectNumber: PROJECT_NUMBER, serviceAccountKey: KEY_JSON }
    const a = agent('a', { ...shared, tenantIds: ['customers/C1'] })
    const b = agent('b', { ...shared, tenantIds: ['customers/C2'] })
    const c = agent('c', { ...shared, tenantIds: ['customers/C1'] })
    const own = agent('d', { ...shared, ownTenantIds: ['customers/C1'] })
    const groups = consolidateGoogleChat([a, b, c, own])
    expect(groups.size).toBe(3)
    expect([...groups.values()].map((g) => g.integrations.length).sort()).toEqual([1, 1, 2])
    expect(googleChatConnKey({ ...shared, tenantIds: [] })).not.toBe(googleChatConnKey(shared))
  })

  it('carries the events URL every card names, and opens a new client when it moves (§11.5)', () => {
    const shared = { projectId: 'example-project', projectNumber: PROJECT_NUMBER, serviceAccountKey: KEY_JSON }
    const eventsUrl = 'https://relay.example.test/googlechat/events'
    const [group] = consolidateGoogleChat([agent('a', { ...shared, eventsUrl })]).values()
    expect(new GoogleChatConnection({ group: group! }).eventsUrl).toBe(eventsUrl)
    expect(googleChatConnKey({ ...shared, eventsUrl })).not.toBe(googleChatConnKey(shared))
  })

  it('names the Space a message resource lives in', () => {
    expect(spaceOf(`${SPACE}/messages/client-abc`)).toBe(SPACE)
    expect(spaceOf(SPACE)).toBe(SPACE)
  })
})

describe('token mint', () => {
  it('signs a chat.bot JWT-bearer grant for the fixed endpoint and caches the hour-long token', async () => {
    const { conn, chatCalls, tokenCalls, clock } = harness(() => created(`${SPACE}/messages/T.M`))
    await conn.createMessage({ space: SPACE, thread: THREAD, clientId: 'client-one', text: 'hi' })
    await conn.createMessage({ space: SPACE, thread: THREAD, clientId: 'client-two', text: 'hi' })
    expect(tokenCalls()).toHaveLength(1)
    const grant = tokenCalls()[0]!
    expect(grant.method).toBe('POST')
    const form = new URLSearchParams(grant.body)
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    const { payload, protectedHeader } = await jwtVerify(form.get('assertion')!, publicKey, {
      issuer: CLIENT_EMAIL,
      audience: GOOGLE_TOKEN_ENDPOINT,
      currentDate: new Date(START)
    })
    expect(protectedHeader).toMatchObject({ alg: 'RS256', typ: 'JWT', kid: 'kid-1' })
    expect(payload.scope).toBe('https://www.googleapis.com/auth/chat.bot')
    expect(payload.exp! - payload.iat!).toBe(3600)
    for (const call of chatCalls()) expect(call.headers.authorization).toBe('Bearer tok-1')
    // Past the renewal margin the next call mints again, ahead of the expiry itself.
    clock.advance(56 * 60 * 1000)
    await conn.createMessage({ space: SPACE, thread: THREAD, clientId: 'client-three', text: 'hi' })
    expect(tokenCalls()).toHaveLength(2)
    expect(chatCalls().at(-1)!.headers.authorization).toBe('Bearer tok-2')
  })

  it('reports a rejected key as credential_rejected, backs off, and never writes the key into a log or an error', async () => {
    const log: string[] = []
    const clock = fakeClock()
    const fetchImpl = (async () => reply(400, { error: 'invalid_grant', error_description: 'bad' })) as typeof fetch
    const conn = new GoogleChatConnection({
      group: group(),
      log: {
        trace: (m) => log.push(m),
        debug: (m) => log.push(m),
        info: (m) => log.push(m),
        warn: (m) => log.push(m),
        error: (m) => log.push(m)
      },
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
      sendIntervalMs: 0
    })
    const first = await conn.token().catch((e: unknown) => e)
    expect(first).toBeInstanceOf(GoogleChatApiError)
    expect((first as GoogleChatApiError).kind).toBe('credential_rejected')
    // The backoff holds the failure without a second round trip.
    const second = await conn.token().catch((e: unknown) => e)
    expect(second).toBe(first)
    const everything = [...log, (first as Error).message].join('\n')
    expect(everything).not.toContain('PRIVATE KEY')
    expect(everything).not.toContain(PRIVATE_PEM.slice(40, 80))
  })

  it('refuses an unreadable key up front, without echoing it', () => {
    const log: string[] = []
    new GoogleChatConnection({
      group: group({
        serviceAccountKey: '{"type":"service_account","client_email":"x@example.test","private_key":"garbage"}'
      }),
      log: { trace: () => {}, debug: () => {}, info: () => {}, warn: (m) => log.push(m), error: () => {} }
    })
    expect(log).toHaveLength(1)
    expect(log[0]).toContain('not a readable RSA key')
    expect(log[0]).not.toContain('garbage')
  })
})

describe('creates and patches', () => {
  it('creates into the thread with REPLY_MESSAGE_OR_FAIL, Markdown syntax, the client id and a matching request id', async () => {
    const { conn, chatCalls } = harness(() => created(`${SPACE}/messages/EXAMPLE_THREAD.abc`))
    const ref = await conn.createMessage({ space: SPACE, thread: THREAD, clientId: 'client-abc', text: '**hi**' })
    expect(ref).toEqual({ name: `${SPACE}/messages/EXAMPLE_THREAD.abc`, clientId: 'client-abc', text: 'hi' })
    const call = chatCalls()[0]!
    expect(call.method).toBe('POST')
    expect(call.url.pathname).toBe(`/v1/${SPACE}/messages`)
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      messageId: 'client-abc',
      requestId: 'client-abc',
      messageReplyOption: 'REPLY_MESSAGE_OR_FAIL'
    })
    expect(JSON.parse(call.body!)).toEqual({
      text: '**hi**',
      markupSyntax: GOOGLE_CHAT_MARKUP,
      thread: { name: THREAD }
    })
    // The create response's sender is the identity source.
    expect(conn.botUserId).toBe(APP_USER)
  })

  it('creates into a DM with no thread option at all', async () => {
    const { conn, chatCalls } = harness(() => created(`${DM}/messages/x.y`))
    await conn.createMessage({ space: DM, clientId: 'client-dm', text: 'hi' })
    const call = chatCalls()[0]!
    expect(call.url.searchParams.has('messageReplyOption')).toBe(false)
    expect(JSON.parse(call.body!)).toEqual({ text: 'hi', markupSyntax: GOOGLE_CHAT_MARKUP })
  })

  it('patches text with updateMask=text and the Markdown syntax in the body, never in the mask', async () => {
    const { conn, chatCalls } = harness(() => reply(200, {}))
    await conn.patchMessage(`${SPACE}/messages/client-abc`, 'edited')
    const call = chatCalls()[0]!
    expect(call.method).toBe('PATCH')
    expect(call.url.pathname).toBe(`/v1/${SPACE}/messages/client-abc`)
    expect(Object.fromEntries(call.url.searchParams)).toEqual({ updateMask: 'text' })
    expect(JSON.parse(call.body!)).toEqual({ text: 'edited', markupSyntax: GOOGLE_CHAT_MARKUP })
  })

  it('surfaces a deleted message on patch as not_found rather than recreating it', async () => {
    const { conn, chatCalls } = harness(() => reply(404, { error: { message: 'Message not found' } }))
    const err = await conn.patchMessage(`${SPACE}/messages/client-abc`, 'edited').catch((e: unknown) => e)
    expect((err as GoogleChatApiError).kind).toBe('not_found')
    expect(chatCalls()).toHaveLength(1)
    expect(chatCalls()[0]!.url.searchParams.has('allowMissing')).toBe(false)
  })

  it('deletes its own message with a bare DELETE, and counts one already gone as deleted', async () => {
    const { conn, chatCalls } = harness(() => reply(200, {}))
    await conn.deleteOwnMessage(`${SPACE}/messages/client-abc`)
    const call = chatCalls()[0]!
    expect(call.method).toBe('DELETE')
    expect(call.url.pathname).toBe(`/v1/${SPACE}/messages/client-abc`)
    expect([...call.url.searchParams]).toEqual([])
    const gone = harness(() => reply(404, { error: { message: 'Message not found' } }))
    await expect(gone.conn.deleteOwnMessage(`${SPACE}/messages/client-abc`)).resolves.toBeUndefined()
    expect(gone.chatCalls()).toHaveLength(1)
  })

  it('reports no text when the create response carries none, so the stream patches instead of assuming a match', async () => {
    const { conn } = harness(() => reply(200, { name: `${SPACE}/messages/T.M`, sender: { name: APP_USER } }))
    const ref = await conn.createMessage({ space: SPACE, thread: THREAD, clientId: 'client-abc', text: '**hi**' })
    expect(ref).toEqual({ name: `${SPACE}/messages/T.M`, clientId: 'client-abc' })
    expect('text' in ref).toBe(false)
  })

  it('posts chrome with a per-call request id and no client id', async () => {
    const { conn, chatCalls } = harness(() => created(`${SPACE}/messages/T.chrome`))
    await conn.postChrome(SPACE, THREAD, 'status')
    const call = chatCalls()[0]!
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      requestId: 'req-fixed',
      messageReplyOption: 'REPLY_MESSAGE_OR_FAIL'
    })
  })
})

describe('an ambiguous create reconciles by client id', () => {
  it('reads the id back after a lost answer and posts nothing more when the message exists', async () => {
    let posts = 0
    const { conn, chatCalls } = harness((call) => {
      if (call.method === 'POST') {
        posts += 1
        throw new Error('socket hang up')
      }
      return reply(200, { name: `${SPACE}/messages/EXAMPLE_THREAD.landed`, text: 'hi' })
    })
    const ref = await conn.createMessage({ space: SPACE, thread: THREAD, clientId: 'client-abc', text: 'hi' })
    expect(ref).toEqual({ name: `${SPACE}/messages/EXAMPLE_THREAD.landed`, clientId: 'client-abc', text: 'hi' })
    expect(posts).toBe(1)
    const read = chatCalls().find((c) => c.method === 'GET')!
    expect(read.url.pathname).toBe(`/v1/${SPACE}/messages/client-abc`)
  })

  it('re-sends the identical request when the read-back proves nothing landed', async () => {
    const posts: Call[] = []
    const { conn } = harness((call) => {
      if (call.method === 'POST') {
        posts.push(call)
        if (posts.length === 1) throw new Error('socket hang up')
        return created(`${SPACE}/messages/EXAMPLE_THREAD.second`)
      }
      return reply(404, { error: { message: 'not found' } })
    })
    const ref = await conn.createMessage({ space: SPACE, thread: THREAD, clientId: 'client-abc', text: 'hi' })
    expect(ref.name).toBe(`${SPACE}/messages/EXAMPLE_THREAD.second`)
    expect(posts).toHaveLength(2)
    expect(posts[1]!.body).toBe(posts[0]!.body)
    expect(posts[1]!.url.toString()).toBe(posts[0]!.url.toString())
  })

  it('adopts the existing message on ALREADY_EXISTS instead of allocating a fresh id', async () => {
    let posts = 0
    const { conn } = harness((call) => {
      if (call.method === 'POST') {
        posts += 1
        return reply(409, { error: { message: 'already exists' } })
      }
      return reply(200, { name: `${SPACE}/messages/EXAMPLE_THREAD.earlier`, text: 'old' })
    })
    const ref = await conn.createMessage({ space: SPACE, thread: THREAD, clientId: 'client-abc', text: 'hi' })
    expect(ref).toEqual({ name: `${SPACE}/messages/EXAMPLE_THREAD.earlier`, clientId: 'client-abc', text: 'old' })
    expect(posts).toBe(1)
  })
})

describe('refusals and backoff', () => {
  it('surfaces a missing thread as not_found after one attempt, with no read-back and no fallback', async () => {
    const { conn, chatCalls } = harness(() => reply(404, { error: { message: 'thread not found' } }))
    const err = await conn
      .createMessage({ space: SPACE, thread: THREAD, clientId: 'client-abc', text: 'hi' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GoogleChatApiError)
    expect((err as GoogleChatApiError).kind).toBe('not_found')
    expect(chatCalls()).toHaveLength(1)
  })

  it('honours Retry-After on a 429 and retries the same create, bounded', async () => {
    let posts = 0
    const { conn, clock } = harness(() => {
      posts += 1
      return posts === 1 ? reply(429, {}, { 'retry-after': '2' }) : created(`${SPACE}/messages/T.M`)
    })
    await conn.createMessage({ space: SPACE, thread: THREAD, clientId: 'client-abc', text: 'hi' })
    expect(posts).toBe(2)
    expect(clock.slept).toEqual([2000])
  })

  it('gives up on a 429 storm after the attempt budget', async () => {
    let posts = 0
    const { conn, clock } = harness(() => {
      posts += 1
      return reply(429, {})
    })
    const err = await conn.patchMessage(`${SPACE}/messages/client-abc`, 'x').catch((e: unknown) => e)
    expect((err as GoogleChatApiError).kind).toBe('rate_limited')
    expect(posts).toBe(3)
    // Exponential from the base, deterministic with the zero jitter injected here.
    expect(clock.slept).toEqual([1000, 2000])
  })

  it('re-mints once on a 401 and then reports the credential as rejected', async () => {
    const { conn, tokenCalls, chatCalls } = harness(() => reply(401, { error: { message: 'invalid token' } }))
    const err = await conn.patchMessage(`${SPACE}/messages/client-abc`, 'x').catch((e: unknown) => e)
    expect((err as GoogleChatApiError).kind).toBe('credential_rejected')
    expect(tokenCalls()).toHaveLength(2)
    expect(chatCalls()).toHaveLength(2)
  })
})

describe('per-Space pacing', () => {
  it('spaces writes into one Space by the interval and leaves another Space unblocked', async () => {
    const { conn, chatCalls } = harness(
      (call) => created(`${call.url.pathname.split('/').slice(2, 4).join('/')}/messages/T.M`),
      {
        sendIntervalMs: 1_000
      }
    )
    await Promise.all([
      conn.createMessage({ space: SPACE, thread: THREAD, clientId: 'client-a', text: 'a' }),
      conn.createMessage({ space: SPACE, thread: THREAD, clientId: 'client-b', text: 'b' }),
      conn.createMessage({ space: DM, clientId: 'client-c', text: 'c' })
    ])
    const at = (id: string) => chatCalls().find((c) => c.url.searchParams.get('messageId') === id)!.at
    expect(at('client-b') - at('client-a')).toBeGreaterThanOrEqual(1_000)
    expect(at('client-c')).toBe(at('client-a'))
  })
})

describe('start() and the app identity', () => {
  it('only warms the token: Google refuses members/app under app authentication, so nothing is read at connect', async () => {
    const { conn, chatCalls, tokenCalls } = harness(() =>
      reply(403, { error: { message: 'Service account authentication does not support app membership' } })
    )
    await conn.start()
    expect(tokenCalls()).toHaveLength(1)
    expect(chatCalls()).toEqual([])
    expect(conn.botUserId).toBeUndefined()
  })

  it('learns the identity from the sender of its first create after start', async () => {
    const { conn } = harness(() => created(`${SPACE}/messages/EXAMPLE_THREAD.first`))
    await conn.start()
    expect(conn.botUserId).toBeUndefined()
    await conn.createMessage({ space: SPACE, thread: THREAD, clientId: 'client-first', text: 'hi' })
    expect(conn.botUserId).toBe(APP_USER)
  })

  it('lists only the named Spaces the app is in for the read port', async () => {
    const { conn } = harness(() =>
      reply(200, {
        spaces: [
          { name: SPACE, spaceType: 'SPACE', displayName: 'Example Space' },
          { name: DM, spaceType: 'DIRECT_MESSAGE' }
        ]
      })
    )
    expect(await conn.listChannels()).toEqual([{ id: SPACE, name: 'Example Space', isPrivate: false }])
  })

  it('answers the read port from spaces.get and never fetches an attachment', async () => {
    const { conn, calls } = harness((call) => {
      if (call.url.pathname === `/v1/${DM}`) return reply(200, { name: DM, spaceType: 'DIRECT_MESSAGE' })
      if (call.url.pathname === `/v1/${DM}/members`)
        return reply(200, {
          memberships: [
            { member: { name: 'users/100000000000000000001', displayName: 'Example Person', type: 'HUMAN' } }
          ]
        })
      return reply(200, { name: SPACE, spaceType: 'SPACE', displayName: 'Example Space' })
    })
    expect(await conn.getChannelInfo(SPACE)).toEqual({
      id: SPACE,
      name: 'Example Space',
      isIm: false,
      isPrivate: false
    })
    // A DM space has no display name of its own: the row is named after the one person in it.
    expect(await conn.getChannelInfo(DM)).toEqual({ id: DM, name: 'Example Person', isIm: true, isPrivate: true })
    const members = calls.find((c) => c.url.pathname === `/v1/${DM}/members`)
    expect(members?.url.searchParams.get('filter')).toBe('member.type = "HUMAN"')
    expect(calls.filter((c) => c.url.pathname === `/v1/${SPACE}/members`)).toHaveLength(0)
    expect(await conn.downloadFile('anything')).toBeNull()
    expect(await conn.listMembers(SPACE)).toEqual([])
    expect(await conn.getUserProfile('users/1')).toEqual({ id: 'users/1' })
  })

  it('leaves a DM row unnamed when its membership read fails or names more than one person', async () => {
    const refused = harness((call) =>
      call.url.pathname === `/v1/${DM}/members`
        ? reply(403, { error: { message: 'no' } })
        : reply(200, { name: DM, spaceType: 'DIRECT_MESSAGE' })
    )
    expect(await refused.conn.getChannelInfo(DM)).toEqual({ id: DM, isIm: true, isPrivate: true })
    const crowded = harness((call) =>
      call.url.pathname === `/v1/${DM}/members`
        ? reply(200, {
            memberships: [
              { member: { name: 'users/100000000000000000001', displayName: 'One', type: 'HUMAN' } },
              { member: { name: 'users/100000000000000000002', displayName: 'Two', type: 'HUMAN' } }
            ]
          })
        : reply(200, { name: DM, spaceType: 'DIRECT_MESSAGE' })
    )
    expect(await crowded.conn.getChannelInfo(DM)).toEqual({ id: DM, isIm: true, isPrivate: true })
  })
})

describe('the tenant fence and the write budget (§10.8)', () => {
  const OTHER_SPACE = 'spaces/EXAMPLE_OTHER'
  const FOREIGN_DM = 'spaces/EXAMPLE_FOREIGN_DM'
  const C1 = 'customers/C0000000001'
  const C2 = 'customers/C0000000002'
  const spaces = [
    { name: SPACE, spaceType: 'SPACE', displayName: 'Example Space', customer: C1 },
    { name: OTHER_SPACE, spaceType: 'SPACE', displayName: 'Other Space', customer: C2 },
    { name: DM, spaceType: 'DIRECT_MESSAGE' }
  ]
  const human = (domainId: string) => ({
    memberships: [{ member: { name: 'users/100000000000000000001', type: 'HUMAN', domainId } }]
  })
  // Google as the fence reads it: each Space's customer, each DM's one human member, every write echoed.
  const answer = (call: Call): Response => {
    const path = call.url.pathname.slice('/v1/'.length)
    if (call.method === 'POST') return created(`${path}/client-x`)
    if (call.method === 'PATCH') return reply(200, { name: path, text: 'edited' })
    if (path === 'spaces') return reply(200, { spaces })
    if (path === SPACE) return reply(200, spaces[0])
    if (path === OTHER_SPACE) return reply(200, spaces[1])
    if (path === DM || path === FOREIGN_DM) return reply(200, { name: path, spaceType: 'DIRECT_MESSAGE' })
    if (path === `${DM}/members`) return reply(200, human('0000000001'))
    if (path === `${FOREIGN_DM}/members`) return reply(200, human('0000000009'))
    return reply(404, { error: { message: `no ${path}` } })
  }
  const chat = (calls: Call[]) => calls.filter((c) => c.url.toString() !== GOOGLE_TOKEN_ENDPOINT)
  const gets = (calls: Call[]) =>
    chat(calls)
      .filter((c) => c.method === 'GET')
      .map((c) => c.url.pathname)
  const writes = (calls: Call[]) =>
    chat(calls)
      .filter((c) => c.method !== 'GET')
      .map((c) => `${c.method} ${c.url.pathname}`)
  const refused = async (attempt: Promise<unknown>) => {
    const err = await attempt.then(
      () => undefined,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(GoogleChatApiError)
    expect((err as GoogleChatApiError).kind).toBe('tenant_refused')
    expect((err as GoogleChatApiError).retryable).toBe(false)
  }

  it('a customer row lists only its customer’s Spaces, and nothing at all without a customer key', async () => {
    const strict = harness(answer, { config: { tenantIds: [C1, 'domains/0000000001'] } })
    expect(await strict.conn.listChannels()).toEqual([{ id: SPACE, name: 'Example Space', isPrivate: false }])
    const domainOnly = harness(answer, { config: { tenantIds: ['domains/0000000001'] } })
    expect(await domainOnly.conn.listChannels()).toEqual([])
    const anchor = harness(answer, { config: { tenantIds: [] } })
    expect(await anchor.conn.listChannels()).toEqual([])
    expect(domainOnly.chatCalls()).toEqual([])
    expect(anchor.chatCalls()).toEqual([])
  })

  it('an organization’s own app lists everything until its customer is known, then its customer’s Spaces alone', async () => {
    const unknown = harness(answer, { config: { ownTenantIds: ['domains/0000000001'] } })
    expect((await unknown.conn.listChannels()).map((s) => s.id)).toEqual([SPACE, OTHER_SPACE])
    const known = harness(answer, { config: { ownTenantIds: [C1, 'domains/0000000001'] } })
    expect((await known.conn.listChannels()).map((s) => s.id)).toEqual([SPACE])
    const none = harness(answer)
    expect((await none.conn.listChannels()).map((s) => s.id)).toEqual([SPACE, OTHER_SPACE])
  })

  it('refuses every write into another customer’s Space before anything is sent, as a recorded refusal', async () => {
    const { conn, calls } = harness(answer, { config: { tenantIds: [C1, 'domains/0000000001'] } })
    await refused(conn.createMessage({ space: OTHER_SPACE, clientId: 'client-a', text: 'hi' }))
    await refused(conn.patchMessage(`${OTHER_SPACE}/messages/client-a`, 'edit'))
    await refused(conn.postChrome(OTHER_SPACE, undefined, 'notice'))
    expect(writes(calls)).toEqual([])
    // The Space's tenant was read once for the three attempts.
    expect(gets(calls)).toEqual([`/v1/${OTHER_SPACE}`])
  })

  it('withdraws a message as a write: fenced to its own customer and taking one budget token', async () => {
    const clock = fakeClock()
    const budget = new GoogleChatWriteBudget({ capacity: 1, refillPerMinute: 60 }, clock.now, clock.sleep)
    const { conn, calls } = harness((call) => (call.method === 'DELETE' ? reply(200, {}) : answer(call)), {
      budget,
      config: { tenantIds: [C1] }
    })
    await refused(conn.deleteOwnMessage(`${OTHER_SPACE}/messages/client-a`))
    await conn.deleteOwnMessage(`${SPACE}/messages/client-a`)
    await conn.deleteOwnMessage(`${SPACE}/messages/client-b`)
    expect(writes(calls)).toEqual([`DELETE /v1/${SPACE}/messages/client-a`, `DELETE /v1/${SPACE}/messages/client-b`])
    expect(clock.slept).toEqual([1000])
  })

  it('writes into its own customer’s Space and its own people’s DM, reading each Space’s tenant once', async () => {
    const { conn, calls } = harness(answer, { config: { tenantIds: [C1, 'domains/0000000001'] } })
    await conn.createMessage({ space: SPACE, thread: THREAD, clientId: 'client-a', text: 'hi' })
    await conn.patchMessage(`${SPACE}/messages/client-a`, 'edit')
    await conn.createMessage({ space: DM, clientId: 'client-b', text: 'hello' })
    await conn.createMessage({ space: DM, clientId: 'client-c', text: 'again' })
    expect(writes(calls)).toEqual([
      `POST /v1/${SPACE}/messages`,
      `PATCH /v1/${SPACE}/messages/client-a`,
      `POST /v1/${DM}/messages`,
      `POST /v1/${DM}/messages`
    ])
    expect(gets(calls)).toEqual([`/v1/${SPACE}`, `/v1/${DM}`, `/v1/${DM}/members`])
  })

  it('refuses a DM outside a customer row’s domains, while an own app’s DMs pass without a membership read', async () => {
    const strict = harness(answer, { config: { tenantIds: [C1, 'domains/0000000001'] } })
    await refused(strict.conn.createMessage({ space: FOREIGN_DM, clientId: 'client-a', text: 'hi' }))
    expect(writes(strict.calls)).toEqual([])
    const own = harness(answer, { config: { ownTenantIds: [C1] } })
    await own.conn.createMessage({ space: FOREIGN_DM, clientId: 'client-a', text: 'hi' })
    await refused(own.conn.createMessage({ space: OTHER_SPACE, clientId: 'client-b', text: 'hi' }))
    expect(writes(own.calls)).toEqual([`POST /v1/${FOREIGN_DM}/messages`])
    expect(gets(own.calls)).toEqual([`/v1/${FOREIGN_DM}`, `/v1/${OTHER_SPACE}`])
  })

  it('a row without tenant keys keeps writing anywhere, with no tenant read at all', async () => {
    const { conn, calls } = harness(answer)
    await conn.createMessage({ space: OTHER_SPACE, clientId: 'client-a', text: 'hi' })
    await conn.createMessage({ space: FOREIGN_DM, clientId: 'client-b', text: 'hi' })
    expect(gets(calls)).toEqual([])
    expect(writes(calls)).toHaveLength(2)
  })

  it('takes one token of the app budget per create and patch under the Space queue, delaying and never dropping', async () => {
    const takes: number[] = []
    const budget = new GoogleChatWriteBudget({ capacity: 2, refillPerMinute: 60 })
    const original = budget.take.bind(budget)
    budget.take = () => {
      takes.push(takes.length + 1)
      return original()
    }
    // Two writes fit the burst; the third and fourth each wait one refill on the connection's fake clock.
    const clock = fakeClock()
    const budgeted = new GoogleChatWriteBudget({ capacity: 2, refillPerMinute: 60 }, clock.now, clock.sleep)
    const { conn, calls } = harness(answer, { budget: budgeted })
    await Promise.all([
      conn.createMessage({ space: SPACE, thread: THREAD, clientId: 'client-a', text: 'one' }),
      conn.createMessage({ space: OTHER_SPACE, clientId: 'client-b', text: 'two' }),
      conn.patchMessage(`${SPACE}/messages/client-a`, 'three'),
      conn.createMessage({ space: DM, clientId: 'client-c', text: 'four' })
    ])
    expect(writes(calls)).toHaveLength(4)
    expect(clock.slept).toEqual([1000, 1000])
    // Reads never spend the budget.
    const reader = harness(answer, { budget })
    await reader.conn.getMessage(`${SPACE}/messages/client-a`)
    await reader.conn.listChannels()
    expect(takes).toEqual([])
  })
})
