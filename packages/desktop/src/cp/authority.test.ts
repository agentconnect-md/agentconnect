import { describe, expect, it } from 'vitest'
import { Computer } from '../computer.js'
import { FakeDriver, testConfig } from '../testing.js'
import { ChannelAuthority, type AuthorityState } from './authority.js'

function harness(options: { registered?: boolean; revokedReason?: string } = {}) {
  let now = 1_760_000_000_000
  const timers: { fn: () => void; at: number }[] = []
  const lost: AuthorityState[] = []
  const authority = new ChannelAuthority({
    registered: options.registered ?? true,
    ...(options.revokedReason ? { revokedReason: options.revokedReason } : {}),
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, at: now + ms }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as (typeof timers)[number])
      if (index >= 0) timers.splice(index, 1)
    },
    onLost: (state) => lost.push(state)
  })
  const advance = (ms: number) => {
    now += ms
    for (const timer of timers.filter((t) => t.at <= now)) {
      timers.splice(timers.indexOf(timer), 1)
      timer.fn()
    }
  }
  const credential = (keyId: string, ttlMs = 300_000) => ({
    keyId,
    key: Buffer.alloc(32, keyId.length).toString('base64url'),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString()
  })
  return { authority, advance, credential, lost, now: () => now }
}

describe('ChannelAuthority', () => {
  it('leaves an unregistered desktop on its local tokens', () => {
    const { authority } = harness({ registered: false })
    expect(authority.state()).toEqual({ kind: 'local' })
    expect(authority.refusal()).toBeUndefined()
  })

  it('refuses a registered desktop until the CP issues a key, then until that key runs out', () => {
    const { authority, advance, credential, lost } = harness()
    expect(authority.refusal()).toMatch(/not connected/)
    authority.accept(credential('a'))
    expect(authority.refusal()).toBeUndefined()
    advance(299_999)
    expect(authority.refusal()).toBeUndefined()
    advance(1)
    expect(authority.refusal()).toMatch(/not connected/)
    expect(lost).toEqual([{ kind: 'lapsed', reason: 'not connected to the Control Plane' }])
  })

  it('keeps acting while renewals arrive and keeps the previous key until it expires', () => {
    const { authority, advance, credential, lost } = harness()
    authority.accept(credential('a'))
    advance(150_000)
    authority.accept(credential('b'))
    expect(authority.key('a')).toBeDefined()
    advance(200_000)
    expect(authority.key('a')).toBeUndefined()
    expect(authority.key('b')).toBeDefined()
    expect(lost).toEqual([])
  })

  it('reads expiries against the CP clock, so a fast local clock does not stretch a key', () => {
    const { authority, credential, now } = harness()
    // The local clock runs 60 s ahead of the CP's.
    authority.syncClock(new Date(now() - 60_000).toISOString())
    authority.accept({ ...credential('a'), expiresAt: new Date(now() - 60_000 + 30_000).toISOString() })
    const state = authority.state()
    expect(state.kind === 'active' && state.expiresAt).toBe(now() + 30_000)
  })

  it('drops every key at a revoke and never takes one back', () => {
    const { authority, credential, lost } = harness()
    authority.accept(credential('a'))
    authority.revoke('revoked by the Control Plane')
    expect(authority.key('a')).toBeUndefined()
    authority.accept(credential('b'))
    expect(authority.refusal()).toMatch(/revoked/)
    expect(lost).toEqual([{ kind: 'revoked', reason: 'revoked by the Control Plane' }])
  })

  it('starts refused when the registration file already records a revoke', () => {
    const { authority } = harness({ revokedReason: 'deleted' })
    expect(authority.state()).toEqual({ kind: 'revoked', reason: 'deleted' })
  })

  it('makes the Computer refuse input, screenshots and viewer control without authority', async () => {
    const { authority, credential } = harness()
    const driver = new FakeDriver()
    const computer = new Computer({
      driver,
      config: testConfig({ actionScreenshot: false }),
      sleep: async () => undefined,
      refusal: () => authority.refusal()
    })
    const refused = async (output: Promise<{ isError?: boolean; content: { text?: string }[] }>) => {
      const result = await output
      expect(result.isError).toBe(true)
      return JSON.parse(result.content[0]!.text!) as { error: string }
    }
    expect((await refused(computer.screenshot('claude'))).error).toBe('unavailable')
    expect((await refused(computer.click('claude', { x: 1, y: 1 }))).error).toBe('unavailable')
    expect(() => computer.takeOver('viewer')).toThrow(/not connected/)
    await expect(computer.frame()).rejects.toThrow(/not connected/)
    expect(driver.calls).toEqual([])

    authority.accept(credential('a'))
    expect((await computer.click('claude', { x: 1, y: 1 })).isError).toBeUndefined()
    expect(computer.liveStatus()).toBe('busy')
    authority.revoke('revoked')
    computer.suspend('computer revoked')
    expect(computer.liveStatus()).toBe('online')
    expect((await refused(computer.type('claude', { text: 'x' }))).error).toBe('unavailable')
  })
})
