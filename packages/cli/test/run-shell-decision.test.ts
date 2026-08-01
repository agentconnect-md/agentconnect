import { describe, it, expect } from 'vitest'
import { RESERVED_RESTART_CODE } from '@agentconnect.md/protocol'
import { decideNext } from '../src/run-shell.js'

describe('decideNext', () => {
  it('stop-before-ready race: a requested stop wins over the not-ready fallback', () => {
    // systemctl stop while the login shell is still pre-readiness: the
    // forwarded TERM kills the shell (ready=false). The loop must exit, not
    // launch a replacement daemon while the service is stopping.
    const result = { code: null, signal: 'SIGTERM' as const, ready: false }
    expect(decideNext(result, { viaShell: true, stopRequested: true })).toBe('exit')
  })

  it('a requested stop also wins over a reserved-code respawn', () => {
    const result = { code: RESERVED_RESTART_CODE, signal: null }
    expect(decideNext(result, { viaShell: false, stopRequested: true })).toBe('exit')
  })

  it('not-ready without a stop falls back to a direct spawn', () => {
    const result = { code: null, signal: 'SIGKILL' as const, ready: false }
    expect(decideNext(result, { viaShell: true, stopRequested: false })).toBe('fallback-direct')
  })

  it('reserved restart code respawns; anything else exits', () => {
    expect(decideNext({ code: RESERVED_RESTART_CODE, signal: null }, { viaShell: false, stopRequested: false })).toBe(
      'respawn'
    )
    expect(
      decideNext({ code: RESERVED_RESTART_CODE, signal: null, ready: true }, { viaShell: true, stopRequested: false })
    ).toBe('respawn')
    expect(decideNext({ code: 0, signal: null }, { viaShell: false, stopRequested: false })).toBe('exit')
    expect(decideNext({ code: 1, signal: null, ready: true }, { viaShell: true, stopRequested: false })).toBe('exit')
  })
})
