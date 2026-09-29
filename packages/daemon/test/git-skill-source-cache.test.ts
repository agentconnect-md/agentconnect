import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitSkillSourceCache } from '../src/skills/git-skill-source-cache.js'
import type { acquireGitSkillSource } from '../src/skills/skill-git-source.js'

const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)

const entry = (overrides: Record<string, unknown> = {}) =>
  ({
    name: 'source',
    source: 'acme/skills',
    githubRepoId: '42',
    ...overrides
  }) as Parameters<typeof acquireGitSkillSource>[0]

describe('Git skill source cache', () => {
  let root: string
  let clock: number
  let acquisitions: Array<{ agentId: string; ref?: string }>
  let verifications: string[]
  let head: string
  let denied: boolean

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-git-skill-cache-'))
    clock = 1_000_000_000_000
    acquisitions = []
    verifications = []
    head = COMMIT_A
    denied = false
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** A stand-in acquisition: writes a one-skill repository whose body names the commit it is at. */
  const acquire: typeof acquireGitSkillSource = async (source, opts) => {
    const ref = (source as { ref?: string }).ref
    acquisitions.push({ agentId: opts.agentId, ...(ref ? { ref } : {}) })
    // A SHA ref is pinned; anything else resolves to the current head, as GitHub would.
    const commit = ref && /^[a-f0-9]{40}$/.test(ref) ? ref : head
    const repository = join(opts.destination, 'repository')
    await mkdir(join(repository, 'pack', 'demo'), { recursive: true })
    await writeFile(join(repository, 'pack', 'demo', 'SKILL.md'), `commit ${commit}\n`)
    await writeFile(join(repository, 'README.md'), 'x'.repeat(1024))
    return { sourceDir: repository, resolvedCommit: commit, source: {} as never }
  }

  const cache = (overrides: ConstructorParameters<typeof GitSkillSourceCache>[1] = {}) =>
    new GitSkillSourceCache(join(root, 'cache'), {
      acquire,
      verifyAccess: async (_entry, opts) => {
        verifications.push(opts.agentId)
        if (denied) throw new Error('skill GitHub repository identity lookup failed with status 404')
      },
      now: () => clock,
      ...overrides
    })

  const options = (agentId = 'agent-1') => ({ agentId, useGitCredential: true })

  it('acquires a commit once and then serves it from the cache after re-proving access', async () => {
    const skills = cache()
    const first = await skills.resolve(entry(), COMMIT_A, options())
    expect(first).toMatchObject({ resolvedCommit: COMMIT_A, cached: false })
    const second = await skills.resolve(entry(), COMMIT_A, options())
    expect(second).toMatchObject({ resolvedCommit: COMMIT_A, cached: true })
    expect(second.sourceDir).toBe(first.sourceDir)
    expect(acquisitions).toEqual([{ agentId: 'agent-1', ref: COMMIT_A }])
    // The miss proved access through its own acquisition; the hit proved it with the identity request.
    expect(verifications).toEqual(['agent-1'])
    expect(await readFile(join(second.sourceDir, 'README.md'), 'utf8')).toHaveLength(1024)
  })

  it('applies the source folder to both a miss and a hit', async () => {
    const skills = cache()
    const miss = await skills.resolve(entry({ subDir: 'pack' }), COMMIT_A, options())
    const hit = await skills.resolve(entry({ subDir: 'pack' }), COMMIT_A, options())
    for (const result of [miss, hit]) {
      expect(await readdir(result.sourceDir)).toEqual(['demo'])
      expect(await readFile(join(result.sourceDir, 'demo', 'SKILL.md'), 'utf8')).toBe(`commit ${COMMIT_A}\n`)
    }
  })

  it('caches under the commit a ref resolved to, and a new commit is a new entry', async () => {
    const skills = cache()
    await skills.resolve(entry({ ref: 'main' }), undefined, options())
    expect((await skills.resolve(entry({ ref: 'main' }), COMMIT_A, options())).cached).toBe(true)
    head = COMMIT_B
    const moved = await skills.resolve(entry({ ref: 'main' }), COMMIT_B, options())
    expect(moved.cached).toBe(false)
    expect(await readFile(join(moved.sourceDir, 'pack', 'demo', 'SKILL.md'), 'utf8')).toBe(`commit ${COMMIT_B}\n`)
  })

  it('never answers one agent with an archive another agent acquired', async () => {
    const skills = cache()
    await skills.resolve(entry(), COMMIT_A, options('agent-1'))
    const other = await skills.resolve(entry(), COMMIT_A, options('agent-2'))
    expect(other.cached).toBe(false)
    expect(acquisitions.map((acquisition) => acquisition.agentId)).toEqual(['agent-1', 'agent-2'])
  })

  it('refuses a hit when the agent can no longer read the repository, without downloading', async () => {
    const skills = cache()
    await skills.resolve(entry(), COMMIT_A, options())
    denied = true
    await expect(skills.resolve(entry(), COMMIT_A, options())).rejects.toThrow(/status 404/)
    expect(acquisitions).toHaveLength(1)
  })

  it('evicts idle entries and the least recently used past the budget, never one in use', async () => {
    const skills = cache({ maxBytes: 2500, idleMs: 24 * 60 * 60_000, inUseMs: 60 * 60_000 })
    await skills.resolve(entry({ githubRepoId: '1' }), COMMIT_A, options())
    clock += 2 * 60 * 60_000
    await skills.resolve(entry({ githubRepoId: '2' }), COMMIT_A, options())
    // Two entries of ~1 KiB each fit; a third tips the budget, and the oldest one not in use goes.
    clock += 2 * 60 * 60_000
    await skills.resolve(entry({ githubRepoId: '3' }), COMMIT_A, options())
    acquisitions = []
    expect((await skills.resolve(entry({ githubRepoId: '1' }), COMMIT_A, options())).cached).toBe(false)
    expect((await skills.resolve(entry({ githubRepoId: '3' }), COMMIT_A, options())).cached).toBe(true)
    // Idle past a day: gone at the next prune, whatever the size.
    clock += 25 * 60 * 60_000
    await skills.prune()
    expect((await skills.resolve(entry({ githubRepoId: '3' }), COMMIT_A, options())).cached).toBe(false)
  })

  it('keeps an entry used within the in-use window even when the cache is over budget', async () => {
    const skills = cache({ maxBytes: 1, inUseMs: 60 * 60_000 })
    await skills.resolve(entry({ githubRepoId: '1' }), COMMIT_A, options())
    await skills.resolve(entry({ githubRepoId: '2' }), COMMIT_A, options())
    expect((await skills.resolve(entry({ githubRepoId: '1' }), COMMIT_A, options())).cached).toBe(true)
    expect((await skills.resolve(entry({ githubRepoId: '2' }), COMMIT_A, options())).cached).toBe(true)
  })

  it('downloads a commit once when two folders of one repository are requested at the same time', async () => {
    const skills = cache()
    const [pack, root] = await Promise.all([
      skills.resolve(entry({ subDir: 'pack' }), COMMIT_A, options()),
      skills.resolve(entry(), COMMIT_A, options())
    ])
    expect(acquisitions).toHaveLength(1)
    expect(await readdir(pack.sourceDir)).toEqual(['demo'])
    expect((await readdir(root.sourceDir)).sort()).toEqual(['README.md', 'pack'])
    // Once published, both folders are hits sharing one claim and its access check; still no download.
    await Promise.all([
      skills.resolve(entry({ subDir: 'pack' }), COMMIT_A, options()),
      skills.resolve(entry(), COMMIT_A, options())
    ])
    expect(acquisitions).toHaveLength(1)
  })

  it('lets two preparations that miss the same commit at once both succeed on one entry', async () => {
    const skills = cache()
    const [left, right] = await Promise.all([
      skills.resolve(entry(), COMMIT_A, options()),
      skills.resolve(entry(), COMMIT_A, options())
    ])
    expect(left.sourceDir).toBe(right.sourceDir)
    expect(await readFile(join(left.sourceDir, 'pack', 'demo', 'SKILL.md'), 'utf8')).toBe(`commit ${COMMIT_A}\n`)
    // Nothing of either staging area is left behind.
    expect((await readdir(join(root, 'cache', '.staging'))).length).toBe(0)
  })
})
