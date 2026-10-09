// An assistant-mode agent's reply in an external place (assistant-mode.md §5.5): drafted to an internal member, never posted unapproved.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildCpClientDeps } from '../src/cp/cp-client-deps.js'
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
    root,
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

  it('is approved from the console through the card’s own path: one post, the card rewritten, a racing click refused', async () => {
    const h = await boot(true)
    try {
      await h.ask()
      const [draft] = await h.drafts()
      const deps = buildCpClientDeps((h.daemon as any).cpClientDepsHost(h.root, 'wss://cp.example.test', () => {}))
      const decide = deps.assistantActivity!.write({
        agentId: 'bot-a',
        operation: 'decide-draft',
        draftId: draft!.id,
        choice: 'approve',
        decider: { userId: 'usr-editor', name: 'Grace' }
      })
      const click = (h.daemon as any).routePermissionChoice({
        requestId: draft!.id,
        optionId: 'approve',
        actor: { userId: 'U1' }
      })
      const [answer] = await Promise.all([decide, click])
      expect(h.conn.postMessage).toHaveBeenCalledTimes(1)
      expect(h.conn.postMessage).toHaveBeenCalledWith('C_EXT', draft!.text, TS, expect.any(Object))
      expect(answer).toMatchObject({
        operation: 'decide-draft',
        result: expect.stringMatching(/^(decided|already-decided)$/)
      })
      expect((await h.drafts())[0]).toMatchObject({ status: 'succeeded', messageId: 'posted-1' })
      // Whoever won, the DM card is rewritten to the outcome and offers no buttons.
      const [channel, ts, blocks] = h.conn.updateBlocks.mock.calls.at(-1) as unknown as [string, string, unknown[]]
      expect([channel, ts]).toEqual(['D_U1', 'card-1'])
      expect(JSON.stringify(blocks)).toContain('Posted')
      expect(JSON.stringify(blocks)).not.toContain('"actions"')
    } finally {
      await h.close()
    }
  })

  it('is discarded from the console, recorded under the editor, and never posted', async () => {
    const h = await boot(true)
    try {
      await h.ask()
      const [draft] = await h.drafts()
      const deps = buildCpClientDeps((h.daemon as any).cpClientDepsHost(h.root, 'wss://cp.example.test', () => {}))
      expect(
        await deps.assistantActivity!.write({
          agentId: 'bot-a',
          operation: 'decide-draft',
          draftId: draft!.id,
          choice: 'discard',
          decider: { userId: 'usr-editor', name: 'Grace' }
        })
      ).toEqual({ operation: 'decide-draft', result: 'decided', status: 'denied', granted: false, failure: null })
      expect((await h.drafts())[0]).toMatchObject({ decidedBy: 'user:usr-editor', decidedByName: 'Grace' })
      expect(JSON.stringify(h.conn.updateBlocks.mock.calls.at(-1))).toContain('Discarded by Grace in the console')
      const click = { requestId: draft!.id, optionId: 'approve', actor: { userId: 'U1' } }
      await (h.daemon as any).routePermissionChoice(click)
      expect(h.conn.postMessage).not.toHaveBeenCalled()
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

describe('an approved post to another place', () => {
  it('gets the bookkeeping of a sent message under the source lineage, without a turn or a second post', async () => {
    const h = await boot(true)
    try {
      const store = (h.daemon as any).store
      const spawn = vi.spyOn((h.daemon as any).collab, 'spawnChannelRootSession').mockResolvedValue(true)
      const draft = await store.assistantDrafts.create({
        agentId: 'bot-a',
        kind: 'elsewhere',
        target: { platform: 'slack', integrationId: INT, channel: 'C_EXT', thread: null },
        text: 'For the shared channel.',
        source: {
          platform: 'slack',
          integrationId: INT,
          channel: 'D_U1',
          thread: 'append:dm',
          transportScope: 'T_FAKE_TEAM',
          sessionKey: 'k-dm',
          sessionId: 'outward-dm',
          place: true
        },
        approver: {
          kind: 'member',
          integrationId: INT,
          channel: 'D_U1',
          userId: 'U1',
          teamId: 'T_FAKE_TEAM',
          consoleUserId: null
        }
      })
      const click = { requestId: draft.id, optionId: 'approve', actor: { userId: 'U1' } }
      await (h.daemon as any).routePermissionChoice(click)
      await (h.daemon as any).routePermissionChoice(click)
      expect(h.conn.postMessage).toHaveBeenCalledTimes(1)
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'bot-a',
          platform: 'slack',
          integrationId: INT,
          channel: 'C_EXT',
          thread: 'posted-1',
          postTs: 'posted-1',
          text: 'For the shared channel.',
          originPlatform: 'slack',
          originTransportScope: 'T_FAKE_TEAM',
          originChannel: 'D_U1',
          originThread: 'append:dm'
        })
      )
      const rows = (await store.db
        .prepare('SELECT thread, ts, sender, text FROM transcript WHERE text = ?')
        .all('For the shared channel.')) as { thread: string; ts: string; sender: string }[]
      expect(rows).toEqual([{ thread: 'posted-1', ts: 'posted-1', sender: 'bot-a', text: 'For the shared channel.' }])
    } finally {
      await h.close()
    }
  })
})
