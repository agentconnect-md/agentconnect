import { describe, expect, it } from 'vitest'
import { slackExternalReason } from '../src/slack-place-trust.js'

describe('slackExternalReason', () => {
  it('reads a Slack Connect channel, or one invited to become one, as external', () => {
    expect(slackExternalReason({ id: 'C1', is_ext_shared: true })).toBe('externallyShared')
    expect(slackExternalReason({ id: 'C2', is_pending_ext_shared: true })).toBe('externallyShared')
  })

  it('finds no share on a plain channel, public or private', () => {
    expect(slackExternalReason({ id: 'C3', is_ext_shared: false })).toBeNull()
    expect(slackExternalReason({ id: 'G4', is_private: true })).toBeNull()
  })
})
