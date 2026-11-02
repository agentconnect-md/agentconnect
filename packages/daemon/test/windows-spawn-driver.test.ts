import { describe, expect, it } from 'vitest'
import { canonicalizeWindowsSpawnEnv } from '../src/acp/spawn-driver.js'
import { resolveLocalInvocation } from '../src/runtimes/probe.js'

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

  it('runs the npm JavaScript entry with Node instead of spawning npm.cmd', () => {
    const cmd = 'C:\\npm\\npm.cmd'
    const cli = 'C:\\npm\\node_modules\\npm\\bin\\npm-cli.js'

    expect(resolveLocalInvocation(cmd, ['view', 'pkg'], {}, 'win32', 'node.exe', (path) => path === cli)).toEqual({
      cmd: 'node.exe',
      args: [cli, 'view', 'pkg']
    })
  })
})
