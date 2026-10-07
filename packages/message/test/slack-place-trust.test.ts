import { describe, expect, it } from 'vitest'
import {
  isSlackGuest,
  SLACK_CHANNEL_SHARED_TRUST,
  SLACK_GUEST_JOINED_TRUST,
  slackListedChannelTrust,
  SlackPendingTrust
} from '../src/slack-place-trust.js'

describe('slackListedChannelTrust', () => {
  it('reads a Slack Connect channel, or one invited to become one, as external', () => {
    expect(slackListedChannelTrust({ id: 'C1', is_ext_shared: true })).toEqual({
      level: 'external',
      reason: 'externallyShared'
    })
    expect(slackListedChannelTrust({ id: 'C2', is_pending_ext_shared: true }).level).toBe('external')
  })

  it('reads a plain channel, public or private, as internal', () => {
    expect(slackListedChannelTrust({ id: 'C3', is_ext_shared: false })).toEqual({
      level: 'internal',
      reason: 'verifiedInternal'
    })
    expect(slackListedChannelTrust({ id: 'G4', is_private: true }).level).toBe('internal')
  })
})

describe('isSlackGuest', () => {
  it('counts multi-channel and single-channel guests, not full members or unknown answers', () => {
    expect(isSlackGuest({ is_restricted: true })).toBe(true)
    expect(isSlackGuest({ is_ultra_restricted: true })).toBe(true)
    expect(isSlackGuest({ is_restricted: false, is_ultra_restricted: false })).toBe(false)
    expect(isSlackGuest(undefined)).toBe(false)
  })
})

describe('SlackPendingTrust', () => {
  const listed = [
    { id: 'C1', trust: slackListedChannelTrust({}) },
    { id: 'C2', trust: slackListedChannelTrust({}) }
  ]

  it('overlays an event detection on the next listing once, even when the listing has not caught up', () => {
    const pending = new SlackPendingTrust()
    pending.note('C1', SLACK_CHANNEL_SHARED_TRUST)
    pending.note('C9', SLACK_GUEST_JOINED_TRUST)
    expect(pending.apply(listed)).toEqual([
      { id: 'C1', trust: SLACK_CHANNEL_SHARED_TRUST },
      { id: 'C2', trust: { level: 'internal', reason: 'verifiedInternal' } }
    ])
    expect(pending.apply(listed)).toEqual(listed)
  })

  it('returns the listing unchanged when nothing is pending', () => {
    expect(new SlackPendingTrust().apply(listed)).toBe(listed)
  })
})
