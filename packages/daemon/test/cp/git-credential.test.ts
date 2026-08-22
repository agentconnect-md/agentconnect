/**
 * GitCredentialCache — monotonic expiry + the 10min handout threshold,
 * per-agent single-flight, serve-cached degradation while the CP is down,
 * terminal SCOPE_DENIED, and password-matched invalidation (the `erase` hook).
 */
import { describe, it, expect } from 'vitest'
import type { GitCredGrant } from '@agentconnect.md/protocol'
import {
  GitCredentialCache,
  GitCredUnavailableError,
  type GitCredentialCacheDeps
} from '../../src/cp/git-credential.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HOOK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function grant(token: string, ttlSec: number): GitCredGrant {
  return {
    username: 'x-access-token',
    token,
    ttlSec,
    expiresAt: '2026-07-06T13:00:00.000Z',
    repoFullName: 'acme/infra',
    access: 'write'
  }
}

interface Harness {
  cache: GitCredentialCache
  calls: () => number
  advance: (ms: number) => void
}

function build(responder: (n: number) => GitCredGrant | Promise<GitCredGrant>): Harness {
  let calls = 0
  let mono = 0
  const cache = new GitCredentialCache({
    request: async () => {
      calls += 1
      return responder(calls)
    },
    log: { warn: () => {} },
    monoNow: () => mono
  })
  return { cache, calls: () => calls, advance: (ms) => (mono += ms) }
}

