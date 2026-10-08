import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  ExecRefusedError,
  assertNoRefusedArguments,
  isValidBranchRef,
  validateGitArgs
} from '../src/workspace/git-command-policy.js'

// Pure, I/O-free table of the shim's Git argv policy; real-Git execution lives in shim-exec-handler.test.ts.

const STAGING = '/run/agentconnect/bundle-staging'
const refuses = (args: string[]): void => {
  expect(() => validateGitArgs(args)).toThrow(ExecRefusedError)
}
const admits = (args: string[]): void => {
  expect(() => validateGitArgs(args)).not.toThrow()
}

describe('refused long options include every abbreviation Git accepts', () => {
  it.each([
    [['clone', '--upload=x', 'u', 'd']],
    [['clone', '--upl=x', 'u', 'd']],
    [['clone', '--upl', 'x', 'u', 'd']],
    [['clone', '--upload-p=x', 'u', 'd']],
    [['clone', '--upload-pack', 'x', 'u', 'd']],
    [['fetch', '--upload=x', 'origin']],
    [['pull', '--upload=x', 'origin']],
    [['ls-remote', '--upload=x', 'origin']],
    [['ls-remote', '--exec=x', 'origin']],
    [['ls-remote', '--exe=x', 'origin']],
    [['push', '--receive=x', 'origin']],
    [['push', '--receive-p=x', 'origin']],
    [['push', '--receive', 'x', 'origin']],
    [['push', '--exec=x', 'origin']],
    [['status', '--conf=k']],
    [['status', '--config-e=k']],
    [['status', '--confi=k']],
    [['clone', '--conf=protocol.ext.allow=always', 'ext::x', 'd']],
    [['branch', '--exec-p=/tmp']],
    [['branch', '--exec-pat=/tmp']],
    [['branch', '--exec-path=/tmp']],
    [['status', '--config-env=core.pager=EVIL']],
    [['status', '-ccore.pager=EVIL']]
  ])('refuses %j', (args) => refuses(args))
})

describe("clone's grouped short options", () => {
  it.each([
    [['clone', '-qu/evil', 'u', 'd']],
    [['clone', '-lqu/evil', 'u', 'd']],
    [['clone', '-qcprotocol.ext.allow=always', 'ext::x', 'd']],
    [['clone', '-nc', 'k=v', 'u', 'd']]
  ])('refuses %j', (args) => refuses(args))

  it('never reads a value after -b as options', () => admits(['clone', '-bfeature-cu', 'u', 'd']))
})

describe('admitted near-misses the daemon sends', () => {
  it.each([
    [['status', '--porcelain=v2', '--branch', '-u', '-z']],
    [['rev-list', '--count', 'HEAD']],
    [['fetch', '-u', 'origin']],
    [['clone', '--filter=blob:none', '--no-checkout', '--single-branch', '--branch', 'main', '--no-tags', 'u', 'repo']],
    [['clone', '-b', 'main', '-o', 'origin', '-q', '-n', 'u', 'repo']],
    [['push', '--no-verify', 'origin', 'refs/heads/a:refs/heads/a']],
    [['commit', '--no-gpg-sign', '--cleanup=verbatim', '-m', 'x']],
    [['checkout', '--no-track', '-B', 'b', 'refs/remotes/origin/b']],
    [['config', '--replace-all', 'k', 'v']],
    [['config', '--add', 'k', 'v']],
    [['config', '--no-includes', '--get', 'k']],
    [['diff', '--no-ext-diff', '--no-textconv', '--no-color']],
    [['rev-parse', '--abbrev-ref', '--symbolic-full-name', '--show-prefix', '--git-common-dir']],
    [['clone', '--no-bundle-uri', 'u', 'repo']]
  ])('admits %j', (args) => admits(args))
})

