import { describe, expect, it } from 'vitest'
import { assertKvmAvailable, kvmPreflightFailure, type KvmObservation } from '../src/microsandbox/kvm.js'

const base: KvmObservation = { username: 'agent', uid: 1000 }

describe('microsandbox KVM preflight', () => {
  it('passes when the device opens', () => {
    expect(kvmPreflightFailure(base)).toBeUndefined()
    expect(() => assertKvmAvailable(() => base)).not.toThrow()
  })

  it('names virtualization when the device is absent', () => {
    const failure = kvmPreflightFailure({ ...base, errorCode: 'ENOENT' })
    expect(failure).toContain('the device is absent')
    expect(failure).toContain('nested virtualization')
  })

  it('separates a membership the process never inherited from one the user lacks', () => {
    const group = { gid: 993, name: 'kvm', heldByProcess: false }
    const stale = kvmPreflightFailure({ ...base, errorCode: 'EACCES', group: { ...group, heldByUser: true } })
    expect(stale).toContain('is a member of group "kvm" but this process is not')
    expect(stale).toContain('systemctl restart user@1000.service')
    const missing = kvmPreflightFailure({ ...base, errorCode: 'EACCES', group: { ...group, heldByUser: false } })
    expect(missing).toContain('usermod -aG kvm agent')
    expect(missing).not.toContain('postdates')
  })

  it('falls back to the gid when the group has no name', () => {
    const failure = kvmPreflightFailure({
      ...base,
      errorCode: 'EPERM',
      group: { gid: 993, heldByProcess: false, heldByUser: false }
    })
    expect(failure).toContain('group "993"')
  })

  it('points at the device itself when the process already holds the group', () => {
    const failure = kvmPreflightFailure({
      ...base,
      errorCode: 'EACCES',
      group: { gid: 993, name: 'kvm', heldByProcess: true, heldByUser: true }
    })
    expect(failure).toContain('owner, mode and ACL')
    expect(failure).not.toContain('usermod')
  })

  it('reports any other errno verbatim', () => {
    expect(kvmPreflightFailure({ ...base, errorCode: 'EBUSY' })).toContain('(EBUSY)')
  })

  it('throws the failure it found', () => {
    expect(() => assertKvmAvailable(() => ({ ...base, errorCode: 'ENOENT' }))).toThrow('microsandbox requires KVM')
  })
})
