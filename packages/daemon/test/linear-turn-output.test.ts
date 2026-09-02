import { describe, it, expect } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import {
  applyLinearAction,
  type LinearAttachmentInput,
  codeHostLinks,
  createLinearConverger,
  initialLinearTurnState,
  LinearConverger,
  linearModePolicy,
  summarizeToolInput,
  EMPTY_RESPONSE_BODY,
  MAX_ACTION_RESULT,
  MAX_REASONING,
  MAX_TURN_ACTIONS,
  PERMISSION_APPROVED_BODY,
  PERMISSION_DENIED_BODY,
  PERMISSION_ELICITATION_BODY,
  type LinearAction,
  type LinearActivityInput,
  type LinearAttribution,
  type LinearOutputMode,
  type LinearSessionUpdateInput
} from '../src/platforms/linear/turn-output.js'

const update = (u: Record<string, unknown>): SessionUpdate => u as unknown as SessionUpdate
const chunk = (text: string, meta?: Record<string, unknown>): SessionUpdate =>
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...(meta ?? {}) })
const thought = (text: string): SessionUpdate =>
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } })
const toolCall = (o: Record<string, unknown>): SessionUpdate => update({ sessionUpdate: 'tool_call', ...o })
const toolDone = (o: Record<string, unknown>): SessionUpdate =>
  update({ sessionUpdate: 'tool_call_update', status: 'completed', ...o })
const plan = (entries: { content: string; status: string }[]): SessionUpdate =>
  update({ sessionUpdate: 'plan', entries })
const output = (text: string) => [{ type: 'content', content: { type: 'text', text } }]

const conv = (mode: LinearOutputMode, showFooter = false) => new LinearConverger(mode, showFooter)
const SESSION_URL = 'https://console.example.test/s/abc'
const elicitationBody = (actions: LinearAction[]) => {
  const found = actions.find((a) => a.kind === 'activity' && a.type === 'elicitation')
  return found && found.kind === 'activity' && found.type === 'elicitation' ? found.body : undefined
}
const types = (actions: LinearAction[]) => actions.map((a) => (a.kind === 'activity' ? a.type : a.kind))
const responseBody = (actions: LinearAction[]) => {
  const found = actions.find((a) => a.kind === 'activity' && a.type === 'response')
  return found && found.kind === 'activity' && found.type === 'response' ? found.body : undefined
}

