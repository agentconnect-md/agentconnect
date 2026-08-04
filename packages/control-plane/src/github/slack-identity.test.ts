/**
 * Unit tests for the Slack/Feishu identity projections of LogtoIdentityService (fake fetch — claim
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
  email_verified: true,
  // Slack's avatar reaches us only here: Logto fills the normalized `avatar`
  // for github and google, but leaves it unset for slack.
  picture: 'https://avatars.example.test/u0example1.png'
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

  it('never reuses a Slack authorization identity beyond two minutes', async () => {
    const clock = new FakeClock(0)
    const users: Record<string, unknown> = { 'sub-1': slackUser(SLACK_RAW) }
    const { fetchImpl, calls } = fakeLogto(users)
    const svc = svcOf(fetchImpl, clock)

    expect(await svc.slackIdentityFor('sub-1')).toMatchObject({ teamId: 'T0EXAMPLE1' })
    delete users['sub-1']
    clock.advance(120_001)

    expect(await svc.slackIdentityFor('sub-1')).toBeNull()
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

describe('LogtoIdentityService.feishuIdentitiesFor', () => {
  it('reads app-scoped open_id values from both built-in Feishu and generic Lark connector rawData', async () => {
    const { fetchImpl } = fakeLogto({
      'sub-1': {
        identities: {
          feishu: { userId: 'union-f', details: { rawData: { open_id: 'ou_feishu' } } },
          lark: { userId: 'union-l', details: { rawData: { data: { open_id: 'ou_lark' } } } }
        }
      }
    })
    await expect(svcOf(fetchImpl).feishuIdentitiesFor('sub-1')).resolves.toEqual([
      { region: 'feishu', openId: 'ou_feishu' },
      { region: 'lark', openId: 'ou_lark' }
    ])
  })

  it('ignores an identity whose connector rawData has no open_id', async () => {
    const { fetchImpl } = fakeLogto({
      'sub-1': { identities: { lark: { userId: 'union-only', details: { rawData: { union_id: 'on_x' } } } } }
    })
    await expect(svcOf(fetchImpl).feishuIdentitiesFor('sub-1')).resolves.toEqual([])
  })
})

/**
 * The invalidation fence. `slackIdentityFor` feeds the session-visibility
 * identity set, so invalidation must be final: a lookup that BEGAN before an
 * unlink/refresh may settle after it, and deleting only the settled cache
 * entry would let that older read write the pre-change identity back for its
 * full TTL. These fakes serve the user snapshot taken when the request
 * ARRIVED (what a slow provider response carries), parked until released.
 */
describe('LogtoIdentityService cache invalidation fence', () => {
  function gatedLogto(users: Record<string, unknown>, onDelete: () => void) {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let arrived!: () => void
    const firstReadArrived = new Promise<void>((resolve) => (arrived = resolve))
    const calls = { user: 0 }
    const fetchImpl: FetchImpl = async (url, init) => {
      if (url.endsWith('/oidc/token')) return Response.json({ access_token: 'tok', expires_in: 3600 })
      if (init?.method === 'DELETE') {
        onDelete()
        return new Response(null, { status: 204 })
      }
      calls.user++
      // What Logto read when the request arrived — delivery may lag the change.
      const snapshot = users[decodeURIComponent(url.split('/').pop()!)]
      if (calls.user === 1) {
        arrived()
        await gate
      }
      return snapshot ? Response.json(snapshot) : new Response('{}', { status: 404 })
    }
    return { fetchImpl, calls, release: () => release(), firstReadArrived }
  }

  it('a read begun before unlink cannot write the removed identity back', async () => {
    const users: Record<string, unknown> = {
      'sub-1': { identities: { slack: slackUser(SLACK_RAW).identities.slack, github: { userId: 'g' } } }
    }
    const { fetchImpl, calls, release, firstReadArrived } = gatedLogto(users, () => {
      users['sub-1'] = { identities: { github: { userId: 'g' } } }
    })
    const svc = svcOf(fetchImpl)

    const staleRead = svc.slackIdentityFor('sub-1') // begins before the unlink…
    await firstReadArrived
    await svc.unlinkSocialIdentity('sub-1', 'slack') // …which lands while it is parked
    release()
    // Its own caller sees the pre-unlink world — that read really did begin
    // before the change. What it must NOT do is survive as cache:
    expect(await staleRead).toMatchObject({ teamId: 'T0EXAMPLE1' })
    expect(await svc.slackIdentityFor('sub-1')).toBeNull()
    // The parked pre-unlink read, the unlink's own read/check (cache-bypassing),
    // and a genuine post-unlink re-read — the last one is the fence working.
    expect(calls.user).toBe(3)
  })

  it('a read begun before a link-refresh cannot write the pre-link user back', async () => {
    // The mirror image, on the forgetUser path (console announcing a link that
    // landed browser→Logto): the parked read carries NO slack identity, and
    // caching it would hide the just-linked workspace for the negative TTL.
    const users: Record<string, unknown> = {}
    const { fetchImpl, calls, release, firstReadArrived } = gatedLogto(users, () => {})
    const svc = svcOf(fetchImpl)

    const preLink = svc.slackIdentityFor('sub-1') // parked; snapshot has no slack
    await firstReadArrived
    users['sub-1'] = slackUser(SLACK_RAW) // the link lands at the provider
    svc.forgetUser('sub-1') // the console's refresh call
    release()

    expect(await preLink).toBeNull()
    expect(await svc.slackIdentityFor('sub-1')).toMatchObject({ teamId: 'T0EXAMPLE1' })
    expect(calls.user).toBe(2)
  })
})