describe('GitCredentialCache', () => {
  it('serves cached while >10min remain on the monotonic clock, re-pulls after', async () => {
    const h = build((n) => grant(`ghs_${n}`, 3540)) // 59min of life
    expect((await h.cache.get(AGENT, 'clone')).token).toBe('ghs_1')
    expect((await h.cache.get(AGENT, 'push')).token).toBe('ghs_1')
    expect(h.calls()).toBe(1)

    h.advance(50 * 60 * 1000) // 9min left < 10min threshold
    expect((await h.cache.get(AGENT, 'push')).token).toBe('ghs_2')
    expect(h.calls()).toBe(2)
  })

  it('coalesces concurrent cold-cache pulls into one WS request', async () => {
    const h = build((n) => grant(`ghs_${n}`, 3540))
    const [a, b, c] = await Promise.all([
      h.cache.get(AGENT, 'clone'),
      h.cache.get(AGENT, 'helper'),
      h.cache.get(AGENT, 'pull')
    ])
    expect(h.calls()).toBe(1)
    expect(a.token).toBe('ghs_1')
    expect(b.token).toBe('ghs_1')
    expect(c.token).toBe('ghs_1')
  })

  it('degrades to the UNEXPIRED cached token when the CP is unreachable', async () => {
    const h = build((n) => {
      if (n === 1) return grant('ghs_1', 3540)
      throw Object.assign(new Error('control plane unreachable'), { code: 'INTERNAL' })
    })
    await h.cache.get(AGENT, 'clone')
    h.advance(50 * 60 * 1000) // below handout threshold → refresh attempt fails → cached still alive
    expect((await h.cache.get(AGENT, 'push')).token).toBe('ghs_1')

    h.advance(10 * 60 * 1000) // now past expiry — no silent resurrection
    await expect(h.cache.get(AGENT, 'push')).rejects.toBeInstanceOf(GitCredUnavailableError)
  })

  it('treats SCOPE_DENIED as terminal until a new spec clears it', async () => {
    const h = build((n) => {
      if (n === 1) throw Object.assign(new Error('agent is not placed on this daemon'), { code: 'SCOPE_DENIED' })
      return grant(`ghs_${n}`, 3540)
    })
    await expect(h.cache.get(AGENT, 'push')).rejects.toMatchObject({ terminal: true })
    // still denied — and crucially, no second WS request was made
    await expect(h.cache.get(AGENT, 'push')).rejects.toMatchObject({ terminal: true })
    expect(h.calls()).toBe(1)

    h.cache.clearDenied(AGENT) // agent/upsert replicated a fresh spec
    expect((await h.cache.get(AGENT, 'push')).token).toBe('ghs_2')
  })

  it('evicts the cached token on an authoritative LEASE_DENIED instead of riding it (19.3)', async () => {
    const h = build((n) => {
      if (n === 2) throw Object.assign(new Error('binding stopped new effects'), { code: 'LEASE_DENIED' })
      return grant(`ghs_${n}`, 3540)
    })
    expect((await h.cache.get(AGENT, 'clone')).token).toBe('ghs_1')
    h.advance(50 * 60 * 1000) // below the handout threshold → refresh, and the CP refuses

    // Unlike the INTERNAL outage above, the caller must fail NOW rather than keep the revoked grant.
    await expect(h.cache.get(AGENT, 'push')).rejects.toMatchObject({ terminal: false })
    // Neither terminal nor negative-cached: a repaired binding serves on the very next ask.
    expect((await h.cache.get(AGENT, 'push')).token).toBe('ghs_3')
    expect(h.calls()).toBe(3)
  })

  it('invalidates only when the presented password matches (stale erase races)', async () => {
    const h = build((n) => grant(`ghs_${n}`, 3540))
    await h.cache.get(AGENT, 'clone')

    h.cache.invalidate(AGENT, 'ghs_OLD') // a stale erase must not wipe a fresh token
    expect((await h.cache.get(AGENT, 'push')).token).toBe('ghs_1')
    expect(h.calls()).toBe(1)

    h.cache.invalidate(AGENT, 'ghs_1') // the real rejection
    expect((await h.cache.get(AGENT, 'push')).token).toBe('ghs_2')
  })

  it('remove() drops the entry with the agent', async () => {
    const h = build((n) => grant(`ghs_${n}`, 3540))
    await h.cache.get(AGENT, 'clone')
    h.cache.remove(AGENT)
    expect((await h.cache.get(AGENT, 'clone')).token).toBe('ghs_2')
  })

  describe('gh credential plane', () => {
    function buildRecording(actionsSupported: () => boolean = () => false) {
      let calls = 0
      const payloads: Array<{
        agentId: string
        reason?: string
        capabilities?: string[]
        repoFullName?: string
        purpose?: string
        hookId?: string
        forceRefresh?: boolean
      }> = []
      let mono = 0
      const cache = new GitCredentialCache({
        request: async (p) => {
          calls += 1
          payloads.push(p as never)
          // A correct CP ECHOES the requested repo (the daemon's identity guard
          // is an equality check); a repo-less (workspace) ask keeps the default.
          return { ...grant(`ghs_${calls}`, 3540), ...(p.repoFullName ? { repoFullName: p.repoFullName } : {}) }
        },
        log: { warn: () => {} },
        actionsSupported,
        monoNow: () => mono
      })
      return { cache, payloads, calls: () => calls, advance: (ms: number) => (mono += ms) }
    }

    it('getPostToken requests a repo-scoped issues/PR grant under a per-repo key', async () => {
      const h = buildRecording()
      const a = await h.cache.getPostToken(AGENT, 'acme/infra', HOOK)
      const b = await h.cache.getPostToken(AGENT, 'acme/other', HOOK) // different repo ⇒ different token
      expect(h.calls()).toBe(2)
      expect(a.token).toBe('ghs_1')
      expect(b.token).toBe('ghs_2')
      expect(h.payloads[0]).toMatchObject({
        repoFullName: 'acme/infra',
        capabilities: ['issues', 'pull_requests'],
        purpose: 'github_hook_reply',
        hookId: HOOK
      })
      expect(h.payloads[1]!.repoFullName).toBe('acme/other')
      // Same repo again ⇒ cached (no contents scope requested — poster is comment-only).
      await h.cache.getPostToken(AGENT, 'acme/infra', HOOK)
      expect(h.calls()).toBe(2)
      expect(h.payloads.every((p) => !p.capabilities?.includes('contents'))).toBe(true)
    })

    it('invalidates only the matching cached poster token after an auth rejection', async () => {
      const h = buildRecording()
      await h.cache.getPostToken(AGENT, 'acme/infra', HOOK)

      h.cache.invalidatePost(AGENT, 'acme/infra', 'ghs_stale')
      expect((await h.cache.getPostToken(AGENT, 'acme/infra', HOOK)).token).toBe('ghs_1')

      h.cache.invalidatePost(AGENT, 'acme/infra', 'ghs_1')
      expect((await h.cache.getPostToken(AGENT, 'acme/infra', HOOK)).token).toBe('ghs_2')
      expect(h.payloads.at(-1)).toMatchObject({ forceRefresh: true, hookId: HOOK })
    })

    it('requests the widened capability set and caches under its OWN key', async () => {
      const h = buildRecording()
      const git = await h.cache.get(AGENT, 'clone')
      const gh = await h.cache.get(AGENT, 'helper', { plane: 'gh' })
      // Two distinct grants — a capability set is a distinct token.
      expect(h.calls()).toBe(2)
      expect(git.token).toBe('ghs_1')
      expect(gh.token).toBe('ghs_2')
      expect(h.payloads[0]!.capabilities).toBeUndefined() // plain git grant unchanged
      expect(h.payloads[1]!.capabilities).toEqual(['contents', 'issues', 'pull_requests'])
      // Both served from cache afterwards.
      await h.cache.get(AGENT, 'push')
      await h.cache.get(AGENT, 'helper', { plane: 'gh' })
      expect(h.calls()).toBe(2)
    })

    it('adds Actions after CP feature negotiation without reusing the legacy gh grant', async () => {
      let supported = false
      const h = buildRecording(() => supported)

      await h.cache.get(AGENT, 'helper', { plane: 'gh' })
      expect(h.payloads[0]!.capabilities).toEqual(['contents', 'issues', 'pull_requests'])

      supported = true
      await h.cache.get(AGENT, 'helper', { plane: 'gh' })
      expect(h.calls()).toBe(2)
      expect(h.payloads[1]!.capabilities).toEqual(['contents', 'issues', 'pull_requests', 'actions'])
    })

    it('honors the handout threshold independently per key', async () => {
      const h = buildRecording()
      await h.cache.get(AGENT, 'helper', { plane: 'gh' })
      h.advance(50 * 60 * 1000) // 9min left < threshold
      expect((await h.cache.get(AGENT, 'helper', { plane: 'gh' })).token).toBe('ghs_2')
    })

    it('remove() clears the gh entry too', async () => {
      const h = buildRecording()
      await h.cache.get(AGENT, 'helper', { plane: 'gh' })
      h.cache.remove(AGENT)
      expect((await h.cache.get(AGENT, 'helper', { plane: 'gh' })).token).toBe('ghs_2')
    })

    it('SCOPE_DENIED on the gh grant is terminal for the gh key only', async () => {
      let calls = 0
      const cache = new GitCredentialCache({
        request: async (p) => {
          calls += 1
          if ((p as { capabilities?: string[] }).capabilities) {
            throw Object.assign(new Error('denied'), { code: 'SCOPE_DENIED' })
          }
          return grant(`ghs_${calls}`, 3540)
        },
        log: { warn: () => {} },
        monoNow: () => 0
      })
      await expect(cache.get(AGENT, 'helper', { plane: 'gh' })).rejects.toMatchObject({ terminal: true })
      // The plain git channel keeps working (separate denial memo).
      expect((await cache.get(AGENT, 'clone')).token).toMatch(/^ghs_/)
      // clearDenied (a replicated spec change) re-enables the gh key as well.
      cache.clearDenied(AGENT)
      await expect(cache.get(AGENT, 'helper', { plane: 'gh' })).rejects.toMatchObject({ terminal: true }) // still SCOPE_DENIED from the CP
    })
  })

  describe('per-repo keying (multi-repo authorization, #457)', () => {
    function repoGrant(token: string, repoFullName: string, ttlSec = 3540): GitCredGrant {
      return { ...grant(token, ttlSec), repoFullName }
    }

    function buildRepos(responder: (n: number, p: { repoFullName?: string }) => GitCredGrant | never) {
      let calls = 0
      const payloads: Array<{ agentId: string; capabilities?: string[]; repoFullName?: string }> = []
      let mono = 0
      const cache = new GitCredentialCache({
        request: async (p) => {
          calls += 1
          payloads.push(p as never)
          return responder(calls, p as never)
        },
        log: { warn: () => {} },
        monoNow: () => mono
      })
      return { cache, payloads, calls: () => calls, advance: (ms: number) => (mono += ms) }
    }

    it('keys tokens per (plane, repo): each repo is its own grant, coalesced per key', async () => {
      const h = buildRepos((n, p) => repoGrant(`ghs_${n}`, p.repoFullName ?? 'acme/infra'))
      const ws = await h.cache.get(AGENT, 'helper')
      const other = await h.cache.get(AGENT, 'helper', { repo: 'other-org/tools' })
      const otherGh = await h.cache.get(AGENT, 'helper', { plane: 'gh', repo: 'other-org/tools' })
      expect(h.calls()).toBe(3)
      expect(ws.repoFullName).toBe('acme/infra')
      expect(other.repoFullName).toBe('other-org/tools')
      expect(h.payloads[1]!.repoFullName).toBe('other-org/tools')
      expect(h.payloads[1]!.capabilities).toBeUndefined() // git plane stays contents-only
      expect(h.payloads[2]!.capabilities).toEqual(['contents', 'issues', 'pull_requests'])
      expect(otherGh.token).toBe('ghs_3')
      // Case-insensitive repo key: OTHER-ORG/Tools hits the cached entry.
      expect((await h.cache.get(AGENT, 'push', { repo: 'OTHER-ORG/Tools' })).token).toBe('ghs_2')
      expect(h.calls()).toBe(3)
    })

    it('repo-keyed SCOPE_DENIED is a 60s negative cache, not terminal', async () => {
      const h = buildRepos((n, p) => {
        if (p.repoFullName && n < 3) {
          throw Object.assign(new Error('repo not authorized'), { code: 'SCOPE_DENIED' })
        }
        return repoGrant(`ghs_${n}`, p.repoFullName ?? 'acme/infra')
      })
      await expect(h.cache.get(AGENT, 'helper', { repo: 'other-org/tools' })).rejects.toMatchObject({
        terminal: false
      })
      // Inside the window: refused locally, no second WS request.
      await expect(h.cache.get(AGENT, 'helper', { repo: 'other-org/tools' })).rejects.toBeInstanceOf(
        GitCredUnavailableError
      )
      expect(h.calls()).toBe(1)
      // The workspace key is untouched by a repo denial.
      expect((await h.cache.get(AGENT, 'clone')).repoFullName).toBe('acme/infra')
      // Past the window: asks again (the operator may have authorized it by now).
      h.advance(61 * 1000)
      expect((await h.cache.get(AGENT, 'helper', { repo: 'other-org/tools' })).token).toBe('ghs_3')
    })

    it('refuses a grant whose repo mismatches the request (old-CP guard) and does not cache it', async () => {
      const h = buildRepos(() => repoGrant('ghs_ws', 'acme/infra')) // CP strips the field → workspace grant
      await expect(h.cache.get(AGENT, 'helper', { repo: 'other-org/tools' })).rejects.toThrow(/too old/)
      // Nothing poisoned the repo key — a later (fixed) CP answer works.
      const h2calls = h.calls()
      await expect(h.cache.get(AGENT, 'helper', { repo: 'other-org/tools' })).rejects.toThrow(/too old/)
      expect(h.calls()).toBe(h2calls + 1) // asked again — mismatch is not a negative cache
    })

    it('a repo revoked mid-life breaks on the DISCOVERING call — no serve-stale of the purged token', async () => {
      const h = buildRepos((n, p) => {
        if (n === 1) return repoGrant('ghs_1', p.repoFullName ?? 'acme/infra')
        throw Object.assign(new Error('repo not authorized'), { code: 'SCOPE_DENIED' })
      })
      // Warm the cache with a live token, then drop below the handout threshold
      // (unexpired, but a refresh is forced) — the entry is still servable-stale.
      expect((await h.cache.get(AGENT, 'helper', { repo: 'other-org/tools' })).token).toBe('ghs_1')
      h.advance(50 * 60 * 1000) // 9min left < 10min handout threshold, > 0 (unexpired)
      // The operator revoked authorization; the CP now SCOPE_DENIES. The discovering
      // call must THROW, not resurrect the token the denial just purged.
      await expect(h.cache.get(AGENT, 'push', { repo: 'other-org/tools' })).rejects.toMatchObject({ terminal: false })
    })

    it('remove() drops repo-keyed entries and denials with the agent', async () => {
      const h = buildRepos((n, p) => repoGrant(`ghs_${n}`, p.repoFullName ?? 'acme/infra'))
      await h.cache.get(AGENT, 'helper', { repo: 'other-org/tools' })
      h.cache.remove(AGENT)
      expect((await h.cache.get(AGENT, 'helper', { repo: 'other-org/tools' })).token).toBe('ghs_2')
    })
  })

  describe('daemon-owned gitlab leases (gitlab-com-integration.md 14.1/14.2)', () => {
    const PROJECT = '4455667'

    function buildEffect(responder: (n: number, payload: { purpose?: string }) => GitCredGrant) {
      let calls = 0
      let mono = 0
      const cache = new GitCredentialCache({
        request: async (p) => {
          calls += 1
          return responder(calls, p)
        },
        log: { warn: () => {} },
        providerV2Supported: () => true,
        gitlabEffectSupported: () => true,
        monoNow: () => mono
      })
      return { cache, calls: () => calls, advance: (ms: number) => (mono += ms) }
    }

    function effectGrant(token: string): GitCredGrant {
      return {
        username: 'project_4455667_bot',
        token,
        ttlSec: 3540,
        expiresAt: '2026-07-06T13:00:00.000Z',
        repoFullName: 'example-group/example-project',
        access: 'comment',
        provider: 'gitlab',
        externalRepoId: PROJECT
      }
    }

    it('keeps a SCOPE_DENIED effect lease retryable instead of durably denying the key', async () => {
      const h = buildEffect((n) => {
        if (n === 1) throw Object.assign(new Error('hook is not enabled'), { code: 'SCOPE_DENIED' })
        return effectGrant(`glpat_${n}`)
      })
      // A stale hook refusal is NOT terminal: hook lifecycle never replicates an agent spec,
      // so a durable denial here could only be cleared by a restart or an unrelated upsert.
      await expect(h.cache.getGitlabEffectToken(AGENT, PROJECT, HOOK)).rejects.toMatchObject({ terminal: false })
      // The very next call re-contacts the CP, which re-resolves the hook live.
      expect((await h.cache.getGitlabEffectToken(AGENT, PROJECT, HOOK)).token).toBe('glpat_2')
      expect(h.calls()).toBe(2)
    })

    it('does not need clearDenied to recover, and never silences the agent workspace key', async () => {
      const h = buildEffect((n) => {
        if (n <= 2) throw Object.assign(new Error('hook is not enabled'), { code: 'SCOPE_DENIED' })
        return effectGrant(`glpat_${n}`)
      })
      await expect(h.cache.getGitlabEffectToken(AGENT, PROJECT)).rejects.toBeInstanceOf(GitCredUnavailableError)
      await expect(h.cache.getGitlabEffectToken(AGENT, PROJECT)).rejects.toBeInstanceOf(GitCredUnavailableError)
      // Two refusals, two CP asks — no local negative cache absorbed the second one.
      expect(h.calls()).toBe(2)
      expect((await h.cache.getGitlabEffectToken(AGENT, PROJECT)).token).toBe('glpat_3')
      // And the agent's own workspace grant was never dragged into the denial.
      expect((await h.cache.get(AGENT, 'clone', { provider: 'gitlab', externalRepoId: PROJECT })).token).toBe('glpat_4')
    })

    it('keeps a SCOPE_DENIED hook-reply lease retryable instead of durably denying the key', async () => {
      const h = buildEffect((n) => {
        if (n === 1) throw Object.assign(new Error('hook is not enabled'), { code: 'SCOPE_DENIED' })
        return effectGrant(`glpat_${n}`)
      })
      // The note poster carries only the numeric project, so this refusal used to read as agent-level.
      await expect(h.cache.getGitlabPostToken(AGENT, PROJECT, HOOK)).rejects.toMatchObject({ terminal: false })
      // A re-enabled hook takes effect on the next turn, with no agent upsert in between.
      expect((await h.cache.getGitlabPostToken(AGENT, PROJECT, HOOK)).token).toBe('glpat_2')
      expect(h.calls()).toBe(2)
    })

    it('recovers the note poster without clearDenied, and leaves the sibling keyspaces alone', async () => {
      const h = buildEffect((n) => {
        if (n <= 2) throw Object.assign(new Error('hook is not enabled'), { code: 'SCOPE_DENIED' })
        return effectGrant(`glpat_${n}`)
      })
      await expect(h.cache.getGitlabPostToken(AGENT, PROJECT, HOOK)).rejects.toBeInstanceOf(GitCredUnavailableError)
      await expect(h.cache.getGitlabPostToken(AGENT, PROJECT, HOOK)).rejects.toBeInstanceOf(GitCredUnavailableError)
      // Two refusals, two CP asks — nothing absorbed the second one locally.
      expect(h.calls()).toBe(2)
      expect((await h.cache.getGitlabPostToken(AGENT, PROJECT, HOOK)).token).toBe('glpat_3')
      // The broker lease and the agent's own workspace grant were never dragged into the denial.
      expect((await h.cache.getGitlabEffectToken(AGENT, PROJECT)).token).toBe('glpat_4')
      expect((await h.cache.get(AGENT, 'clone', { provider: 'gitlab', externalRepoId: PROJECT })).token).toBe('glpat_5')
    })

    it('leaves a workspace-keyed git SCOPE_DENIED terminal, exactly as before', async () => {
      const h = buildEffect((n, p) => {
        if (p.purpose === undefined) throw Object.assign(new Error('not placed here'), { code: 'SCOPE_DENIED' })
        return effectGrant(`glpat_${n}`)
      })
      await expect(h.cache.get(AGENT, 'push')).rejects.toMatchObject({ terminal: true })
      await expect(h.cache.get(AGENT, 'push')).rejects.toMatchObject({ terminal: true })
      expect(h.calls()).toBe(1) // still silenced locally — the git-purpose behavior is unchanged
      // …and that terminal git denial reaches neither daemon-owned writer's keyspace.
      expect((await h.cache.getGitlabEffectToken(AGENT, PROJECT)).token).toBe('glpat_2')
      expect((await h.cache.getGitlabPostToken(AGENT, PROJECT, HOOK)).token).toBe('glpat_3')
    })
  })
})