describe('LinearConverger — §5.1 event translation', () => {
  it('turns reasoning chunks into ONE ephemeral thought per idle window', () => {
    const c = conv('medium')
    expect(c.onUpdate(thought('weighing '))).toEqual([])
    expect(c.onUpdate(thought('the options'))).toEqual([])
    expect(c.hasBuffered()).toBe(true)
    expect(c.flushBuffered()).toEqual([
      { kind: 'activity', type: 'thought', body: 'weighing the options', ephemeral: true }
    ])
    expect(c.hasBuffered()).toBe(false)
    expect(c.flushBuffered()).toEqual([])
  })

  it('tail-clamps a long reasoning buffer', () => {
    const c = conv('high')
    c.onUpdate(thought('x'.repeat(MAX_REASONING * 3)))
    const [action] = c.flushBuffered()
    expect(action).toBeDefined()
    if (action?.kind !== 'activity' || action.type !== 'thought') throw new Error('expected a thought')
    expect(action.body.startsWith('…')).toBe(true)
    expect(action.body.length).toBe(MAX_REASONING + 1)
  })

  it('emits only the delta since the last flush, so consecutive windows never overlap', () => {
    const c = conv('medium')
    c.onUpdate(thought('first window '))
    c.onUpdate(thought('of thinking'))
    expect(c.flushBuffered()).toEqual([
      { kind: 'activity', type: 'thought', body: 'first window of thinking', ephemeral: true }
    ])
    // Nothing new arrived, so the window that follows costs no activity at all.
    expect(c.hasBuffered()).toBe(false)
    expect(c.flushBuffered()).toEqual([])
    c.onUpdate(thought('second window'))
    const second = c.flushBuffered()
    expect(second).toEqual([{ kind: 'activity', type: 'thought', body: 'second window', ephemeral: true }])
    const body = second[0]?.kind === 'activity' && second[0].type === 'thought' ? second[0].body : ''
    expect(body).not.toContain('first window')
  })

  it('turns intermediate message text into a NON-ephemeral thought at a tool boundary', () => {
    const c = conv('low')
    expect(c.onUpdate(chunk('reading the failing test'))).toEqual([])
    expect(c.onUpdate(toolCall({ toolCallId: 't1', title: 'Read', status: 'pending' }))).toEqual([
      { kind: 'activity', type: 'thought', body: 'reading the failing test' }
    ])
  })

  it('emits an action ONCE at terminal status: action = title, parameter = input summary', () => {
    const c = conv('low')
    expect(c.onUpdate(toolCall({ toolCallId: 't1', title: 'Bash', rawInput: { command: 'pnpm test' } }))).toEqual([])
    expect(c.onUpdate(toolDone({ toolCallId: 't1', content: output('42 passed') }))).toEqual([])
    expect(c.flushBuffered()).toEqual([{ kind: 'activity', type: 'action', action: 'Bash', parameter: 'pnpm test' }])
  })

  it('carries a head-clamped result only in high mode', () => {
    const long = 'y'.repeat(MAX_ACTION_RESULT + 500)
    const high = conv('high')
    high.onUpdate(toolCall({ toolCallId: 't1', title: 'Bash', rawInput: { command: 'cat big' } }))
    high.onUpdate(toolDone({ toolCallId: 't1', content: output(long) }))
    const [action] = high.flushBuffered()
    if (action?.kind !== 'activity' || action.type !== 'action') throw new Error('expected an action')
    expect(action.result).toBe(`${'y'.repeat(MAX_ACTION_RESULT)}\n…`)

    const medium = conv('medium')
    medium.onUpdate(toolCall({ toolCallId: 't1', title: 'Bash', rawInput: { command: 'cat big' } }))
    medium.onUpdate(toolDone({ toolCallId: 't1', content: output(long) }))
    expect(medium.flushBuffered()).toEqual([{ kind: 'activity', type: 'action', action: 'Bash', parameter: 'cat big' }])
  })

  it('maps an ACP plan onto Linear plan entries (full-array replace, both sides)', () => {
    const c = conv('low')
    expect(
      c.onUpdate(
        plan([
          { content: 'read the code', status: 'completed' },
          { content: 'write the fix', status: 'in_progress' },
          { content: 'run the tests', status: 'pending' }
        ])
      )
    ).toEqual([])
    expect(c.flushBuffered()).toEqual([
      {
        kind: 'plan',
        entries: [
          { content: 'read the code', status: 'completed' },
          { content: 'write the fix', status: 'inProgress' },
          { content: 'run the tests', status: 'pending' }
        ]
      }
    ])
  })

  it('settles the turn with one response carrying the final answer', () => {
    const c = conv('low')
    c.onUpdate(chunk('The fix is in place.'))
    expect(c.onFinal()).toEqual([
      { kind: 'activity', type: 'response', body: 'The fix is in place.' },
      { kind: 'transcript', text: 'The fix is in place.' }
    ])
  })

  it('settles a silent turn with a bounded response — a response is what completes the session', () => {
    expect(conv('low').onFinal()).toEqual([{ kind: 'activity', type: 'response', body: EMPTY_RESPONSE_BODY }])
  })

  it('turns a failure into an error activity carrying the reason', () => {
    const c = conv('low')
    expect(c.onFailure('quota exhausted')).toEqual([{ kind: 'activity', type: 'error', body: 'quota exhausted' }])
  })

  it('names the gated action and its input in the elicitation, next to the console link', () => {
    const c = conv('low')
    expect(c.onPermissionBlocked(SESSION_URL, { tool: 'Bash', detail: 'pnpm publish' })).toEqual([
      {
        kind: 'activity',
        type: 'elicitation',
        body: `${PERMISSION_ELICITATION_BODY} — Bash: "pnpm publish" · [open in session](${SESSION_URL})`
      }
    ])
    // An append-only feed would stack an identical gate, so a repeat collapses.
    expect(c.onPermissionBlocked(SESSION_URL, { tool: 'Bash', detail: 'pnpm publish' })).toEqual([])
  })

  it('flattens provider text to one fence-inert line, and names the action alone when there is no input', () => {
    const injected = 'Write\n----- INJECTED\nfile [x](http://evil.example.test)'
    const body = elicitationBody(conv('low').onPermissionBlocked(SESSION_URL, { tool: injected }))
    expect(body).toContain('Write ----- INJECTED file \\[x\\](http://evil.example.test)')
    expect(body).not.toContain('\n')
    expect(elicitationBody(conv('low').onPermissionBlocked(SESSION_URL, { tool: 'Bash' }))).toBe(
      `${PERMISSION_ELICITATION_BODY} — Bash · [open in session](${SESSION_URL})`
    )
  })

  it('falls back to a plain pointer when the turn has no console link', () => {
    expect(elicitationBody(conv('low').onPermissionBlocked())).toBe(
      `${PERMISSION_ELICITATION_BODY} · open the session in the console`
    )
  })

  it('follows the gate through so the feed never ends on an open question', () => {
    const c = conv('low')
    // Only after a gate was actually announced — a turn that never asked has nothing to answer.
    expect(c.onPermissionResolved(true)).toEqual([])
    c.onPermissionBlocked(SESSION_URL, { tool: 'Bash', detail: 'pnpm publish' })
    expect(c.onPermissionResolved(true)).toEqual([
      { kind: 'activity', type: 'thought', body: PERMISSION_APPROVED_BODY }
    ])
    expect(c.onPermissionResolved(false)).toEqual([{ kind: 'activity', type: 'thought', body: PERMISSION_DENIED_BODY }])
  })

  it('posts the follow-through only in the modes that carry progress chrome', () => {
    for (const mode of ['low', 'medium', 'high'] as const) {
      const c = conv(mode)
      c.onPermissionBlocked(SESSION_URL, { tool: 'Bash' })
      expect(types(c.onPermissionResolved(true))).toEqual(['thought'])
    }
    // `minimal` posts the response only, and `none` is silent even about the gate itself.
    const minimal = conv('minimal')
    expect(types(minimal.onPermissionBlocked(SESSION_URL, { tool: 'Bash' }))).toEqual(['elicitation'])
    expect(minimal.onPermissionResolved(true)).toEqual([])
    const none = conv('none')
    expect(none.onPermissionBlocked(SESSION_URL, { tool: 'Bash' })).toEqual([])
    expect(none.onPermissionResolved(true)).toEqual([])
  })

  it('emits nothing for a session title update — Linear names its own sessions', () => {
    const c = conv('high')
    expect(c.onUpdate(update({ sessionUpdate: 'session_info_update', title: 'Fix the flake' }))).toEqual([])
    expect(c.hasBuffered()).toBe(false)
  })
})

