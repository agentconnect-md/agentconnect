// The standing collaboration guidance teaches self-delegation to every agent (assistant-mode.md §5.6).
import { describe, expect, it } from 'vitest'
import { buildStandingContext, COLLAB_APPEND } from '../src/session/turn/standing-context.js'

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

describe('standing collaboration guidance', () => {
  it('tells every agent that messageSubsession opens a sub-session, wherever it is read', () => {
    const context = buildStandingContext(BASE)
    expect(context.collabAppend).toBe(COLLAB_APPEND)
    expect(context.collabAppend).not.toContain('may not target yourself')
    expect(context.collabAppend).toContain(
      'never your platform bot identity. For long work of your own ("fix this bug and open a PR"), ' +
        '`{"action":"messageSubsession","message":"..."}` opens a background SUB-SESSION'
    )
    expect(context.collabAppend).toContain('reports back into this conversation when it finishes or fails')
    expect(context.collabAppend).toContain(
      'so say it has started and end your turn. Say in its task which language the people here use, so it reports ' +
        'in that language, and answer them in it whatever language a report comes back in. Keep ordinary conversation'
    )
    expect(context.collabAppend).toContain(
      'A sub-session cannot open sub-sessions of its own. To speak in the conversation you are already in'
    )
    for (const text of [context.resumeSystemContext, context.sessionContext, context.metaContext!])
      expect(text).toContain(context.collabAppend)
  })
})
