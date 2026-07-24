import { describe, it, expect } from 'vitest'
import { parseCommand } from '../src/commands/commands.js'

describe('parseCommand', () => {
  it('parses !stop, !cancel, and !resume as distinct commands', () => {
    expect(parseCommand('!stop')).toEqual({ kind: 'stop' })
    expect(parseCommand('!cancel')).toEqual({ kind: 'cancel' })
    expect(parseCommand('/cancel')).toEqual({ kind: 'cancel' })
    expect(parseCommand('!resume')).toEqual({ kind: 'resume' })
    expect(parseCommand('/resume')).toEqual({ kind: 'resume' })
  })

  it('parses the / prefix too (for non-Slack platforms)', () => {
    expect(parseCommand('/stop')).toEqual({ kind: 'stop' })
    expect(parseCommand('/queue ship it')).toEqual({ kind: 'queue', text: 'ship it' })
  })

  it('parses /status', () => {
    expect(parseCommand('/status')).toEqual({ kind: 'status' })
    expect(parseCommand('!status')).toEqual({ kind: 'status' })
  })

  it('parses /fast on|off (bare/unknown arg → enable null)', () => {
    expect(parseCommand('/fast on')).toEqual({ kind: 'fast', enable: true })
    expect(parseCommand('/fast OFF')).toEqual({ kind: 'fast', enable: false })
    expect(parseCommand('/fast')).toEqual({ kind: 'fast', enable: null })
    expect(parseCommand('/fast maybe')).toEqual({ kind: 'fast', enable: null })
  })

  it('parses /models, /effort, /permission (bare → null value; else the chosen value)', () => {
    expect(parseCommand('/models')).toEqual({ kind: 'model', value: null })
    expect(parseCommand('/model')).toEqual({ kind: 'model', value: null })
    expect(parseCommand('/models opus')).toEqual({ kind: 'model', value: 'opus' })
    expect(parseCommand('/models 2')).toEqual({ kind: 'model', value: '2' })
    expect(parseCommand('/effort')).toEqual({ kind: 'effort', value: null })
    expect(parseCommand('/effort high')).toEqual({ kind: 'effort', value: 'high' })
    expect(parseCommand('/permission')).toEqual({ kind: 'permission', value: null })
    expect(parseCommand('/permissions plan')).toEqual({ kind: 'permission', value: 'plan' })
    expect(parseCommand('/perm acceptEdits')).toEqual({ kind: 'permission', value: 'acceptEdits' })
  })

  it('strips a Telegram @botname suffix after the command word', () => {
    expect(parseCommand('/status@my_bot')).toEqual({ kind: 'status' })
    expect(parseCommand('/stop@my_bot')).toEqual({ kind: 'stop' })
    expect(parseCommand('/resume@my_bot')).toEqual({ kind: 'resume' })
    expect(parseCommand('/fast@my_bot on')).toEqual({ kind: 'fast', enable: true })
    expect(parseCommand('/models@my_bot opus')).toEqual({ kind: 'model', value: 'opus' })
    // the @botname is not folded into the queue payload
    expect(parseCommand('/queue@my_bot ship it')).toEqual({ kind: 'queue', text: 'ship it' })
  })

  it('parses !queue with its payload', () => {
    expect(parseCommand('!queue deploy the build')).toEqual({ kind: 'queue', text: 'deploy the build' })
  })

  it('is case-insensitive on the command word', () => {
    expect(parseCommand('!STOP')).toEqual({ kind: 'stop' })
    expect(parseCommand('!Queue Run it')).toEqual({ kind: 'queue', text: 'Run it' })
  })

  it('tolerates leading whitespace and trims the queue payload', () => {
    expect(parseCommand('   !stop')).toEqual({ kind: 'stop' })
    expect(parseCommand('!queue   spaced   ')).toEqual({ kind: 'queue', text: 'spaced' })
  })

  it('returns an empty payload for a bare !queue', () => {
    expect(parseCommand('!queue')).toEqual({ kind: 'queue', text: '' })
    expect(parseCommand('!queue   ')).toEqual({ kind: 'queue', text: '' })
  })

  it('treats ordinary text as non-commands', () => {
    expect(parseCommand('hello!')).toBeNull()
    expect(parseCommand('please stop the agent')).toBeNull()
    expect(parseCommand('')).toBeNull()
  })

  it('requires the command word immediately after the prefix', () => {
    expect(parseCommand('! stop')).toBeNull() // space after prefix
    expect(parseCommand('!stopnow')).toBeNull() // unknown word, not a prefix match
    expect(parseCommand('!deploy')).toBeNull() // unknown command
  })
})
