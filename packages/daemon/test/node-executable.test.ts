import { describe, it, expect } from 'vitest'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeExecutable } from '../src/runtimes/node-executable.js'

describe('nodeExecutable', () => {
  it('resolves the running Node through its symlinks', () => {
    expect(nodeExecutable()).toBe(realpathSync(process.execPath))
  })

  it('names the removed install and the commands that recover from it', () => {
    const gone = join(tmpdir(), 'ac-gone-node', 'Cellar', 'node', '26.13.0_2', 'bin', 'node')
    expect(() => nodeExecutable(gone)).toThrow(gone)
    expect(() => nodeExecutable(gone)).toThrow(/agentconnect install-service.*agentconnect restart/)
    expect(() => nodeExecutable(gone)).not.toThrow(/lstat/)
  })
})
