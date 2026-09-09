import { describe, expect, it } from 'vitest'
import {
  managedMemoryHomeOf,
  memoryHomedInControlPlane,
  resolveMemoryBindingOnCreate,
  resolveMemoryBindingOnUpdate
} from './home.js'

const cp = { provider: 'managed', home: 'control-plane' } as const
const pendingCp = { ...cp, homeMigration: 'pending' } as const
const daemon = { provider: 'managed', home: 'daemon' } as const

describe('managedMemoryHomeOf', () => {
  it('reads no binding and a binding older than the field as the daemon home; other providers have none', () => {
    expect(managedMemoryHomeOf(null)).toBe('daemon')
    expect(managedMemoryHomeOf({ provider: 'managed' } as never)).toBe('daemon')
    expect(managedMemoryHomeOf(cp)).toBe('control-plane')
    expect(managedMemoryHomeOf({ provider: 'native' })).toBeNull()
    expect(memoryHomedInControlPlane(pendingCp)).toBe(true)
    expect(memoryHomedInControlPlane(daemon)).toBe(false)
  })
})

describe('resolveMemoryBindingOnCreate', () => {
  it('resolves the pool to the Control Plane, everything else to the given value or daemon', () => {
    expect(resolveMemoryBindingOnCreate(undefined, true)).toEqual({ memory: cp })
    expect(resolveMemoryBindingOnCreate({ provider: 'managed', autoDistill: false }, true)).toEqual({
      memory: { provider: 'managed', autoDistill: false, home: 'control-plane' }
    })
    expect(resolveMemoryBindingOnCreate(undefined, false)).toEqual({ memory: undefined })
    expect(resolveMemoryBindingOnCreate({ provider: 'managed' }, false)).toEqual({ memory: daemon })
    expect(resolveMemoryBindingOnCreate({ provider: 'managed', home: 'control-plane' }, false)).toEqual({ memory: cp })
    expect(resolveMemoryBindingOnCreate({ provider: 'native' }, true)).toEqual({ memory: { provider: 'native' } })
  })

  it('refuses an explicit daemon home on the pool', () => {
    expect(resolveMemoryBindingOnCreate(daemon, true)).toMatchObject({ refused: 'pool-daemon-home' })
  })
})

describe('resolveMemoryBindingOnUpdate', () => {
  it('leaves an absent patch alone, and an absent home keeps the current one — the migration flag included', () => {
    expect(resolveMemoryBindingOnUpdate(pendingCp, undefined, false, false)).toEqual({ kind: 'unchanged' })
    expect(resolveMemoryBindingOnUpdate(pendingCp, { provider: 'managed', autoDistill: true }, false, false)).toEqual({
      kind: 'write',
      memory: { provider: 'managed', autoDistill: true, home: 'control-plane', homeMigration: 'pending' },
      dropHome: false
    })
    expect(resolveMemoryBindingOnUpdate(daemon, { provider: 'managed', scope: 'channel' }, false, false)).toEqual({
      kind: 'write',
      memory: { provider: 'managed', scope: 'channel', home: 'daemon' },
      dropHome: false
    })
    // The managed default on a daemon-home agent stays the bare default; on a CP-home agent it must carry the home.
    expect(resolveMemoryBindingOnUpdate(null, null, false, false)).toEqual({
      kind: 'write',
      memory: null,
      dropHome: false
    })
    expect(resolveMemoryBindingOnUpdate(pendingCp, null, false, false)).toEqual({
      kind: 'write',
      memory: pendingCp,
      dropHome: false
    })
  })

  it('flags the forward switch and never re-flags a home that already is the Control Plane', () => {
    expect(resolveMemoryBindingOnUpdate(null, { provider: 'managed', home: 'control-plane' }, false, false)).toEqual({
      kind: 'write',
      memory: pendingCp,
      dropHome: false
    })
    expect(resolveMemoryBindingOnUpdate(cp, { provider: 'managed', home: 'control-plane' }, false, false)).toEqual({
      kind: 'write',
      memory: cp,
      dropHome: false
    })
  })

  it('refuses the reverse without force, and drops the tree with it', () => {
    expect(resolveMemoryBindingOnUpdate(pendingCp, daemon, false, false)).toMatchObject({
      kind: 'refused',
      refused: 'reverse-needs-force'
    })
    expect(resolveMemoryBindingOnUpdate(pendingCp, daemon, false, true)).toEqual({
      kind: 'write',
      memory: daemon,
      dropHome: true
    })
    // `force` alone names no home: the managed default on a CP-home agent keeps the home, and nothing is dropped.
    expect(resolveMemoryBindingOnUpdate(cp, null, false, true)).toEqual({ kind: 'write', memory: cp, dropHome: false })
  })

  it('never lets a pool agent name the daemon home, force or not', () => {
    expect(resolveMemoryBindingOnUpdate(cp, daemon, true, true)).toMatchObject({ refused: 'pool-daemon-home' })
    expect(resolveMemoryBindingOnUpdate({ provider: 'native' }, daemon, true, false)).toMatchObject({
      refused: 'pool-daemon-home'
    })
    expect(resolveMemoryBindingOnUpdate({ provider: 'native' }, null, true, false)).toEqual({
      kind: 'write',
      memory: cp,
      dropHome: false
    })
  })

  it('a provider switch never migrates: away drops the home, back resolves as on create with no flag', () => {
    expect(resolveMemoryBindingOnUpdate(pendingCp, { provider: 'native' }, false, false)).toEqual({
      kind: 'write',
      memory: { provider: 'native' },
      dropHome: false
    })
    expect(
      resolveMemoryBindingOnUpdate({ provider: 'native' }, { provider: 'managed', home: 'control-plane' }, false, false)
    ).toEqual({ kind: 'write', memory: cp, dropHome: false })
    expect(resolveMemoryBindingOnUpdate({ provider: 'native' }, { provider: 'managed' }, false, false)).toEqual({
      kind: 'write',
      memory: daemon,
      dropHome: false
    })
  })
})
