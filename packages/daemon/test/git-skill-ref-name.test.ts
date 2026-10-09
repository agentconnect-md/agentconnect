// Naming the full ref an anonymous skill entry follows (source-cache.md §5): real git over a local bare repository.
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentSkillEntry } from '@agentconnect.md/protocol'
import {
  GIT_SKILL_REF_NAME_MAX_BYTES,
  nameGitSkillRef,
  runBoundedGit,
  type GitRefNameInvocation,
  type GitRefNameRunner
} from '../src/skills/git-skill-ref-name.js'
import { GitSkillRefTracker } from '../src/skills/git-skill-ref-tracker.js'
import { createSkillRefPlanResolution, createSkillRefResolution } from '../src/skills/skill-ref-resolution.js'
import type { GitSkillCommitResolution } from '../src/skills/skill-git-source.js'

const URL_ = 'https://github.com/acme/skills.git'
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@e',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@e',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null'
}
const git = (cwd: string, args: string[]): string => {
  const result = spawnSync('git', args, { cwd, env: gitEnv })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

let root: string
let origin: string
let home: string
const tips: Record<string, string> = {}

// A bare origin on `trunk` with a second branch `main`, an annotated tag `v1`, a lightweight tag `light`, and `both` as a branch and a tag.
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ac-ref-name-'))
  home = join(root, 'home')
  origin = join(root, 'origin.git')
  const work = join(root, 'work')
  git(root, ['init', '-q', '--initial-branch=trunk', work])
  git(work, ['commit', '-q', '--allow-empty', '-m', 'one'])
  tips.one = git(work, ['rev-parse', 'HEAD'])
  git(work, ['tag', '-a', 'v1', '-m', 'v1'])
  git(work, ['tag', 'light'])
  git(work, ['branch', 'both'])
  git(work, ['tag', 'both'])
  git(work, ['branch', 'main'])
  git(work, ['commit', '-q', '--allow-empty', '-m', 'two'])
  tips.trunk = git(work, ['rev-parse', 'HEAD'])
  git(root, ['clone', '-q', '--bare', work, origin])
  // Thousands of tags in one packed-refs file: the scoped patterns keep the listing a few lines.
  const many = Array.from({ length: 3000 }, (_, i) => `${tips.one} refs/tags/release-${i}`).join('\n')
  const packed = (await readFile(join(origin, 'packed-refs'), 'utf8')).replace(/^#.*\n/, '')
  await writeFile(join(origin, 'packed-refs'), `# pack-refs with: peeled fully-peeled \n${packed}${many}\n`)
  await mkdir(home, { recursive: true })
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The real bounded runner with the canonical URL served from the local bare repository. */
const local =
  (seen?: GitRefNameInvocation[]): GitRefNameRunner =>
  async (invocation) => {
    seen?.push(invocation)
    return await runBoundedGit({
      ...invocation,
      args: invocation.args.map((arg) => (arg === URL_ ? pathToFileURL(origin).href : arg)),
      env: { ...invocation.env, GIT_ALLOW_PROTOCOL: `${invocation.env.GIT_ALLOW_PROTOCOL}:file` }
    })
  }

const name = (ref: string | undefined, seen?: GitRefNameInvocation[]) =>
  nameGitSkillRef({ url: URL_, ...(ref !== undefined ? { name: ref } : {}), privateHome: home, run: local(seen) })

describe('nameGitSkillRef (anonymous ls-remote)', () => {
  it('names the default branch for an absent ref', async () => {
    expect(await name(undefined)).toEqual({ kind: 'named', ref: 'refs/heads/trunk', commit: tips.trunk })
  })

  it('names a short branch name as its branch', async () => {
    expect(await name('main')).toEqual({ kind: 'named', ref: 'refs/heads/main', commit: tips.one })
  })

  it('names a tag-only name as its tag, with the peeled commit of an annotated tag', async () => {
    expect(await name('v1')).toEqual({ kind: 'named', ref: 'refs/tags/v1', commit: tips.one })
    expect(await name('light')).toEqual({ kind: 'named', ref: 'refs/tags/light', commit: tips.one })
    expect(await name('release-2999')).toEqual({ kind: 'named', ref: 'refs/tags/release-2999', commit: tips.one })
  })

  it('leaves a name that is both a branch and a tag, or neither, unnamed', async () => {
    expect(await name('both')).toEqual({ kind: 'unnamed', reason: 'ambiguous' })
    expect(await name('nothing')).toEqual({ kind: 'unnamed', reason: 'absent' })
  })

  it('refuses a glob or invalid name without spawning, and lists by exact patterns only', async () => {
    const seen: GitRefNameInvocation[] = []
    for (const bad of ['*', 'release-*', 'a..b', 'a b', 'x.lock']) {
      expect(await name(bad, seen)).toEqual({ kind: 'unnamed', reason: 'invalid' })
    }
    expect(seen).toEqual([])
    await name('main', seen)
    expect(seen[0]!.args).toEqual([
      'ls-remote',
      '-q',
      '--',
      URL_,
      'refs/heads/main',
      'refs/tags/main',
      'refs/tags/main^{}'
    ])
    expect(GIT_SKILL_REF_NAME_MAX_BYTES).toBeLessThan(64 * 1024)
    // Unscoped, this origin's tags alone overflow the cap: the patterns are what keep it bounded.
    await expect(local()({ ...seen[0]!, args: ['ls-remote', '-q', '--', URL_] })).rejects.toThrow(/MAXBUFFER/)
  })

  it('runs anonymously: no credential helper, no system or global config, no prompt', async () => {
    const seen: GitRefNameInvocation[] = []
    await name(undefined, seen)
    const env = seen[0]!.env
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(env.HOME).toBe(home)
    expect(Object.keys(env).filter((key) => key.startsWith('AC_GITCRED_'))).toEqual([])
    const pairs = Object.entries(env).filter(([key]) => key.startsWith('GIT_CONFIG_KEY_'))
    const helper = pairs.find(([, value]) => value === 'credential.helper')
    expect(helper && env[helper[0].replace('KEY', 'VALUE')]).toBe('')
    expect(pairs.filter(([, value]) => /^credential\..+\.helper$/.test(value))).toEqual([])
  })

  it('refuses a URL outside github.com before any spawn', async () => {
    const seen: GitRefNameInvocation[] = []
    await expect(
      nameGitSkillRef({ url: pathToFileURL(origin).href, privateHome: home, run: local(seen) })
    ).rejects.toThrow()
    expect(seen).toEqual([])
  })
})

const entry = (over: Record<string, unknown> = {}) =>
  ({ name: 'git', source: 'acme/skills', githubRepoId: '42', skills: ['git-skill'], ...over }) as AgentSkillEntry

/** A tracker whose REST check reports `commit`, with real naming over the local origin. */
function tracker(opts: { commit?: (e: AgentSkillEntry) => string; now?: () => number; namings?: string[] } = {}) {
  const restCalls: AgentSkillEntry[] = []
  const t = new GitSkillRefTracker({
    stateRoot: root,
    ...(opts.now ? { now: opts.now } : {}),
    resolve: async (e): Promise<GitSkillCommitResolution> => {
      restCalls.push(e)
      return { status: 'resolved', commit: opts.commit?.(e) ?? tips.trunk! }
    },
    nameRef: async (input) => {
      opts.namings?.push(input.name ?? 'HEAD')
      return await nameGitSkillRef({ ...input, run: local() })
    }
  })
  return { t, restCalls }
}

describe('GitSkillRefTracker names the full ref of an anonymous Source', () => {
  it('reports refs/heads/<default> and its commit for a no-ref entry', async () => {
    const { t } = tracker()
    expect(await t.resolveTracked(entry())).toEqual({ commit: tips.trunk, ref: 'refs/heads/trunk' })
    expect(await t.resolve(entry())).toBe(tips.trunk)
  })

  it('reports refs/heads/main for `main`, and the tag for a tag-only name with its peeled commit', async () => {
    const { t } = tracker({ commit: (e) => (e.ref === undefined ? tips.trunk! : tips.one!) })
    expect(await t.resolveTracked(entry({ ref: 'main' }))).toEqual({ commit: tips.one, ref: 'refs/heads/main' })
    expect(await t.resolveTracked(entry({ ref: 'v1' }))).toEqual({ commit: tips.one, ref: 'refs/tags/v1' })
  })

  it('serves the commit without a ref for an ambiguous name or a listing that saw another commit', async () => {
    const { t } = tracker({ commit: () => tips.one! })
    expect(await t.resolveTracked(entry({ ref: 'both' }))).toEqual({ commit: tips.one })
    // The REST answer moved past what the listing saw: the planned commit must be the ref's, so no ref yet.
    expect(await t.resolveTracked(entry())).toEqual({ commit: tips.one })
  })

  it('keeps a full ref spelled in the entry without listing, and never names a pinned or credentialed Source', async () => {
    const namings: string[] = []
    const { t, restCalls } = tracker({ namings })
    expect(await t.resolveTracked(entry({ ref: 'refs/tags/v9' }))).toEqual({ commit: tips.trunk, ref: 'refs/tags/v9' })
    expect(await t.resolveTracked(entry({ ref: tips.one }))).toBeNull()
    expect(await t.resolveTracked(entry({ private: true }))).toBeNull()
    expect(namings).toEqual([])
    expect(restCalls).toHaveLength(1)
  })

  it('names once per commit and shares the answer across agents', async () => {
    let now = 1_000
    const namings: string[] = []
    const { t, restCalls } = tracker({ now: () => now, namings })
    const plan = createSkillRefPlanResolution({
      anonymous: t,
      credentialed: {
        resolveRef: async () => {
          throw new Error('never asked')
        }
      }
    })
    const a = await plan(entry(), 'agent-a')
    const b = await plan(entry(), 'agent-b')
    expect(a).toEqual({ ok: true, commit: tips.trunk, ref: 'refs/heads/trunk', pinned: false, credentialed: false })
    expect(b).toEqual(a)
    now += 120_000
    // `main` sits behind the REST answer here, so it is listed and left unnamed.
    expect(await plan(entry({ ref: 'main' }), 'agent-a')).not.toHaveProperty('ref')
    expect(await plan(entry(), 'agent-a')).toEqual(a)
    // Two REST refreshes of the no-ref entry, one naming: the commit did not move.
    expect(restCalls.filter((e) => e.ref === undefined)).toHaveLength(2)
    expect(namings).toEqual(['HEAD', 'main'])
  })

  it('serves the commit without a ref when the listing fails, and names again on the next refresh', async () => {
    let now = 1_000
    let fail = true
    const warnings: string[] = []
    const t = new GitSkillRefTracker({
      stateRoot: root,
      now: () => now,
      resolve: async () => ({ status: 'resolved', commit: tips.trunk! }),
      nameRef: async (input) => {
        if (fail) throw new Error('git ls-remote failed (128)')
        return await nameGitSkillRef({ ...input, run: local() })
      },
      warn: (message) => warnings.push(message)
    })
    expect(await t.resolveTracked(entry())).toEqual({ commit: tips.trunk })
    // Paused, and warned once per commit, while github.com stays unreachable.
    now += 120_000
    expect(await t.resolveTracked(entry())).toEqual({ commit: tips.trunk })
    now += 5 * 60_000
    expect(await t.resolveTracked(entry())).toEqual({ commit: tips.trunk })
    expect(warnings).toEqual([expect.stringContaining('ref naming failed')])
    fail = false
    now += 6 * 60_000
    expect(await t.resolveTracked(entry())).toEqual({ commit: tips.trunk, ref: 'refs/heads/trunk' })
  })

  it('never lists for the commit-only resolution a daemon without a cache uses', async () => {
    const namings: string[] = []
    const { t } = tracker({ namings })
    const commitOf = createSkillRefResolution({
      anonymous: t,
      credentialed: {
        resolveRef: async () => {
          throw new Error('never asked')
        }
      }
    })
    expect(await commitOf(entry({ ref: 'main' }), 'agent-a')).toBe(tips.trunk)
    expect(namings).toEqual([])
  })

  it('never lists for resolve(), and keeps a named ref through a failed commit check', async () => {
    let now = 1_000
    let restFails = false
    const namings: string[] = []
    const t = new GitSkillRefTracker({
      stateRoot: root,
      now: () => now,
      resolve: async (): Promise<GitSkillCommitResolution> => {
        if (restFails) throw new Error('rate limited')
        return { status: 'resolved', commit: tips.trunk! }
      },
      nameRef: async (input) => {
        namings.push(input.name ?? 'HEAD')
        return await nameGitSkillRef({ ...input, run: local() })
      }
    })
    expect(await t.resolve(entry())).toBe(tips.trunk)
    expect(namings).toEqual([])
    expect(await t.resolveTracked(entry())).toEqual({ commit: tips.trunk, ref: 'refs/heads/trunk' })
    restFails = true
    now += 120_000
    expect(await t.resolveTracked(entry())).toBeNull()
    restFails = false
    now += 120_000
    expect(await t.resolveTracked(entry())).toEqual({ commit: tips.trunk, ref: 'refs/heads/trunk' })
    expect(namings).toEqual(['HEAD'])
  })
})
