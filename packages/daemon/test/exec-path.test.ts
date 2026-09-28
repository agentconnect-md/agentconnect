import { describe, it, expect, afterEach } from 'vitest'
import { delimiter, dirname, join } from 'node:path'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ensureNodeBinOnPath, ensureRuntimeInstallDirsOnPath } from '../src/runtimes/exec-path.js'

const nodeBin = dirname(process.execPath)
const realNodeBin = dirname(realpathSync(process.execPath))

describe('ensureNodeBinOnPath', () => {
  it('prepends the Node bin dir to a service-manager-style minimal PATH', () => {
    const env: NodeJS.ProcessEnv = { PATH: ['/usr/local/bin', '/usr/bin', '/bin'].join(delimiter) }
    ensureNodeBinOnPath(env)
    const dirs = env.PATH!.split(delimiter)
    expect(dirs[0]).toBe(nodeBin)
    expect(dirs).toContain('/usr/bin')
  })

  it('is a no-op when the dir is already present', () => {
    const path = [nodeBin, realNodeBin, '/usr/bin'].join(delimiter)
    const env: NodeJS.ProcessEnv = { PATH: path }
    ensureNodeBinOnPath(env)
    expect(env.PATH).toBe(path)
  })

  it('handles a missing PATH', () => {
    const env: NodeJS.ProcessEnv = {}
    ensureNodeBinOnPath(env)
    expect(env.PATH!.split(delimiter)).toContain(nodeBin)
  })
})

describe('ensureRuntimeInstallDirsOnPath', () => {
  const roots: string[] = []
  const tempHome = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-install-dirs-'))
    roots.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('appends the Kimi Code install dir after the existing PATH', () => {
    const home = tempHome()
    const bin = join(home, '.kimi-code', 'bin')
    mkdirSync(bin, { recursive: true })
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, PATH: ['/usr/bin', '/bin'].join(delimiter) }
    ensureRuntimeInstallDirsOnPath(env)
    expect(env.PATH!.split(delimiter)).toEqual(['/usr/bin', '/bin', bin])
  })

  it('honors KIMI_CODE_HOME', () => {
    const home = tempHome()
    const bin = join(home, 'relocated', 'bin')
    mkdirSync(bin, { recursive: true })
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, KIMI_CODE_HOME: join(home, 'relocated'), PATH: '' }
    ensureRuntimeInstallDirsOnPath(env)
    expect(env.PATH).toBe(bin)
  })

  it('skips missing dirs and dirs already present', () => {
    const home = tempHome()
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, PATH: '/usr/bin' }
    ensureRuntimeInstallDirsOnPath(env)
    expect(env.PATH).toBe('/usr/bin')
    const bin = join(home, '.kimi-code', 'bin')
    mkdirSync(bin, { recursive: true })
    env.PATH = [bin, '/usr/bin'].join(delimiter)
    ensureRuntimeInstallDirsOnPath(env)
    expect(env.PATH).toBe([bin, '/usr/bin'].join(delimiter))
  })
})
