// The standing collaboration guidance teaches self-delegation to assistant-mode agents only (assistant-mode.md §5.6).
import { describe, expect, it } from 'vitest'
import { buildCollabAppend, buildStandingContext } from '../src/session/turn/standing-context.js'

const BASE = {
  agentName: 'bot-a',
  agentId: 'bot-a',
  platform: 'slack',
  channel: 'C1',
  thread: '100.1',
  envSecretNames: [],
  fileSecrets: [],
  needsReplyToParent: false,
  memoryIndex: '',
  usesMeta: true
}

const NO_DIRECT_SELF = 'A direct `toAgent` call without `channel` may not target yourself. '

describe('standing collaboration guidance', () => {
  it('is the same for every other agent, in the fresh-session and the resume context', () => {
    const plain = buildStandingContext(BASE)
    expect(buildStandingContext({ ...BASE, assistantMode: false })).toEqual(plain)
    expect(plain.collabAppend).toBe(buildCollabAppend(false))
    expect(plain.collabAppend).toContain(
      `never your platform bot identity. ${NO_DIRECT_SELF}To speak in the conversation you are already in`
    )
    expect(plain.collabAppend).not.toMatch(/sub-session/i)
  })

  it('tells an assistant-mode agent that its direct self-call opens a sub-session, wherever it is read', () => {
    const assistant = buildStandingContext({ ...BASE, assistantMode: true })
    const plain = buildStandingContext(BASE)
    expect(assistant.collabAppend).toBe(buildCollabAppend(true))
    expect(assistant.collabAppend).not.toContain(NO_DIRECT_SELF)
    expect(assistant.collabAppend).toContain(
      'A direct `toAgent` call to yourself without `channel` opens a background SUB-SESSION for long work ' +
        '("fix this bug and open a PR")'
    )
    expect(assistant.collabAppend).toContain('reports back into this conversation when it finishes or fails')
    expect(assistant.collabAppend).toContain('A sub-session cannot open sub-sessions of its own.')
    for (const text of [assistant.resumeSystemContext, assistant.sessionContext, assistant.metaContext!]) {
      expect(text).toContain(assistant.collabAppend)
      expect(text).not.toContain(NO_DIRECT_SELF)
    }
    // Only the self-call sentence differs.
    expect(
      assistant.collabAppend.replace(/A direct `toAgent` call to yourself[^]*?of its own\. /, NO_DIRECT_SELF)
    ).toBe(plain.collabAppend)
  })
})