describe('LinearConverger — §5.2 output modes', () => {
  const script = (c: LinearConverger): LinearAction[] => {
    const out: LinearAction[] = []
    out.push(...c.onUpdate(thought('weighing it')))
    out.push(...c.onUpdate(chunk('reading the test')))
    out.push(...c.onUpdate(toolCall({ toolCallId: 't1', title: 'Bash', rawInput: { command: 'pnpm test' } })))
    out.push(...c.onUpdate(toolDone({ toolCallId: 't1', content: output('42 passed') })))
    out.push(...c.onUpdate(plan([{ content: 'ship it', status: 'in_progress' }])))
    out.push(...c.flushBuffered())
    out.push(...c.onUpdate(chunk('Fixed the flake.')))
    out.push(...c.onFinal())
    return out
  }

  it('none is truly silent on the feed — the answer still reaches the transcript, nothing else does', () => {
    expect(script(conv('none'))).toEqual([{ kind: 'transcript', text: 'Fixed the flake.' }])
  })

  it('minimal posts the response only', () => {
    expect(types(script(conv('minimal')))).toEqual(['response', 'transcript'])
  })

  it('low — the default — already includes progress thoughts, actions and plan', () => {
    expect(types(script(conv('low')))).toEqual(['thought', 'action', 'plan', 'response', 'transcript'])
  })

  it('medium adds the ephemeral reasoning thought', () => {
    expect(types(script(conv('medium')))).toEqual(['thought', 'action', 'thought', 'plan', 'response', 'transcript'])
  })

  it('high adds tool results to the action row', () => {
    const actions = script(conv('high'))
    const action = actions.find((a) => a.kind === 'activity' && a.type === 'action')
    if (action?.kind !== 'activity' || action.type !== 'action') throw new Error('expected an action')
    expect(action.result).toBe('42 passed')
  })

  it('publishes the mode matrix as data, so every switch reads the same row', () => {
    expect(linearModePolicy('none')).toEqual({
      reasoning: false,
      progress: false,
      actions: false,
      actionResults: false,
      plan: false,
      links: false,
      response: false
    })
    expect(linearModePolicy('low').actions).toBe(true)
    expect(linearModePolicy('low').plan).toBe(true)
    expect(linearModePolicy('low').links).toBe(true)
    expect(linearModePolicy('minimal').links).toBe(false)
    expect(linearModePolicy('low').reasoning).toBe(false)
    expect(linearModePolicy('medium').reasoning).toBe(true)
    expect(linearModePolicy('high').actionResults).toBe(true)
  })
})

