import { describe, it, expect, vi } from 'vitest'
import type { RcVerifyResult } from '@agentconnect.md/protocol'
import { WebchatVerdictCache, webchatTokenExpiryMs } from './webchat-verdict-cache.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const DAEMON = '22222222-2222-4222-8222-222222222222'
const CONV = '33333333-3333-4333-8333-333333333333'
const T0 = 1_800_000_000_000

const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url')
/** A JWT-shaped token; the cache reads only `exp`, never the signature. */
const token = (expSec: number | undefined, nonce = 'a'): string =>
  `${b64({ alg: 'HS256' })}.${b64({ sub: 'user-1', nonce, ...(expSec !== undefined ? { exp: expSec } : {}) })}.sig`

const OK: RcVerifyResult = {
  ok: true,
  agentId: AGENT,
  daemonId: DAEMON,
  conversationId: CONV,
  participants: [{ agentId: AGENT, daemonId: DAEMON, primary: true }]
}

function build(verdict: () => Promise<RcVerifyResult> = async () => OK) {
  let now = T0
  const verify = vi.fn(verdict)
  const cache = new WebchatVerdictCache<[token: string]>(verify, () => now)
  return { cache, verify, advance: (ms: number) => (now += ms) }
}

describe('webchatTokenExpiryMs', () => {
  it('reads `exp` from the payload, and nothing from a malformed token', () => {
    expect(webchatTokenExpiryMs(token(1_800_000_300))).toBe(1_800_000_300_000)
    expect(webchatTokenExpiryMs(token(undefined))).toBeUndefined()
    expect(webchatTokenExpiryMs('not-a-jwt')).toBeUndefined()
    expect(webchatTokenExpiryMs('a.!!!.c')).toBeUndefined()
  })
})

describe('WebchatVerdictCache', () => {
  it('answers a live token from the cache for a minute, then asks the CP again so a revoked member is refused', async () => {
    const { cache, verify, advance } = build()
    const t = token(T0 / 1000 + 300)
    expect(await cache.verify(t)).toMatchObject(OK)
    advance(59_000)
    expect(await cache.verify(t)).toMatchObject(OK)
    expect(verify).toHaveBeenCalledTimes(1)
    advance(1_000) // a minute after verification: expired, though the token lives on
    await cache.verify(t)
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it('never answers from the cache past the token’s own exp', async () => {
    const { cache, verify, advance } = build()
    const t = token(T0 / 1000 + 30)
    await cache.verify(t)
    advance(29_000)
    await cache.verify(t)
    expect(verify).toHaveBeenCalledTimes(1)
    advance(1_000) // exactly exp: expired
    await cache.verify(t)
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it('dates a verdict by its CP verification, which a cache hit keeps', async () => {
    const { cache, advance } = build()
    const t = token(T0 / 1000 + 300)
    expect((await cache.verify(t)).verifiedAtMs).toBe(T0)
    advance(30_000)
    expect((await cache.verify(t)).verifiedAtMs).toBe(T0)
  })

  it('dates a verdict when its request starts, so an older verification that resolves later ranks lower', async () => {
    const settle: Array<() => void> = []
    const { cache, advance } = build(() => new Promise<RcVerifyResult>((resolve) => settle.push(() => resolve(OK))))
    const older = cache.verify(token(T0 / 1000 + 300, 'a'))
    advance(1_000)
    const newer = cache.verify(token(T0 / 1000 + 300, 'b'))
    settle[1]!()
    settle[0]!()
    expect((await newer).verifiedAtMs).toBe(T0 + 1_000)
    expect((await older).verifiedAtMs).toBe(T0)
  })

  it('keys by token, so a different token is its own verification', async () => {
    const { cache, verify } = build()
    await cache.verify(token(T0 / 1000 + 300, 'a'))
    await cache.verify(token(T0 / 1000 + 300, 'b'))
    expect(verify).toHaveBeenCalledTimes(2)
    expect(cache.size()).toBe(2)
  })

  it('never caches a refusal or a verify that threw', async () => {
    const refusal: RcVerifyResult = { ok: false, reason: 'daemon offline' }
    const { cache, verify } = build(async () => refusal)
    const t = token(T0 / 1000 + 300)
    expect(await cache.verify(t)).toMatchObject(refusal)
    expect(await cache.verify(t)).toMatchObject(refusal)
    expect(verify).toHaveBeenCalledTimes(2)

    verify.mockRejectedValueOnce(new Error('link down'))
    await expect(cache.verify(t)).rejects.toThrow('link down')
    expect(cache.size()).toBe(0)
  })

  it('does not cache a token without an exp, or one already expired', async () => {
    const { cache, verify } = build()
    await cache.verify(token(undefined))
    await cache.verify(token(undefined))
    await cache.verify(token(T0 / 1000 - 1))
    expect(verify).toHaveBeenCalledTimes(3)
    expect(cache.size()).toBe(0)
  })

  it('hands every caller its own copy, so healing one placement cannot rewrite the cached verdict', async () => {
    const { cache } = build()
    const t = token(T0 / 1000 + 300)
    const first = await cache.verify(t)
    first.participants![0]!.daemonId = '44444444-4444-4444-8444-444444444444'
    expect((await cache.verify(t)).participants![0]!.daemonId).toBe(DAEMON)
  })

  it('drops expired entries when a new verdict is stored', async () => {
    const { cache, advance } = build()
    await cache.verify(token(T0 / 1000 + 60, 'short'))
    advance(61_000)
    await cache.verify(token(T0 / 1000 + 600, 'long'))
    expect(cache.size()).toBe(1)
  })

  it('keys a fixed-lifetime cache by every argument, as the agent chat API caches a key per agent and chat id', async () => {
    let now = T0
    const verify = vi.fn(async (_key: string, _agentId: string, _chatId: string) => OK)
    const cache = new WebchatVerdictCache<[string, string, string]>(
      verify,
      () => now,
      (_args, verifiedAtMs) => verifiedAtMs + 60_000
    )
    await cache.verify('key', AGENT, 'chat-1')
    await cache.verify('key', AGENT, 'chat-1')
    await cache.verify('key', AGENT, 'chat-2')
    expect(verify).toHaveBeenCalledTimes(2)
    now += 60_000
    await cache.verify('key', AGENT, 'chat-1')
    expect(verify).toHaveBeenCalledTimes(3)
  })
})
