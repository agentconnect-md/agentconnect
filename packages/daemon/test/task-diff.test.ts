import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

  it('does not adopt existing work or a task without a saved baseline', async () => {
    const root = repository()
    const sources = [{ git: hostGitRunner(root), name: 'project' }]
    await expect(openTaskDiff(sources, 'old-task', false)).rejects.toThrow('no saved starting point')
    writeFileSync(join(root, 'app.js'), 'unrelated change\n')
    await expect(openTaskDiff(sources, 'new-task', true)).rejects.toThrow('already has changes')
  })

  it('refuses an oversized diff instead of publishing a partial patch', async () => {
    const root = repository()
    const snapshot = await openTaskDiff([{ git: hostGitRunner(root), name: 'project' }], 'task-large', true)
    writeFileSync(join(root, 'app.js'), 'x'.repeat(200_000))
    await expect(snapshot.read()).rejects.toThrow('too large')
  })
})
