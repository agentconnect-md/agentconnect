import { describe, it, expect } from 'vitest'
import { pickController, resolveController } from '../src/service/index.js'

const deps = { root: '/tmp/r', home: '/tmp/h', uid: 501, exec: async () => ({ code: 0, stdout: '', stderr: '' }) }

describe('pickController', () => {
  it('returns the launchd controller on darwin', () => {
    expect(pickController('darwin', deps).label).toBe('md.agentconnect.daemon')
  })
  it('returns the systemd controller on linux', () => {
    expect(pickController('linux', deps).label).toBe('agentconnect.service')
  })
  it('throws an actionable error on win32', () => {
    expect(() => pickController('win32', deps)).toThrow(/not supported on win32/i)
  })
})

describe('resolveController', () => {
  it('builds a controller for the requested platform', () => {
    const c = resolveController({ root: '/tmp/r', platform: 'linux' })
    expect(c.label).toBe('agentconnect.service')
  })
})
