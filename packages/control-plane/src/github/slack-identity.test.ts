/**
 * Unit tests for the Slack half of LogtoIdentityService (fake fetch — claim
 * extraction, per-provider caching, invalidation on unlink). No Docker, no
 * network. The GitHub half and the connector-id/unlink writes are covered by
 * `user-authz.test.ts`.
 */
import { describe, it, expect } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import type { SocialIdentityMutationGate } from '../persistence/ports.js'
import { LogtoIdentityService } from './logto-identity.js'

const MGMT = { endpoint: 'https://t.logto.app', appId: 'app', appSecret: 'sec', resource: 'https://t.logto.app/api' }
const MUTATIONS: SocialIdentityMutationGate = {
  runExclusive: async (_oidcSubject, mutation) => mutation()
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

/** Fake Logto: one token endpoint + a mutable user directory. Counts user reads. */
function fakeLogto(users: Record<string, unknown>) {
  const calls = { user: 0, deletes: 0 }
  const fetchImpl: FetchImpl = async (url, init) => {
    if (url.endsWith('/oidc/token')) return Response.json({ access_token: 'tok', expires_in: 3600 })
    if (init?.method === 'DELETE') {
      calls.deletes++
      return new Response(null, { status: 204 })
    }
    if (init?.method === 'POST') return Response.json({})
    calls.user++
    const sub = decodeURIComponent(url.split('/').pop()!)
    const user = users[sub]
    if (!user) return new Response('{}', { status: 404 })
    return Response.json(user)
  }
  return { fetchImpl, calls }
}

const svcOf = (fetchImpl: FetchImpl, clock = new FakeClock(0)) =>
  new LogtoIdentityService(MGMT, clock, MUTATIONS, fetchImpl)

/** A Logto user whose slack identity carries `rawData` — the connector stores the
 *  decoded OIDC payload whole. Synthetic ids: never a real workspace. */
function slackUser(rawData: Record<string, unknown>, userId = 'U0EXAMPLE1') {
  return { identities: { slack: { userId, details: { rawData } } } }
}

const SLACK_RAW = {
  sub: 'U0EXAMPLE1',
  'https://slack.com/team_id': 'T0EXAMPLE1',
  'https://slack.com/user_id': 'U0EXAMPLE1',
  'https://slack.com/team_name': 'Example Workspace',
  'https://slack.com/team_domain': 'example-workspace',
  email: 'dev@example.test',
  email_verified: true
}

describe('LogtoIdentityService.slackIdentityFor', () => {
  it('resolves the workspace identity from the connector rawData', async () => {
    const { fetchImpl } = fakeLogto({ 'sub-1': slackUser(SLACK_RAW) })
    expect(await svcOf(fetchImpl).slackIdentityFor('sub-1')).toEqual({
      teamId: 'T0EXAMPLE1',
      userId: 'U0EXAMPLE1',
      teamName: 'Example Workspace',
      teamDomain: 'example-workspace'
    })
  })

  it('omits the optional workspace labels when Slack did not send them', async () => {
    const { fetchImpl } = fakeLogto({
      'sub-1': slackUser({ 'https://slack.com/team_id': 'T0EXAMPLE1', 'https://slack.com/user_id': 'U0EXAMPLE1' })
    })
    expect(await svcOf(fetchImpl).slackIdentityFor('sub-1')).toEqual({ teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' })
  })

  it("falls back to the stored identity key when the user_id claim is absent (it is Slack's sub)", async () => {
    const { fetchImpl } = fakeLogto({
      'sub-1': slackUser({ 'https://slack.com/team_id': 'T0EXAMPLE1' }, 'U0FALLBACK')
    })
    expect(await svcOf(fetchImpl).slackIdentityFor('sub-1')).toMatchObject({ userId: 'U0FALLBACK' })
  })

  it('returns null without a team id — a user id alone is not addressable', async () => {
    const { fetchImpl } = fakeLogto({
      'sub-1': slackUser({ 'https://slack.com/user_id': 'U0EXAMPLE1' }, '')
    })
    expect(await svcOf(fetchImpl).slackIdentityFor('sub-1')).toBeNull()
  })

  it('returns null for accounts that never connected Slack, and for unknown users', async () => {
    const { fetchImpl } = fakeLogto({ 'sub-gh': { identities: { github: { details: { rawData: { login: 'x' } } } } } })
    const svc = svcOf(fetchImpl)
    expect(await svc.slackIdentityFor('sub-gh')).toBeNull()
    expect(await svc.slackIdentityFor('sub-missing')).toBeNull()
  })

  it('surfaces mgmt-API failures rather than reporting "not connected"', async () => {
    const fetchImpl: FetchImpl = async (url) =>
      url.endsWith('/oidc/token')
        ? Response.json({ access_token: 't', expires_in: 3600 })
        : new Response('boom', { status: 503 })
    await expect(svcOf(fetchImpl).slackIdentityFor('s')).rejects.toMatchObject({ retryable: true })
  })

  it('caches per provider — a slack read neither serves nor poisons the github cache', async () => {
    const { fetchImpl, calls } = fakeLogto({
      'sub-1': {
        identities: {
          github: { details: { rawData: { userInfo: { login: 'octocat' } } } },
          slack: { userId: 'U0EXAMPLE1', details: { rawData: SLACK_RAW } }
        }
      }
    })
    const svc = svcOf(fetchImpl)

    expect(await svc.githubLoginFor('sub-1')).toBe('octocat')
    expect(calls.user).toBe(1)
    // Separate cache ⇒ its own request, and the github answer is untouched.
    expect(await svc.slackIdentityFor('sub-1')).toMatchObject({ teamId: 'T0EXAMPLE1' })
    expect(calls.user).toBe(2)

    // Both now hold their own positive entry.
    expect(await svc.githubLoginFor('sub-1')).toBe('octocat')
    expect(await svc.slackIdentityFor('sub-1')).toMatchObject({ teamId: 'T0EXAMPLE1' })
    expect(calls.user).toBe(2)
  })

  it('re-asks after the negative TTL, so a just-connected workspace shows up', async () => {
    const clock = new FakeClock(0)
    const users: Record<string, unknown> = {}
    const { fetchImpl, calls } = fakeLogto(users)
    const svc = svcOf(fetchImpl, clock)

    expect(await svc.slackIdentityFor('sub-1')).toBeNull()
    expect(await svc.slackIdentityFor('sub-1')).toBeNull() // negative cache
    expect(calls.user).toBe(1)

    clock.advance(61_000)
    users['sub-1'] = slackUser(SLACK_RAW)
    expect(await svc.slackIdentityFor('sub-1')).toMatchObject({ teamId: 'T0EXAMPLE1' })
    expect(calls.user).toBe(2)

    clock.advance(60_000) // positive cache holds
    expect(await svc.slackIdentityFor('sub-1')).toMatchObject({ teamId: 'T0EXAMPLE1' })
    expect(calls.user).toBe(2)
  })

  it('drops the cached workspace when an identity is unlinked', async () => {
    // Otherwise Profile keeps showing a workspace the user just disconnected,
    // for the rest of the positive TTL.
    const users: Record<string, unknown> = {
      'sub-1': { identities: { slack: { userId: 'U0EXAMPLE1', details: { rawData: SLACK_RAW } }, github: {} } }
    }
    const { fetchImpl, calls } = fakeLogto(users)
    const svc = svcOf(fetchImpl)

    expect(await svc.slackIdentityFor('sub-1')).toMatchObject({ teamId: 'T0EXAMPLE1' })
    await svc.unlinkSocialIdentity('sub-1', 'slack')
    expect(calls.deletes).toBe(1)

    users['sub-1'] = { identities: { github: {} } }
    expect(await svc.slackIdentityFor('sub-1')).toBeNull() // re-read, not the stale hit
  })

  it('drops the cached workspace when the identity is unlinked', async () => {
    // Two identities, so the last-sign-in-method guard lets the unlink through.
    const users: Record<string, unknown> = {
      'sub-1': { identities: { slack: slackUser(SLACK_RAW).identities.slack, github: { userId: 'g' } } }
    }
    const { fetchImpl } = fakeLogto(users)
    const svc = svcOf(fetchImpl)

    expect(await svc.slackIdentityFor('sub-1')).toMatchObject({ teamId: 'T0EXAMPLE1' })
    await svc.unlinkSocialIdentity('sub-1', 'slack')

    // Without invalidation the 10-minute positive cache would keep reporting a
    // workspace the user just disconnected.
    users['sub-1'] = { identities: { github: { userId: 'g' } } }
    expect(await svc.slackIdentityFor('sub-1')).toBeNull()
  })
})