/**
 * §17.3 — GitHub requests carry `provider: 'github'` once the CP advertises gitcred-github-v2,
 * verify the echo like every other provider, and fall back to the pre-v2 shape otherwise. The
 * cache key is deliberately blind to which shape went out: one credential, one entry.
 */
describe('GitCredentialCache — explicit github provider (§17.3)', () => {
  type Payload = Parameters<GitCredentialCacheDeps['request']>[0]

  function buildV2(opts: { v2: boolean; respond?: (payload: Payload, n: number) => GitCredGrant }) {
    let calls = 0
    let mono = 0
    const seen: Payload[] = []
    const cache = new GitCredentialCache({
      request: async (payload) => {
        calls += 1
        seen.push(payload)
        if (opts.respond) return opts.respond(payload, calls)
        // The default answer echoes the repository the ask named — the identity guard refuses anything else.
        return { ...qualifiedGrant(`ghs_${calls}`), repoFullName: payload.repoFullName ?? 'acme/infra' }
      },
      log: { warn: () => {} },
      monoNow: () => mono,
      githubV2Supported: () => opts.v2
    })
    return { cache, seen, calls: () => calls, advance: (ms: number) => (mono += ms) }
  }

  const qualifiedGrant = (token: string): GitCredGrant => ({
    ...grant(token, 3540),
    provider: 'github',
    externalRepoId: '501'
  })

  it('qualifies the workspace, gh-plane, and hook-reply asks once the CP advertises the bit', async () => {
    const h = buildV2({ v2: true })
    await h.cache.get(AGENT, 'clone')
    await h.cache.get(AGENT, 'helper', { plane: 'gh', repo: 'acme/tools' })
    await h.cache.getPostToken(AGENT, 'acme/infra', HOOK)

    expect(h.seen.map((p) => p.provider)).toEqual(['github', 'github', 'github'])
    // Everything else about the ask is what it always was.
    expect(h.seen[1]).toMatchObject({
      repoFullName: 'acme/tools',
      capabilities: ['contents', 'issues', 'pull_requests']
    })
    expect(h.seen[2]).toMatchObject({ purpose: 'github_hook_reply', hookId: HOOK, repoFullName: 'acme/infra' })
    // The daemon knows no numeric GitHub identity for these asks, so it names none and the CP echo
    // is verified on the provider and the repository name alone.
    expect(h.seen.every((p) => p.externalRepoId === undefined && p.requestedAccess === undefined)).toBe(true)
  })

  it('sends the pre-v2 shape byte-identically to a control plane without the bit', async () => {
    const h = buildV2({
      v2: false,
      respond: (p, n) => ({ ...grant(`ghs_${n}`, 3540), repoFullName: p.repoFullName ?? 'acme/infra' })
    })
    await h.cache.get(AGENT, 'clone')
    await h.cache.get(AGENT, 'helper', { plane: 'gh', repo: 'acme/tools' })
    await h.cache.getPostToken(AGENT, 'acme/infra', HOOK)

    expect(h.seen[0]).toEqual({ agentId: AGENT, reason: 'clone' })
    expect(h.seen[1]).toEqual({
      agentId: AGENT,
      reason: 'helper',
      capabilities: ['contents', 'issues', 'pull_requests'],
      repoFullName: 'acme/tools'
    })
    expect(h.seen[2]).toEqual({
      agentId: AGENT,
      reason: 'helper',
      capabilities: ['issues', 'pull_requests'],
      repoFullName: 'acme/infra',
      purpose: 'github_hook_reply',
      hookId: HOOK
    })
  })

  it('refuses a grant whose provider or repository echo disagrees with the qualified ask', async () => {
    const stripped = buildV2({ v2: true, respond: (_p, n) => grant(`ghs_${n}`, 3540) })
    await expect(stripped.cache.get(AGENT, 'clone')).rejects.toThrow(/github \(unqualified\) for a github request/)

    const wrongRepo = buildV2({
      v2: true,
      respond: (_p, n) => ({ ...qualifiedGrant(`ghs_${n}`), repoFullName: 'acme/other' })
    })
    await expect(wrongRepo.cache.get(AGENT, 'helper', { repo: 'acme/tools' })).rejects.toThrow(GitCredUnavailableError)
  })

  it('serves ONE cache entry across both shapes: a CP downgrade must not split the credential', async () => {
    let v2 = true
    let calls = 0
    const mono = 0
    const cache = new GitCredentialCache({
      request: async () => {
        calls += 1
        return v2 ? qualifiedGrant(`ghs_${calls}`) : grant(`ghs_${calls}`, 3540)
      },
      log: { warn: () => {} },
      monoNow: () => mono,
      githubV2Supported: () => v2
    })

    expect((await cache.get(AGENT, 'clone')).token).toBe('ghs_1')
    v2 = false // reconnected to an older control plane
    expect((await cache.get(AGENT, 'push')).token).toBe('ghs_1')
    expect(calls).toBe(1) // the v1-shaped ask found the entry the qualified ask stored

    // …and the erase path reaches that same entry regardless of the shape that filled it.
    cache.invalidate(AGENT, 'ghs_1')
    expect((await cache.get(AGENT, 'push')).token).toBe('ghs_2')
    expect(calls).toBe(2)
  })
})