describe('LinearConverger — coalescing', () => {
  it('collapses consecutive same-title calls into one row with a count', () => {
    const c = conv('low')
    for (const [id, command] of [
      ['t1', 'ls'],
      ['t2', 'pwd'],
      ['t3', 'whoami']
    ]) {
      c.onUpdate(toolCall({ toolCallId: id, title: 'Bash', rawInput: { command } }))
      c.onUpdate(toolDone({ toolCallId: id }))
    }
    expect(c.flushBuffered()).toEqual([
      { kind: 'activity', type: 'action', action: 'Bash ×3', parameter: 'ls pwd whoami' }
    ])
  })

  it('stops collapsing when a different title, or narration, separates the run', () => {
    const c = conv('low')
    c.onUpdate(toolCall({ toolCallId: 't1', title: 'Bash', rawInput: { command: 'ls' } }))
    c.onUpdate(toolDone({ toolCallId: 't1' }))
    c.onUpdate(toolCall({ toolCallId: 't2', title: 'Read', rawInput: { path: 'a.ts' } }))
    const released = c.onUpdate(toolDone({ toolCallId: 't2' }))
    expect(released).toEqual([{ kind: 'activity', type: 'action', action: 'Bash', parameter: 'ls' }])
    // Narration between two same-title calls separates them in the feed too.
    c.onUpdate(chunk('now checking the config'))
    const boundary = c.onUpdate(toolCall({ toolCallId: 't3', title: 'Read', rawInput: { path: 'b.ts' } }))
    expect(boundary).toEqual([
      { kind: 'activity', type: 'action', action: 'Read', parameter: 'a.ts' },
      { kind: 'activity', type: 'thought', body: 'now checking the config' }
    ])
  })

  it('caps actions per turn and reports the overflow once as a closing thought', () => {
    const c = conv('low')
    const calls = MAX_TURN_ACTIONS + 5
    const emitted: LinearAction[] = []
    for (let i = 0; i < calls; i++) {
      emitted.push(...c.onUpdate(toolCall({ toolCallId: `t${i}`, title: `Tool${i}`, rawInput: { path: `f${i}` } })))
      emitted.push(...c.onUpdate(toolDone({ toolCallId: `t${i}` })))
    }
    expect(emitted.filter((a) => a.kind === 'activity' && a.type === 'action')).toHaveLength(MAX_TURN_ACTIONS)
    expect(types(c.onFinal())).toEqual(['thought', 'response'])
    const overflow = c.onFinal()
    expect(overflow).toEqual([])
  })

  it('names the exact overflow count in the closing thought', () => {
    const c = conv('low')
    const calls = MAX_TURN_ACTIONS + 5
    for (let i = 0; i < calls; i++) {
      c.onUpdate(toolCall({ toolCallId: `t${i}`, title: `Tool${i}` }))
      c.onUpdate(toolDone({ toolCallId: `t${i}` }))
    }
    expect(c.onFinal()[0]).toEqual({
      kind: 'activity',
      type: 'thought',
      body: `… and ${calls - MAX_TURN_ACTIONS} more tool calls`
    })
  })

  it('debounces the plan last-write-wins, and never repeats an unchanged one', () => {
    const c = conv('low')
    c.onUpdate(plan([{ content: 'ship it', status: 'pending' }]))
    c.onUpdate(plan([{ content: 'ship it', status: 'in_progress' }]))
    expect(c.flushBuffered()).toEqual([{ kind: 'plan', entries: [{ content: 'ship it', status: 'inProgress' }] }])
    c.onUpdate(plan([{ content: 'ship it', status: 'in_progress' }]))
    expect(c.flushBuffered()).toEqual([])
    c.onUpdate(plan([{ content: 'ship it', status: 'completed' }]))
    expect(c.flushBuffered()).toEqual([{ kind: 'plan', entries: [{ content: 'ship it', status: 'completed' }] }])
  })

  it('holds narration on the idle timer unless a tool call is in flight', () => {
    const quiet = conv('low')
    quiet.onUpdate(chunk('this is the answer.\n\n'))
    // Nothing is in flight, so this text may still be the closing answer: the response owns it.
    expect(quiet.hasBuffered()).toBe(false)
    expect(quiet.flushBuffered()).toEqual([])
    expect(responseBody(quiet.onFinal())).toBe('this is the answer.')

    const working = conv('low')
    working.onUpdate(toolCall({ toolCallId: 't1', title: 'Bash', status: 'pending' }))
    working.onUpdate(chunk('still grinding.\n\ntail'))
    expect(working.hasBuffered()).toBe(true)
    expect(working.flushBuffered()).toEqual([{ kind: 'activity', type: 'thought', body: 'still grinding.' }])
  })
})

