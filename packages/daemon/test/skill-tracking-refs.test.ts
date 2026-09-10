/**
 * Tracking versus pinned Git skill refs (shared-skills.md §5): what one install
 * decides to acquire, and — the part that matters — when the publication layer
 * is allowed to answer "unchanged". These cases drive the real installer through
 * an injected CLI seam and need no sandbox, so they run in the ordinary unit
 * lane rather than only where bwrap exists.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

describe('tracking and pinned Git skill refs', () => {
  let root: string
  let cwd: string
  let stateDir: string
  let sources: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-skill-refs-'))
    cwd = join(root, 'workspace')
    stateDir = join(root, 'trusted-state')
    sources = join(root, 'sources')
    await mkdir(cwd)
    await mkdir(sources)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  // A tracking ref (a branch, or none at all) is what "keep my skills current"
  // means: every new session's preparation asks where the head is now, and only a
  // move costs a download. A pinned SHA keeps the retained-commit semantics.
  it('re-reads a tracking Git ref per install and reinstalls only when the head moved', async () => {
    const gitDir = await writeSkill(sources, 'git-skill', 'git')
    const cli = fakeCli(() => '.runtime')
    const first = 'a'.repeat(40)
    const moved = 'b'.repeat(40)
    const requestedRefs: Array<string | undefined> = []
    const acquireGit = async (entry: { ref?: string }) => {
      requestedRefs.push(entry.ref)
      return { sourceDir: gitDir, resolvedCommit: entry.ref ?? first }
    }
    const moving = { name: 'git', source: 'acme/skills', githubRepoId: '42', skills: ['git-skill'] }
    let head = first
    const install = () =>
      installSkills({ id: 'a1', runtime: 'claude', skills: [moving] }, cwd, {
        stateDir,
        acquireGit,
        resolveGitRef: async () => head,
        runCli: cli.run
      })

    const initial = await install()
    expect(initial.skipped).toBeNull()
    // Same head: nothing acquired, nothing reinstalled.
    const unchanged = await install()
    expect(unchanged.skipped).toBe('unchanged')
    // Moved head: the plan is invalidated and the NEW commit is what gets acquired.
    head = moved
    const advanced = await install()
    expect(advanced.skipped).toBeNull()
    expect(requestedRefs).toEqual([first, moved])
  }, 120_000)

  it('keeps the installed commit when a tracking ref cannot be resolved', async () => {
    const gitDir = await writeSkill(sources, 'git-skill', 'git')
    const cli = fakeCli(() => '.runtime')
    const first = 'a'.repeat(40)
    const requestedRefs: Array<string | undefined> = []
    const acquireGit = async (entry: { ref?: string }) => {
      requestedRefs.push(entry.ref)
      return { sourceDir: gitDir, resolvedCommit: entry.ref ?? first }
    }
    const moving = { name: 'git', source: 'acme/skills', githubRepoId: '42', skills: ['git-skill'] }
    await installSkills({ id: 'a1', runtime: 'claude', skills: [moving] }, cwd, {
      stateDir,
      acquireGit,
      resolveGitRef: async () => first,
      runCli: cli.run
    })
    // GitHub unreachable or the rate limit spent: unknown is not a reason to
    // rebuild, and certainly not a reason to lose the skills.
    const offline = await installSkills({ id: 'a1', runtime: 'claude', skills: [moving] }, cwd, {
      stateDir,
      acquireGit,
      resolveGitRef: async () => null,
      runCli: cli.run
    })
    expect(offline.skipped).toBe('unchanged')
    expect(requestedRefs).toEqual([first])
  }, 120_000)

  it('never asks about a ref pinned to a commit, and ignores an answer for one', async () => {
    const gitDir = await writeSkill(sources, 'git-skill', 'git')
    const cli = fakeCli(() => '.runtime')
    const pinned = 'c'.repeat(40)
    const requestedRefs: Array<string | undefined> = []
    const acquireGit = async (entry: { ref?: string }) => {
      requestedRefs.push(entry.ref)
      return { sourceDir: gitDir, resolvedCommit: pinned }
    }
    const entry = { name: 'git', source: 'acme/skills', githubRepoId: '42', ref: pinned, skills: ['git-skill'] }
    const install = (resolveGitRef: () => Promise<string | null>) =>
      installSkills({ id: 'a1', runtime: 'claude', skills: [entry] }, cwd, {
        stateDir,
        acquireGit,
        resolveGitRef,
        runCli: cli.run
      })
    await install(async () => null)
    // The tracker returns null for a pinned ref; a stray answer must not move it.
    const second = await install(async () => 'd'.repeat(40))
    expect(second.skipped).toBe('unchanged')
    expect(requestedRefs).toEqual([pinned])
  }, 120_000)
})
