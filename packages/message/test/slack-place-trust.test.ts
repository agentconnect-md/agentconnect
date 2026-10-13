import { describe, expect, it } from 'vitest'
import {
  slackEnvelopeExternallyShared,
  slackExternalReason,
  slackFullMember,
  slackMemberExternalReason
} from '../src/slack-place-trust.js'

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

describe('slackEnvelopeExternallyShared', () => {
  it('reads the envelope flag Slack sets on every event from a Slack Connect channel', () => {
    expect(slackEnvelopeExternallyShared({ type: 'event_callback', is_ext_shared_channel: true })).toBe(true)
    expect(slackEnvelopeExternallyShared({ type: 'event_callback', is_ext_shared_channel: false })).toBe(false)
    expect(slackEnvelopeExternallyShared(undefined)).toBe(false)
  })
})

// assistant-mode.md §5.3: a guest, or someone from another organization, joining a channel makes it external.
describe('slackMemberExternalReason', () => {
  const home = { teamId: 'T1' }

  it('reads single- and multi-channel guests as guests', () => {
    expect(slackMemberExternalReason({ id: 'U1', team_id: 'T1', is_restricted: true }, home)).toBe('guestMember')
    expect(slackMemberExternalReason({ id: 'U2', team_id: 'T1', is_ultra_restricted: true }, home)).toBe('guestMember')
  })

  it('reads a member of another workspace as external, and a full member as nothing', () => {
    expect(slackMemberExternalReason({ id: 'U3', team_id: 'T9' }, home)).toBe('externalMember')
    expect(slackMemberExternalReason({ id: 'U4', team_id: 'T1' }, home)).toBeNull()
  })

  it('keeps another workspace of the same enterprise internal', () => {
    const grid = { teamId: 'T1', enterpriseId: 'E1' }
    expect(slackMemberExternalReason({ id: 'U5', team_id: 'T2', enterprise_user: { enterprise_id: 'E1' } }, grid)).toBe(
      null
    )
    expect(slackMemberExternalReason({ id: 'U6', team_id: 'T8', enterprise_user: { enterprise_id: 'E8' } }, grid)).toBe(
      'externalMember'
    )
  })

  it('cannot tell an organization apart without knowing its own, so it reports only guests then', () => {
    expect(slackMemberExternalReason({ id: 'U7', team_id: 'T9' }, {})).toBeNull()
  })
})

// assistant-mode.md §5.5: only a full member of the installing workspace approves a draft.
describe('slackFullMember', () => {
  const home = { teamId: 'T1' }

  it('takes a person of the installing workspace, and no guest, outside member, bot or deactivated account', () => {
    expect(slackFullMember({ id: 'U1', team_id: 'T1' }, home)).toBe(true)
    for (const user of [
      { id: 'U2', team_id: 'T1', is_restricted: true },
      { id: 'U3', team_id: 'T1', is_ultra_restricted: true },
      { id: 'U4', team_id: 'T9' },
      { id: 'U5', team_id: 'T1', is_stranger: true },
      { id: 'U6', team_id: 'T1', is_bot: true },
      { id: 'U7', team_id: 'T1', deleted: true }
    ])
      expect(slackFullMember(user, home), user.id).toBe(false)
  })

  it('does not take a member of another workspace of the same enterprise, whom detection keeps internal', () => {
    const grid = { teamId: 'T1', enterpriseId: 'E1' }
    const sibling = { id: 'U8', team_id: 'T2', enterprise_user: { enterprise_id: 'E1' } }
    expect(slackMemberExternalReason(sibling, grid)).toBeNull()
    expect(slackFullMember(sibling, grid)).toBe(false)
  })

  it('takes no one without knowing its own workspace', () => {
    expect(slackFullMember({ id: 'U9', team_id: 'T1' }, {})).toBe(false)
    expect(slackFullMember({ id: 'U9', team_id: '' }, { teamId: '' })).toBe(false)
  })
})