describe('clone --bundle-uri', () => {
  const longQuery = `X-Amz-Signature=${'a'.repeat(1500)}`
  it('admits one joined https URL with a long presigned query', () =>
    admits(['clone', `--bundle-uri=https://bucket.example.com/src/a.bundle?${longQuery}`, 'u', 'repo']))

  it.each([
    [['clone', '--bundle-uri', 'https://h/a.bundle', 'u', 'repo']],
    [['clone', '--bundle=https://h/a.bundle', 'u', 'repo']],
    [['clone', '--bun=https://h/a.bundle', 'u', 'repo']],
    [['clone', '--bundle-u=https://h/a.bundle', 'u', 'repo']],
    [['clone', '--bundle-ur=https://h/a.bundle', 'u', 'repo']],
    [['clone', '--bundle-uri=http://h/a.bundle', 'u', 'repo']],
    [['clone', '--bundle-uri=file:///etc/passwd', 'u', 'repo']],
    [['clone', '--bundle-uri=s3://b/a.bundle', 'u', 'repo']],
    [['clone', '--bundle-uri=HTTPS://h/a.bundle', 'u', 'repo']],
    [['clone', '--bundle-uri=https://user:pw@h/a.bundle', 'u', 'repo']],
    [['clone', '--bundle-uri=https://@h/a.bundle', 'u', 'repo']],
    [['clone', '--bundle-uri=https:///p', 'u', 'repo']],
    [['clone', '--bundle-uri=https://h/a\n.bundle', 'u', 'repo']],
    [['clone', '--bundle-uri=https://h/a\r.bundle', 'u', 'repo']],
    [['clone', '--bundle-uri=https://h/a\t.bundle', 'u', 'repo']],
    [['clone', '--bundle-uri=https://h/a .bundle', 'u', 'repo']],
    [['clone', '--bundle-uri=https://h/a\x7f.bundle', 'u', 'repo']],
    [['clone', '--bundle-uri=https://h\\a.bundle', 'u', 'repo']],
    [['clone', '--bundle-uri=', 'u', 'repo']],
    [['clone', `--bundle-uri=https://h/${'a'.repeat(8200)}`, 'u', 'repo']],
    [['clone', '--bundle-uri=https://h/a.bundle', '--bundle-uri=https://h/b.bundle', 'u', 'repo']],
    [['fetch', '--bundle-uri=https://h/a.bundle', 'origin']],
    [['pull', '--bundle-uri=https://h/a.bundle', 'origin']],
    [['ls-remote', '--bundle-uri=https://h/a.bundle', 'origin']],
    [['push', '--bundle-uri=https://h/a.bundle', 'origin']]
  ])('refuses %j', (args) => refuses(args))
})

const BAD_REFS = [
  'HEAD',
  'main',
  'refs/remotes/origin/main',
  'refs/tags/v1',
  'refs/heads/',
  'refs/heads/a..b',
  'refs/heads/a@{1}',
  'refs/heads/x.lock',
  'refs/heads/.x',
  'refs/heads/x/',
  'refs/heads/x.',
  'refs/heads/a//b',
  'refs/heads/a\x01',
  'refs/heads/a b',
  'refs/heads/a~1',
  'refs/heads/a^',
  'refs/heads/a:b',
  'refs/heads/a?',
  'refs/heads/a*',
  'refs/heads/a[',
  'refs/heads/a\\b',
  '^refs/heads/main',
  'refs/heads/a..refs/heads/b'
]
const GOOD_REFS = ['refs/heads/main', 'refs/heads/feat/a-b', 'refs/heads/-x', 'refs/heads/a.b']

// Write-back bundles are cut by the shim's own `bundle` operation (source-cache.md §6.1), so exec admits no form of `bundle`.
describe('bundle', () => {
  const file = `${STAGING}/x.bundle`
  it.each([
    [['bundle', 'create', file, 'refs/heads/main']],
    [['bundle', 'create', '-q', file, 'refs/heads/main']],
    [['bundle', 'create', file, '--filter=blob:none', 'refs/heads/main']],
    [['bundle', 'create', '-q', file, '--filter=blob:none', 'refs/heads/feat/a-b']],
    [['bundle', 'verify', file]],
    [['bundle', 'unbundle', file]],
    [['bundle', 'list-heads', file]],
    [['bundle']]
  ])('refuses %j', (args) => refuses(args))
})

