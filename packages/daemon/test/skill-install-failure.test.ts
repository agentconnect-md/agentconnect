/**
 * What survives a failed install (shared-skills.md §6.3). An install that cannot
 * build a source says nothing about whether the operator still wants that skill —
 * only that this run could not rebuild it — so the bytes already published stay.
 * A source the desired set no longer names is a different thing entirely, and is
 * still removed: that removal needs no source, and leaving disabled executable
 * content active is what the clearing pass exists for.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  installSkills,
  type SkillsCliInvocation,
  type SkillsCliInvocationResult
} from '../src/skills/install-skills.js'

const skillBody = (name: string, marker = name) =>
  `---\nname: ${name}\ndescription: ${name} fixture\n---\n# ${marker}\n`

async function writeSkill(root: string, name: string, marker = name): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), skillBody(name, marker))
  return dir
}

function digest(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

/** The same deterministic CLI seam the unified installer suite uses: it decides
 * the harness directory and copies the selected bundle into the private cell. */
function fakeCli(rootForAgent: (agentId: string) => string) {
  const calls: SkillsCliInvocation[] = []
  const run = async (input: SkillsCliInvocation): Promise<SkillsCliInvocationResult> => {
    calls.push(input)
    const name = input.skills[0] ?? 'git-skill'
    const relativeRoot = [rootForAgent(input.agentId), 'skills', name].filter(Boolean).join('/')
    const bundleDir = join(input.cellDir, ...relativeRoot.split('/'))
    await mkdir(bundleDir, { recursive: true })
    const body = await readFile(join(input.sourceDir, 'SKILL.md'), 'utf8')
    await writeFile(join(bundleDir, 'SKILL.md'), body)
    return {
      bundles: [
        {
          relativeRoot,
          sourceDir: bundleDir,
          treeDigest: digest(body),
          files: [{ path: 'SKILL.md', mode: 0o600, size: Buffer.byteLength(body), sha256: digest(body) }]
        }
      ],
      stdoutDigest: digest('ok'),
      stderrDigest: digest('')
    }
  }
  return { calls, run }
}

