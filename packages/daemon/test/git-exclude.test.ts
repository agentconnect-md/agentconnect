import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workspaceGitLocalEnv } from '../src/workspace/git-injection.js'
import { bundlePathsFromCheckoutRoot, excludeManagedSkillBundles } from '../src/workspace/git-exclude.js'

const env = {
  ...workspaceGitLocalEnv(),
  GIT_AUTHOR_NAME: 'Ada Lovelace',
  GIT_AUTHOR_EMAIL: 'ada@example.invalid',
  GIT_COMMITTER_NAME: 'Ada Lovelace',
  GIT_COMMITTER_EMAIL: 'ada@example.invalid'
}
// No background maintenance: its detached child races this file's fixture teardown.
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], {
    env,
    encoding: 'utf8'
  })

const BUNDLE = '.claude/skills/corepack-checks'

/** A checkout plus one session worktree, the shape the daemon prepares. `trackedSkill` is the
 *  difference that decides what `status` reports: with one, Git descends into `.claude/skills` and
 *  names the bundle; without, it collapses the whole tree to `?? .claude/`. Both must go clean. */
function fixture(name: string, trackedSkill: boolean) {
  const base = mkdtempSync(join(tmpdir(), `ac-git-exclude-${name}-`))
  const repo = join(base, 'repo')
  const worktree = join(base, 'worktrees', 'session-1')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  if (trackedSkill) {
    mkdirSync(join(repo, '.claude', 'skills', 'repo-skill'), { recursive: true })
    writeFileSync(join(repo, '.claude', 'skills', 'repo-skill', 'SKILL.md'), '# in the repo\n')
  }
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'first commit')
  git(repo, 'worktree', 'add', '--detach', worktree)
  const commonDir = git(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim()
  return { base, repo, worktree, commonDir, excludeFile: join(commonDir, 'info', 'exclude') }
}

/** What the daemon's skill installer leaves behind in a session worktree. */
function installBundle(worktree: string, relativeRoot: string): void {
  const dir = join(worktree, ...relativeRoot.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '# installed by the daemon\n')
}

let repoWithSkills: ReturnType<typeof fixture>

beforeAll(() => {
  repoWithSkills = fixture('tracked', true)
  installBundle(repoWithSkills.worktree, BUNDLE)
})

afterAll(() => rmSync(repoWithSkills.base, { recursive: true, force: true }))

const readExclude = () => readFileSync(repoWithSkills.excludeFile, 'utf8')

describe('excludeManagedSkillBundles', () => {
  it('clears the dirty status a daemon-installed bundle leaves in a session worktree', async () => {
    const { worktree, repo, commonDir } = repoWithSkills
    // The regression: the GC reads this as the user's untracked work and keeps the worktree forever.
    expect(git(worktree, 'status', '--porcelain').trim()).toBe(`?? ${BUNDLE}/`)

    await excludeManagedSkillBundles(commonDir, [BUNDLE])

    expect(git(worktree, 'status', '--porcelain').trim()).toBe('')
    // The main checkout shares the common dir, so one write covers every worktree of the clone.
    expect(git(repo, 'status', '--porcelain').trim()).toBe('')
  })

  it('clears it in a repository that tracks no skills of its own', async () => {
    const plain = fixture('plain', false)
    try {
      installBundle(plain.worktree, BUNDLE)
      // Git collapses a wholly untracked tree, so the reported path is not the bundle's.
      expect(git(plain.worktree, 'status', '--porcelain').trim()).toBe('?? .claude/')

      await excludeManagedSkillBundles(plain.commonDir, [BUNDLE])

      expect(git(plain.worktree, 'status', '--porcelain').trim()).toBe('')
    } finally {
      rmSync(plain.base, { recursive: true, force: true })
    }
  })

  it('lets the retention GC reclaim the worktree without forcing', async () => {
    const gc = fixture('gc', true)
    try {
      installBundle(gc.worktree, BUNDLE)
      // What the GC does today: refuses, because the daemon's own bundle reads as user work.
      expect(() => git(gc.repo, 'worktree', 'remove', gc.worktree)).toThrow()

      await excludeManagedSkillBundles(gc.commonDir, [BUNDLE])

      // No --force, exactly as removeRootSessionWorktree runs it.
      git(gc.repo, 'worktree', 'remove', gc.worktree)
      expect(git(gc.repo, 'worktree', 'list')).not.toContain(gc.worktree)
    } finally {
      rmSync(gc.base, { recursive: true, force: true })
    }
  })

  it('keeps entries a human wrote and replaces only its own block', async () => {
    writeFileSync(repoWithSkills.excludeFile, `# my own notes\n/scratch/\n${readExclude()}`)

    await excludeManagedSkillBundles(repoWithSkills.commonDir, ['.claude/skills/renamed'])

    const content = readExclude()
    expect(content).toContain('# my own notes')
    expect(content).toContain('/scratch/')
    expect(content).toContain('/.claude/skills/renamed/')
    expect(content).not.toContain('corepack-checks')
    expect(content.match(/# BEGIN agentconnect-managed skills/g)).toHaveLength(1)
    // A bundle the agent stopped installing stops being excluded, so its files show up again.
    expect(git(repoWithSkills.worktree, 'status', '--porcelain').trim()).toBe(`?? ${BUNDLE}/`)
  })

  it('is idempotent for an unchanged bundle set', async () => {
    await excludeManagedSkillBundles(repoWithSkills.commonDir, [BUNDLE])
    const first = readExclude()
    await excludeManagedSkillBundles(repoWithSkills.commonDir, [BUNDLE])
    expect(readExclude()).toBe(first)
  })

  it('drops the block entirely when the agent installs no bundles', async () => {
    await excludeManagedSkillBundles(repoWithSkills.commonDir, [])

    const content = readExclude()
    expect(content).toContain('# my own notes')
    expect(content).not.toContain('agentconnect-managed')
    expect(content).not.toContain('/.claude/skills/')
  })

  it('anchors an agentDir agent’s bundles at the checkout root, not at its cwd', () => {
    // The installer reports roots relative to the ACP cwd; `agentDir` puts that below the checkout.
    expect(bundlePathsFromCheckoutRoot('/repo', '/repo/services/api', [BUNDLE])).toEqual([`services/api/${BUNDLE}`])
    expect(bundlePathsFromCheckoutRoot('/repo', '/repo', [BUNDLE])).toEqual([BUNDLE])
    // Anchoring a root that is not in the checkout would exclude an unrelated path.
    expect(bundlePathsFromCheckoutRoot('/repo', '/elsewhere', [BUNDLE])).toEqual([])
  })

  // Win32 forbids `*` in a filename outright, so the directory this needs cannot exist there — and
  // a bundle that cannot exist needs no escaping. The escaping itself is platform-independent.
  it.skipIf(process.platform === 'win32')(
    'escapes a name that would otherwise act as a gitignore pattern',
    async () => {
      const odd = '.claude/skills/a[b]*c'
      installBundle(repoWithSkills.worktree, odd)

      await excludeManagedSkillBundles(repoWithSkills.commonDir, [BUNDLE, odd])

      expect(readExclude()).toContain('/.claude/skills/a\\[b\\]\\*c/')
      expect(git(repoWithSkills.worktree, 'status', '--porcelain').trim()).toBe('')
    }
  )
})
