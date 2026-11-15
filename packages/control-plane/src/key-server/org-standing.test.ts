import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { KeyServerOrgStanding, ORG_STANDING_TTL_MS, standingRefusal } from './org-standing.js'

const SUSPENDED_MESSAGE = 'Your organization is out of credit. Add credit at https://console.example.test/billing.'

type Answer = { status: number; body: unknown } | Error

/** A key server that answers from a script and records every request. */
function keyServer(...answers: Answer[]) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = []
  const fetch = (async (url: URL | string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body))
    })
    const answer = answers.length > 1 ? answers.shift()! : answers[0]!
    if (answer instanceof Error) throw answer
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const allowed = { status: 200, body: { allowed: true } }
const suspended = (status = 402) => ({
  status,
  body: { error: { code: 'org_suspended', message: SUSPENDED_MESSAGE } }
})

function standing(fetch: typeof globalThis.fetch, opts: { tokenPath?: string; clock?: FakeClock } = {}) {
  return new KeyServerOrgStanding('http://key-server.example.test:8080', {
    clock: opts.clock ?? new FakeClock(1_000),
    fetch,
    ...(opts.tokenPath ? { tokenPath: opts.tokenPath } : {})
  })
}

describe('KeyServerOrgStanding', () => {
  it('asks POST /v1/org-standing with the org alone and a bearer re-read from its file per request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'org-standing-'))
    const tokenPath = join(dir, 'token')
    writeFileSync(tokenPath, 'first-token\n')
    const server = keyServer(allowed)
    const clock = new FakeClock(1_000)
    const client = standing(server.fetch, { tokenPath, clock })

    expect(await client.check('org-1')).toEqual({ allowed: true })
    writeFileSync(tokenPath, 'rotated-token')
    expect(await client.check('org-2')).toEqual({ allowed: true })

    expect(server.calls.map((c) => c.url)).toEqual([
      'http://key-server.example.test:8080/v1/org-standing',
      'http://key-server.example.test:8080/v1/org-standing'
    ])
    expect(server.calls.map((c) => c.body)).toEqual([{ orgId: 'org-1' }, { orgId: 'org-2' }])
    expect(server.calls.map((c) => c.headers.authorization)).toEqual(['Bearer first-token', 'Bearer rotated-token'])
  })

  it('sends no Authorization header without a token path', async () => {
    const server = keyServer(allowed)
    await standing(server.fetch).check('org-1')
    expect(server.calls[0]!.headers).not.toHaveProperty('authorization')
  })

  it('passes a suspension through with the stop’s own status and the key server’s message', async () => {
    const verdict = await standing(keyServer(suspended(403)).fetch).check('org-1')
    expect(verdict).toEqual({ allowed: false, reason: 'suspended', status: 403, message: SUSPENDED_MESSAGE })
    expect(await standing(keyServer(suspended(402)).fetch).check('org-1')).toMatchObject({ status: 402 })
  })

  it('reads an `unavailable` answer, any other refusal, and a malformed allowance as unable to say', async () => {
    const outage = { status: 503, body: { error: { code: 'unavailable', message: 'upstream down' } } }
    expect(await standing(keyServer(outage).fetch).check('org-1')).toMatchObject({
      allowed: false,
      reason: 'unavailable',
      status: 503
    })
    const quota = { status: 403, body: { error: { code: 'quota_denied', message: 'limit' } } }
    expect(await standing(keyServer(quota).fetch).check('org-1')).toMatchObject({ reason: 'unavailable' })
    const malformed = { status: 200, body: { allowed: false } }
    expect(await standing(keyServer(malformed).fetch).check('org-1')).toMatchObject({ reason: 'unavailable' })
    const html = { status: 502, body: '<html>' }
    expect(await standing(keyServer(html).fetch).check('org-1')).toMatchObject({ reason: 'unavailable' })
  })

  it('reads a network failure or an unreadable token as unable to say', async () => {
    const down = await standing(keyServer(new TypeError('fetch failed')).fetch).check('org-1')
    expect(down).toMatchObject({ allowed: false, reason: 'unavailable' })
    expect((down as { message: string }).message).toMatch(/fetch failed/)
    const missing = standing(keyServer(allowed).fetch, { tokenPath: join(tmpdir(), 'no-such-token-file') })
    expect(await missing.check('org-1')).toMatchObject({ reason: 'unavailable' })
  })

  it('caches an allowance per org for one TTL on the injected clock', async () => {
    const clock = new FakeClock(1_000)
    const server = keyServer(allowed)
    const client = standing(server.fetch, { clock })

    await client.check('org-1')
    await client.check('org-1')
    await client.check('org-2')
    expect(server.calls.map((c) => c.body)).toEqual([{ orgId: 'org-1' }, { orgId: 'org-2' }])

    clock.advance(ORG_STANDING_TTL_MS - 1)
    await client.check('org-1')
    expect(server.calls).toHaveLength(2)
    clock.advance(1)
    await client.check('org-1')
    expect(server.calls).toHaveLength(3)
  })

  it('holds a suspension no longer than the TTL, and never caches an unanswered check', async () => {
    const clock = new FakeClock(1_000)
    const server = keyServer(suspended(), suspended(), allowed)
    const client = standing(server.fetch, { clock })

    expect(await client.check('org-1')).toMatchObject({ reason: 'suspended' })
    clock.advance(ORG_STANDING_TTL_MS - 1)
    expect(await client.check('org-1')).toMatchObject({ reason: 'suspended' })
    expect(server.calls).toHaveLength(1)
    clock.advance(1)
    await client.check('org-1')
    clock.advance(ORG_STANDING_TTL_MS)
    // Topped up: the next question after the TTL lets it through.
    expect(await client.check('org-1')).toEqual({ allowed: true })
    expect(server.calls).toHaveLength(3)

    const flaky = keyServer(new TypeError('fetch failed'), allowed)
    const retried = standing(flaky.fetch, { clock })
    expect(await retried.check('org-1')).toMatchObject({ reason: 'unavailable' })
    expect(await retried.check('org-1')).toEqual({ allowed: true })
    expect(flaky.calls).toHaveLength(2)
  })

  it('joins concurrent checks for one org into one request', async () => {
    const server = keyServer(allowed)
    const client = standing(server.fetch)
    await Promise.all([client.check('org-1'), client.check('org-1'), client.check('org-1')])
    expect(server.calls).toHaveLength(1)
  })

  it('refuses a non-http address and credentials in the URL', () => {
    const opts = { clock: new FakeClock() }
    expect(() => new KeyServerOrgStanding('ftp://key-server.example.test', opts)).toThrow(/http or https/)
    expect(() => new KeyServerOrgStanding('https://user:pass@key-server.example.test', opts)).toThrow(/credentials/)
  })
})

describe('standingRefusal', () => {
  it('lets everything through with no gate configured', async () => {
    expect(await standingRefusal(undefined, 'org-1')).toBeNull()
  })

  it('names a suspension with the key server’s words, and an unanswered check with a fixed line it logs', async () => {
    const warned: unknown[] = []
    const log = { warn: (obj: unknown) => warned.push(obj) }
    const suspendedGate = {
      check: async () => ({ allowed: false, reason: 'suspended', status: 402, message: 'out of credit' }) as const
    }
    expect(await standingRefusal(suspendedGate, 'org-1', log)).toEqual({
      code: 'org_suspended',
      message: 'out of credit'
    })
    const downGate = {
      check: async () => ({ allowed: false, reason: 'unavailable', message: 'fetch failed' }) as const
    }
    const down = await standingRefusal(downGate, 'org-1', log)
    expect(down).toMatchObject({ code: 'standing_unavailable' })
    expect(down!.message).not.toMatch(/fetch failed/)
    expect(warned).toEqual([{ orgId: 'org-1', reason: 'fetch failed' }])
    expect(await standingRefusal({ check: async () => ({ allowed: true }) as const }, 'org-1', log)).toBeNull()
  })
})
