import type { FastifyRequest } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { OrgId } from '../domain/ids.js'
import { canViewSession } from '../authorization/policy.js'
import type { ExternalScopeRecord, SessionFilterQuery } from '../persistence/ports.js'
import type { HttpDeps } from './deps.js'
import type { SessionAccessPlugin } from './session-access-plugin.js'
import { makeSessionAccessResolver } from './session-access.js'

const scope: ExternalScopeRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: OrgId('org-1'),
  provider: 'feishu',
  realmKey: 'lark:cli_custom_bot',
  resourceKind: 'conversation',
  resourceKey: 'oc_p2p',
  credentialKind: 'bot',
  credentialId: '22222222-2222-4222-8222-222222222222',
  aclRevision: 2n,
  revokedAt: null
}

function request(): FastifyRequest {
  return {
    headers: {},
    oidcSubject: 'logto-subject',
    orgCtx: { orgId: 'org-1', role: 'collaborator', userId: 'user-1' },
    log: { warn: vi.fn() }
  } as unknown as FastifyRequest
}

/** The durable row a provider always has once ingest has seen a candidate. */
function enabledPolicy(provider: string) {
  return { orgId: 'org-1', provider, state: 'enabled', currentRev: 1n, readFenceRev: null, migrationCursor: null }
}

describe('makeSessionAccessResolver', () => {
  it('matches a custom-Bot p2p owner by union_id without an external access check', async () => {
    const getExternalScopes = vi.fn(async () => [scope])
    const resolve = vi.fn(async (scopes: readonly ExternalScopeRecord[]) => {
      expect(scopes).toEqual([])
      return { allowedScopes: [], degraded: false, accessIssues: [] }
    })
    const plugin: SessionAccessPlugin = {
      provider: 'feishu',
      available: true,
      addViewerIdentities: async ({ identitySet }) => {
        identitySet.add('feishu:lark:cli_custom_bot:on_member')
      },
      resolve
    }
    const policy = {
      orgId: 'org-1',
      provider: 'feishu',
      state: 'disabled',
      currentRev: 0n,
      readFenceRev: null
    } as const
    const deps = {
      repos: {
        session: {
          getExternalScopes,
          getExternalAccessPolicy: vi.fn(async (_orgId: string, provider: string) =>
            provider === 'feishu' ? policy : null
          )
        }
      },
      clock: { now: () => 1_000 },
      sessionAccessPlugins: [plugin]
    } as unknown as HttpDeps
    const session = {
      visibility: 'private' as const,
      ownerIdentity: 'feishu:lark:cli_custom_bot:on_member',
      externalProvider: 'feishu',
      externalScopeId: scope.id,
      externalResolution: 'settled' as const
    }

    const access = await makeSessionAccessResolver(deps).forSessions(request(), [session])

    expect(getExternalScopes).toHaveBeenCalledWith([scope.id])
    expect(access.identitySet).toContain(session.ownerIdentity)
    expect(
      canViewSession(session, { userId: 'user-1', role: 'collaborator' }, access.identitySet, access.externalAccess)
    ).toBe(true)
  })

  it('passes the login union_id to the Bot-app group membership resolver', async () => {
    const getExternalScopes = vi.fn(async (ids: readonly string[]) => (ids.length > 0 ? [scope] : []))
    const resolve = vi.fn(async (scopes: readonly ExternalScopeRecord[], viewer) => {
      expect(viewer.identitySet).toContain('feishu:lark:cli_custom_bot:on_member')
      return {
        allowedScopes: scopes.map(({ id, aclRevision }) => ({ id, aclRevision })),
        degraded: false,
        accessIssues: []
      }
    }) satisfies SessionAccessPlugin['resolve']
    const deps = {
      repos: {
        session: {
          getExternalScopes,
          // Ingest upserts the policy row before it ever records a candidate,
          // so a provider with scopes to resolve always has one. Resolving is
          // gated on it being on.
          getExternalAccessPolicy: vi.fn(async () => enabledPolicy('feishu'))
        }
      },
      clock: { now: () => 1_000 },
      sessionAccessPlugins: [
        {
          provider: 'feishu',
          available: true,
          addViewerIdentities: async ({ identitySet }: { identitySet: Set<string> }) => {
            identitySet.add('feishu:lark:cli_custom_bot:on_member')
          },
          resolve
        }
      ]
    } as unknown as HttpDeps

    const access = await makeSessionAccessResolver(deps).forSessions(request(), [
      {
        visibility: 'external',
        externalProvider: 'feishu',
        externalScopeId: scope.id
      }
    ])

    expect(access.degraded).toBe(false)
    expect(access.externalAccess.allowedScopes).toEqual([{ id: scope.id, aclRevision: scope.aclRevision }])
  })
})

