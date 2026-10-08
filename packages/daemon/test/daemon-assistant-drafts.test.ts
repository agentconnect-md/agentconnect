// An assistant-mode agent's reply in an external place (assistant-mode.md §5.5): drafted to an internal member, never posted unapproved.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import type { AssistantDraft } from '../src/store/assistant-drafts.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const INT = 'int-bot-a'
const TS = '1700000000.000100'

function scaffold(assistant: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-drafts-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', 'bot-a')
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [
        {
          id: INT,
          platform: 'slack',
          core: {
            gated: true,
            bindRules: [{ match: { kind: 'auto' }, channel: 'C_EXT' }],
            externalChannels: ['C_EXT']
          },
          config: { botToken: 'xoxb', appToken: 'xapp' }
        }
      ],
      output: { mode: 'medium' },
      ...(assistant ? { assistantMode: { enabled: true, responsibleUserId: 'usr-1' } } : {})
    })
  )
  return root
}

async function boot(assistant: boolean) {
  const root = scaffold(assistant)
  const daemon = new Daemon({
    root,
    slackAppFactory: fakeSlackAppFactory(),
    hostFactory: (_agent, onUpdate) =>
      ({
        __started: true,
        start: async () => {},
        stop: async () => {},
        cancel: async () => {},
        newSession: async () => 'acp-1',
        loadSession: async () => true,
        hasSession: () => true,
        prompt: async (id: string) => {
          onUpdate(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me check.' } })
          onUpdate(id, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read notes', status: 'in_progress' })
          onUpdate(id, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' })
          onUpdate(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The answer is 42.' } })
          return { stopReason: 'end_turn' }
        }
      }) as never
  })
  await daemon.start()
  const conn = {
    workspaceId: () => 'T_FAKE_TEAM',
    workspaceUrl: 'https://example.slack.test',
    setStatus: vi.fn(async () => true),
    setTitle: vi.fn(async () => {}),
    react: vi.fn(async () => {}),
    postMessage: vi.fn(async () => 'posted-1'),
    postContext: vi.fn(async () => {}),
    postBlocks: vi.fn(async () => 'card-1'),
    updateBlocks: vi.fn(async () => true),
    updateMessage: vi.fn(async () => true),
    openDirectMessage: vi.fn(async (user: string) => `D_${user}`),
    isFullMember: vi.fn(async () => true),
    getChannelInfo: vi.fn(async (id: string) => ({ id, isPrivate: false }))
  }
  ;(daemon as any).connByIntegration.set(INT, conn)
  const ask = async () =>
    await (daemon as any).dispatch(
      'bot-a',
      {
        msgId: `slack:C_EXT:${TS}`,
        traceId: 'draft',
        source: 'user',
        platform: 'slack',
        channel: 'C_EXT',
        thread: TS,
        sender: { id: 'U1', isBot: false },
        text: 'what is the answer?',
        mentionedBots: [],
        isDm: false
      },
      INT
    )
  const drafts = async (): Promise<AssistantDraft[]> => {
    const store = (daemon as any).store
    const rows = (await store.assistantDrafts.db.query('SELECT id FROM assistant_draft', [])).rows as { id: string }[]
    return Promise.all(rows.map(async (row) => (await store.assistantDrafts.get(row.id)) as AssistantDraft))
  }
  return {
    daemon,
    conn,
    ask,
    drafts,
    async close() {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

describe('a reply in an external place', () => {
  it('is drafted to the asker: the place sees a reaction only, no status, progress or text', async () => {
    const h = await boot(true)
    try {
      await h.ask()
      expect(h.conn.postMessage).not.toHaveBeenCalled()
      expect(h.conn.setStatus).not.toHaveBeenCalled()
      expect(h.conn.updateMessage).not.toHaveBeenCalled()
      expect(h.conn.react).toHaveBeenCalledWith('C_EXT', TS, 'seen')
      const [draft] = await h.drafts()
      expect(draft).toMatchObject({
        kind: 'reply',
        status: 'awaiting_review',
        target: { platform: 'slack', integrationId: INT, channel: 'C_EXT', thread: TS },
        targetExternal: true,
        approver: { kind: 'member', channel: 'D_U1', userId: 'U1' },
        cardTs: 'card-1'
      })
      expect(draft!.text).toBe('Let me check.\n\nThe answer is 42.')
      // The card is the only message: it lands in the asker's DM, never in the external place.
      expect(h.conn.isFullMember).toHaveBeenCalledWith('U1')
      expect(h.conn.postBlocks).toHaveBeenCalledTimes(1)
      const [cardChannel, blocks] = h.conn.postBlocks.mock.calls[0] as unknown as [string, unknown[]]
      expect(cardChannel).toBe('D_U1')
      expect(JSON.stringify(blocks)).toContain('The answer is 42.')
    } finally {
      await h.close()
    }
  })

  it('posts the drafted text unchanged in the original thread once the asker approves, and only once', async () => {
    const h = await boot(true)
    try {
      await h.ask()
      const [draft] = await h.drafts()
      const click = { requestId: draft!.id, optionId: 'approve', actor: { userId: 'U1' } }
      await (h.daemon as any).routePermissionChoice(click)
      await (h.daemon as any).routePermissionChoice(click)
      expect(h.conn.postMessage).toHaveBeenCalledTimes(1)
      expect(h.conn.postMessage).toHaveBeenCalledWith(
        'C_EXT',
        draft!.text,
        TS,
        expect.objectContaining({ agentAuthorId: 'bot-a' })
      )
      expect((await h.drafts())[0]).toMatchObject({ status: 'succeeded', messageId: 'posted-1' })
    } finally {
      await h.close()
    }
  })

  it('is posted directly, as before, for an agent outside assistant mode', async () => {
    const h = await boot(false)
    try {
      await h.ask()
      expect(h.conn.postMessage).toHaveBeenCalled()
      expect(await h.drafts()).toEqual([])
    } finally {
      await h.close()
    }
  })
})
