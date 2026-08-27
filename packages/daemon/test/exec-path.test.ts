import { describe, it, expect } from 'vitest'
import { delimiter, dirname } from 'node:path'
import { realpathSync } from 'node:fs'
import { ensureNodeBinOnPath } from '../src/runtimes/exec-path.js'

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