/**
 * One console page load asks the same authorization question from `/sessions`,
 * `/sessions/facets` and `/usage` at once, and each answer used to cost its own
 * provider sweep — which is what made those three the only reads on the page
 * measured in seconds.
 */
describe('makeSessionAccessResolver snapshot', () => {
  const query: SessionFilterQuery = { agentIds: [] } as unknown as SessionFilterQuery

  /** `Clock` reports wall-clock epoch milliseconds, and the snapshot needs it
   *  to: lru-cache reads a falsy entry start as "no TTL recorded", so a clock
   *  left at 0 would make the first snapshot immortal. */
  const EPOCH = 1_777_000_000_000

  /** Lets a background refresh settle without advancing the clock. */
  const settle = () => new Promise((done) => setImmediate(done))

  function harness(scopes: readonly ExternalScopeRecord[] = [scope]) {
    const clock = new FakeClock(EPOCH)
    let sweeps = 0
    let policy = enabledPolicy('feishu')
    /** Mirrors the write path: every toggle bumps the revision. */
    const setSync = (state: 'enabled' | 'disabled') => {
      policy = { ...policy, state, currentRev: policy.currentRev + 1n }
    }
    const resolve = vi.fn(async (given: readonly ExternalScopeRecord[]) => ({
      allowedScopes: given.map(({ id, aclRevision }) => ({ id, aclRevision })),
      // Marks WHICH sweep an answer came from, so a test can tell a served
      // snapshot from the refresh that replaced it.
      degraded: ++sweeps > 1,
      accessIssues: []
    })) satisfies SessionAccessPlugin['resolve']
    const deps = {
      repos: {
        session: {
          listExternalScopes: vi.fn(async () => scopes),
          getExternalScopes: vi.fn(async (ids: readonly string[]) => scopes.filter((row) => ids.includes(row.id))),
          getExternalAccessPolicy: vi.fn(async () => policy)
        }
      },
      clock,
      sessionAccessPlugins: [{ provider: 'feishu', available: true, resolve }]
    } as unknown as HttpDeps
    return { deps, clock, resolve, setSync }
  }

  it('never asks a provider whose sync is switched off', async () => {
    const { deps, resolve, setSync } = harness()
    setSync('disabled')
    const resolver = makeSessionAccessResolver(deps)

    const access = await resolver.forQuery(request(), query)

    // Off means the SQL scope arm stops admitting this provider's `external`
    // rows, so resolving them would be latency spent on an answer nothing
    // reads — a disabled Feishu policy was still costing a tenant-token round
    // trip plus a member-list page on every session list.
    expect(resolve).not.toHaveBeenCalled()
    expect(access.externalAccess.allowedScopes).toEqual([])
    expect(access.degraded).toBe(false)
    // The policy itself stays in the snapshot: `org`-classified rows created
    // while sync was off carry the provider, and the provider arm — which does
    // not care about state — is the only thing that makes them visible.
    expect(access.externalAccess.policies.map((policy) => policy.provider)).toEqual(['feishu'])
  })

  it('re-decides the moment the switch moves, in both directions', async () => {
    const { deps, setSync } = harness()
    const resolver = makeSessionAccessResolver(deps)
    const grants = async () => (await resolver.forQuery(request(), query)).externalAccess.allowedScopes.length

    expect(await grants()).toBe(1)

    // No clock movement: the entry is still well inside its fresh window, so
    // anything reusing it would keep authorizing on the old setting. The list
    // path reads the live policy in SQL, so a snapshot that lagged here would
    // have detail allowing a session the list had already hidden.
    setSync('disabled')
    expect(await grants()).toBe(0)

    // And the inverse — a cached empty answer must not delay restoration.
    setSync('enabled')
    expect(await grants()).toBe(1)
  })

  it('drops grants when the switch goes off midway through the sweep', async () => {
    const { deps, resolve } = harness()
    let reads = 0
    // The sweep reads the policy twice: once to key and seed the decision, once
    // as the durable fence after the provider round trips. Land the disable in
    // between.
    deps.repos.session.getExternalAccessPolicy = vi.fn(async () =>
      ++reads <= 1 ? enabledPolicy('feishu') : { ...enabledPolicy('feishu'), state: 'disabled' }
    ) as never
    const resolver = makeSessionAccessResolver(deps)

    const access = await resolver.forQuery(request(), query)

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(access.externalAccess.allowedScopes).toEqual([])
    // Obeying the switch is not a provider failing to answer, so this must not
    // raise the "scopes stopped resolving" banner.
    expect(access.degraded).toBe(false)
  })

  it('collapses the concurrent reads of one page load into a single provider sweep', async () => {
    const { deps, resolve } = harness()
    const resolver = makeSessionAccessResolver(deps)

    const [first, second, third] = await Promise.all([
      resolver.forQuery(request(), query),
      resolver.forQuery(request(), query),
      resolver.forQuery(request(), query)
    ])

    expect(resolve).toHaveBeenCalledTimes(1)
    for (const access of [first, second, third]) {
      expect(access.externalAccess.allowedScopes).toEqual([{ id: scope.id, aclRevision: scope.aclRevision }])
    }
  })

  it('shares one snapshot across the route modules that each build a resolver', async () => {
    const { deps, resolve } = harness()

    await makeSessionAccessResolver(deps).forQuery(request(), query)
    await makeSessionAccessResolver(deps).forQuery(request(), query)

    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('serves a fresh snapshot without touching the providers', async () => {
    const { deps, clock, resolve } = harness()
    const resolver = makeSessionAccessResolver(deps)

    await resolver.forQuery(request(), query)
    clock.advance(29_999)
    await resolver.forQuery(request(), query)

    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('serves the snapshot it has and refreshes behind the request', async () => {
    const { deps, clock, resolve } = harness()
    const resolver = makeSessionAccessResolver(deps)

    await resolver.forQuery(request(), query)
    clock.advance(30_001)

    // Past the fresh window: this read must NOT wait on the sweep, so it still
    // reports the first sweep's answer (`degraded: false`).
    const served = await resolver.forQuery(request(), query)
    expect(served.degraded).toBe(false)

    // …and the refresh it kicked off lands without anyone waiting for it, so
    // the next read sees the second sweep.
    await settle()
    expect(resolve).toHaveBeenCalledTimes(2)
    expect((await resolver.forQuery(request(), query)).degraded).toBe(true)
  })

  it('blocks on a real sweep once the ceiling passes', async () => {
    const { deps, clock, resolve } = harness()
    const resolver = makeSessionAccessResolver(deps)

    await resolver.forQuery(request(), query)
    clock.advance(60_001)

    // Nothing servable is left, so this read waits and gets the fresh answer
    // rather than an arbitrarily old one.
    expect((await resolver.forQuery(request(), query)).degraded).toBe(true)
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('keeps serving the previous snapshot when a refresh behind the request fails', async () => {
    const { deps, clock, resolve } = harness()
    const resolver = makeSessionAccessResolver(deps)

    await resolver.forQuery(request(), query)
    clock.advance(30_001)
    resolve.mockRejectedValueOnce(new Error('slack unreachable'))

    await expect(resolver.forQuery(request(), query)).resolves.toMatchObject({ degraded: false })
    await settle()
    // A provider blip does not empty the answer, and does not surface as an
    // error on a read that never waited for it.
    await expect(resolver.forQuery(request(), query)).resolves.toMatchObject({
      degraded: false,
      externalAccess: { allowedScopes: [{ id: scope.id, aclRevision: scope.aclRevision }] }
    })
  })

  it('emits one countable warn and stamps the snapshot when a refresh behind the request fails', async () => {
    const { deps, clock, resolve } = harness()
    const resolver = makeSessionAccessResolver(deps)

    await resolver.forQuery(request(), query)
    clock.advance(30_001)
    resolve.mockRejectedValueOnce(
      Object.assign(new Error('getaddrinfo failed for the provider host'), { code: 'ENOTFOUND' })
    )

    const kicker = request()
    await expect(resolver.forQuery(kicker, query)).resolves.toMatchObject({ degraded: false })
    await settle()

    // The failure reached no caller, so this warn is its only trace: a CAUSE and the org, never the message.
    expect(kicker.log.warn).toHaveBeenCalledTimes(1)
    expect(kicker.log.warn).toHaveBeenCalledWith(
      { orgId: 'org-1', cause: 'ENOTFOUND' },
      'session access refresh-behind failed — still serving the previous snapshot'
    )
    // The entry it left behind says when it went stale-and-failing, and still serves the recorded answer.
    const served = await resolver.forQuery(request(), query)
    expect(served.refreshFailedAt).toEqual(new Date(clock.now()))
    expect(served.degraded).toBe(false)
    expect(served.externalAccess.allowedScopes).toEqual([{ id: scope.id, aclRevision: scope.aclRevision }])
  })

  it('clears the staleness stamp once a refresh lands', async () => {
    const { deps, clock, resolve } = harness()
    const resolver = makeSessionAccessResolver(deps)

    await resolver.forQuery(request(), query)
    clock.advance(30_001)
    resolve.mockRejectedValueOnce(new Error('slack unreachable'))
    await resolver.forQuery(request(), query)
    await settle()

    // Still inside the stale window: this read serves the stamped entry and kicks a refresh that succeeds.
    expect((await resolver.forQuery(request(), query)).refreshFailedAt).toBeDefined()
    await settle()

    const after = await resolver.forQuery(request(), query)
    expect(after.refreshFailedAt).toBeUndefined()
    // `degraded` marks the third sweep's answer: the stamp is gone because the refresh REPLACED the entry.
    expect(after.degraded).toBe(true)
    expect(resolve).toHaveBeenCalledTimes(3)
  })

  it('does not emit the refresh-behind warn when a cold blocking sweep fails', async () => {
    const { deps, resolve } = harness()
    const resolver = makeSessionAccessResolver(deps)
    resolve.mockRejectedValueOnce(new Error('slack unreachable'))

    // A cold sweep's failure already surfaces to its caller; only the invisible background class is logged.
    const req = request()
    await expect(resolver.forQuery(req, query)).rejects.toThrow('slack unreachable')
    expect(req.log.warn).not.toHaveBeenCalled()
  })

  // The ceiling has to hold even when a refresh straddles it. `fetch` coalesces
  // a later caller onto the SAME in-flight promise and settles it with the
  // options of the fetch that created it, so a stale-on-rejection policy set by
  // the refresh would leak to a caller that was supposed to block.
  it('makes a caller that arrives past the ceiling observe a straddling refresh’s failure', async () => {
    const { deps, clock, resolve } = harness()
    const resolver = makeSessionAccessResolver(deps)

    await resolver.forQuery(request(), query)

    // A refresh that starts inside the stale window and is still running later.
    let failRefresh!: (err: Error) => void
    resolve.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failRefresh = reject
        })
    )
    clock.advance(30_001)
    await expect(resolver.forQuery(request(), query)).resolves.toMatchObject({ degraded: false })

    // Past the ceiling nothing is servable, so this caller joins the pending
    // refresh and must see its failure rather than inherit the old snapshot.
    clock.advance(30_000)
    const blocked = resolver.forQuery(request(), query)
    // It has to reach the cache and join that refresh BEFORE the refresh
    // settles, or it simply starts a sweep of its own and the overlap this test
    // exists for never happens.
    await settle()
    failRefresh(new Error('slack unreachable'))

    await expect(blocked).rejects.toThrow('slack unreachable')
  })

  it('keys the snapshot on the scope set, so a re-fenced scope never hits a stale entry', async () => {
    const { deps, resolve } = harness()
    const resolver = makeSessionAccessResolver(deps)

    await resolver.forQuery(request(), query)
    // An ACL bump rewrites `aclRevision`; the same conversation is now a
    // different authorization question and must not reuse the old answer.
    deps.repos.session.listExternalScopes = vi.fn(async () => [{ ...scope, aclRevision: 3n }]) as never
    await resolver.forQuery(request(), query)

    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('never caches a failed sweep as a verdict', async () => {
    const { deps, resolve } = harness()
    const resolver = makeSessionAccessResolver(deps)
    resolve.mockRejectedValueOnce(new Error('slack unreachable'))

    await expect(resolver.forQuery(request(), query)).rejects.toThrow('slack unreachable')
    const access = await resolver.forQuery(request(), query)

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(access.externalAccess.allowedScopes).toEqual([{ id: scope.id, aclRevision: scope.aclRevision }])
  })
})
