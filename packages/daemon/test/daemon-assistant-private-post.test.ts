// An assistant-mode post from a DM to a private place the agent is enabled in (assistant-mode.md §5.5): drafted, not refused by the reach rule.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { executeTool, type SessionContext } from '../src/mcp/ops.js'
import type { AssistantDraft } from '../src/store/assistant-drafts.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const INT = 'int-bot-a'
const TS = '1700000000.000100'
const REACH_REFUSAL = /C1 is a private Slack conversation, and this session was not started there/

function scaffold(assistant: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-private-post-'))
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
          // Enabled in the asker's DM and the private channel C1; never in the private channel G1.
          core: {
            gated: true,
            bindRules: [
              { match: { kind: 'auto' }, channel: 'D1' },
              { match: { kind: 'auto' }, channel: 'C1' }
            ]
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

/** A daemon whose DM turn makes each `sendMessage` call through the session's own MCP context. */
async function boot(assistant: boolean, sends: Record<string, unknown>[]) {
  const root = scaffold(assistant)
  const results: unknown[] = []
  const daemon: Daemon = new Daemon({
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
          const mcp = (daemon as any).mcp
          const ctx = [...mcp.sessions.values()].find((s: SessionContext) => s.channel === 'D1') as SessionContext
          for (const args of sends) {
            results.push(await executeTool(ctx, 'sendMessage', args, mcp.deps).catch((err: Error) => err))
          }
          onUpdate(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } })
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
    openDirectMessage: vi.fn(async (user: string) => (user === 'U1' ? 'D1' : `D_${user}`)),
    isFullMember: vi.fn(async () => true),
    getChannelInfo: vi.fn(async (id: string) => ({
      id,
      name: id === 'C1' ? 'leadership' : id,
      isPrivate: id === 'C1' || id === 'G1',
      ...(id.startsWith('D') ? { isIm: true } : {})
    }))
  }
  ;(daemon as any).connByIntegration.set(INT, conn)
  const ask = async () =>
    await (daemon as any).dispatch(
      'bot-a',
      {
        msgId: `slack:D1:${TS}`,
        traceId: 'private-post',
        source: 'user',
        platform: 'slack',
        channel: 'D1',
        thread: TS,
        sender: { id: 'U1', isBot: false },
        text: 'post the update in the leadership channel',
        mentionedBots: [],
        isDm: true
      },
      INT
    )
  const drafts = async (): Promise<AssistantDraft[]> => {
    const store = (daemon as any).store
    const rows = (await store.assistantDrafts.db.query('SELECT id FROM assistant_draft', [])).rows as { id: string }[]
    return Promise.all(rows.map(async (row) => (await store.assistantDrafts.get(row.id)) as AssistantDraft))
  }
  // "Always allow from here to there", as a person's earlier click would have recorded it.
  const grant = async (channel: string) => {
    const ledger = (daemon as any).store.assistantDrafts
    const here = { platform: 'slack', integrationId: INT, channel: 'D1' }
    const there = { platform: 'slack', integrationId: INT, channel }
    await ledger.grant('bot-a', here, there, 'T_FAKE_TEAM:U1', await ledger.grantEpoch('bot-a'), Date.now())
  }
  return {
    daemon,
    conn,
    ask,
    drafts,
    grant,
    results,
    async close() {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

describe('an assistant-mode post from a DM to a private place', () => {
  it('is drafted to the asker when the agent is enabled there, and posts into it once approved', async () => {
    const h = await boot(true, [{ channel: 'C1', message: 'The launch moves to Monday.' }])
    try {
      await h.ask()
      expect(h.results[0]).not.toBeInstanceOf(Error)
      expect(h.results[0]).toMatchObject({ drafted: true, approver: 'the person who asked, in a direct message' })
      const [draft] = await h.drafts()
      expect(draft).toMatchObject({
        kind: 'elsewhere',
        status: 'awaiting_review',
        target: { platform: 'slack', integrationId: INT, channel: 'C1', thread: null },
        text: 'The launch moves to Monday.',
        approver: { kind: 'member', channel: 'D1', userId: 'U1' }
      })
      expect(h.conn.postMessage).not.toHaveBeenCalledWith('C1', expect.anything(), undefined, expect.anything())
      const [cardChannel, blocks] = h.conn.postBlocks.mock.calls[0] as unknown as [string, unknown[]]
      expect(cardChannel).toBe('D1')
      expect(JSON.stringify(blocks)).toContain('The launch moves to Monday.')

      await (h.daemon as any).routePermissionChoice({
        requestId: draft!.id,
        optionId: 'approve',
        actor: { userId: 'U1' }
      })
      expect(h.conn.postMessage).toHaveBeenCalledWith(
        'C1',
        'The launch moves to Monday.',
        undefined,
        expect.objectContaining({ agentAuthorId: 'bot-a' })
      )
      expect((await h.drafts())[0]).toMatchObject({ status: 'succeeded', messageId: 'posted-1' })
    } finally {
      await h.close()
    }
  })

  it('posts directly under a person’s earlier grant for that pair of places', async () => {
    const h = await boot(true, [{ channel: 'C1', message: 'The launch moves to Monday.' }])
    try {
      await h.grant('C1')
      await h.ask()
      expect(h.results[0]).not.toBeInstanceOf(Error)
      expect(await h.drafts()).toEqual([])
      expect(h.conn.postMessage).toHaveBeenCalledWith(
        'C1',
        'The launch moves to Monday.',
        undefined,
        expect.objectContaining({ agentAuthorId: 'bot-a' })
      )
    } finally {
      await h.close()
    }
  })

  it('is refused where the agent is not enabled, even under a grant, and nothing is drafted or posted', async () => {
    const h = await boot(true, [{ channel: 'G1', message: 'The launch moves to Monday.' }])
    try {
      await h.grant('G1')
      await h.ask()
      expect(h.results[0]).toBeInstanceOf(Error)
      expect((h.results[0] as Error).message).toMatch(/this agent is not enabled in that conversation/)
      expect(await h.drafts()).toEqual([])
      expect(h.conn.postMessage).not.toHaveBeenCalledWith('G1', expect.anything(), undefined, expect.anything())
    } finally {
      await h.close()
    }
  })

  it('is still refused by the reach rule for an agent outside assistant mode', async () => {
    const h = await boot(false, [{ channel: 'C1', message: 'The launch moves to Monday.' }])
    try {
      await h.ask()
      expect(h.results[0]).toBeInstanceOf(Error)
      expect((h.results[0] as Error).message).toMatch(REACH_REFUSAL)
      expect(await h.drafts()).toEqual([])
      expect(h.conn.postMessage).not.toHaveBeenCalledWith('C1', expect.anything(), undefined, expect.anything())
    } finally {
      await h.close()
    }
  })
})