describe('LogtoIdentityService.socialAccountFor', () => {
  const account = (extra: Record<string, unknown> = {}) => ({
    primaryEmail: 'dev@example.test',
    identities: {
      github: { userId: '9', details: { name: 'Octo Cat', rawData: { userInfo: { login: 'octocat' } } } },
      slack: slackUser(SLACK_RAW).identities.slack
    },
    ...extra
  })

  it('narrows each identity for rendering and addresses it at its provider', async () => {
    const { fetchImpl } = fakeLogto({ 'sub-1': account() })
    const result = await svcOf(fetchImpl).socialAccountFor('sub-1')

    const github = result.identities.find((i) => i.target === 'github')
    expect(github).toMatchObject({ name: 'Octo Cat', profileUrl: 'https://github.com/octocat' })

    const slack = result.identities.find((i) => i.target === 'slack')
    expect(slack?.profileUrl).toBe('https://example-workspace.slack.com/team/U0EXAMPLE1')
    expect(slack?.workspace).toEqual({
      teamId: 'T0EXAMPLE1',
      name: 'Example Workspace',
      domain: 'example-workspace',
      url: 'https://example-workspace.slack.com'
    })
  })

  it('never leaks the connector rawData to the caller', async () => {
    // It is a whole OIDC payload; none of it needs to reach a browser.
    const { fetchImpl } = fakeLogto({ 'sub-1': account() })
    const result = await svcOf(fetchImpl).socialAccountFor('sub-1')
    expect(JSON.stringify(result)).not.toContain('rawData')
    expect(JSON.stringify(result)).not.toContain('at_hash')
  })

  it('mirrors Logto: a password, an email, or a phone means re-verification', async () => {
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ primaryEmail: 'dev@example.test' }, true],
      [{ primaryEmail: null, primaryPhone: '+100000000' }, true],
      [{ primaryEmail: null, hasPassword: true }, true],
      [{ primaryEmail: null, primaryPhone: null, hasPassword: false }, false]
    ]
    for (const [fields, expected] of cases) {
      const { fetchImpl } = fakeLogto({ 'sub-1': { identities: {}, ...fields } })
      expect((await svcOf(fetchImpl).socialAccountFor('sub-1')).hasSecurityVerificationMethod).toBe(expected)
    }
  })

  it('serves the Slack projection and the account from ONE upstream read', async () => {
    // The whole point of moving this behind the CP: a profile load must not cost
    // one upstream fetch per projection.
    const { fetchImpl, calls } = fakeLogto({ 'sub-1': account() })
    const svc = svcOf(fetchImpl)
    await svc.socialAccountFor('sub-1')
    await svc.slackIdentityFor('sub-1')
    expect(calls.user).toBe(1)
  })

  it('reports an account that is gone as having nothing linked', async () => {
    const { fetchImpl } = fakeLogto({})
    expect(await svcOf(fetchImpl).socialAccountFor('missing')).toEqual({
      identities: [],
      hasSecurityVerificationMethod: false
    })
  })
})

