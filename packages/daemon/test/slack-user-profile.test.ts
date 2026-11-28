import { describe, expect, it } from 'vitest'
import { SlackConnection } from '../src/slack/connection.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

// A Slack connection whose `users.info` / `users.lookupByEmail` answer from the given stubs.
function connWith(users: {
  info?: (a: { user: string }) => Promise<unknown>
  lookupByEmail?: (a: { email: string }) => Promise<unknown>
}): SlackConnection {
  const factory = fakeSlackAppFactory()
  return new SlackConnection(
    {
      group: { appToken: 'xapp-1', botToken: 'xoxb-a', integrations: [] },
      onMessage: () => {},
      newTraceId: () => 't'
    } as never,
    ((opts: unknown) => {
      const app = factory(opts as never) as any
      if (users.info) app.client.users.info = users.info
      if (users.lookupByEmail) app.client.users.lookupByEmail = users.lookupByEmail
      return app
    }) as never
  )
}

const ADA = {
  id: 'U0ADA',
  name: 'ada',
  real_name: 'Ada Example',
  is_bot: false,
  profile: {
    title: 'Backend Engineer',
    email: 'ada@example.com',
    status_text: 'On holiday',
    status_emoji: ':palm_tree:',
    status_expiration: 1_800_000_000,
    image_72: 'https://example.com/ada.png'
  }
}

function slackError(code: string): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), { data: { ok: false, error: code } })
}

describe('a Slack profile read', () => {
  it('carries the title, status and its expiry users.info reports, never the email', async () => {
    const conn = connWith({ info: async () => ({ user: ADA }) })
    expect(await conn.getUserProfile('U0ADA')).toEqual({
      id: 'U0ADA',
      name: 'ada',
      realName: 'Ada Example',
      isBot: false,
      avatarUrl: 'https://example.com/ada.png',
      title: 'Backend Engineer',
      statusText: 'On holiday',
      statusEmoji: ':palm_tree:',
      statusExpiresAt: '2027-01-15T08:00:00.000Z'
    })
  })

  it('leaves out an empty status and a status that never expires', async () => {
    const conn = connWith({
      info: async () => ({
        user: { id: 'U0BOB', name: 'bob', profile: { status_text: '', status_emoji: '', status_expiration: 0 } }
      })
    })
    const profile = await conn.getUserProfile('U0BOB')
    for (const key of ['statusText', 'statusEmoji', 'statusExpiresAt', 'email', 'title', 'deleted']) {
      expect(profile, key).not.toHaveProperty(key)
    }
  })

  it('marks a deactivated account', async () => {
    const conn = connWith({ info: async () => ({ user: { id: 'U0GONE', deleted: true } }) })
    expect(await conn.getUserProfile('U0GONE')).toMatchObject({ id: 'U0GONE', deleted: true })
  })
})

describe('a Slack email lookup', () => {
  it('returns the member users.lookupByEmail finds, as a profile', async () => {
    const conn = connWith({
      lookupByEmail: async ({ email }) => ({ user: email === 'ada@example.com' ? ADA : undefined })
    })
    expect(await conn.lookupUserByEmail('ada@example.com')).toMatchObject({
      id: 'U0ADA',
      realName: 'Ada Example',
      statusText: 'On holiday'
    })
  })

  it('reads Slack’s users_not_found as no match', async () => {
    const conn = connWith({
      lookupByEmail: async () => {
        throw slackError('users_not_found')
      }
    })
    expect(await conn.lookupUserByEmail('nobody@example.com')).toBeUndefined()
  })

  it('reports a missing scope to the agent instead of answering no match', async () => {
    const conn = connWith({
      lookupByEmail: async () => {
        throw slackError('missing_scope')
      }
    })
    await expect(conn.lookupUserByEmail('ada@example.com')).rejects.toThrow(
      'Slack looking up a user by email failed: missing_scope'
    )
  })
})
