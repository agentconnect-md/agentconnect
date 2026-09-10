/**
 * The tracking-ref seam (shared-skills.md §5): every new session's workspace
 * preparation asks where a moving skill branch head is now, so the cost of
 * asking — and the behavior when the answer is unavailable — is the contract.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitSkillRefTracker, isPinnedGitSkillRef } from '../src/skills/git-skill-ref-tracker.js'
import { resolveTrackedCommits, retainedAfterTracking, gitResolutionDigest } from '../src/skills/install-skills.js'
import type { GitSkillCommitResolution } from '../src/skills/skill-git-source.js'

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

describe('GitSkillRefTracker', () => {
  it('answers from cache within the TTL, then refreshes conditionally with the stored etag', async () => {
    let now = 1_000
    const seen: Array<string | undefined> = []
    let answer: GitSkillCommitResolution = { status: 'resolved', commit: FIRST, etag: 'W/"one"' }
    const tracker = new GitSkillRefTracker({
      stateRoot,
      ttlMs: 60_000,
      now: () => now,
      resolve: async (_e, opts) => {
        seen.push(opts.etag)
        return answer
      }
    })
    const ask = () => tracker.resolve(entry(), { agentId: 'a1', useGitCredential: false })

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
      stateRoot,
      resolve: async () => {
        calls += 1
        await gate
        return { status: 'resolved', commit: FIRST }
      }
    })
    const asks = [0, 1, 2].map(() => tracker.resolve(entry(), { agentId: 'a1', useGitCredential: false }))
    release!()
    expect(await Promise.all(asks)).toEqual([FIRST, FIRST, FIRST])
    expect(calls).toBe(1)
  })

  it('returns the last known commit when the check fails, and backs off before retrying', async () => {
    let now = 1_000
    let calls = 0
    let fail = false
    const tracker = new GitSkillRefTracker({
      stateRoot,
      ttlMs: 1,
      now: () => now,
      resolve: async () => {
        calls += 1
        if (fail) throw new Error('rate limited')
        return { status: 'resolved', commit: FIRST }
      }
    })
    const ask = () => tracker.resolve(entry(), { agentId: 'a1', useGitCredential: false })
    expect(await ask()).toBe(FIRST)

    fail = true
    now += 10
    expect(await ask()).toBe(FIRST) // unknown ⇒ keep what is installed
    expect(calls).toBe(2)
    now += 10
    expect(await ask()).toBe(FIRST) // still inside the failure backoff: no call
    expect(calls).toBe(2)
  })

  it('answers null for a ref pinned to a commit, without asking', async () => {
    let calls = 0
    const tracker = new GitSkillRefTracker({
      stateRoot,
      resolve: async () => {
        calls += 1
        return { status: 'resolved', commit: MOVED }
      }
    })
    expect(isPinnedGitSkillRef(entry({ ref: FIRST }))).toBe(true)
    expect(isPinnedGitSkillRef(entry({ ref: 'main' }))).toBe(false)
    expect(isPinnedGitSkillRef(entry())).toBe(false)
    expect(await tracker.resolve(entry({ ref: FIRST }), { agentId: 'a1', useGitCredential: false })).toBeNull()
    expect(calls).toBe(0)
  })
})

describe('tracking-ref retention helpers', () => {
  it('resolves each acquisition identity once and ignores a non-SHA answer', async () => {
    const entries = [entry(), entry({ name: 'twin' }), entry({ name: 'branch', ref: 'main' })]
    let calls = 0
    const tracked = await resolveTrackedCommits(entries, async (candidate) => {
      calls += 1
      return (candidate as { ref?: string }).ref === 'main' ? 'not-a-sha' : FIRST
    })
    // The first two share one repo/ref identity, so they share one resolution.
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
