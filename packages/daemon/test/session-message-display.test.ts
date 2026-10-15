// What the console shows of a delivered session message beside what the model reads (send-message-guide.md §9.5).
import { describe, expect, it } from 'vitest'
import { subsessionRoundReport } from '../src/collab/coordinator.js'
import { renderedSessionMessageInput, renderSessionMessage } from '../src/collab/session-message.js'

const view = {
  messageId: 'msg-1',
  kind: 'reply' as const,
  sourceAgentId: 'agent-b',
  sourceLabel: 'reviewer',
  sourceSessionId: 'sid-b',
  inReplyTo: 'msg-0',
  replyRequested: true
}

describe('session message display', () => {
  it('shows the body alone and folds the header facts and reply call, the model reading the same prompt', () => {
    const input = renderedSessionMessageInput(view, 'All 12 items are done.')
    expect(input.text).toBe('All 12 items are done.')
    expect(input.turnBody.prompt).toBe(renderSessionMessage(view, 'All 12 items are done.'))
    expect(input.turnBody.sessionMessage).toEqual({
      messageId: 'msg-1',
      kind: 'reply',
      source: { agentId: 'agent-b', label: 'reviewer', sessionId: 'sid-b' },
      inReplyTo: 'msg-0',
      replyRequested: true,
      notes: [expect.stringContaining('"action":"replyToSession","messageId":"msg-1"')]
    })
  })

  it('folds no notes for a message that owes no reply', () => {
    const input = renderedSessionMessageInput({ ...view, replyRequested: false }, 'FYI')
    expect(input.turnBody.sessionMessage).not.toHaveProperty('notes')
    expect(input.turnBody.sessionMessage).not.toHaveProperty('replyRequested')
  })

  it('shows a finished task’s output alone, its framing and continue call folded', () => {
    const report = subsessionRoundReport('task-key', { outcome: 'completed' }, '40 files, 15,393 lines.')
    expect(report.text).toContain('Its final output, delivered on its behalf:\n\n40 files, 15,393 lines.\n\n')
    expect(report.shown).toEqual({
      text: '40 files, 15,393 lines.',
      notes: [
        '[task finished] Task task-key finished this round of work. Its final output, delivered on its behalf:',
        expect.stringContaining('"action":"messageTask","taskId":"task-key"')
      ]
    })
  })

  it('shows a stopped task’s status, its continue call folded', () => {
    const report = subsessionRoundReport('task-key', { outcome: 'failed' })
    expect(report.shown.text).toBe(
      '[task ended] Task task-key stopped before finishing (error). Anything it sent before this is all it reported.'
    )
    expect(report.text).toBe(`${report.shown.text} ${report.shown.notes![0]}`)
  })
})
