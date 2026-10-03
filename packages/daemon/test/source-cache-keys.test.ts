import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  anonRepoId,
  bundleKey,
  canonicalSourceUrl,
  credRepoId,
  isSourceCacheObjectKey,
  newBundleId,
  parseSourceCacheObjectKey,
  pointerKey,
  refHash
} from '../src/source-cache/keys.js'

const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const ANON = sha('https://github.com/acme/infra')
const UUID = '3f1c2a4e-9b7d-4e21-8c3a-0d5e6f7a8b9c'

describe('Source Cache canonical source URL (§4)', () => {
  it('maps every spelling of one repository to one identity', () => {
    const spellings = [
      'https://github.com/acme/infra',
      'https://GitHub.com/acme/infra.git/',
      'https://user:tok@github.com/acme/infra?x=1#frag',
      'https://github.com:443/acme/infra',
      'github.com/acme/infra',
      'acme/infra',
      'git@github.com:acme/infra.git',
      'git@GitHub.com:acme/infra',
      'ssh://git@github.com/acme/infra.git',
      'ssh://git@github.com:22/acme/infra',
      'https://github.com./acme/infra'
    ]
    for (const spelling of spellings)
      expect(canonicalSourceUrl(spelling), spelling).toBe('https://github.com/acme/infra')
    expect(new Set(spellings.map(anonRepoId))).toEqual(new Set([ANON]))
  })

  it('keeps distinct what may be a different repository', () => {
    expect(canonicalSourceUrl('https://github.com/Acme/Infra')).toBe('https://github.com/Acme/Infra')
    expect(anonRepoId('https://github.com/Acme/Infra')).not.toBe(ANON)
    expect(canonicalSourceUrl('ssh://git@git.example.test:2222/a/b.git')).toBe('ssh://git.example.test:2222/a/b')
    expect(canonicalSourceUrl('https://git.example.test:8443/a/b')).toBe('https://git.example.test:8443/a/b')
    expect(canonicalSourceUrl('https://gitlab.com/group/sub/project.git')).toBe('https://gitlab.com/group/sub/project')
  })

  it('refuses local, non-network and malformed sources', () => {
    for (const bad of [
      'ext::sh -c touch% /tmp/x',
      'file:///srv/repo.git',
      '/srv/repo.git',
      './repo',
      'git://github.com/acme/infra',
      'https://github.com/',
      'https://github.com/.git',
      ''
    ]) {
      expect(() => canonicalSourceUrl(bad), bad).toThrow()
    }
  })

  it('refuses literal and percent-encoded dot segments before URL parsing can collapse them', () => {
    for (const bad of [
      'https://github.com/acme/%2e%2e/infra',
      'https://github.com/acme/%2E%2E/infra',
      'https://github.com/acme/.%2e/infra',
      'https://github.com/acme/%2E./infra',
      'https://github.com/acme/%2e/infra',
      'https://github.com/acme/../infra',
      'https://github.com/acme/./infra',
      'https://github.com/acme/infra/..',
      'https://github.com/acme\\..\\infra',
      'https://github.com/acme/.\t./infra',
      'ssh://git@github.com/acme/%2e%2e/infra',
      'git@github.com:../infra',
      'git@github.com:acme/%2e%2e/infra.git',
      'github.com/acme/../infra',
      'acme/%2e%2e'
    ]) {
      expect(() => canonicalSourceUrl(bad), bad).toThrow('dot path segments')
    }
    expect(canonicalSourceUrl('https://github.com/acme/..infra')).toBe('https://github.com/acme/..infra')
    expect(canonicalSourceUrl('https://github.com/acme/infra?p=/../x')).toBe('https://github.com/acme/infra')
  })
})

describe('Source Cache repository ids and refs', () => {
  it('builds a provider-qualified cred id', () => {
    expect(credRepoId('github', '123')).toBe('github:123')
    expect(credRepoId('gitlab', '0')).toBe('gitlab:0')
    expect(() => credRepoId('bitbucket', '1')).toThrow()
    expect(() => credRepoId('github', '012')).toThrow()
    expect(() => credRepoId('github', 'acme/infra')).toThrow()
  })

  it('hashes a full branch ref name and refuses anything else', () => {
    expect(refHash('refs/heads/main')).toBe(sha('refs/heads/main'))
    expect(refHash('refs/heads/release/v1.2')).toBe(sha('refs/heads/release/v1.2'))
    for (const bad of [
      'main',
      'HEAD',
      'refs/tags/v1',
      'refs/remotes/origin/main',
      'refs/heads/',
      'refs/heads/a..b',
      'refs/heads/a/',
      'refs/heads/a.',
      'refs/heads/.hidden',
      'refs/heads/x.lock',
      'refs/heads/a b',
      'refs/heads/a~1',
      'refs/heads/a^',
      'refs/heads/a:b',
      'refs/heads/a@{1}',
      'refs/heads/a\\b',
      'refs/heads/a//b',
      `refs/heads/${'x'.repeat(1100)}`
    ]) {
      expect(() => refHash(bad), bad).toThrow()
    }
  })
})

