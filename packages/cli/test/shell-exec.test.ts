import { describe, it, expect } from 'vitest'
import { shellExecArgv } from '../src/shell-exec.js'

const CMD = ['/nvm/v24/bin/node', '/root/current/dist/index.js', 'run'] as const

describe('shellExecArgv', () => {
  it('POSIX-family shells exec via "$0" "$@" so argv crosses without re-quoting', () => {
    for (const shell of ['/bin/bash', '/usr/bin/zsh', '/bin/sh', '/bin/dash']) {
      expect(shellExecArgv(shell, CMD)).toEqual([shell, '-l', '-i', '-c', 'exec "$0" "$@"', ...CMD])
    }
  })

  it('fish execs via $argv', () => {
    expect(shellExecArgv('/usr/bin/fish', CMD)).toEqual(['/usr/bin/fish', '-l', '-i', '-c', 'exec $argv', ...CMD])
  })

  it('returns undefined for shells with no safe template (tcsh rejects -l with other flags)', () => {
    expect(shellExecArgv('/bin/tcsh', CMD)).toBeUndefined()
    expect(shellExecArgv('/bin/csh', CMD)).toBeUndefined()
    expect(shellExecArgv('/usr/bin/nu', CMD)).toBeUndefined()
  })

  it('returns undefined for an empty command', () => {
    expect(shellExecArgv('/bin/bash', [])).toBeUndefined()
  })
})
