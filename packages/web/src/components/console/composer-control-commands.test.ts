import { describe, expect, it } from 'vitest'
import {
  commandHighlight,
  draftWithoutCommandLine,
  matchChoices,
  matchControls,
  resolveControl,
  syncCommandMirror,
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

describe('commandHighlight', () => {
  const fast: ControlCommand = {
    name: 'fast',
    choices: [
      { value: 'on', label: 'On', current: false },
      { value: 'off', label: 'Off', current: true }
    ],
    run: () => {}
  }
  const controls = [...ALL.filter((c) => c.name !== 'fast'), fast]
  const skills = [
    { name: 'plugin', hint: '[install]' },
    { name: 'tdd', hint: null }
  ]

  it('marks a whole command word and hints its argument until one is typed', () => {
    expect(commandHighlight('/fast', controls, skills)).toEqual({ start: 0, end: 5, hint: '[on|off]' })
    expect(commandHighlight('  !fast ', controls, skills)).toEqual({ start: 2, end: 7, hint: '[on|off]' })
    expect(commandHighlight('/fast on', controls, skills)).toEqual({ start: 0, end: 5, hint: null })
    expect(commandHighlight('!cancel', controls, skills)).toEqual({ start: 0, end: 7, hint: null })
  })

  it('marks a skill only behind `/`, with its own argument hint', () => {
    expect(commandHighlight('/plugin', controls, skills)).toEqual({ start: 0, end: 7, hint: '[install]' })
    expect(commandHighlight('/tdd now', controls, skills)).toEqual({ start: 0, end: 4, hint: null })
    expect(commandHighlight('!plugin', controls, skills)).toBeNull()
  })

  it('leaves a partial or unknown word, or a command not at the start, unmarked', () => {
    expect(commandHighlight('/fas', controls, skills)).toBeNull()
    expect(commandHighlight('/unknown', controls, skills)).toBeNull()
    expect(commandHighlight('hi /fast', controls, skills)).toBeNull()
  })
})

describe('syncCommandMirror', () => {
  it('fits the overlay to the text viewport, not the outer box with its scrollbar', () => {
    // A 320px composer whose 10px scrollbar leaves a 310px text viewport.
    const textarea = { clientWidth: 310, clientHeight: 160, scrollTop: 48 } as HTMLTextAreaElement
    const mirror = { style: {}, scrollTop: 0 } as HTMLElement
    syncCommandMirror(mirror, textarea)
    expect(mirror.style.width).toBe('310px')
    expect(mirror.style.height).toBe('160px')
    expect(mirror.scrollTop).toBe(48)
    expect(() => syncCommandMirror(null, textarea)).not.toThrow()
  })
})

describe('draftWithoutCommandLine', () => {
  it('drops the command line and keeps what follows it', () => {
    expect(draftWithoutCommandLine('/stop', 0)).toBe('')
    expect(draftWithoutCommandLine('  /effort high', 2)).toBe('')
    expect(draftWithoutCommandLine('/stop\nkeep this', 0)).toBe('keep this')
  })
})
