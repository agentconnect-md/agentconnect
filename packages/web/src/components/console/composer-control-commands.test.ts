import { describe, expect, it } from 'vitest'
import {
  draftWithoutCommandLine,
  matchChoices,
  matchControls,
  resolveControl,
  type ControlCommand,
  type ControlName
} from './composer-control-commands'

const control = (name: ControlName): ControlCommand => ({ name, choices: name === 'stop' ? null : [], run: () => {} })
const ALL = (['stop', 'model', 'effort', 'permission', 'fast'] as const).map(control)

describe('matchControls', () => {
  it('lists every command for a bare prefix, in the given order', () => {
    expect(matchControls(ALL, '').map((c) => c.name)).toEqual(['stop', 'model', 'effort', 'permission', 'fast'])
  })

  it('puts a prefix match ahead of a substring one and reaches the chat aliases', () => {
    expect(matchControls(ALL, 'f').map((c) => c.name)).toEqual(['fast', 'effort'])
    expect(matchControls(ALL, 'canc').map((c) => c.name)).toEqual(['stop'])
    expect(matchControls(ALL, 'PERM').map((c) => c.name)).toEqual(['permission'])
    expect(matchControls(ALL, 'xyz')).toEqual([])
  })
})

describe('resolveControl', () => {
  it('names a command by its whole word or alias only', () => {
    expect(resolveControl(ALL, 'Models')?.name).toBe('model')
    expect(resolveControl(ALL, 'perm')?.name).toBe('permission')
    expect(resolveControl(ALL, 'mod')).toBeUndefined()
  })
})

describe('matchChoices', () => {
  const choices = [
    { value: 'low', label: 'Low', current: false },
    { value: 'high', label: 'High', current: true },
    { value: 'xhigh', label: 'Extra high', current: false }
  ]

  it('narrows by value or label, prefix matches first', () => {
    expect(matchChoices(choices, '').map((c) => c.value)).toEqual(['low', 'high', 'xhigh'])
    expect(matchChoices(choices, 'hi').map((c) => c.value)).toEqual(['high', 'xhigh'])
    expect(matchChoices(choices, 'extra').map((c) => c.value)).toEqual(['xhigh'])
    expect(matchChoices(choices, 'none')).toEqual([])
  })
})

describe('draftWithoutCommandLine', () => {
  it('drops the command line and keeps what follows it', () => {
    expect(draftWithoutCommandLine('/stop', 0)).toBe('')
    expect(draftWithoutCommandLine('  /effort high', 2)).toBe('')
    expect(draftWithoutCommandLine('/stop\nkeep this', 0)).toBe('keep this')
  })
})
