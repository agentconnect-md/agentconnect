import { describe, it, expect } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stableNodePath } from '../src/service/node-path.js'

const CELLAR = '/opt/homebrew/Cellar/node/26.13.0_2/bin/node'
const ALIAS = '/opt/homebrew/opt/node/bin/node'

describe('stableNodePath', () => {
  it('swaps a Homebrew Cellar path for the opt alias that resolves to it', () => {
    const realpath = (p: string) => (p === ALIAS ? CELLAR : p)
    expect(stableNodePath(CELLAR, realpath)).toBe(ALIAS)
  })

  it('keeps the formula name of a versioned formula and of a Linux prefix', () => {
    const cellar = '/home/linuxbrew/.linuxbrew/Cellar/node@22/22.11.0/bin/node'
    const alias = '/home/linuxbrew/.linuxbrew/opt/node@22/bin/node'
    expect(stableNodePath(cellar, (p) => (p === alias ? cellar : p))).toBe(alias)
  })

  it('keeps the Cellar path when the alias is missing', () => {
    const realpath = (p: string) => {
      if (p === ALIAS) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return p
    }
    expect(stableNodePath(CELLAR, realpath)).toBe(CELLAR)
  })

  it('keeps the Cellar path when the alias points at another version', () => {
    const realpath = (p: string) => (p === ALIAS ? '/opt/homebrew/Cellar/node/27.0.0/bin/node' : p)
    expect(stableNodePath(CELLAR, realpath)).toBe(CELLAR)
  })

  it('leaves paths outside a Cellar alone', () => {
    const untouched = () => {
      throw new Error('must not be consulted')
    }
    for (const p of [
      '/usr/bin/node',
      '/Users/agent/.nvm/versions/node/v26.13.0/bin/node',
      'C:\\Program Files\\nodejs\\node.exe'
    ]) {
      expect(stableNodePath(p, untouched)).toBe(p)
    }
  })

  it.skipIf(process.platform === 'win32')('survives the upgrade that deletes the versioned directory', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'ac-brew-'))
    const old = join(prefix, 'Cellar/node/26.13.0_2')
    mkdirSync(join(old, 'bin'), { recursive: true })
    writeFileSync(join(old, 'bin/node'), '')
    mkdirSync(join(prefix, 'opt'))
    symlinkSync('../Cellar/node/26.13.0_2', join(prefix, 'opt/node'))

    const stable = stableNodePath(join(old, 'bin/node'))
    expect(stable).toBe(join(prefix, 'opt/node/bin/node'))

    const next = join(prefix, 'Cellar/node/26.14.0')
    cpSync(old, next, { recursive: true })
    rmSync(join(prefix, 'opt/node'))
    symlinkSync('../Cellar/node/26.14.0', join(prefix, 'opt/node'))
    rmSync(old, { recursive: true })
    expect(stableNodePath(stable)).toBe(stable)
    expect(stableNodePath(join(next, 'bin/node'))).toBe(stable)
  })
})
