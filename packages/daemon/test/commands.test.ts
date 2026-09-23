import { describe, it, expect } from 'vitest'
import { isControlCommandText, parseCommand, queuePromptText, requiresTrustedActor } from '../src/commands/commands.js'

// One predicate, asked by every ingress path that parses a command. The failure it exists to
// prevent is a gate applied on direct ingress but not on relay — which is where the HTTP
// callbacks that can carry no actor at all arrive.
describe('requiresTrustedActor', () => {
  it('covers the commands that cannot be undone or that reset a safety latch', () => {
    expect(requiresTrustedActor('new')).toBe(true)
    expect(requiresTrustedActor('resume')).toBe(true)
  })

  it('leaves the reversible and read-only ones open', () => {
    for (const kind of ['stop', 'cancel', 'queue', 'status', 'fast', 'model', 'effort', 'permission'] as const)
      expect(requiresTrustedActor(kind)).toBe(false)
  })
})

describe('parseCommand', () => {
  it('parses !stop, !cancel, and !resume as distinct commands', () => {
    expect(parseCommand('!stop')).toEqual({ kind: 'stop' })
    expect(parseCommand('!new')).toEqual({ kind: 'new' })
    expect(parseCommand('/new')).toEqual({ kind: 'new' })
    // Telegram group addressing, and the word must not match a prefix of ordinary text.
    expect(parseCommand('/new@mybot')).toEqual({ kind: 'new' })
    expect(parseCommand('!newsletter')).toBeNull()
    expect(parseCommand('new session please')).toBeNull()
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

// message-intake.md §5 step 2: the row keeps the command as typed; the prompt is the stripped text.
describe('queuePromptText', () => {
  it('strips an admitted !queue prefix, in either prefix and with Telegram group addressing', () => {
    expect(queuePromptText('!queue hello')).toBe('hello')
    expect(queuePromptText('/queue@mybot hello')).toBe('hello')
  })

  it('keeps the attachment mention the row carries', () => {
    expect(queuePromptText('!queue hello\n[attached: a.png (image/png)]')).toBe('hello\n[attached: a.png (image/png)]')
  })

  it('leaves everything that is not an admitted !queue alone', () => {
    // A bare `!queue` draws a usage reply and is never admitted — blanking it would empty its row.
    expect(queuePromptText('!queue')).toBe('!queue')
    expect(queuePromptText('!stop')).toBe('!stop')
    expect(queuePromptText('remember to !queue the deploy')).toBe('remember to !queue the deploy')
  })
})

// The read-side twin of the strip: a recorded control is never session context (§5 step 2).
describe('isControlCommandText', () => {
  it('names every control but `!queue`, whose row IS admitted', () => {
    expect(isControlCommandText('!stop')).toBe(true)
    expect(isControlCommandText('/status@mybot')).toBe(true)
    expect(isControlCommandText('!queue hello')).toBe(false)
    expect(isControlCommandText('hello!')).toBe(false)
    expect(isControlCommandText('!deploy the thing')).toBe(false)
  })
})

describe('command grammar ownership', () => {
  it('re-exports the activation-policy parser so the relay and the daemon agree', async () => {
    const policy = await import('@agentconnect.md/activation-policy')
    expect(parseCommand).toBe(policy.parseCommand)
  })
})