describe('Source Cache keys (§4)', () => {
  it('builds the exact pointer and bundle keys', () => {
    expect(pointerKey({ org: 'org_1', class: 'anon', repo: ANON, ref: 'refs/heads/main', shape: 'blobless' })).toBe(
      `src/org_1/anon/${ANON}/refs/${sha('refs/heads/main')}/blobless/latest`
    )
    expect(pointerKey({ org: 'org_1', class: 'cred', repo: 'github:42', ref: 'refs/heads/dev', shape: 'full' })).toBe(
      `src/org_1/cred/github:42/refs/${sha('refs/heads/dev')}/full/latest`
    )
    expect(bundleKey({ org: 'org_1', class: 'cred', repo: 'gitlab:7', id: UUID })).toBe(
      `src/org_1/cred/gitlab:7/bundles/${UUID}.bundle`
    )
    const fresh = newBundleId()
    expect(bundleKey({ org: 'o', class: 'anon', repo: ANON, id: fresh })).toMatch(/\.bundle$/)
  })

  it('refuses inputs that would escape or confuse the layout', () => {
    const ok = { org: 'org_1', class: 'anon' as const, repo: ANON, ref: 'refs/heads/main', shape: 'blobless' as const }
    expect(() => pointerKey({ ...ok, org: '../x' })).toThrow()
    expect(() => pointerKey({ ...ok, org: '' })).toThrow()
    expect(() => pointerKey({ ...ok, repo: 'github:1' })).toThrow()
    expect(() => pointerKey({ ...ok, class: 'cred' })).toThrow()
    expect(() => pointerKey({ ...ok, class: 'cred', repo: 'bitbucket:1' })).toThrow()
    expect(() => pointerKey({ ...ok, class: 'public' as never })).toThrow()
    expect(() => pointerKey({ ...ok, shape: 'shallow' as never })).toThrow()
    expect(() => pointerKey({ ...ok, repo: ANON.toUpperCase() })).toThrow()
    expect(() => bundleKey({ org: 'o', class: 'anon', repo: ANON, id: UUID.toUpperCase() })).toThrow()
    expect(() => bundleKey({ org: 'o', class: 'anon', repo: ANON, id: '../latest' })).toThrow()
    expect(() =>
      bundleKey({ org: 'o', class: 'anon', repo: ANON, id: '3f1c2a4e-9b7d-1e21-8c3a-0d5e6f7a8b9c' })
    ).toThrow()
  })

  it('recognizes exactly the keys the builders produce', () => {
    const REF = sha('refs/heads/main')
    for (const key of [
      `src/o/anon/${ANON}/bundles/${UUID}.bundle`,
      `src/org_1/cred/github:42/bundles/${UUID}.bundle`,
      `src/org_1/anon/${ANON}/refs/${REF}/blobless/latest`,
      `src/org_1/cred/gitlab:0/refs/${REF}/full/latest`
    ]) {
      expect(isSourceCacheObjectKey(key), key).toBe(true)
    }
    for (const key of [
      'snapshots/o/x',
      'src/o/../snapshots/x',
      'src//x',
      `src/o/anon/${ANON}/bundles/${UUID}.bundle?x=1`,
      `src/o/anon/${ANON}/bundles/${UUID}.bundle#f`,
      `src/o/anon/${ANON}/bundles/${UUID}.bundle\n`,
      `src/o\n/anon/${ANON}/bundles/${UUID}.bundle`,
      `src/o/anon/${ANON}//bundles/${UUID}.bundle`,
      `src/o/anon/${ANON}/bundles/../refs/${REF}/full/latest`,
      `src/../anon/${ANON}/bundles/${UUID}.bundle`,
      `src/o/anon/${ANON}/refs/${REF}/shallow/latest`,
      `src/o/anon/${ANON}/other/${UUID}.bundle`,
      `src/o/anon/github:1/bundles/${UUID}.bundle`,
      `src/o/cred/bitbucket:1/bundles/${UUID}.bundle`,
      `src/o/cred/github:01/bundles/${UUID}.bundle`,
      `src/o/anon/${ANON}/bundles/${UUID.toUpperCase()}.bundle`,
      `src/o/anon/${ANON}`,
      'src/',
      42
    ]) {
      expect(isSourceCacheObjectKey(key), String(key)).toBe(false)
    }
  })

  it('parses a key back into its segments and nothing else', () => {
    const pointer = pointerKey({ org: 'org_1', class: 'anon', repo: ANON, ref: 'refs/heads/main', shape: 'full' })
    expect(parseSourceCacheObjectKey(pointer)).toEqual({
      orgId: 'org_1',
      repoClass: 'anon',
      repoId: ANON,
      kind: 'pointer',
      refHash: refHash('refs/heads/main'),
      shape: 'full'
    })
    const bundle = bundleKey({ org: 'o', class: 'cred', repo: credRepoId('github', '42'), id: UUID })
    expect(parseSourceCacheObjectKey(bundle)).toEqual({
      orgId: 'o',
      repoClass: 'cred',
      repoId: 'github:42',
      kind: 'bundle',
      id: UUID
    })
    for (const key of ['snapshots/o/x', `src/o/anon/github:1/bundles/${UUID}.bundle`, `${bundle}x`, 'src/', 7])
      expect(parseSourceCacheObjectKey(key), String(key)).toBeUndefined()
  })
})
