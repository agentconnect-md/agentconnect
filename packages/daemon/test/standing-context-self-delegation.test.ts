// The standing collaboration guidance teaches background tasks to every agent (send-message-guide.md §2.1).
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
  it('tells every agent that startTask starts a task of this session, wherever it is read', () => {
    const context = buildStandingContext(BASE)
    expect(context.collabAppend).toBe(COLLAB_APPEND)
    expect(context.collabAppend).not.toContain('may not target yourself')
    expect(context.collabAppend).not.toMatch(/sub-session|messageSubsession|childSessionId>/i)
    expect(context.collabAppend).toContain(
      'a session of that conversation, not a task: use your own ID from the # Agent block (also included by ' +
        '`listAgents`), never your platform bot identity. For long work of your own ("fix this bug and open a PR"), ' +
        '`{"action":"startTask","message":"..."}` starts a background TASK of this session'
    )
    expect(context.collabAppend).toContain(
      'reports back into this session each time a round of its work finishes or fails'
    )
    expect(context.collabAppend).toContain(
      "Start it before you explore or begin the work yourself — it starts from this session's context and finds " +
        'what it needs — then say it has started and end your turn. Start independent tasks together; start a task ' +
        "that needs another's result once that result has arrived. To give one more work later, even after it " +
        'reported, send `{"action":"messageTask","taskId":"<its taskId>","message":"..."}`: it keeps its context and ' +
        'reports again. When a task is no longer needed — the plan changed, or a task it depended on failed — stop ' +
        'it with `stopTask` and its taskId. Say in its message which language the people here use'
    )
    expect(context.collabAppend).toContain(
      'A task cannot start tasks of its own. To speak in the conversation you are already in'
    )
    for (const text of [context.resumeSystemContext, context.sessionContext, context.metaContext!])
      expect(text).toContain(context.collabAppend)
  })
})
