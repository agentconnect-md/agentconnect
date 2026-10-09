// The tracking-ref seam (shared-skills.md §5, source-cache.md §5): cost, isolation and the unknown answer are the contract.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CodeHostProvider } from '@agentconnect.md/protocol'
import { CodeHostRefResolver } from '../src/codehost/ref-resolver.js'
import type {
  CodeHostRepositoryModule,
  ProviderAnswer,
  ProviderResolveInput,
  RepositoryReadTokens,
  RepositoryTokenAsk
} from '../src/codehost/repository.js'
import { GitCredUnavailableError } from '../src/cp/git-credential.js'
import { GitSkillRefTracker } from '../src/skills/git-skill-ref-tracker.js'
import { createSkillRefResolution } from '../src/skills/skill-ref-resolution.js'
import {
  GitSkillCommitResolutionError,
  isPinnedGitSkillRef,
  type GitSkillCommitResolution,
  type ResolveGitSkillCommitOptions
} from '../src/skills/skill-git-source.js'
import { resolveTrackedCommits, retainedAfterTracking, gitResolutionDigest } from '../src/skills/install-skills.js'

// These cases are about the commit; naming the ref is covered in git-skill-ref-name.test.ts.
const unnamed = async () => ({ kind: 'unnamed' as const, reason: 'absent' as const })
const FIRST = 'a'.repeat(40)
const MOVED = 'b'.repeat(40)
const entry = (over: Record<string, unknown> = {}) =>
  ({
    name: 'git',
    source: 'acme/skills',
    githubRepoId: '42',
    skills: ['git-skill'],
    ...over
  }) as never

let stateRoot: string
beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'ac-ref-tracker-'))
})
afterEach(async () => {
  await rm(stateRoot, { recursive: true, force: true })
})

describe('GitSkillRefTracker (anonymous github.com check)', () => {
  it('answers from cache within the TTL, then refreshes conditionally with the stored etag', async () => {
    let now = 1_000
    const seen: Array<string | undefined> = []
    let answer: GitSkillCommitResolution = { status: 'resolved', commit: FIRST, etag: 'W/"one"' }
    const tracker = new GitSkillRefTracker({
      nameRef: unnamed,
      stateRoot,
      ttlMs: 60_000,
      now: () => now,
      resolve: async (_e, opts) => {
        seen.push(opts.etag)
        return answer
      }
    })
    const ask = () => tracker.resolve(entry())

    expect(await ask()).toBe(FIRST)
    now += 30_000
    expect(await ask()).toBe(FIRST) // inside the TTL: no second request
    expect(seen).toEqual([undefined])

    // Past the TTL the etag rides along; a 304 keeps the known commit for free.
    now += 40_000
    answer = { status: 'unchanged' }
    expect(await ask()).toBe(FIRST)
    expect(seen).toEqual([undefined, 'W/"one"'])

    now += 70_000
    answer = { status: 'resolved', commit: MOVED }
    expect(await ask()).toBe(MOVED)
  })

  it('collapses concurrent askers into one request', async () => {
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const tracker = new GitSkillRefTracker({
      nameRef: unnamed,
      stateRoot,
      resolve: async () => {
        calls += 1
        await gate
        return { status: 'resolved', commit: FIRST }
      }
    })
    const asks = [0, 1, 2].map(() => tracker.resolve(entry()))
    release!()
    expect(await Promise.all(asks)).toEqual([FIRST, FIRST, FIRST])
    expect(calls).toBe(1)
  })

  it('lets a failure replace a cached success at once, backing off 5 s doubling to 60 s', async () => {
    let now = 1_000
    let calls = 0
    let fail = false
    const tracker = new GitSkillRefTracker({
      nameRef: unnamed,
      stateRoot,
      ttlMs: 1,
      now: () => now,
      resolve: async () => {
        calls += 1
        if (fail) throw new Error('status 502')
        return { status: 'resolved', commit: FIRST }
      }
    })
    const ask = () => tracker.resolve(entry())
    expect(await ask()).toBe(FIRST)

    fail = true
    now += 10
    expect(await ask()).toBeNull() // unknown ⇒ the installed commit stands
    expect(calls).toBe(2)
    for (const window of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      now += window - 1
      expect(await ask()).toBeNull()
      const before = calls
      now += 1
      await ask()
      expect(calls, `window ${window}`).toBe(before + 1)
    }
    fail = false
    now += 60_000
    expect(await ask()).toBe(FIRST)
  })

  it('stretches the backoff to the host’s Retry-After, capped at 15 minutes', async () => {
    let now = 1_000
    let calls = 0
    let wait = 120_000
    const tracker = new GitSkillRefTracker({
      nameRef: unnamed,
      stateRoot,
      now: () => now,
      resolve: async () => {
        calls += 1
        throw new GitSkillCommitResolutionError('rate limited', wait)
      }
    })
    await tracker.resolve(entry())
    now += 119_999
    await tracker.resolve(entry())
    expect(calls).toBe(1)
    now += 1
    wait = 60 * 60_000
    await tracker.resolve(entry())
    expect(calls).toBe(2)
    now += 15 * 60_000 - 1
    await tracker.resolve(entry())
    expect(calls).toBe(2)
    now += 1
    await tracker.resolve(entry())
    expect(calls).toBe(3)
  })

  it('answers null for a ref pinned to a commit, without asking', async () => {
    let calls = 0
    const tracker = new GitSkillRefTracker({
      nameRef: unnamed,
      stateRoot,
      resolve: async () => {
        calls += 1
        return { status: 'resolved', commit: MOVED }
      }
    })
    expect(isPinnedGitSkillRef(entry({ ref: FIRST }))).toBe(true)
    expect(isPinnedGitSkillRef(entry({ ref: 'main' }))).toBe(false)
    expect(isPinnedGitSkillRef(entry())).toBe(false)
    expect(await tracker.resolve(entry({ ref: FIRST }))).toBeNull()
    expect(calls).toBe(0)
  })

  it('never answers a credentialed Source and never asks with a credential', async () => {
    const asked: ResolveGitSkillCommitOptions[] = []
    const tracker = new GitSkillRefTracker({
      nameRef: unnamed,
      stateRoot,
      resolve: async (_e, opts) => {
        asked.push(opts)
        return { status: 'resolved', commit: FIRST }
      }
    })
    expect(await tracker.resolve(entry({ private: true }))).toBeNull()
    expect(asked).toHaveLength(0)
    expect(await tracker.resolve(entry())).toBe(FIRST)
    expect(asked).toHaveLength(1)
    expect(asked[0]!.useGitCredential).toBe(false)
    expect(asked[0]!.credentialProvider).toBeUndefined()
    expect(asked[0]!.agentId).not.toMatch(/^agent-/)
  })
})