describe('LinearConverger — terminal-only actions', () => {
  it('emits nothing for a start-status tool call, and nothing again for a repeat terminal', () => {
    const c = conv('high')
    expect(c.onUpdate(toolCall({ toolCallId: 't1', title: 'Bash', status: 'pending' }))).toEqual([])
    expect(c.onUpdate(update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' }))).toEqual(
      []
    )
    expect(c.onUpdate(toolDone({ toolCallId: 't1', content: output('done') }))).toEqual([])
    expect(c.onUpdate(toolDone({ toolCallId: 't1', content: output('done again') }))).toEqual([])
    expect(c.flushBuffered()).toEqual([
      { kind: 'activity', type: 'action', action: 'Bash', parameter: '', result: 'done' }
    ])
  })

  it('emits an action for a failed call too — terminal is terminal', () => {
    const c = conv('low')
    c.onUpdate(toolCall({ toolCallId: 't1', title: 'Bash', rawInput: { command: 'false' } }))
    c.onUpdate(update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' }))
    expect(c.flushBuffered()).toEqual([{ kind: 'activity', type: 'action', action: 'Bash', parameter: 'false' }])
  })
})

describe('LinearConverger — final answer, footer, failure ordering', () => {
  it('prefers the runtime explicit final phase over earlier commentary', () => {
    const c = conv('low')
    c.onUpdate(chunk('let me look', { messageId: 'm1', _meta: { codex: { phase: 'commentary' } } }))
    c.onUpdate(chunk('All green.', { messageId: 'm2', _meta: { codex: { phase: 'final_answer' } } }))
    expect(responseBody(c.onFinal())).toBe('All green.')
  })

  it('falls back to message grouping, then to the last text run', () => {
    const grouped = conv('low')
    grouped.onUpdate(chunk('thinking out loud', { messageId: 'm1', _meta: { codex: { phase: 'commentary' } } }))
    grouped.onUpdate(chunk('Here is the ', { messageId: 'm2' }))
    grouped.onUpdate(chunk('answer.', { messageId: 'm2' }))
    expect(responseBody(grouped.onFinal())).toBe('Here is the answer.')

    const runs = conv('low')
    runs.onUpdate(chunk('first run'))
    runs.onUpdate(toolCall({ toolCallId: 't1', title: 'Bash' }))
    runs.onUpdate(chunk('second run'))
    expect(responseBody(runs.onFinal())).toBe('second run')
  })

  it('appends the attribution footer only when the turn shows chrome', () => {
    const attribution: LinearAttribution = {
      agentName: 'review-bot',
      agentUrl: 'https://console.example.test/agents/review-bot',
      runtime: 'claude',
      model: 'sonnet',
      sessionUrl: 'https://console.example.test/s/abc'
    }
    const shown = conv('low', true)
    shown.onUpdate(chunk('Looks good.'))
    expect(responseBody(shown.onFinal(attribution))).toBe(
      'Looks good.\n\nsent by [review-bot](https://console.example.test/agents/review-bot) (claude · sonnet) · ' +
        '[open in session](https://console.example.test/s/abc)'
    )

    const hidden = conv('low', false)
    hidden.onUpdate(chunk('Looks good.'))
    expect(responseBody(hidden.onFinal(attribution))).toBe('Looks good.')
  })

  it('closes an open code fence before the footer', () => {
    const shown = conv('low', true)
    shown.onUpdate(chunk('```ts\nconst a = 1'))
    const body = responseBody(
      shown.onFinal({
        agentName: 'review-bot',
        agentUrl: '',
        runtime: 'claude',
        model: 'sonnet',
        sessionUrl: ''
      })
    )
    expect(body).toBe('```ts\nconst a = 1\n```\n\nsent by review-bot (claude · sonnet)')
  })

  it('flushes the converger buffer before the error, dropping runtime narration that repeats it', () => {
    const duplicated = conv('low')
    duplicated.onUpdate(chunk('You have hit your usage limit.'))
    expect(duplicated.onFailure('You have hit your usage limit.')).toEqual([
      { kind: 'activity', type: 'error', body: 'You have hit your usage limit.' }
    ])

    const distinct = conv('low')
    distinct.onUpdate(chunk('halfway through the refactor'))
    expect(distinct.onFailure('connection reset')).toEqual([
      { kind: 'activity', type: 'thought', body: 'halfway through the refactor' },
      { kind: 'activity', type: 'error', body: 'connection reset' }
    ])
  })

  it('releases a held action ahead of the error, keeping feed order', () => {
    const c = conv('low')
    c.onUpdate(toolCall({ toolCallId: 't1', title: 'Bash', rawInput: { command: 'ls' } }))
    c.onUpdate(toolDone({ toolCallId: 't1' }))
    expect(types(c.onFailure('connection reset'))).toEqual(['action', 'error'])
  })

  it('settles once: nothing follows the response or the error', () => {
    const settled = conv('low')
    settled.onUpdate(chunk('done'))
    expect(types(settled.onFinal())).toEqual(['response', 'transcript'])
    expect(settled.onFinal()).toEqual([])
    expect(settled.onUpdate(chunk('late'))).toEqual([])
    expect(settled.flushBuffered()).toEqual([])
    expect(settled.onPermissionBlocked()).toEqual([])
    expect(settled.onPermissionResolved(true)).toEqual([])

    const failed = conv('low')
    expect(failed.onFailure('boom')).toHaveLength(1)
    expect(failed.onFinal()).toEqual([])
  })

  it('drains the whole buffer on an abnormal end, paragraph break or not', () => {
    const c = conv('low')
    c.onUpdate(chunk('no paragraph break here'))
    expect(c.flushTerminal()).toEqual([{ kind: 'activity', type: 'thought', body: 'no paragraph break here' }])
    expect(c.hasBuffered()).toBe(false)
  })
})

describe('LinearConverger — AC_NO_RESPONSE is ack-only', () => {
  it('emits nothing at all once the turn resolves to the sentinel', () => {
    for (const mode of ['minimal', 'low', 'medium', 'high'] as const) {
      const c = conv(mode)
      expect(c.onUpdate(chunk('AC_NO'))).toEqual([])
      expect(c.onUpdate(chunk('_RESPONSE'))).toEqual([])
      expect(c.flushBuffered()).toEqual([])
      expect(c.flushTerminal()).toEqual([])
      expect(c.onFinal()).toEqual([])
      expect(c.onFinal()).toEqual([])
    }
  })

  it('suppresses a non-compliant model that explains itself and then emits the sentinel', () => {
    const c = conv('low')
    c.onUpdate(chunk('This message is not for me.\nAC_NO_RESPONSE'))
    expect(c.onFinal()).toEqual([])
  })

  it('releases a body that merely starts like the sentinel', () => {
    const c = conv('low')
    c.onUpdate(chunk('AC_NO'))
    expect(c.flushTerminal()).toEqual([])
    c.onUpdate(chunk('T is a different acronym.'))
    expect(responseBody(c.onFinal())).toBe('AC_NOT is a different acronym.')
  })
})

describe('createLinearConverger', () => {
  it('reads the turn context, and falls back to the default mode for an unknown one', () => {
    const ctx = { isDm: false, showFooter: true, message: {} }
    expect(createLinearConverger({ ...ctx, mode: 'high' }).outputMode()).toBe('high')
    expect(createLinearConverger({ ...ctx, mode: 'nonsense' }).outputMode()).toBe('low')
  })
})

describe('summarizeToolInput', () => {
  it('prefers the well-known input keys, then falls back to scalar pairs', () => {
    expect(summarizeToolInput({ command: 'pnpm test', cwd: '/repo' })).toBe('pnpm test')
    expect(summarizeToolInput({ file_path: 'src/a.ts' })).toBe('src/a.ts')
    expect(summarizeToolInput({ limit: 20, recursive: true })).toBe('limit=20 recursive=true')
    expect(summarizeToolInput('a bare string')).toBe('a bare string')
    expect(summarizeToolInput(undefined)).toBe('')
    expect(summarizeToolInput([1, 2])).toBe('')
  })
})

class FakePort {
  readonly activities: { sessionId: string; activity: LinearActivityInput }[] = []
  readonly updates: { sessionId: string; update: LinearSessionUpdateInput }[] = []
  async postActivity(sessionId: string, activity: LinearActivityInput): Promise<void> {
    this.activities.push({ sessionId, activity })
  }
  async updateSession(sessionId: string, update: LinearSessionUpdateInput): Promise<void> {
    this.updates.push({ sessionId, update })
  }
  readonly attachments: LinearAttachmentInput[] = []
  async createIssueAttachment(input: LinearAttachmentInput): Promise<void> {
    this.attachments.push(input)
  }
}

const turnFor = (port: FakePort | undefined, thread: string | undefined) => ({
  conn: port,
  plan: { thread, platform: 'linear', agentId: 'a1', sessionKey: 'k1' }
})
const linearTurn = (port: FakePort) => turnFor(port, 'agent-session-uuid')

describe('applyLinearAction', () => {
  it('maps each activity kind onto one agentActivityCreate input', async () => {
    const port = new FakePort()
    const turn = linearTurn(port)
    const state = initialLinearTurnState()
    const actions: LinearAction[] = [
      { kind: 'activity', type: 'thought', body: 'thinking', ephemeral: true },
      { kind: 'activity', type: 'thought', body: 'progress' },
      { kind: 'activity', type: 'action', action: 'Bash ×2', parameter: 'ls', result: 'ok' },
      { kind: 'activity', type: 'elicitation', body: 'approve me' },
      { kind: 'activity', type: 'error', body: 'boom' },
      { kind: 'activity', type: 'response', body: 'done' }
    ]
    for (const action of actions) await applyLinearAction(turn, state, action)
    expect(port.activities.map((a) => a.activity)).toEqual([
      { type: 'thought', body: 'thinking', ephemeral: true },
      { type: 'thought', body: 'progress' },
      { type: 'action', action: 'Bash ×2', parameter: 'ls', result: 'ok' },
      { type: 'elicitation', body: 'approve me' },
      { type: 'error', body: 'boom' },
      { type: 'response', body: 'done' }
    ])
    expect(new Set(port.activities.map((a) => a.sessionId))).toEqual(new Set(['agent-session-uuid']))
  })

  it('sends plan and external URLs through agentSessionUpdate, skipping an unchanged plan', async () => {
    const port = new FakePort()
    const turn = linearTurn(port)
    const state = initialLinearTurnState()
    const entries = [{ content: 'ship it', status: 'inProgress' as const }]
    await applyLinearAction(turn, state, { kind: 'plan', entries })
    await applyLinearAction(turn, state, { kind: 'plan', entries: [...entries] })
    await applyLinearAction(turn, state, {
      kind: 'plan',
      entries: [{ content: 'ship it', status: 'completed' }]
    })
    await applyLinearAction(turn, state, {
      kind: 'external-urls',
      add: [{ label: 'PR #123', url: 'https://code.example.test/pr/123' }]
    })
    await applyLinearAction(turn, state, { kind: 'external-urls', add: [] })
    expect(port.updates.map((u) => u.update)).toEqual([
      { plan: [{ content: 'ship it', status: 'inProgress' }] },
      { plan: [{ content: 'ship it', status: 'completed' }] },
      { addedExternalUrls: [{ label: 'PR #123', url: 'https://code.example.test/pr/123' }] }
    ])
  })

  it('adds the issue resource through attachmentCreate without spending the activity budget', async () => {
    const port = new FakePort()
    const turn = linearTurn(port)
    const state = initialLinearTurnState()
    const before = state.activityBudget
    const input = {
      issueId: 'issue-uuid',
      url: 'https://console.example.test/sessions/s1',
      title: 'AgentConnect session'
    }
    await applyLinearAction(turn, state, { kind: 'attachment', input })
    expect(port.attachments).toEqual([input])
    expect(port.activities).toEqual([])
    expect(state.activityBudget).toBe(before)
  })

  it('enforces the per-turn activity budget as the hard egress backstop', async () => {
    const port = new FakePort()
    const turn = linearTurn(port)
    const state = { ...initialLinearTurnState(), activityBudget: 2 }
    for (let i = 0; i < 5; i++) {
      await applyLinearAction(turn, state, { kind: 'activity', type: 'thought', body: `n${i}` })
    }
    expect(port.activities).toHaveLength(2)
    expect(state.activityBudget).toBe(0)
  })

  it('still posts the settling response once the hard cap is exhausted, and nothing else', async () => {
    const port = new FakePort()
    const turn = linearTurn(port)
    const state = { ...initialLinearTurnState(), activityBudget: 0 }
    await applyLinearAction(turn, state, { kind: 'activity', type: 'thought', body: 'chrome' })
    await applyLinearAction(turn, state, { kind: 'activity', type: 'action', action: 'Bash', parameter: 'ls' })
    await applyLinearAction(turn, state, { kind: 'activity', type: 'elicitation', body: 'approve me' })
    await applyLinearAction(turn, state, { kind: 'activity', type: 'response', body: 'the answer' })
    expect(port.activities.map((a) => a.activity)).toEqual([{ type: 'response', body: 'the answer' }])
    // The settle draws nothing from the budget, so the cap can never be what drops it.
    expect(state.activityBudget).toBe(0)
  })

  it('still posts the settling error once the hard cap is exhausted', async () => {
    const port = new FakePort()
    const turn = linearTurn(port)
    const state = { ...initialLinearTurnState(), activityBudget: 0 }
    await applyLinearAction(turn, state, { kind: 'activity', type: 'thought', body: 'chrome' })
    await applyLinearAction(turn, state, { kind: 'activity', type: 'error', body: 'quota exhausted' })
    expect(port.activities.map((a) => a.activity)).toEqual([{ type: 'error', body: 'quota exhausted' }])
    expect(state.activityBudget).toBe(0)
  })

  it('no-ops on a headless turn or a session with no Linear coordinate', async () => {
    const port = new FakePort()
    const state = initialLinearTurnState()
    await applyLinearAction(turnFor(undefined, 'agent-session-uuid'), state, {
      kind: 'activity',
      type: 'response',
      body: 'x'
    })
    await applyLinearAction(turnFor(port, undefined), state, { kind: 'activity', type: 'response', body: 'x' })
    expect(port.activities).toEqual([])
    expect(state.activityBudget).toBe(initialLinearTurnState().activityBudget)
  })

  it('records the transcript action under the session coordinates, posting nothing to the feed', async () => {
    const port = new FakePort()
    const rows: { channel: string; thread: string; ts: string; sender: string; kind: string; text: string }[] = []
    const host = { appendTranscript: async (row: (typeof rows)[number]) => void rows.push(row), monotonicTs: () => '7' }
    const turn = {
      conn: port,
      plan: {
        thread: 'agent-session-uuid',
        platform: 'linear',
        agentId: 'a1',
        sessionKey: 'k1',
        transcriptChannel: 'team-1scope',
        statusThread: 'agent-session-uuid'
      }
    }
    const state = initialLinearTurnState()
    // The footer chrome rides the response `body`; the transcript row is the answer alone.
    await applyLinearAction(turn, state, { kind: 'activity', type: 'response', body: 'done\n\nsent by agent' }, host)
    await applyLinearAction(turn, state, { kind: 'transcript', text: 'done' }, host)
    expect(rows).toEqual([
      { channel: 'team-1scope', thread: 'agent-session-uuid', ts: '7', sender: 'a1', kind: 'text', text: 'done' }
    ])
    expect(port.activities.map((a) => a.activity)).toEqual([{ type: 'response', body: 'done\n\nsent by agent' }])
    expect(state.activityBudget).toBe(initialLinearTurnState().activityBudget)
  })

  it('records the transcript with no Linear port at all — the transcript is core’s, not the feed’s', async () => {
    const rows: unknown[] = []
    const host = { appendTranscript: async (row: unknown) => void rows.push(row), monotonicTs: () => '7' }
    const turn = {
      plan: {
        platform: 'linear',
        agentId: 'a1',
        sessionKey: 'k1',
        transcriptChannel: 'team-1scope',
        statusThread: 'agent-session-uuid'
      }
    }
    await applyLinearAction(turn, initialLinearTurnState(), { kind: 'transcript', text: 'done' }, host)
    expect(rows).toEqual([
      { channel: 'team-1scope', thread: 'agent-session-uuid', ts: '7', sender: 'a1', kind: 'text', text: 'done' }
    ])
  })

  it('records nothing when the turn carries no transcript coordinates or no host', async () => {
    const port = new FakePort()
    const rows: unknown[] = []
    const host = { appendTranscript: async (row: unknown) => void rows.push(row), monotonicTs: () => '7' }
    await applyLinearAction(linearTurn(port), initialLinearTurnState(), { kind: 'transcript', text: 'done' }, host)
    await applyLinearAction(linearTurn(port), initialLinearTurnState(), { kind: 'transcript', text: 'done' })
    expect(rows).toEqual([])
    expect(port.activities).toEqual([])
  })
})

describe('LinearConverger — §10.3 code-host links', () => {
  it('labels GitHub pull requests and GitLab merge requests the way their hosts do, each URL once', () => {
    const text =
      'Opened https://github.com/example-org/example-repo/pull/123 and https://github.com/example-org/example-repo/pull/123. ' +
      'Also https://gitlab.example.test/group/sub/project/-/merge_requests/45, plus an issue ' +
      'https://github.com/example-org/example-repo/issues/9 that is not a PR.'
    expect(codeHostLinks(text)).toEqual([
      { label: 'PR #123', url: 'https://github.com/example-org/example-repo/pull/123' },
      { label: 'MR !45', url: 'https://gitlab.example.test/group/sub/project/-/merge_requests/45' }
    ])
  })

  it('publishes the links named anywhere in the turn’s text, ahead of the settling response', () => {
    const c = conv('low')
    // Chunk boundaries split the URL; the collector reads the joined text, not the pieces.
    c.onUpdate(chunk('Working on it — see https://github.com/example-org/'))
    c.onUpdate(chunk('example-repo/pull/7 for the diff.'))
    c.onUpdate(toolCall({ toolCallId: 't1', title: 'Bash', rawInput: { command: 'gh pr view 7' } }))
    c.onUpdate(toolDone({ toolCallId: 't1' }))
    c.onUpdate(chunk('Done: https://github.com/example-org/example-repo/pull/7'))
    const actions = c.onFinal()
    expect(types(actions)).toEqual(['action', 'external-urls', 'response', 'transcript'])
    const links = actions.find((a) => a.kind === 'external-urls')
    expect(links).toEqual({
      kind: 'external-urls',
      add: [{ label: 'PR #7', url: 'https://github.com/example-org/example-repo/pull/7' }]
    })
  })

  it('emits no link update when the turn named none, and none at all in minimal mode', () => {
    const quiet = conv('low')
    quiet.onUpdate(chunk('nothing to link here'))
    expect(types(quiet.onFinal())).toEqual(['response', 'transcript'])
    const minimal = conv('minimal')
    minimal.onUpdate(chunk('see https://github.com/example-org/example-repo/pull/7'))
    expect(types(minimal.onFinal())).toEqual(['response', 'transcript'])
  })
})
