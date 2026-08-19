import { describe, expect, it } from 'vitest'
import { codexAuthPinsAnotherKey } from '../src/runtimes/codex-config.js'

describe('codexAuthPinsAnotherKey', () => {
  it('flags a file minted from a different injected key', () => {
    expect(codexAuthPinsAnotherKey(JSON.stringify({ OPENAI_API_KEY: 'sk-old', tokens: null }), 'sk-new')).toBe(true)
  })

  it('accepts a file that already carries the launch key', () => {
    expect(codexAuthPinsAnotherKey(JSON.stringify({ OPENAI_API_KEY: 'sk-now', tokens: null }), 'sk-now')).toBe(false)
  })

  it('never flags a human ChatGPT login, whatever key rides beside the tokens', () => {
    const chatgpt = JSON.stringify({ OPENAI_API_KEY: 'sk-derived', tokens: { id_token: 'x' } })
    expect(codexAuthPinsAnotherKey(chatgpt, 'sk-injected')).toBe(false)
  })

  it('leaves a keyless account shape alone rather than guessing', () => {
    expect(codexAuthPinsAnotherKey(JSON.stringify({ OPENAI_API_KEY: null, tokens: null }), 'sk-now')).toBe(false)
  })

  it('flags an unparseable file — replacing it is the only recovery', () => {
    expect(codexAuthPinsAnotherKey('not json', 'sk-now')).toBe(true)
    expect(codexAuthPinsAnotherKey('[1,2]', 'sk-now')).toBe(true)
  })
})