const PRIVATE = (over: Record<string, unknown> = {}) =>
  entry({ name: 'private', source: 'acme/private-skills', githubRepoId: '77', private: true, ...over })

/** The routed resolution over a real CodeHostRefResolver, a scripted host and per-agent tokens. */
function routed(opts: { revoked?: Set<string>; host?: (input: ProviderResolveInput) => ProviderAnswer } = {}) {
  let now = 1_000_000
  const hostCalls: ProviderResolveInput[] = []
  const asks: Array<{ agentId: string; ask: RepositoryTokenAsk }> = []
  const module: CodeHostRepositoryModule = {
    provider: 'github',
    apiBaseUrl: () => 'https://api.github.com',
    readTokenAsk: (repository) => ({
      plane: 'git',
      ...(repository.repoFullName ? { repoFullName: repository.repoFullName } : {})
    }),
    resolve: async (input) => {
      hostCalls.push(input)
      return (
        opts.host?.(input) ?? { ok: true, commit: input.token.startsWith('agent-a') ? FIRST : MOVED, validators: {} }
      )
    }
  }
  const tokens: RepositoryReadTokens = {
    async get(agentId, ask) {
      asks.push({ agentId, ask })
      if (opts.revoked?.has(agentId)) throw new GitCredUnavailableError('revoked', false, 'repository')
      return { token: `${agentId}-token` }
    },
    invalidate() {}
  }
  const credentialed = new CodeHostRefResolver({
    tokens,
    modules: (provider: CodeHostProvider) => (provider === 'github' ? module : undefined),
    now: () => now
  })
  const anonymousCalls: ResolveGitSkillCommitOptions[] = []
  const anonymous = new GitSkillRefTracker({
    nameRef: unnamed,
    stateRoot,
    now: () => now,
    resolve: async (_e, o) => {
      anonymousCalls.push(o)
      return { status: 'resolved', commit: FIRST }
    }
  })
  const resolve = createSkillRefResolution({ anonymous, credentialed })
  return { resolve, credentialed, hostCalls, asks, anonymousCalls, advance: (ms: number) => (now += ms) }
}