describe('a failed install keeps what is still desired', () => {
  let root: string
  let cwd: string
  let stateDir: string
  let sources: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-skill-failure-'))
    cwd = join(root, 'workspace')
    stateDir = join(root, 'trusted-state')
    sources = join(root, 'sources')
    await mkdir(cwd)
    await mkdir(sources)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const FIRST = 'a'.repeat(40)
  const MOVED = 'b'.repeat(40)
  const entry = (name: string, skills: string[], over: Record<string, unknown> = {}) => ({
    name,
    source: `acme/${name}`,
    githubRepoId: name === 'git' ? '42' : '43',
    skills,
    ...over
  })

  async function installedRoots(): Promise<string[]> {
    const bundles = await readdir(join(cwd, '.runtime', 'skills')).catch(() => [] as string[])
    return bundles.sort()
  }

  it('keeps the published bundle when the tracked head cannot be acquired', async () => {
    const gitDir = await writeSkill(sources, 'git-skill', 'first version')
    const cli = fakeCli(() => '.runtime')
    let head = FIRST
    let acquire = async (candidate: { ref?: string }) => ({
      sourceDir: gitDir,
      resolvedCommit: candidate.ref ?? FIRST
    })
    const install = () =>
      installSkills({ id: 'a1', runtime: 'claude', skills: [entry('git', ['git-skill'])] }, cwd, {
        stateDir,
        acquireGit: (candidate: { ref?: string }) => acquire(candidate),
        resolveGitRef: async () => head,
        runCli: cli.run
      })

    await install()
    expect(await installedRoots()).toEqual(['git-skill'])
    const before = await readFile(join(cwd, '.runtime', 'skills', 'git-skill', 'SKILL.md'), 'utf8')

    // The head moved, and acquiring it fails — a rate limit, an outage, anything.
    head = MOVED
    acquire = async () => {
      throw new Error('skill GitHub commit resolution failed with status 403')
    }
    const failed = await install()
    expect(failed.errors).toEqual([{ source: 'git', error: 'skill GitHub commit resolution failed with status 403' }])
    expect(await installedRoots()).toEqual(['git-skill'])
    expect(await readFile(join(cwd, '.runtime', 'skills', 'git-skill', 'SKILL.md'), 'utf8')).toBe(before)
    // The ledger still names the commit that is on disk, so a later unknown answer
    // has something to fall back to.
    expect(failed.owned).toEqual(['.runtime/skills/git-skill'])
  })

  it('one unavailable source does not cost the others their skills', async () => {
    const gitDir = await writeSkill(sources, 'git-skill', 'git')
    const otherDir = await writeSkill(sources, 'other-skill', 'other')
    const cli = fakeCli(() => '.runtime')
    const skills = [entry('git', ['git-skill']), entry('other', ['other-skill'])]
    let failOther = false
    const acquireGit = async (candidate: { name?: string; ref?: string }) => {
      if (failOther && candidate.name === 'other') throw new Error('unavailable')
      return { sourceDir: candidate.name === 'other' ? otherDir : gitDir, resolvedCommit: candidate.ref ?? FIRST }
    }
    void MOVED
    const install = () =>
      installSkills({ id: 'a1', runtime: 'claude', skills }, cwd, {
        stateDir,
        acquireGit,
        resolveGitRef: async () => FIRST,
        runCli: cli.run
      })

    await install()
    expect(await installedRoots()).toEqual(['git-skill', 'other-skill'])

    // Move the head so the run genuinely rebuilds: `git` acquires it, `other` cannot.
    failOther = true
    const partial = await installSkills({ id: 'a1', runtime: 'claude', skills }, cwd, {
      stateDir,
      acquireGit,
      resolveGitRef: async () => MOVED,
      runCli: cli.run
    })
    expect(partial.errors.map((e) => e.source)).toEqual(['other'])
    expect(await installedRoots()).toEqual(['git-skill', 'other-skill'])
  })

  it('still removes a source the desired set no longer names', async () => {
    const gitDir = await writeSkill(sources, 'git-skill', 'git')
    const otherDir = await writeSkill(sources, 'other-skill', 'other')
    const cli = fakeCli(() => '.runtime')
    const acquireGit = async (candidate: { name?: string; ref?: string }) => ({
      sourceDir: candidate.name === 'other' ? otherDir : gitDir,
      resolvedCommit: candidate.ref ?? FIRST
    })
    const install = (skills: unknown[]) =>
      installSkills({ id: 'a1', runtime: 'claude', skills } as never, cwd, {
        stateDir,
        acquireGit,
        resolveGitRef: async () => FIRST,
        runCli: cli.run
      })

    await install([entry('git', ['git-skill']), entry('other', ['other-skill'])])
    expect(await installedRoots()).toEqual(['git-skill', 'other-skill'])

    // `other` is disabled AND `git` cannot be built: the disabled one still goes.
    const acquireFailing = async (candidate: { name?: string }) => {
      if (candidate.name === 'git') throw new Error('unavailable')
      return { sourceDir: gitDir, resolvedCommit: FIRST }
    }
    const pruned = await installSkills({ id: 'a1', runtime: 'claude', skills: [entry('git', ['git-skill'])] }, cwd, {
      stateDir,
      acquireGit: acquireFailing,
      resolveGitRef: async () => FIRST,
      runCli: cli.run
    })
    expect(pruned.errors.map((e) => e.source)).toEqual(['git'])
    expect(await installedRoots()).toEqual(['git-skill'])
  })

  // Sibling entries share a repository and ref, so the acquisition identity alone
  // would preserve a sibling that was just disabled — leaving explicitly disabled
  // executable content active, which is the one thing the old clearing pass got right.
  it('preserves the failed entry, not every entry sharing its acquisition identity', async () => {
    const oneDir = await writeSkill(join(sources, 'catalog'), 'one', 'one')
    const twoDir = await writeSkill(join(sources, 'catalog'), 'two', 'two')
    const cli = fakeCli(() => '.runtime')
    const one = { name: 'one', source: 'acme/skills', githubRepoId: '42', subDir: 'catalog/one', skills: ['one'] }
    const two = { name: 'two', source: 'acme/skills', githubRepoId: '42', subDir: 'catalog/two', skills: ['two'] }
    const acquireGit = async (candidate: { subDir?: string; ref?: string }) => ({
      sourceDir: candidate.subDir === 'catalog/one' ? oneDir : twoDir,
      resolvedCommit: candidate.ref ?? FIRST
    })

    await installSkills({ id: 'a1', runtime: 'claude', skills: [one, two] } as never, cwd, {
      stateDir,
      acquireGit,
      resolveGitRef: async () => FIRST,
      runCli: cli.run
    })
    expect(await installedRoots()).toEqual(['one', 'two'])

    // `two` is disabled and `one` cannot be acquired: only `one` is preserved.
    const pruned = await installSkills({ id: 'a1', runtime: 'claude', skills: [one] } as never, cwd, {
      stateDir,
      acquireGit: async () => {
        throw new Error('unavailable')
      },
      resolveGitRef: async () => FIRST,
      runCli: cli.run
    })
    expect(pruned.errors.map((e) => e.source)).toEqual(['one'])
    expect(await installedRoots()).toEqual(['one'])
    expect(pruned.removed).toEqual(['.runtime/skills/two'])
  })

  it('clears on failure only when nothing is desired at all — that is a complete statement', async () => {
    const gitDir = await writeSkill(sources, 'git-skill', 'git')
    const cli = fakeCli(() => '.runtime')
    await installSkills({ id: 'a1', runtime: 'claude', skills: [entry('git', ['git-skill'])] }, cwd, {
      stateDir,
      acquireGit: async (candidate: { ref?: string }) => ({
        sourceDir: gitDir,
        resolvedCommit: candidate.ref ?? FIRST
      }),
      resolveGitRef: async () => FIRST,
      runCli: cli.run
    })
    expect(await installedRoots()).toEqual(['git-skill'])

    // Every source disabled, and the run throws on the way to enacting that.
    const emptied = await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, {
      stateDir,
      runCli: async () => {
        throw new Error('skills CLI exited 1')
      }
    })
    expect(await installedRoots()).toEqual([])
    expect(emptied.owned).toEqual([])
  })

  it('keeps them when the CLI itself fails, which is not a statement about intent', async () => {
    const gitDir = await writeSkill(sources, 'git-skill', 'git')
    const cli = fakeCli(() => '.runtime')
    const acquireGit = async (candidate: { ref?: string }) => ({
      sourceDir: gitDir,
      resolvedCommit: candidate.ref ?? FIRST
    })
    await installSkills({ id: 'a1', runtime: 'claude', skills: [entry('git', ['git-skill'])] }, cwd, {
      stateDir,
      acquireGit,
      resolveGitRef: async () => FIRST,
      runCli: cli.run
    })
    expect(await installedRoots()).toEqual(['git-skill'])

    const broken = await installSkills(
      { id: 'a1', runtime: 'claude', skills: [entry('git', ['git-skill'], { ref: MOVED })] },
      cwd,
      {
        stateDir,
        acquireGit: async () => ({ sourceDir: gitDir, resolvedCommit: MOVED }),
        runCli: async () => {
          throw new Error('skills CLI exited 1')
        }
      }
    )
    expect(broken.errors.map((e) => e.source)).toEqual(['*'])
    expect(await installedRoots()).toEqual(['git-skill'])
    expect(broken.owned).toEqual(['.runtime/skills/git-skill'])
  })
})
