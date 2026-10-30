import { describe, expect, it } from 'vitest'
import {
  ASSISTANT_ACTIVITY_CHECKS_MAX,
  ASSISTANT_ACTIVITY_ITEMS_MAX,
  ASSISTANT_ACTIVITY_RESULT_BYTES,
  AgentPermissionRequestRecord,
  AssistantActivityDraft,
  AssistantActivityPermission,
  assistantActivityResultFits,
  buildEnvelope,
  decodeEnvelope,
  FRAME_TYPES
} from '../index.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const decodes = (type: Parameters<typeof buildEnvelope>[0], payload: unknown): boolean =>
  decodeEnvelope(JSON.stringify(buildEnvelope(type, payload as never, { orgId: 'org-a' }))).ok

const item = {
  id: 'item-1',
  title: 'Ship the release notes',
  status: 'active',
  doneWhen: null,
  nextCheck: '2026-10-10T09:00:00.000Z',
  origin: { platform: 'slack', channel: 'D0ALICE' },
  places: [{ platform: 'webchat', channel: 'conv-1' }],
  createdAt: '2026-10-09T09:00:00.000Z',
  updatedAt: '2026-10-09T09:00:00.000Z'
}

describe('assistant/activity frames', () => {
  it('registers exactly the read and write pairs', () => {
    expect(FRAME_TYPES.filter((t) => t.startsWith('assistant/activity/'))).toEqual([
      'assistant/activity/read',
      'assistant/activity/read/result',
      'assistant/activity/write',
      'assistant/activity/write/result'
    ])
  })

  it('round-trips every read and its answer', () => {
    expect(
      decodes('assistant/activity/read', { agentId: AGENT_ID, operation: 'items', section: 'open', limit: 50 })
    ).toBe(true)
    expect(decodes('assistant/activity/read', { agentId: AGENT_ID, operation: 'item', itemId: 'item-1' })).toBe(true)
    expect(decodes('assistant/activity/read', { agentId: AGENT_ID, operation: 'subsessions', limit: 50 })).toBe(true)
    expect(decodes('assistant/activity/read', { agentId: AGENT_ID, operation: 'drafts', limit: 50 })).toBe(true)

    expect(decodes('assistant/activity/read/result', { operation: 'items', items: [item], truncated: false })).toBe(
      true
    )
    expect(
      decodes('assistant/activity/read/result', {
        operation: 'item',
        item: { ...item, summary: 'In review.', observations: [{ text: 'PR opened', at: '2026-10-09T10:00:00.000Z' }] }
      })
    ).toBe(true)
    expect(decodes('assistant/activity/read/result', { operation: 'item', item: null })).toBe(true)
    expect(
      decodes('assistant/activity/read/result', {
        operation: 'subsessions',
        subsessions: [
          { sessionId: null, parentSessionId: 'sid-1', state: 'open', createdAt: '2026-10-09T09:00:00.000Z' },
          { sessionId: 'sid-2', parentSessionId: 'sid-1', state: 'failed', createdAt: '2026-10-09T08:00:00.000Z' }
        ],
        truncated: false
      })
    ).toBe(true)
    expect(
      decodes('assistant/activity/read/result', {
        operation: 'drafts',
        drafts: [
          {
            id: 'draft-1',
            kind: 'reply',
            target: {
              platform: 'slack',
              integrationId: 'int-1',
              channel: 'C0SHARED',
              thread: null,
              name: 'shared',
              dm: false,
              external: true
            },
            text: 'Thanks, we are on it.',
            approver: null,
            createdAt: '2026-10-09T09:00:00.000Z',
            expiresAt: '2026-10-10T09:00:00.000Z'
          }
        ],
        truncated: false
      })
    ).toBe(true)
  })

  // auto-session-mode.md §6.7: a task's summary rides the read, bounded, and a row without one is still read.
  it('carries a task’s title, summary, background and whether a thread is attached', () => {
    const row = {
      sessionId: 'sid-2',
      parentSessionId: 'sid-1',
      state: 'open',
      createdAt: '2026-10-09T08:00:00.000Z',
      kind: 'delegated',
      title: 'Add retry to the webhook sender',
      summary: 'Scope: webhook retries. Status: in review. Next: merge.',
      summaryUpdatedAt: '2026-10-09T09:00:00.000Z',
      background: 'can you add retry with backoff to the webhook sender?',
      threaded: true
    }
    const page = (over: Record<string, unknown>) => ({
      operation: 'subsessions',
      subsessions: [{ ...row, ...over }],
      truncated: false
    })
    expect(decodes('assistant/activity/read/result', page({}))).toBe(true)
    expect(decodes('assistant/activity/read/result', page({ summary: 'x'.repeat(2_001) }))).toBe(false)
    expect(decodes('assistant/activity/read/result', page({ summaryUpdatedAt: 'yesterday' }))).toBe(false)
    expect(decodes('assistant/activity/read/result', { operation: 'task', task: row })).toBe(true)
  })

  it('round-trips follow-ups among the tasks, with their newest checks', () => {
    const check = { at: '2026-10-09T09:00:00.000Z', observation: 'The build is still running.', reported: false }
    const followUp = {
      title: 'Watch the release',
      doneWhen: null,
      status: 'paused',
      nextCheck: null,
      recentChecks: Array.from({ length: ASSISTANT_ACTIVITY_CHECKS_MAX }, () => check)
    }
    const row = {
      sessionId: null,
      parentSessionId: 'sid-1',
      state: 'open',
      createdAt: '2026-10-09T08:00:00.000Z',
      kind: 'follow-up',
      followUp
    }
    const page = { operation: 'subsessions', subsessions: [row], truncated: false, followUps: true }
    expect(decodes('assistant/activity/read/result', page)).toBe(true)
    const withRow = (over: Record<string, unknown>) => ({ ...page, subsessions: [{ ...row, ...over }] })
    expect(decodes('assistant/activity/read/result', withRow({ kind: 'approved-proposal', followUp: undefined }))).toBe(
      true
    )
    expect(decodes('assistant/activity/read/result', withRow({ kind: 'patrol' }))).toBe(false)
    expect(decodes('assistant/activity/read/result', withRow({ followUp: { ...followUp, status: 'active' } }))).toBe(
      false
    )
    expect(
      decodes(
        'assistant/activity/read/result',
        withRow({ followUp: { ...followUp, recentChecks: [...followUp.recentChecks, check] } })
      )
    ).toBe(false)
  })

  it('round-trips an item deletion and its answer', () => {
    expect(decodes('assistant/activity/write', { agentId: AGENT_ID, operation: 'delete-item', itemId: 'item-1' })).toBe(
      true
    )
    expect(decodes('assistant/activity/write/result', { operation: 'delete-item', found: false })).toBe(true)
  })

  it('round-trips one conversation’s background work page and a stop', () => {
    const parent = { sessionId: 'sid-1' }
    expect(decodes('assistant/activity/read', { agentId: AGENT_ID, operation: 'subsessions', limit: 20, parent })).toBe(
      true
    )
    expect(
      decodes('assistant/activity/read', {
        agentId: AGENT_ID,
        operation: 'subsessions',
        limit: 20,
        parent: { ...parent, cursor: 'opaque' }
      })
    ).toBe(true)
    expect(
      decodes('assistant/activity/read', { agentId: AGENT_ID, operation: 'subsessions', limit: 20, parent: {} })
    ).toBe(false)
    const page = { operation: 'subsessions', subsessions: [], truncated: true }
    expect(decodes('assistant/activity/read/result', { ...page, nextCursor: 'opaque' })).toBe(true)
    expect(decodes('assistant/activity/read/result', { ...page, nextCursor: null })).toBe(true)
    expect(decodes('assistant/activity/read/result', { ...page, nextCursor: 'x'.repeat(1_025) })).toBe(false)

    const stop = {
      agentId: AGENT_ID,
      operation: 'stop-subsession',
      sessionId: 'sid-2',
      actor: { userId: 'usr-1', name: 'Grace' }
    }
    expect(decodes('assistant/activity/write', stop)).toBe(true)
    expect(decodes('assistant/activity/write', { ...stop, actor: undefined })).toBe(false)
    for (const result of ['stopped', 'not-running', 'not-found']) {
      expect(decodes('assistant/activity/write/result', { operation: 'stop-subsession', result })).toBe(true)
    }
    expect(decodes('assistant/activity/write/result', { operation: 'stop-subsession', result: 'killed' })).toBe(false)
  })

  it('round-trips one task by its session, a follow-up’s id, and ending a follow-up by it', () => {
    expect(decodes('assistant/activity/read', { agentId: AGENT_ID, operation: 'task', sessionId: 'sid-2' })).toBe(true)
    expect(decodes('assistant/activity/read', { agentId: AGENT_ID, operation: 'task' })).toBe(false)
    const followUp = {
      id: 'item-1',
      title: 'Watch',
      doneWhen: null,
      status: 'waiting',
      nextCheck: null,
      recentChecks: []
    }
    const task = { sessionId: null, parentSessionId: 'sid-1', state: 'open', createdAt: item.createdAt, followUp }
    expect(decodes('assistant/activity/read/result', { operation: 'task', task })).toBe(true)
    expect(decodes('assistant/activity/read/result', { operation: 'task', task: null })).toBe(true)
    expect(
      decodes('assistant/activity/read/result', {
        operation: 'task',
        task: { ...task, followUp: { ...followUp, id: '' } }
      })
    ).toBe(false)

    const stop = {
      agentId: AGENT_ID,
      operation: 'stop-follow-up',
      followUpId: 'item-1',
      parentSessionId: 'sid-1',
      actor: { userId: 'usr-1', name: null }
    }
    expect(decodes('assistant/activity/write', stop)).toBe(true)
    expect(decodes('assistant/activity/write', { ...stop, parentSessionId: undefined })).toBe(false)
    expect(decodes('assistant/activity/write/result', { operation: 'stop-follow-up', result: 'not-found' })).toBe(true)
  })

  it('round-trips a draft decision and its outcome', () => {
    const decide = {
      agentId: AGENT_ID,
      operation: 'decide-draft',
      draftId: 'draft-1',
      choice: 'approve',
      decider: { userId: 'usr-1', name: 'Grace' }
    }
    expect(decodes('assistant/activity/write', decide)).toBe(true)
    expect(decodes('assistant/activity/write', { ...decide, decider: { userId: 'usr-1', name: null } })).toBe(true)
    expect(decodes('assistant/activity/write', { ...decide, choice: 'always' })).toBe(false)
    expect(decodes('assistant/activity/write', { ...decide, decider: undefined })).toBe(false)
    const outcome = { operation: 'decide-draft', result: 'decided', status: 'succeeded', failure: null }
    expect(decodes('assistant/activity/write/result', outcome)).toBe(true)
    expect(decodes('assistant/activity/write/result', { ...outcome, result: 'not-found', status: null })).toBe(true)
    expect(decodes('assistant/activity/write/result', { ...outcome, result: 'maybe' })).toBe(false)
    expect(decodes('assistant/activity/write/result', { ...outcome, failure: 'x'.repeat(2_001) })).toBe(false)
  })

  it('round-trips a proposal beside the drafts, and a decision that leaves it waiting', () => {
    expect(
      decodes('assistant/activity/read', { agentId: AGENT_ID, operation: 'drafts', limit: 50, proposals: true })
    ).toBe(true)
    const proposal = {
      id: 'proposal-1',
      kind: 'task',
      target: {
        platform: 'slack',
        integrationId: 'int-1',
        channel: 'C0',
        thread: null,
        name: 'general',
        dm: false,
        external: false
      },
      text: 'Rebase PR #12 onto main and push.',
      approver: null,
      proposal: {
        sentence: 'I want to rebase PR #12 because it conflicts with main.',
        why: 'The check found a merge conflict.',
        itemId: 'item-1',
        itemTitle: 'Land PR #12'
      },
      createdAt: '2026-10-09T09:00:00.000Z',
      expiresAt: '2026-10-10T09:00:00.000Z'
    }
    expect(
      decodes('assistant/activity/read/result', { operation: 'drafts', drafts: [proposal], truncated: false })
    ).toBe(true)
    expect(
      AssistantActivityDraft.safeParse({ ...proposal, proposal: { ...proposal.proposal, sentence: '' } }).success
    ).toBe(false)
    expect(
      decodes('assistant/activity/write/result', {
        operation: 'decide-draft',
        result: 'busy',
        status: 'awaiting_review',
        failure: 'The agent already has 3 pieces of background work running.'
      })
    ).toBe(true)
  })

  it('narrows a read and a decision to one webchat conversation, and either side may predate it', () => {
    const read = { agentId: AGENT_ID, operation: 'drafts', limit: 50, proposals: true }
    expect(decodes('assistant/activity/read', { ...read, conversation: { sessionId: 'sid-webchat' } })).toBe(true)
    expect(decodes('assistant/activity/read', { ...read, conversation: { sessionId: '' } })).toBe(false)
    const decide = {
      agentId: AGENT_ID,
      operation: 'decide-draft',
      draftId: 'proposal-1',
      choice: 'approve',
      decider: { userId: 'usr-1', name: null }
    }
    expect(decodes('assistant/activity/write', { ...decide, conversation: { sessionId: 'sid-webchat' } })).toBe(true)
    expect(decodes('assistant/activity/write', { ...decide, conversation: {} })).toBe(false)
    const proposal = {
      id: 'proposal-1',
      kind: 'task',
      target: {
        platform: 'webchat',
        integrationId: null,
        channel: 'conv-1',
        thread: null,
        name: null,
        dm: false,
        external: false
      },
      text: 'Rebase PR #12 onto main and push.',
      approver: null,
      proposal: { sentence: 'I want to rebase PR #12.', why: '', itemId: 'item-1', itemTitle: null },
      createdAt: '2026-10-09T09:00:00.000Z',
      expiresAt: '2026-10-10T09:00:00.000Z'
    }
    // A daemon that marks a proposal decided in its conversation, and one that predates the mark.
    expect(AssistantActivityDraft.parse({ ...proposal, inConversation: true }).inConversation).toBe(true)
    expect(AssistantActivityDraft.parse(proposal)).not.toHaveProperty('inConversation')
  })

  it('carries background work’s permission requests beside the drafts, and either side may predate them', () => {
    const permission = {
      requestId: '22222222-2222-4222-8222-222222222222',
      sessionId: 'sid-sub',
      parentSessionId: 'sid-parent',
      tool: 'Write src/app.ts',
      createdAt: '2026-10-09T09:00:00.000Z',
      expiresAt: '2026-10-09T21:00:00.000Z',
      options: [{ optionId: 'o-allow', name: 'Allow', kind: 'allow_once' }]
    }
    const drafts = { operation: 'drafts', drafts: [], truncated: false }
    // A Control Plane that asks, and one that predates the flag.
    expect(
      decodes('assistant/activity/read', { agentId: AGENT_ID, operation: 'drafts', limit: 50, permissions: true })
    ).toBe(true)
    expect(decodes('assistant/activity/read', { agentId: AGENT_ID, operation: 'drafts', limit: 50 })).toBe(true)
    // A daemon that lists them, and one that predates them.
    expect(decodes('assistant/activity/read/result', { ...drafts, permissions: [permission] })).toBe(true)
    expect(decodes('assistant/activity/read/result', drafts)).toBe(true)
    expect(AssistantActivityPermission.safeParse({ ...permission, options: undefined }).success).toBe(true)
    expect(AssistantActivityPermission.safeParse({ ...permission, requestId: 'not-a-uuid' }).success).toBe(false)
    expect(AssistantActivityPermission.safeParse({ ...permission, tool: 'x'.repeat(241) }).success).toBe(false)

    // The approval queue names the conversation a request from background work belongs to; an older daemon's rows have none.
    const record = {
      id: permission.requestId,
      agentId: AGENT_ID,
      sessionId: 'sid-sub',
      createdAt: permission.createdAt,
      requesterId: null,
      requesterName: 'Butler',
      command: permission.tool,
      status: 'pending',
      resolvedAt: null
    }
    expect(AgentPermissionRequestRecord.parse({ ...record, parentSessionId: 'sid-parent' }).parentSessionId).toBe(
      'sid-parent'
    )
    expect(AgentPermissionRequestRecord.parse(record)).not.toHaveProperty('parentSessionId')
  })

  it('refuses unbounded or malformed requests and answers', () => {
    const tooMany = ASSISTANT_ACTIVITY_ITEMS_MAX + 1
    expect(
      decodes('assistant/activity/read', { agentId: AGENT_ID, operation: 'items', section: 'open', limit: tooMany })
    ).toBe(false)
    expect(
      decodes('assistant/activity/read', { agentId: AGENT_ID, operation: 'items', section: 'all', limit: 5 })
    ).toBe(false)
    expect(decodes('assistant/activity/read', { agentId: 'not-a-uuid', operation: 'drafts', limit: 5 })).toBe(false)
    expect(decodes('assistant/activity/write', { agentId: AGENT_ID, operation: 'drop-everything' })).toBe(false)
    expect(
      decodes('assistant/activity/read/result', {
        operation: 'items',
        items: Array.from({ length: tooMany }, () => item),
        truncated: true
      })
    ).toBe(false)
    expect(
      decodes('assistant/activity/read/result', {
        operation: 'items',
        items: [{ ...item, status: 'paused' }],
        truncated: false
      })
    ).toBe(false)
  })

  it('measures a result against the wire budget', () => {
    expect(assistantActivityResultFits({ operation: 'items', items: [item], truncated: false })).toBe(true)
    expect(assistantActivityResultFits({ text: 'x'.repeat(ASSISTANT_ACTIVITY_RESULT_BYTES) })).toBe(false)
  })
})