describe('skill ref resolution routing (source-cache.md §5)', () => {
  it('never shares a credentialed answer across agents, and asks a token scoped to the skill repository', async () => {
    const h = routed()
    expect(await h.resolve(PRIVATE(), 'agent-a')).toBe(FIRST)
    expect(await h.resolve(PRIVATE(), 'agent-b')).toBe(MOVED)
    expect(await h.resolve(PRIVATE(), 'agent-a')).toBe(FIRST)
    expect(h.hostCalls).toHaveLength(2)
    expect(h.asks).toEqual([
      { agentId: 'agent-a', ask: { plane: 'git', repoFullName: 'acme/private-skills' } },
      { agentId: 'agent-b', ask: { plane: 'git', repoFullName: 'acme/private-skills' } }
    ])
    expect(h.hostCalls[0]!.repository).toMatchObject({
      provider: 'github',
      externalId: '77',
      path: 'acme/private-skills'
    })
    expect(h.anonymousCalls).toHaveLength(0)
  })

  it('stops a revoked agent within 60 s while another agent’s cached answer is unaffected', async () => {
    const revoked = new Set<string>()
    const h = routed({ revoked })
    expect(await h.resolve(PRIVATE(), 'agent-a')).toBe(FIRST)
    h.advance(30_000)
    expect(await h.resolve(PRIVATE(), 'agent-b')).toBe(MOVED)
    revoked.add('agent-a')
    h.advance(30_000)
    expect(await h.resolve(PRIVATE(), 'agent-a')).toBeNull()
    const calls = h.hostCalls.length
    expect(await h.resolve(PRIVATE(), 'agent-b')).toBe(MOVED)
    expect(h.hostCalls).toHaveLength(calls)
  })

  it('forgetting one agent never evicts another agent’s answer', async () => {
    const h = routed()
    await h.resolve(PRIVATE(), 'agent-a')
    await h.resolve(PRIVATE(), 'agent-b')
    h.credentialed.forgetAgent('agent-a')
    await h.resolve(PRIVATE(), 'agent-b')
    expect(h.hostCalls).toHaveLength(2)
    await h.resolve(PRIVATE(), 'agent-a')
    expect(h.hostCalls).toHaveLength(3)
  })

  it('shares the anonymous github.com answer across agents, without any credential or private answer in it', async () => {
    const h = routed()
    expect(await h.resolve(entry(), 'agent-a')).toBe(FIRST)
    expect(await h.resolve(entry(), 'agent-b')).toBe(FIRST)
    expect(h.anonymousCalls).toHaveLength(1)
    expect(h.anonymousCalls[0]!.useGitCredential).toBe(false)
    expect(JSON.stringify(h.anonymousCalls[0])).not.toMatch(/agent-|token/)
    // A private Source of the same repository and ref is still asked per agent, never served the shared answer.
    await h.resolve(PRIVATE({ source: 'acme/skills', githubRepoId: '42' }), 'agent-a')
    expect(h.hostCalls).toHaveLength(1)
    expect(h.asks).toHaveLength(1)
  })

  it('resolves a bare name as a branch first, then as a tag', async () => {
    const h = routed({
      host: (input) =>
        input.ref.kind === 'branch'
          ? { ok: false, reason: 'ref_not_found', detail: 'status_404' }
          : { ok: true, commit: FIRST, validators: {} }
    })
    expect(await h.resolve(PRIVATE({ ref: 'v1.0' }), 'agent-a')).toBe(FIRST)
    expect(h.hostCalls.map((c) => c.ref)).toEqual([
      { kind: 'branch', name: 'v1.0' },
      { kind: 'tag', name: 'v1.0' }
    ])
  })

  it('maps an absent ref to the default branch and leaves a pinned SHA unasked', async () => {
    const h = routed()
    await h.resolve(PRIVATE(), 'agent-a')
    expect(h.hostCalls[0]!.ref).toEqual({ kind: 'default' })
    expect(await h.resolve(PRIVATE({ ref: MOVED }), 'agent-a')).toBeNull()
    expect(h.hostCalls).toHaveLength(1)
  })

  it('keeps the daemon-local install path resolving a credentialed Source through the resolver', async () => {
    // installSkills' resolveGitRef feeds resolveTrackedCommits exactly like this.
    const h = routed()
    const tracked = await resolveTrackedCommits([PRIVATE(), entry()], (candidate) => h.resolve(candidate, 'agent-a'))
    expect(tracked.get(gitResolutionDigest(PRIVATE()))).toBe(FIRST)
    expect(tracked.get(gitResolutionDigest(entry()))).toBe(FIRST)
    expect(h.hostCalls).toHaveLength(1)
    expect(h.anonymousCalls).toHaveLength(1)
  })
})

describe('tracking-ref retention helpers', () => {
  it('resolves each acquisition identity once, skips a pinned ref, and ignores a non-SHA answer', async () => {
    const entries = [
      entry(),
      entry({ name: 'twin' }),
      entry({ name: 'branch', ref: 'main' }),
      entry({ name: 'exact', ref: MOVED })
    ]
    let calls = 0
    const tracked = await resolveTrackedCommits(entries, async (candidate) => {
      calls += 1
      return (candidate as { ref?: string }).ref === 'main' ? 'not-a-sha' : FIRST
    })
    // The first two share one repo/ref identity; the pinned one is never asked.
    expect(calls).toBe(2)
    expect([...tracked.values()]).toEqual([FIRST])
    expect(tracked.get(gitResolutionDigest(entry()))).toBe(FIRST)
  })

  it('keeps a retention the head agrees with and drops the one it moved past', () => {
    const retained = [
      { definitionDigest: 'd1', resolvedCommit: FIRST },
      { definitionDigest: 'd2', resolvedCommit: FIRST }
    ]
    const survivors = retainedAfterTracking(retained, new Map([['d2', MOVED]]))
    expect(survivors).toEqual([{ definitionDigest: 'd1', resolvedCommit: FIRST }])
  })

  it('resolves nothing at all without a resolver — the retained commit stands', async () => {
    expect([...(await resolveTrackedCommits([entry()], undefined)).keys()]).toEqual([])
  })
})
