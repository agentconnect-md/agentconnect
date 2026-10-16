import { describe, expect, it } from 'vitest'
import {
  managedBindingHomedInControlPlane,
  managedMemoryHomeOf,
  memoryHomedInControlPlane,
  resolveMemoryBindingOnCreate,
  resolveMemoryBindingOnUpdate,
  resolveMemoryHomeOnMove
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
    expect(resolveMemoryBindingOnCreate(daemon, true)).toMatchObject({ refused: 'set-daemon-home' })
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
    expect(resolveMemoryBindingOnUpdate(cp, daemon, true, true)).toMatchObject({ refused: 'set-daemon-home' })
    expect(resolveMemoryBindingOnUpdate({ provider: 'native' }, daemon, true, false)).toMatchObject({
      refused: 'set-daemon-home'
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

// The rule reads one fact, "placed on a member set": a group and the pool are the same input, a pinned agent is not.
describe.each([
  { placement: 'pinned', onSet: false },
  { placement: 'group', onSet: true },
  { placement: 'pool', onSet: true }
])('the home rule for a $placement agent', ({ onSet }) => {
  const native = { provider: 'native' } as const

  it('create: a managed binding defaults to the Control Plane on a set and to the daemon when pinned', () => {
    expect(resolveMemoryBindingOnCreate(undefined, onSet)).toEqual({ memory: onSet ? cp : undefined })
    expect(resolveMemoryBindingOnCreate({ provider: 'managed' }, onSet)).toEqual({ memory: onSet ? cp : daemon })
    expect(resolveMemoryBindingOnCreate(cp, onSet)).toEqual({ memory: cp })
    const explicit = resolveMemoryBindingOnCreate(daemon, onSet)
    expect(explicit).toEqual(onSet ? expect.objectContaining({ refused: 'set-daemon-home' }) : { memory: daemon })
    if ('refused' in explicit) expect(explicit.message).toMatch(/group or the managed pool/)
    expect(resolveMemoryBindingOnCreate(native, onSet)).toEqual({ memory: native })
  })

  it('update: the daemon home is refused on a set even with force; the forward switch and its flag are the same everywhere', () => {
    expect(resolveMemoryBindingOnUpdate(daemon, cp, onSet, false)).toEqual({
      kind: 'write',
      memory: pendingCp,
      dropHome: false
    })
    const back = resolveMemoryBindingOnUpdate(cp, daemon, onSet, true)
    expect(back).toEqual(
      onSet
        ? expect.objectContaining({ kind: 'refused', refused: 'set-daemon-home' })
        : { kind: 'write', memory: daemon, dropHome: true }
    )
    // A stale daemon binding on a set is not re-stored by a save that names no home.
    expect(resolveMemoryBindingOnUpdate(daemon, { provider: 'managed', autoDistill: false }, onSet, false).kind).toBe(
      onSet ? 'refused' : 'write'
    )
    expect(resolveMemoryBindingOnUpdate(cp, native, onSet, false)).toEqual({
      kind: 'write',
      memory: native,
      dropHome: false
    })
    expect(resolveMemoryBindingOnUpdate(native, { provider: 'managed' }, onSet, false)).toEqual({
      kind: 'write',
      memory: onSet ? cp : daemon,
      dropHome: false
    })
  })

  it('move: only a daemon home landing on a set is touched — refused when placed, switched when unplaced', () => {
    for (const binding of [null, daemon]) {
      expect(resolveMemoryHomeOnMove(binding, onSet, false)).toBe(onSet ? 'refuse' : 'keep')
      expect(resolveMemoryHomeOnMove(binding, onSet, true)).toBe(onSet ? 'switch' : 'keep')
    }
    for (const binding of [cp, pendingCp, native, { provider: 'none' } as const]) {
      expect(resolveMemoryHomeOnMove(binding, onSet, false)).toBe('keep')
      expect(resolveMemoryHomeOnMove(binding, onSet, true)).toBe('keep')
    }
  })
})

// Assistant mode is the second reason the CP home is mandatory (assistant-mode.md §4.1); `assistantMode` is the mode after the edit.
describe.each([
  { placement: 'pinned', onSet: false },
  { placement: 'group', onSet: true }
])('the home rule under assistant mode for a $placement agent', ({ onSet }) => {
  const resolve = (
    current: Parameters<typeof resolveMemoryBindingOnUpdate>[0],
    patch: Parameters<typeof resolveMemoryBindingOnUpdate>[1],
    force = false
  ) => resolveMemoryBindingOnUpdate(current, patch, onSet, force, true)

  it('an edit with no binding, turning the mode on, moves a daemon home and flags the migration', () => {
    expect(resolve(null, undefined)).toEqual({ kind: 'write', memory: pendingCp, dropHome: false })
    expect(resolve({ ...daemon, autoDistill: false }, undefined)).toEqual({
      kind: 'write',
      memory: { ...pendingCp, autoDistill: false },
      dropHome: false
    })
    expect(resolve(cp, undefined)).toEqual({ kind: 'unchanged' })
    expect(resolve(pendingCp, undefined)).toEqual({ kind: 'unchanged' })
    expect(resolve({ provider: 'none' }, undefined)).toEqual({ kind: 'unchanged' })
    expect(resolveMemoryBindingOnUpdate(daemon, undefined, onSet, false)).toEqual({ kind: 'unchanged' })
  })

  it('a managed save that names no home lands in the Control Plane', () => {
    expect(resolve(daemon, { provider: 'managed', autoDistill: true })).toEqual({
      kind: 'write',
      memory: { ...pendingCp, autoDistill: true },
      dropHome: false
    })
    expect(resolve(daemon, null)).toEqual({ kind: 'write', memory: pendingCp, dropHome: false })
    expect(resolve(pendingCp, { provider: 'managed' })).toEqual({ kind: 'write', memory: pendingCp, dropHome: false })
    expect(resolve({ provider: 'none' }, { provider: 'managed' })).toEqual({
      kind: 'write',
      memory: cp,
      dropHome: false
    })
    expect(resolve({ provider: 'none' }, null)).toEqual({ kind: 'write', memory: cp, dropHome: false })
  })

  it('refuses the daemon home and the forced return, naming the mode unless the placement already refuses it', () => {
    const refused = onSet ? 'set-daemon-home' : 'assistant-mode'
    for (const current of [cp, pendingCp, daemon, { provider: 'none' } as const]) {
      for (const force of [false, true]) {
        const result = resolve(current, daemon, force)
        expect(result).toMatchObject({ kind: 'refused', refused })
        if (!onSet && result.kind === 'refused') expect(result.message).toMatch(/turn assistant mode off first/)
      }
    }
  })

  it('passes another provider through to the admission check', () => {
    expect(resolve(cp, { provider: 'none' })).toEqual({ kind: 'write', memory: { provider: 'none' }, dropHome: false })
  })
})

describe('managedBindingHomedInControlPlane', () => {
  it('keeps the policy fields, sets the home, and drops the CP-owned flag; no binding is the managed default', () => {
    expect(managedBindingHomedInControlPlane(null)).toEqual(cp)
    expect(managedBindingHomedInControlPlane({ provider: 'managed' } as never)).toEqual(cp)
    expect(managedBindingHomedInControlPlane({ ...daemon, autoDistill: false, scope: 'channel' })).toEqual({
      provider: 'managed',
      autoDistill: false,
      scope: 'channel',
      home: 'control-plane'
    })
    expect(managedBindingHomedInControlPlane(pendingCp)).toEqual(cp)
  })
})
