import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertInstanceName,
  commandSelector,
  clearInstancePointer,
  instanceRoot,
  readInstancePointer,
  resolveServiceTarget,
  shouldBakeRootEnv,
  writeInstancePointer
} from '../src/service/instance.js'

/** A fresh HOME so `defaultRoot()`/`resolveRoot()` are deterministic. */
function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'ac-home-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home) // what `homedir()` reads on Windows
  vi.stubEnv('AGENTCONNECT_ROOT', undefined)
  return home
}

afterEach(() => vi.unstubAllEnvs())

describe('assertInstanceName', () => {
  it('accepts unit-safe names', () => {
    for (const name of ['dev', 'b', 'team-2', 'a_b', '0x']) expect(assertInstanceName(name)).toBe(name)
  })
  it('rejects anything that would break a unit name or a plist label', () => {
    for (const name of ['', '-dev', 'Dev', 'a b', 'a/b', 'a.b', 'a@b', 'x'.repeat(33)]) {
      expect(() => assertInstanceName(name)).toThrow(/invalid instance name/)
    }
  })
})

describe('instanceRoot', () => {
  it('sits beside the default root', () => {
    const home = fakeHome()
    expect(instanceRoot('dev')).toBe(join(home, '.agentconnect-dev'))
  })
})

describe('resolveServiceTarget', () => {
  it('defaults to the default root and no instance', () => {
    const home = fakeHome()
    expect(resolveServiceTarget()).toEqual({ root: join(home, '.agentconnect') })
  })

  it('derives the root from the instance name', () => {
    const home = fakeHome()
    expect(resolveServiceTarget({ instance: 'dev' })).toEqual({
      root: join(home, '.agentconnect-dev'),
      instance: 'dev'
    })
  })

  it('lets an explicit root win, keeping the named instance', () => {
    fakeHome()
    const root = mkdtempSync(join(tmpdir(), 'ac-root-'))
    expect(resolveServiceTarget({ root, instance: 'dev' })).toEqual({ root, instance: 'dev' })
  })

  it('adopts the instance recorded in the root when only --root is given', () => {
    fakeHome()
    const root = mkdtempSync(join(tmpdir(), 'ac-root-'))
    writeInstancePointer(root, { instance: 'dev', label: 'agentconnect@dev.service' })
    // This is the CP-commanded `upgrade --to <v> --root <root>` path: the daemon
    // knows only its root, and must still restart ITS unit, not the default one.
    expect(resolveServiceTarget({ root })).toEqual({ root, instance: 'dev' })
  })

  it('ignores a corrupt or foreign pointer', () => {
    fakeHome()
    const root = mkdtempSync(join(tmpdir(), 'ac-root-'))
    writeFileSync(join(root, 'service.json'), '{ not json')
    expect(resolveServiceTarget({ root })).toEqual({ root })
    writeFileSync(join(root, 'service.json'), JSON.stringify({ instance: 'BAD NAME', label: 'x' }))
    expect(resolveServiceTarget({ root })).toEqual({ root })
  })

  it('rejects a bad instance name before touching the filesystem', () => {
    fakeHome()
    expect(() => resolveServiceTarget({ instance: 'Not Valid' })).toThrow(/invalid instance name/)
  })
})

describe('shouldBakeRootEnv', () => {
  it('is false only for the default root', () => {
    const home = fakeHome()
    expect(shouldBakeRootEnv(join(home, '.agentconnect'))).toBe(false)
    expect(shouldBakeRootEnv(join(home, '.agentconnect-dev'))).toBe(true)
  })

  it('is true for an AGENTCONNECT_ROOT-driven install with no --root flag', () => {
    const home = fakeHome()
    // Regression: the old `Boolean(--root)` gate wrote a unit with no root at
    // all, so the service silently started on ~/.agentconnect instead.
    vi.stubEnv('AGENTCONNECT_ROOT', join(home, 'elsewhere'))
    expect(shouldBakeRootEnv(resolveServiceTarget().root)).toBe(true)
  })
})

describe('instance pointer', () => {
  it('round-trips and clears', () => {
    fakeHome()
    const root = mkdtempSync(join(tmpdir(), 'ac-root-'))
    expect(readInstancePointer(root)).toBeUndefined()
    writeInstancePointer(root, { instance: 'dev', label: 'agentconnect@dev.service' })
    expect(readInstancePointer(root)).toBe('dev')
    clearInstancePointer(root)
    expect(existsSync(join(root, 'service.json'))).toBe(false)
    expect(() => clearInstancePointer(root)).not.toThrow() // idempotent
  })

  it('records the default instance without a name', () => {
    fakeHome()
    const root = mkdtempSync(join(tmpdir(), 'ac-root-'))
    writeInstancePointer(root, { label: 'agentconnect.service' })
    expect(readInstancePointer(root)).toBeUndefined()
  })

  it('never throws when the root is not writable', () => {
    fakeHome()
    const root = join(mkdtempSync(join(tmpdir(), 'ac-root-')), 'missing')
    mkdirSync(root, { recursive: false })
    expect(() => writeInstancePointer(join(root, 'nope'), { label: 'x' })).not.toThrow()
  })
})

describe('commandSelector', () => {
  it('is empty for the default instance on the default root', () => {
    const home = fakeHome()
    expect(commandSelector({ root: join(home, '.agentconnect') })).toBe('')
    expect(commandSelector({})).toBe('')
  })

  it('emits just the name when the root is the one that name implies', () => {
    const home = fakeHome()
    expect(commandSelector({ root: join(home, '.agentconnect-dev'), instance: 'dev' })).toBe(' --instance dev')
  })

  it('keeps a custom root alongside the name', () => {
    fakeHome()
    // `--instance dev` alone would resolve ~/.agentconnect-dev, so a follow-up
    // command that dropped --root would act on the wrong root.
    expect(commandSelector({ root: '/srv/ac-dev', instance: 'dev' })).toBe(' --instance dev --root /srv/ac-dev')
    expect(commandSelector({ root: '/srv/ac dev', instance: 'dev' })).toBe(" --instance dev --root '/srv/ac dev'")
  })

  it('falls back to --root for an unnamed non-default root, shell-quoting when needed', () => {
    fakeHome()
    expect(commandSelector({ root: '/srv/ac-b' })).toBe(' --root /srv/ac-b')
    expect(commandSelector({ root: '/srv/ac b' })).toBe(" --root '/srv/ac b'")
  })
})
