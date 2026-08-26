import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalizeWindowsSpawnEnv, resolveLocalInvocation } from '../src/acp/spawn-driver.js'

describe('Windows local runtime launch', () => {
  it('canonicalizes a mixed-case PATH before command resolution', () => {
    const env = { Path: 'C:\\bin', PathExt: '.EXE;.CMD', SYSTEMROOT: 'C:\\Windows' }
    canonicalizeWindowsSpawnEnv(env, 'win32')
    expect(env).toEqual({ PATH: 'C:\\bin', PATHEXT: '.EXE;.CMD', SystemRoot: 'C:\\Windows' })
  })

  it('runs the npx JavaScript entry with Node instead of spawning npx.cmd', () => {
    const bin = mkdtempSync(join(tmpdir(), 'ac-win-npx-'))
    const cmd = join(bin, 'npx.cmd')
    const cli = join(bin, 'node_modules', 'npm', 'bin', 'npx-cli.js')
    mkdirSync(join(cli, '..'), { recursive: true })
    writeFileSync(cmd, '@echo off\r\n')
    writeFileSync(cli, '')

    expect(resolveLocalInvocation('npx', ['-y', 'pkg'], { PATH: bin, PATHEXT: '.CMD' }, 'win32', 'node.exe')).toEqual({
      cmd: 'node.exe',
      args: [cli, '-y', 'pkg']
    })
  })
})
