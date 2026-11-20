import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitFor } from '../src/workspace/git-injection.js'
import { LocalGitRunner } from '../src/workspace/git-runner.js'
import { openTaskDiff } from '../src/workspace/task-diff.js'
import { ShimGitRunner } from '../src/shim/git-exec.js'
import { createExecHandler } from '../src/shim/exec-handler.js'

const roots: string[] = []
const hostGitRunner = (root: string) => new LocalGitRunner(gitFor(root), root, (env) => gitFor(root, undefined, env))
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_COMMITTER_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_EMAIL: 'test@example.test'
    }
  })
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'task-diff-'))
  roots.push(root)
  git(root, ['init', '--initial-branch=main'])
  writeFileSync(join(root, 'app.js'), 'export const count = 1\n')
  writeFileSync(join(root, '.gitignore'), '.env\n')
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'initial'])
  return root
}

describe('task diff against a fixed baseline', () => {
  it('includes new and staged files, survives commits and reloads, and agrees on the sandbox transport', async () => {
    const root = repository()
    const local = hostGitRunner(root)
    const handle = createExecHandler({ workspaceRoot: root, log: { info() {}, warn() {} } })
    const remote = new ShimGitRunner({ request: (capability, payload) => handle(capability, payload) }, root)
    const snapshot = await openTaskDiff([{ git: local, name: 'project' }], 'task-one', true)
    writeFileSync(join(root, 'app.js'), 'export const count = 2\n')
    git(root, ['add', 'app.js'])
    writeFileSync(join(root, 'new file.txt'), 'new content without a newline')
    writeFileSync(join(root, '.env'), 'DO_NOT_PUBLISH=secret\n')
    const before = git(root, ['diff', '--cached'])
    const patch = await snapshot.read()
    expect(patch).toContain('-export const count = 1')
    expect(patch).toContain('+export const count = 2')
    expect(patch).toContain('+new content without a newline')
    expect(patch).not.toContain('DO_NOT_PUBLISH')
    expect(git(root, ['diff', '--cached'])).toBe(before)
    const resumed = await openTaskDiff([{ git: remote, name: 'project' }], 'task-one', false)
    expect(await resumed.read()).toBe(patch)
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'task change'])
    const committed = await resumed.read()
    expect(committed).toContain('+export const count = 2')
    expect(committed).toContain('+new content without a newline')
    expect(git(root, ['status', '--porcelain'])).toBe('')
    git(root, ['revert', '--no-edit', 'HEAD'])
    expect(await resumed.read()).toBe('')
  })

  it('compares with where the task left its base branch, so the base moving on and a rebase add nothing', async () => {
    const root = repository()
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    git(root, ['checkout', '-q', '-b', 'task'])
    // A task with no saved start is adopted: its base branch is the comparison.
    const diff = await openTaskDiff([{ git: hostGitRunner(root), name: 'project', branch: 'main' }], 'old-task', false)
    expect(diff.repositories).toEqual([{ title: 'project', base: 'origin/main' }])
    writeFileSync(join(root, 'app.js'), 'export const count = 2\n')
    git(root, ['commit', '-qam', 'task change'])
    git(root, ['checkout', '-q', 'main'])
    writeFileSync(join(root, 'upstream.js'), 'export const landed = true\n')
    git(root, ['add', 'upstream.js'])
    git(root, ['commit', '-qm', 'landed elsewhere'])
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    git(root, ['checkout', '-q', 'task'])
    git(root, ['rebase', '-q', 'origin/main'])
    writeFileSync(join(root, 'notes.txt'), 'uncommitted\n')
    const patch = await diff.read()
    expect(patch).toContain('+export const count = 2')
    expect(patch).toContain('+uncommitted')
    expect(patch).not.toContain('landed')
    expect(git(root, ['for-each-ref', 'refs/agentconnect'])).toBe('')
  })

  it('does not adopt existing work or a task without a saved baseline', async () => {
    const root = repository()
    const sources = [{ git: hostGitRunner(root), name: 'project' }]
    await expect(openTaskDiff(sources, 'old-task', false)).rejects.toThrow('no saved starting point')
    writeFileSync(join(root, 'app.js'), 'unrelated change\n')
    await expect(openTaskDiff(sources, 'new-task', true)).rejects.toThrow('already has changes')
  })

  it("shows a repository's own untracked uploads/ files, since saved attachments no longer land in the checkout", async () => {
    const root = repository()
    const snapshot = await openTaskDiff([{ git: hostGitRunner(root), name: 'project' }], 'task-uploads', true)
    mkdirSync(join(root, 'uploads'))
    writeFileSync(join(root, 'uploads', 'avatar.svg'), 'new upload handler fixture\n')
    expect(await snapshot.read()).toContain('+new upload handler fixture')
  })

  it('adds a repository cloned during the task, against its remote default branch, under its own name', async () => {
    const root = repository()
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    const remote = mkdtempSync(join(tmpdir(), 'task-diff-remote-'))
    roots.push(remote)
    git(remote, ['init', '-q', '--initial-branch=develop'])
    writeFileSync(join(remote, 'links.js'), 'export const store = "branch"\n')
    git(remote, ['add', '.'])
    git(remote, ['commit', '-qm', 'initial'])
    const clone = join(mkdtempSync(join(tmpdir(), 'task-diff-clones-')), 'acme', 'web')
    roots.push(join(clone, '..', '..'))
    const cloned: Array<{ git: ReturnType<typeof hostGitRunner>; name: string; baseFromOriginHead: true }> = []
    const diff = await openTaskDiff(
      [{ git: hostGitRunner(root), name: 'workspace', branch: 'main' }],
      'task-clone',
      false,
      async () => cloned
    )
    expect(diff.discovers).toBe(true)
    expect(await diff.read()).toBe('')
    execFileSync('git', ['clone', '-q', remote, clone])
    git(clone, ['checkout', '-q', '-b', 'task'])
    writeFileSync(join(clone, 'links.js'), 'export const store = "adjust"\n')
    git(clone, ['commit', '-qam', 'swap the store link'])
    writeFileSync(join(clone, 'notes.txt'), 'uncommitted\n')
    cloned.push({ git: hostGitRunner(clone), name: 'acme/web', baseFromOriginHead: true })
    const patch = await diff.read()
    expect(patch).toContain('a/acme/web/links.js')
    expect(patch).toContain('+export const store = "adjust"')
    expect(patch).toContain('b/acme/web/notes.txt')
    expect(diff.repositories).toEqual([
      { title: 'workspace', base: 'origin/main' },
      { title: 'acme/web', base: 'origin/develop' }
    ])
    // The primary's own files take its name once it shares the diff.
    writeFileSync(join(root, 'app.js'), 'export const count = 2\n')
    expect(await diff.read()).toContain('a/workspace/app.js')
  })

  it('leaves out a discovered repository until it has a remote default branch, without failing the diff', async () => {
    const root = repository()
    const loose = repository()
    const diff = await openTaskDiff([{ git: hostGitRunner(root), name: 'workspace' }], 'task-loose', true, async () => [
      { git: hostGitRunner(loose), name: 'acme/loose', baseFromOriginHead: true }
    ])
    writeFileSync(join(loose, 'app.js'), 'clone work\n')
    writeFileSync(join(root, 'app.js'), 'export const count = 2\n')
    const patch = await diff.read()
    expect(patch).toContain('+export const count = 2')
    expect(patch).not.toContain('clone work')
    expect(diff.repositories).toEqual([{ title: 'workspace' }])
    // A clone still being written gains its remote refs a moment later, and a later read takes it.
    git(loose, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    git(loose, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
    expect(await diff.read()).toContain('b/acme/loose/app.js')
    expect(diff.repositories).toEqual([{ title: 'workspace' }, { title: 'acme/loose', base: 'origin/main' }])
  })

  it('does not report discovery on a diff opened without it', async () => {
    const root = repository()
    expect((await openTaskDiff([{ git: hostGitRunner(root), name: 'project' }], 'task-plain', true)).discovers).toBe(
      false
    )
  })

  it('refuses an oversized diff instead of publishing a partial patch', async () => {
    const root = repository()
    const snapshot = await openTaskDiff([{ git: hostGitRunner(root), name: 'project' }], 'task-large', true)
    writeFileSync(join(root, 'app.js'), 'x'.repeat(200_000))
    await expect(snapshot.read()).rejects.toThrow('too large')
  })
})