describe('isValidBranchRef', () => {
  it.each(BAD_REFS)('refuses %j', (ref) => expect(isValidBranchRef(ref)).toBe(false))
  it.each(GOOD_REFS)('admits %j', (ref) => expect(isValidBranchRef(ref)).toBe(true))

  it('agrees with git check-ref-format on every refs/heads/ row', () => {
    for (const ref of [...BAD_REFS, ...GOOD_REFS]) {
      let gitAccepts = true
      try {
        execFileSync('git', ['check-ref-format', ref], { stdio: 'ignore' })
      } catch {
        gitAccepts = false
      }
      // Outside refs/heads/ the namespace alone refuses, so only branch rows must agree exactly.
      if (ref.startsWith('refs/heads/')) expect(gitAccepts, ref).toBe(isValidBranchRef(ref))
    }
  })
})

describe('fsck', () => {
  it.each([[['fsck', '--connectivity-only']], [['fsck', '--connectivity-only', '--no-dangling']]])(
    'admits exactly %j',
    (args) => admits(args)
  )
  it.each([
    [['fsck', '--no-dangling']],
    [['fsck', '--no-dangling', '--connectivity-only']],
    [['fsck', '--connectivity-only --no-dangling']],
    [['fsck', '--connectivity-only', '--no-dangling', '--lost-found']],
    [['fsck', '--connectivity-only', '--no-dangl']],
    [['fsck']],
    [['fsck', '--full']],
    [['fsck', '--connectivity-only', '--lost-found']],
    [['fsck', '--connectivity-only=true']],
    [['fsck', '--connectivity-only', 'extra']],
    [['fsck', '--strict']]
  ])('refuses %j', (args) => refuses(args))
})

describe('refs/bundles cleanup shape', () => {
  it.each([
    [['show-ref']],
    [['update-ref', '-d', 'refs/bundles/main']],
    [['update-ref', '-d', 'refs/bundles/heads/main']]
  ])('admits %j', (args) => admits(args))
})

describe('assertNoRefusedArguments (shim-internal argv)', () => {
  it.each([
    [['clone', '--upl=x', 'u', 'd']],
    [['clone', '-qu', 'x', 'u', 'd']],
    [['clone', '--bundle=https://h/b', 'u', 'd']],
    [['clone', '--bundle-uri=file:///etc/passwd', 'u', 'd']],
    [['fetch', '--upload-pack=x', 'origin']],
    [['ls-remote', '--exec=x', 'u']],
    [['read-tree', '-ccore.fsmonitor=x', 'HEAD']],
    [['read-tree', '--config-env=core.pager=EVIL', 'HEAD']],
    [['config', '--edit']],
    [['fsck']],
    [['fsck', '--full']],
    [['--upload-pack=x']],
    [[]]
  ])('refuses %j', (args) => {
    expect(() => assertNoRefusedArguments(args)).toThrow(ExecRefusedError)
  })

  it.each([
    [
      [
        'clone',
        '-q',
        '--filter=blob:none',
        '--no-checkout',
        '--bundle-uri=https://cache.example/b',
        '--',
        'https://h/r',
        '/s/repo'
      ]
    ],
    [['read-tree', '--reset', '-u', 'abc:skills']],
    [['checkout', '--detach', 'abc']],
    [['checkout', '--', 'x']],
    [['cat-file', '-e', 'abc^{commit}']],
    [['fsck', '--connectivity-only', '--no-dangling']]
  ])('admits %j, which the exec inventory need not', (args) => {
    expect(() => assertNoRefusedArguments(args)).not.toThrow()
  })

  it('leaves the exec policy as strict as before for checkout and the inventory', () => {
    refuses(['checkout', '--detach', 'abc'])
    refuses(['checkout', '--', 'x'])
    refuses(['read-tree', '--reset', '-u', 'abc'])
    refuses(['cat-file', '-e', 'abc'])
  })
})
