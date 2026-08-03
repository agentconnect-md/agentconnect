import { describe, it, expect } from 'vitest'
import { loopGuardScopesFor, type LoopGuardMessage } from '../src/platforms/loop-guard.js'

/**
 * The strategy's whole reason to exist is Slack's unstable top-level coordinates:
 * a top-level post is normalized with `thread` = its own event ts, so every fresh
 * root would mint a virgin guard scope and two bots alternating roots could never
 * trip the circuit. These pin the three answers core depends on — is there a
 * coarse circuit, is THIS message a root, and does everyone else stay
 * coordinate-only.
 */
const msg = (over: Partial<LoopGuardMessage>): LoopGuardMessage => ({
  platform: 'slack',
  channel: 'C1',
  msgId: 'slack:C1:1700000000.001',
  isDm: false,
  ...over
})

describe('loop-guard scopes', () => {
  it('collapses a Slack top-level root into the channel circuit', () => {
    // thread === the msgId's own ts is exactly the normalized top-level shape.
    const scopes = loopGuardScopesFor(msg({ thread: '1700000000.001' }))
    expect(scopes.coarse).toBe('slack:C1:top-level')
    expect(scopes.isRoot).toBe(true)
  })

  it('leaves a reply inside an established Slack thread on its own scope', () => {
    // Same channel, but the thread root is an EARLIER message — coordinates are
    // stable here, so the coarse circuit must not swallow the conversation.
    const scopes = loopGuardScopesFor(msg({ thread: '1699999999.900' }))
    expect(scopes.coarse).toBe('slack:C1:top-level')
    expect(scopes.isRoot).toBe(false)
  })

  it('offers no coarse circuit for a Slack DM', () => {
    // A DM has no channel-wide notion to collapse into, and its coordinates are
    // already channel-level.
    const scopes = loopGuardScopesFor(msg({ isDm: true, channel: 'D1', msgId: 'slack:D1:1700000000.001' }))
    expect(scopes.coarse).toBeUndefined()
    expect(scopes.isRoot).toBe(false)
  })

  it('treats a msgId that is not canonically shaped as a non-root', () => {
    // Fail closed: an unrecognized id must not be read as a fresh root, which
    // would route an ordinary reply onto the shared channel circuit.
    const scopes = loopGuardScopesFor(msg({ msgId: 'something-else', thread: '1700000000.001' }))
    expect(scopes.isRoot).toBe(false)
  })

  it('leaves every other platform coordinate-only', () => {
    // Their thread roots are stable, so coordinates key the circuit correctly.
    // The default is "no coarse circuit", NOT "Slack's, disabled".
    for (const platform of ['telegram', 'discord', 'feishu', 'some-future-platform']) {
      const scopes = loopGuardScopesFor(msg({ platform, thread: 'root-1' }))
      expect(scopes.coarse).toBeUndefined()
      expect(scopes.isRoot).toBe(false)
    }
  })
})
