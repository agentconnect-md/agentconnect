import { describe, expect, it } from 'vitest'
import { COMMAND_PREFIXES, parseCommand } from '../src/index.js'

// The command grammar the relay and the daemon share (moved here so both parse identically).

describe('parseCommand', () => {
  it('parses every command word under both prefixes, with Telegram @bot addressing', () => {
    expect(COMMAND_PREFIXES).toEqual(['!', '/'])
    for (const prefix of COMMAND_PREFIXES) {
      expect(parseCommand(`${prefix}stop`)).toEqual({ kind: 'stop' })
      expect(parseCommand(`  ${prefix}CANCEL`)).toEqual({ kind: 'cancel' })
      expect(parseCommand(`${prefix}resume`)).toEqual({ kind: 'resume' })
      expect(parseCommand(`${prefix}new`)).toEqual({ kind: 'new' })
      expect(parseCommand(`${prefix}queue  do it later `)).toEqual({ kind: 'queue', text: 'do it later' })
      expect(parseCommand(`${prefix}status@my_bot`)).toEqual({ kind: 'status' })
      expect(parseCommand(`${prefix}fast on`)).toEqual({ kind: 'fast', enable: true })
      expect(parseCommand(`${prefix}fast off`)).toEqual({ kind: 'fast', enable: false })
      expect(parseCommand(`${prefix}fast maybe`)).toEqual({ kind: 'fast', enable: null })
      expect(parseCommand(`${prefix}models 2`)).toEqual({ kind: 'model', value: '2' })
      expect(parseCommand(`${prefix}model`)).toEqual({ kind: 'model', value: null })
      expect(parseCommand(`${prefix}effort high`)).toEqual({ kind: 'effort', value: 'high' })
      expect(parseCommand(`${prefix}perm`)).toEqual({ kind: 'permission', value: null })
    }
  })

  it('leaves ordinary text alone', () => {
    for (const text of ['hello!', '! note', 'stop', '!unknown', '!', '/ stop', 'x !stop'])
      expect(parseCommand(text)).toBe(null)
  })
})
