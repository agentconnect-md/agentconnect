// The `/help` reply and the welcome (google-chat-integration.md §11.4): the command list must match the daemon's grammar.
import { describe, expect, it } from 'vitest'
import * as grammar from '@agentconnect.md/activation-policy'
import { GOOGLE_CHAT_COMMAND_HELP, googleChatHelp, googleChatHelpText, googleChatWelcomeText } from './help.js'

// Every `!word` the help text names.
const namedWords = (text: string): string[] => [...text.matchAll(/!([A-Za-z]+)/g)].map((m) => m[1]!)

// Every word the grammar accepts, from its exported `*_WORDS` sets.
const grammarWords = (): string[] =>
  Object.entries(grammar)
    .filter(([name, value]) => name.endsWith('_WORDS') && value instanceof Set)
    .flatMap(([, value]) => [...(value as ReadonlySet<string>)])

describe('Google Chat /help', () => {
  it('names only commands the grammar parses, each as the kind it is listed under', () => {
    const text = googleChatHelpText()
    const words = namedWords(text)
    expect(words.length).toBeGreaterThan(0)
    for (const word of words) expect(grammar.parseCommand(`!${word}`), word).not.toBeNull()
    for (const [kind, { usage }] of Object.entries(GOOGLE_CHAT_COMMAND_HELP)) {
      expect(grammar.parseCommand(usage)?.kind, usage).toBe(kind)
      expect(text).toContain(usage)
    }
  })

  it('lists every command the grammar accepts', () => {
    const listed = new Set(Object.keys(GOOGLE_CHAT_COMMAND_HELP))
    const words = grammarWords()
    expect(words.length).toBeGreaterThan(0)
    for (const word of words) {
      const kind = grammar.parseCommand(`!${word}`)?.kind
      expect(kind, word).toBeDefined()
      expect(listed.has(kind!), `${word} → ${kind}`).toBe(true)
    }
  })

  it('tells an unclaimed tenant to connect first, and otherwise only how to use the app', () => {
    expect(googleChatHelpText({ unclaimed: true })).toContain('your organization needs to connect this app')
    expect(googleChatHelpText()).not.toContain('connect this app')
    expect(googleChatHelpText()).toContain('/help')
    expect(googleChatHelp()).toEqual({
      hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: googleChatHelpText() } } } }
    })
  })

  it('welcomes a DM and a space with how to reach the app and that /help lists the commands', () => {
    for (const isDm of [true, false]) {
      const text = googleChatWelcomeText(isDm)
      expect(text).toContain('AI agent powered by AgentConnect')
      expect(text).toContain('@mention me')
      expect(text).toContain('/help')
    }
    expect(googleChatWelcomeText(true)).toContain('Send me a message here')
    expect(googleChatWelcomeText(false)).toContain('in this space')
  })
})
