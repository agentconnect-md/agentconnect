import { describe, expect, it } from 'vitest'
import { canonicalizeWindowsSpawnEnv, resolveLocalInvocation } from '../src/acp/spawn-driver.js'

describe('Windows local runtime launch', () => {
  it('canonicalizes a mixed-case PATH before command resolution', () => {
    const env = { Path: 'C:\\bin', PathExt: '.EXE;.CMD', SYSTEMROOT: 'C:\\Windows' }
    canonicalizeWindowsSpawnEnv(env, 'win32')
    expect(env).toEqual({ PATH: 'C:\\bin', PATHEXT: '.EXE;.CMD', SystemRoot: 'C:\\Windows' })
  })

  it('runs the npx JavaScript entry with Node instead of spawning npx.cmd', () => {
    const cmd = 'C:\\npm\\npx.cmd'
    const cli = 'C:\\npm\\node_modules\\npm\\bin\\npx-cli.js'

    expect(resolveLocalInvocation(cmd, ['-y', 'pkg'], {}, 'win32', 'node.exe', (path) => path === cli)).toEqual({
      cmd: 'node.exe',
      args: [cli, '-y', 'pkg']
    })
  })
})
