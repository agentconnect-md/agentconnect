import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeAutoModeRules, repositoryAutoModeRules } from '../src/acp/claude-auto-mode.js'
import { createExecHandler } from '../src/shim/exec-handler.js'
import { ShimGitRunner } from '../src/shim/git-exec.js'
import { gitFor } from '../src/workspace/git-injection.js'
import { LocalGitRunner, type GitRunner } from '../src/workspace/git-runner.js'

const roots: string[] = []
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

function writeSettings(root: string, settings: unknown): void {
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(
    join(root, '.claude', 'settings.json'),
    typeof settings === 'string' ? settings : JSON.stringify(settings)
  )
}

// A remote whose main carries `settings`, and a checkout cloned from it.
function checkout(settings?: unknown): string {
  const base = mkdtempSync(join(tmpdir(), 'claude-auto-mode-'))
  roots.push(base)
  const remote = join(base, 'remote')
  mkdirSync(remote)
  git(remote, ['init', '--initial-branch=main'])
  writeFileSync(join(remote, 'README.md'), 'example\n')
  if (settings !== undefined) writeSettings(remote, settings)
  git(remote, ['add', '.'])
  git(remote, ['commit', '-m', 'initial'])
  git(base, ['clone', '--branch', 'main', '--single-branch', remote, 'checkout'])
  return join(base, 'checkout')
}

const local = (root: string): GitRunner => new LocalGitRunner(gitFor(root), root, (env) => gitFor(root, undefined, env))
function sandboxed(root: string): GitRunner {
  const handle = createExecHandler({ workspaceRoot: root, log: { info() {}, warn() {} } })
  return new ShimGitRunner({ request: (capability, payload) => handle(capability, payload) }, root)
}

const TRUSTED = { autoMode: { allow: ['Example rollout: syncing the example release is pre-authorized.'] } }
const TRUSTED_RULES = { allow: ['$defaults', 'Example rollout: syncing the example release is pre-authorized.'] }

describe('claudeAutoModeRules', () => {
  it('keeps the four rule lists and makes each extend the built-in rules', () => {
    expect(
      claudeAutoModeRules(
        JSON.stringify({
          permissions: { allow: ['Bash(example:*)'] },
          autoMode: {
            environment: ['Example environment'],
            allow: ['First', '$defaults', 'Second'],
            soft_deny: ['Example block'],
            hard_deny: ['$defaults'],
            classifyAllShell: true
          }
        })
      )
    ).toEqual({
      environment: ['$defaults', 'Example environment'],
      allow: ['$defaults', 'First', 'Second'],
      soft_deny: ['$defaults', 'Example block']
    })
  })

  it('grants nothing without rules of its own', () => {
    expect(claudeAutoModeRules('{}')).toBeUndefined()
    expect(claudeAutoModeRules(JSON.stringify({ autoMode: {} }))).toBeUndefined()
    expect(claudeAutoModeRules(JSON.stringify({ autoMode: { allow: ['$defaults', ' '] } }))).toBeUndefined()
  })

  it.each(['[]', '{"autoMode":[]}', '{"autoMode":{"allow":"all"}}', '{"autoMode":{"allow":[1]}}', '{'])(
    'rejects %s',
    (settings) => {
      expect(() => claudeAutoModeRules(settings)).toThrow()
    }
  )
})

describe('repositoryAutoModeRules', () => {
  it.each([
    ['this disk', local],
    ['the sandbox exec channel', sandboxed]
  ])('reads the tracked branch through %s, never the working tree', async (_name, runner) => {
    const root = checkout(TRUSTED)
    git(root, ['checkout', '-b', 'task'])
    writeSettings(root, { autoMode: { allow: ['Everything is pre-authorized.'] } })
    git(root, ['commit', '-am', 'widen'])
    writeSettings(root, { autoMode: { allow: ['Uncommitted and pre-authorized.'] } })
    expect(await repositoryAutoModeRules(runner(root), 'main')).toEqual(TRUSTED_RULES)
  })

  it('resolves the settings file beside the session cwd', async () => {
    const root = checkout(TRUSTED)
    mkdirSync(join(root, 'nested'))
    expect(await repositoryAutoModeRules(local(join(root, 'nested')), 'main')).toBeUndefined()
  })

  it('grants nothing without a settings file, a tracked branch, or a checkout', async () => {
    expect(await repositoryAutoModeRules(local(checkout()), 'main')).toBeUndefined()
    expect(await repositoryAutoModeRules(local(checkout(TRUSTED)), 'release')).toBeUndefined()
    expect(await repositoryAutoModeRules(local(checkout(TRUSTED)), 'main:x')).toBeUndefined()
    const plain = mkdtempSync(join(tmpdir(), 'claude-auto-mode-'))
    roots.push(plain)
    expect(await repositoryAutoModeRules(local(plain), 'main')).toBeUndefined()
  })

  it('reports a settings file it cannot use', async () => {
    await expect(repositoryAutoModeRules(local(checkout('{')), 'main')).rejects.toThrow()
    const oversized = { autoMode: { allow: ['x'.repeat(300 * 1024)] } }
    await expect(repositoryAutoModeRules(local(checkout(oversized)), 'main')).rejects.toThrow('exceed')
  })
})
