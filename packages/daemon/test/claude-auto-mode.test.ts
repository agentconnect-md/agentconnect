import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  anchorRepositoryRules,
  claudeAutoModeRules,
  claudePermissionRules,
  claudeRepositoryRules,
  repositoryClaudeRules
} from '../src/acp/claude-auto-mode.js'
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

const TRUSTED = {
  permissions: { allow: ['Bash(scripts/example:*)'] },
  autoMode: { allow: ['Example rollout: syncing the example release is pre-authorized.'] }
}
const TRUSTED_RULES = {
  autoMode: { allow: ['$defaults', 'Example rollout: syncing the example release is pre-authorized.'] },
  permissions: { allow: ['Bash(scripts/example:*)'] }
}

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

describe('claudePermissionRules', () => {
  it('keeps the allow, ask and deny lists and nothing else of the block', () => {
    expect(
      claudePermissionRules(
        JSON.stringify({
          permissions: {
            allow: ['Bash(scripts/example:*)', ' '],
            ask: ['Bash(scripts/example push:*)'],
            deny: ['Bash(git push*main)'],
            defaultMode: 'bypassPermissions',
            additionalDirectories: ['/']
          },
          autoMode: { allow: ['Example'] }
        })
      )
    ).toEqual({
      allow: ['Bash(scripts/example:*)'],
      ask: ['Bash(scripts/example push:*)'],
      deny: ['Bash(git push*main)']
    })
  })

  it('grants nothing without rules of its own', () => {
    expect(claudePermissionRules('{}')).toBeUndefined()
    expect(claudePermissionRules(JSON.stringify({ permissions: {} }))).toBeUndefined()
    expect(claudePermissionRules(JSON.stringify({ permissions: { allow: [''], defaultMode: 'plan' } }))).toBeUndefined()
  })

  it.each(['[]', '{"permissions":[]}', '{"permissions":{"allow":"all"}}', '{"permissions":{"deny":[1]}}'])(
    'rejects %s',
    (settings) => {
      expect(() => claudePermissionRules(settings)).toThrow()
    }
  )
})

describe('claudeRepositoryRules', () => {
  it('passes both blocks, either alone, or nothing', () => {
    expect(claudeRepositoryRules(JSON.stringify(TRUSTED))).toEqual(TRUSTED_RULES)
    expect(claudeRepositoryRules(JSON.stringify({ permissions: TRUSTED.permissions }))).toEqual({
      permissions: TRUSTED_RULES.permissions
    })
    expect(claudeRepositoryRules(JSON.stringify({ autoMode: TRUSTED.autoMode }))).toEqual({
      autoMode: TRUSTED_RULES.autoMode
    })
    expect(claudeRepositoryRules('{"hooks":{}}')).toBeUndefined()
  })

  it('passes nothing from a file with one unusable block', () => {
    expect(() => claudeRepositoryRules(JSON.stringify({ ...TRUSTED, permissions: { allow: 'all' } }))).toThrow()
  })
})

describe('anchorRepositoryRules', () => {
  it('roots each project-relative file rule at the checkout, and leaves every other rule as it is', () => {
    const rules = {
      autoMode: TRUSTED_RULES.autoMode,
      permissions: {
        allow: ['Edit(/**)', 'Edit(/docs/*.md)', 'Read(/)', 'Bash(scripts/example:*)', 'Bash(/opt/tool:*)'],
        ask: ['Edit(./local/**)', 'Read(~/notes/**)', 'Write(/docs/**)'],
        deny: ['Edit(//etc/**)', 'Edit(/decisions/**)', 'mcp__example__write', 'WebFetch(domain:example.com)']
      }
    }
    expect(anchorRepositoryRules(rules, '/agents/w 1/')).toEqual({
      autoMode: TRUSTED_RULES.autoMode,
      permissions: {
        allow: [
          'Edit(//agents/w\\ 1/**)',
          'Edit(//agents/w\\ 1/docs/*.md)',
          'Read(//agents/w\\ 1/)',
          'Bash(scripts/example:*)',
          'Bash(/opt/tool:*)'
        ],
        // Claude matches no path in a Write rule, so it is passed as written.
        ask: ['Edit(./local/**)', 'Read(~/notes/**)', 'Write(/docs/**)'],
        deny: [
          'Edit(//etc/**)',
          'Edit(//agents/w\\ 1/decisions/**)',
          'mcp__example__write',
          'WebFetch(domain:example.com)'
        ]
      }
    })
  })

  it('returns rules without a permissions block unchanged', () => {
    const rules = { autoMode: TRUSTED_RULES.autoMode }
    expect(anchorRepositoryRules(rules, '/repo')).toBe(rules)
  })
})

describe('repositoryClaudeRules', () => {
  it.each([
    ['this disk', local],
    ['the sandbox exec channel', sandboxed]
  ])('reads the tracked branch through %s, never the working tree', async (_name, runner) => {
    const root = checkout(TRUSTED)
    git(root, ['checkout', '-b', 'task'])
    writeSettings(root, { permissions: { allow: ['Bash(*)'] }, autoMode: { allow: ['Everything is pre-authorized.'] } })
    git(root, ['commit', '-am', 'widen'])
    writeSettings(root, { permissions: { allow: ['Edit(//**)'] }, autoMode: { allow: ['Uncommitted.'] } })
    expect(await repositoryClaudeRules(runner(root), 'main')).toEqual(TRUSTED_RULES)
  })

  it('resolves the settings file beside the session cwd', async () => {
    const root = checkout(TRUSTED)
    mkdirSync(join(root, 'nested'))
    expect(await repositoryClaudeRules(local(join(root, 'nested')), 'main')).toBeUndefined()
  })

  it('grants nothing without a settings file, a tracked branch, or a checkout', async () => {
    expect(await repositoryClaudeRules(local(checkout()), 'main')).toBeUndefined()
    expect(await repositoryClaudeRules(local(checkout(TRUSTED)), 'release')).toBeUndefined()
    expect(await repositoryClaudeRules(local(checkout(TRUSTED)), 'main:x')).toBeUndefined()
    const plain = mkdtempSync(join(tmpdir(), 'claude-auto-mode-'))
    roots.push(plain)
    expect(await repositoryClaudeRules(local(plain), 'main')).toBeUndefined()
  })

  it('reports a settings file it cannot use', async () => {
    await expect(repositoryClaudeRules(local(checkout('{')), 'main')).rejects.toThrow()
    await expect(repositoryClaudeRules(local(checkout({ permissions: { allow: [1] } })), 'main')).rejects.toThrow()
    const oversized = { autoMode: { allow: ['x'.repeat(300 * 1024)] } }
    await expect(repositoryClaudeRules(local(checkout(oversized)), 'main')).rejects.toThrow('exceed')
  })
})
