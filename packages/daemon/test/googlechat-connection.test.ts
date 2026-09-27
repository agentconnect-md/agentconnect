/**
 * The Google Chat Layer-1 connection (google-chat-integration.md §5): the JWT-bearer token mint and its
 * cache, the create/patch request shapes, reconciliation of an ambiguous create by client id, thread and
 * credential failures, 429 backoff, per-Space pacing, and app-identity discovery. Nothing here reaches Google.
 */
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
function harness(handler: Handler, opts: { sendIntervalMs?: number; log?: string[] } = {}) {
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
    group: group(),
    log: logger,
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
    // The create response's sender is the fallback identity source.
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

describe('start() discovers the app identity', () => {
  it('reads members/app in a Space the app is in, and lists named Spaces for the read port', async () => {
    const { conn, chatCalls } = harness((call) => {
      if (call.url.pathname === '/v1/spaces')
        return reply(200, {
          spaces: [
            { name: SPACE, spaceType: 'SPACE', displayName: 'Example Space' },
            { name: DM, spaceType: 'DIRECT_MESSAGE' }
          ]
        })
      if (call.url.pathname === `/v1/${SPACE}/members/app`)
        return reply(200, { member: { name: APP_USER, type: 'BOT' } })
      return reply(404, {})
    })
    await conn.start()
    expect(conn.botUserId).toBe(APP_USER)
    expect(chatCalls().map((c) => c.url.pathname)).toEqual(['/v1/spaces', `/v1/${SPACE}/members/app`])
    expect(await conn.listChannels()).toEqual([{ id: SPACE, name: 'Example Space', isPrivate: false }])
  })

  it('leaves the identity unknown when the app is in no Space yet', async () => {
    const { conn } = harness(() => reply(200, {}))
    await conn.start()
    expect(conn.botUserId).toBeUndefined()
  })

  it('answers the read port from spaces.get and never fetches an attachment', async () => {
    const { conn } = harness((call) =>
      call.url.pathname === `/v1/${DM}`
        ? reply(200, { name: DM, spaceType: 'DIRECT_MESSAGE' })
        : reply(200, { name: SPACE, spaceType: 'SPACE', displayName: 'Example Space' })
    )
    expect(await conn.getChannelInfo(SPACE)).toEqual({
      id: SPACE,
      name: 'Example Space',
      isIm: false,
      isPrivate: false
    })
    expect(await conn.getChannelInfo(DM)).toEqual({ id: DM, isIm: true, isPrivate: true })
    expect(await conn.downloadFile('anything')).toBeNull()
    expect(await conn.listMembers(SPACE)).toEqual([])
    expect(await conn.getUserProfile('users/1')).toEqual({ id: 'users/1' })
  })
})