describe('LogtoIdentityService.socialAccountFor avatars', () => {
  it('falls back to the raw picture claim when the connector fills no avatar', async () => {
    const { fetchImpl } = fakeLogto({
      'sub-1': {
        identities: {
          slack: slackUser(SLACK_RAW).identities.slack,
          github: { userId: 'g', details: { avatar: 'https://avatars.example.test/gh.png' } }
        }
      }
    })
    const byTarget = Object.fromEntries(
      (await svcOf(fetchImpl).socialAccountFor('sub-1')).identities.map((i) => [i.target, i.avatar])
    )
    expect(byTarget.slack).toBe('https://avatars.example.test/u0example1.png')
    // The normalized field still wins where a connector does provide it.
    expect(byTarget.github).toBe('https://avatars.example.test/gh.png')
  })
})

describe('LogtoIdentityService cache freshness after an external link', () => {
  it('serves a newly linked identity once the CP is told the link happened', async () => {
    // Linking runs browser→Logto (the Account API is the only side with a
    // connector session), so the CP never sees the write. Without being told,
    // the positive whole-user cache would hide the new identity for its full TTL.
    const users: Record<string, unknown> = { 'sub-1': { identities: { github: { userId: 'g' } } } }
    const { fetchImpl, calls } = fakeLogto(users)
    const svc = svcOf(fetchImpl)

    expect((await svc.socialAccountFor('sub-1')).identities.map((i) => i.target)).toEqual(['github'])
    expect(calls.user).toBe(1)

    // The browser links Slack directly at the provider.
    users['sub-1'] = { identities: { github: { userId: 'g' }, slack: slackUser(SLACK_RAW).identities.slack } }

    svc.forgetUser('sub-1')
    expect((await svc.socialAccountFor('sub-1')).identities.map((i) => i.target)).toEqual(['github', 'slack'])
    expect(calls.user).toBe(2)
  })
})

describe('LogtoIdentityService.socialAuthorizationFor', () => {
  /** Logto with a connector per target; `sessionBound` ones fail to build a URI
   *  exactly as Slack's does (the connector calls setSession, Logto 500s). */
  function fakeConnectors(sessionBound: string[]) {
    const calls = { authorize: 0 }
    const fetchImpl: FetchImpl = async (url, init) => {
      if (url.endsWith('/oidc/token')) return Response.json({ access_token: 'tok', expires_in: 3600 })
      const target = /target=([a-z]+)/.exec(url)?.[1]
      if (target) return Response.json([{ id: `${target}-connector`, target, type: 'Social' }])
      if (url.endsWith('/authorization-uri')) {
        calls.authorize++
        const connector = /connectors\/([a-z]+)-connector/.exec(url)?.[1] ?? ''
        if (sessionBound.includes(connector)) return new Response('boom', { status: 500 })
        return Response.json({ redirectTo: `https://${connector}.example.test/authorize` })
      }
      void init
      return Response.json({})
    }
    return { fetchImpl, calls }
  }

  it('drives a session-free connector server-side, sparing the user a code', async () => {
    const { fetchImpl } = fakeConnectors([])
    const svc = svcOf(fetchImpl)
    await expect(svc.socialAuthorizationFor('google', 'https://app.example.test/cb', 's')).resolves.toEqual({
      mode: 'direct',
      connectorId: 'google-connector',
      authorizationUri: 'https://google.example.test/authorize'
    })
  })

  it('falls back to the browser for a connector Logto cannot build a URI for', async () => {
    // The failure is NOT surfaced as one: Slack is still linkable, just the
    // other way. Reporting an error here is what the 502 bug used to do.
    const { fetchImpl } = fakeConnectors(['slack'])
    const svc = svcOf(fetchImpl)
    await expect(svc.socialAuthorizationFor('slack', 'https://app.example.test/cb', 's')).resolves.toEqual({
      mode: 'verified',
      connectorId: 'slack-connector'
    })
  })

  it('remembers that a connector needs the browser, instead of probing per click', async () => {
    const { fetchImpl, calls } = fakeConnectors(['slack'])
    const svc = svcOf(fetchImpl)

    await svc.socialAuthorizationFor('slack', 'https://app.example.test/cb', 's')
    await svc.socialAuthorizationFor('slack', 'https://app.example.test/cb', 's')
    expect(calls.authorize).toBe(1)
  })

  it('keeps re-asking for a connector that works, so its URI is never stale', async () => {
    // `direct` is not cached as a shortcut: each link needs its OWN state and
    // redirect in the URI, so the round trip is the point, not overhead.
    const { fetchImpl, calls } = fakeConnectors([])
    const svc = svcOf(fetchImpl)

    await svc.socialAuthorizationFor('google', 'https://app.example.test/cb', 's1')
    await svc.socialAuthorizationFor('google', 'https://app.example.test/cb', 's2')
    expect(calls.authorize).toBe(2)
  })
})
