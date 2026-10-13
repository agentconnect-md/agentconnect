// A post from a DM to another conversation (assistant-mode.md §5.5): it goes where the asker could post, and a shared conversation's is drafted.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { APPROVAL_DM_ROUTE_V1_FEATURE } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { executeTool, type SessionContext } from '../src/mcp/ops.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { SUBSESSION_COORDINATE_PREFIX } from '../src/session/subsession-coordinate.js'
import type { AssistantDraft } from '../src/store/assistant-drafts.js'
import { sessionKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const INT = 'int-bot-a'
const TS = '1700000000.000100'
const NOT_POSTED = "I can't post there from here."

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
          // Enabled in the asker's DM, the private channel C1 and C_SHARED, a channel shared with another organization.
          core: {
            gated: true,
            bindRules: [
              { match: { kind: 'auto' }, channel: 'D1' },
              { match: { kind: 'auto' }, channel: 'C1' },
              { match: { kind: 'auto' }, channel: 'C_SHARED' }
            ],
            externalChannels: ['C_SHARED']
          },
          config: { botToken: 'xoxb', appToken: 'xapp' }
        }
      ],
      output: { mode: 'medium' },
      ...(assistant ? { assistantMode: { enabled: true } } : {})
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
    // U1 is in the private channel C1 and the shared one, never in the private channel G1.
    listMemberIds: vi.fn(async (id: string) =>
      id === 'C1' || id === 'C_SHARED' ? ['U1', 'U2'] : id === 'G1' ? ['U2'] : ['U1']
    ),
    getChannelInfo: vi.fn(async (id: string) => ({
      id,
      name: id === 'C1' ? 'leadership' : id,
      isPrivate: id === 'C1' || id === 'G1' || id === 'C_SHARED',
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
  return {
    daemon,
    conn,
    ask,
    drafts,
    results,
    async close() {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

describe('a post from a DM to another conversation, in either mode', () => {
  for (const assistant of [false, true]) {
    const mode = assistant ? 'in assistant mode' : 'outside assistant mode'

    it(`posts straight into a private channel the asker is in, with no draft (${mode})`, async () => {
      const h = await boot(assistant, [{ channel: 'C1', message: 'The launch moves to Monday.' }])
      try {
        await h.ask()
        expect(h.results[0]).not.toBeInstanceOf(Error)
        expect(h.conn.postMessage).toHaveBeenCalledWith(
          'C1',
          'The launch moves to Monday.',
          undefined,
          expect.objectContaining({ agentAuthorId: 'bot-a' })
        )
        expect(await h.drafts()).toEqual([])
        expect(h.conn.postBlocks).not.toHaveBeenCalled()
      } finally {
        await h.close()
      }
    })

    it(`refuses a private channel the asker is not in, opaquely, and drafts nothing (${mode})`, async () => {
      const h = await boot(assistant, [{ channel: 'G1', message: 'The launch moves to Monday.' }])
      try {
        await h.ask()
        expect(h.results[0]).toBeInstanceOf(Error)
        expect((h.results[0] as Error).message).toContain(NOT_POSTED)
        expect(await h.drafts()).toEqual([])
        expect(h.conn.postMessage).not.toHaveBeenCalledWith('G1', expect.anything(), undefined, expect.anything())
      } finally {
        await h.close()
      }
    })

    it(`drafts a post into a shared conversation to the asker, and posts it once approved (${mode})`, async () => {
      const h = await boot(assistant, [{ channel: 'C_SHARED', message: 'The launch moves to Monday.' }])
      try {
        await h.ask()
        expect(h.results[0]).toMatchObject({ drafted: true, approver: 'the person who asked, in a direct message' })
        const [draft] = await h.drafts()
        expect(draft).toMatchObject({
          kind: 'elsewhere',
          status: 'awaiting_review',
          target: { platform: 'slack', integrationId: INT, channel: 'C_SHARED', thread: null },
          targetExternal: true,
          approver: { kind: 'member', channel: 'D1', userId: 'U1' }
        })
        expect(h.conn.postMessage).not.toHaveBeenCalledWith('C_SHARED', expect.anything(), undefined, expect.anything())
        const [cardChannel, blocks] = h.conn.postBlocks.mock.calls[0] as unknown as [string, unknown[]]
        expect(cardChannel).toBe('D1')
        expect(JSON.stringify(blocks)).not.toContain('Always allow')

        await (h.daemon as any).routePermissionChoice({
          requestId: draft!.id,
          optionId: 'approve',
          actor: { userId: 'U1' }
        })
        expect(h.conn.postMessage).toHaveBeenCalledWith(
          'C_SHARED',
          'The launch moves to Monday.',
          undefined,
          expect.objectContaining({ agentAuthorId: 'bot-a' })
        )
        expect((await h.drafts())[0]).toMatchObject({ status: 'succeeded', messageId: 'posted-1' })
      } finally {
        await h.close()
      }
    })
  }
})

describe('a drafted post outside assistant mode, on a turn no one typed', () => {
  const toShared = {
    platform: 'slack',
    integrationId: INT,
    channel: 'C_SHARED',
    text: 'The launch moves to Monday.',
    directMessage: false
  }

  /** A live turn the write rule resolves to a person, at `thread` in C1; it is not run, so it is removed before shutdown. */
  function liveTurn(d: any, thread: string, msg: Partial<NormalizedMessage>) {
    const scope: string = d.transportScopeForIntegrationIds([INT])
    const key = sessionKey('slack', 'C1', thread, 'bot-a', scope)
    d.activeGateEntries.set(key, {
      msg: {
        msgId: `m-${thread}`,
        traceId: `t-${thread}`,
        source: 'agent',
        platform: 'slack',
        channel: 'C1',
        thread: TS,
        sender: { id: 'bot-a', isBot: true },
        text: 'go',
        mentionedBots: [],
        isDm: false,
        ...msg
      },
      integrationId: INT
    })
    const ctx: SessionContext = {
      agentId: 'bot-a',
      platform: 'slack',
      integrationId: INT,
      transportScope: scope,
      isDm: false,
      channel: 'C1',
      thread,
      deliveryThread: TS,
      tools: []
    }
    return { key, ctx }
  }

  it("cards a person-backed schedule's post to that person's own direct message", async () => {
    const h = await boot(false, [])
    const d = h.daemon as any
    const approvalRoute = vi.fn(async (req: { requestId: string; consoleUserId?: string }) => ({
      requestId: req.requestId,
      ...(req.consoleUserId === 'user-editor'
        ? { target: { integrationId: INT, teamId: 'T_FAKE_TEAM', userId: 'U_EDITOR', consoleUserId: 'user-editor' } }
        : {})
    }))
    const cronId = randomUUID()
    const turn = liveTurn(d, 'cron-thread', {
      source: 'cron',
      cronRun: { cronId, firedAt: '2026-10-13T09:00:00.000Z' }
    })
    try {
      d.cpCrons.upsert({
        cronId,
        agentId: 'bot-a',
        schedule: '0 9 * * 1-5',
        timezone: 'UTC',
        trigger: 'post the update',
        enabled: true,
        askerUserId: 'user-editor'
      })
      d.cpClient = {
        supportsServerFeature: (feature: string) => feature === APPROVAL_DM_ROUTE_V1_FEATURE,
        approvalRoute,
        stop: vi.fn(async () => {})
      }
      expect(await d.draftPost(turn.ctx, toShared)).toMatchObject({
        handled: true,
        result: { drafted: true, approver: 'the person who asked, in a direct message' }
      })
      expect(approvalRoute).toHaveBeenCalledWith(expect.objectContaining({ consoleUserId: 'user-editor' }), undefined)
      expect((h.conn.postBlocks.mock.calls[0] as unknown as [string])[0]).toBe('D_U_EDITOR')
      expect((await h.drafts())[0]).toMatchObject({ approver: { kind: 'member', userId: 'U_EDITOR' } })
    } finally {
      d.activeGateEntries.delete(turn.key)
      d.cpClient = undefined
      await h.close()
    }
  })

  it("cards a sub-session's post to the person whose turn opened it", async () => {
    const h = await boot(false, [])
    const d = h.daemon as any
    const turn = liveTurn(d, `${SUBSESSION_COORDINATE_PREFIX}d-1`, {})
    try {
      d.subsessionOpeners.set(turn.key, {
        people: [{ kind: 'member', platform: 'slack', integrationId: INT, userId: 'U1' }],
        nobody: false
      })
      expect(await d.draftPost(turn.ctx, toShared)).toMatchObject({
        handled: true,
        result: { drafted: true, approver: 'the person who asked, in a direct message' }
      })
      expect((h.conn.postBlocks.mock.calls[0] as unknown as [string])[0]).toBe('D1')
      expect((await h.drafts())[0]).toMatchObject({ approver: { kind: 'member', userId: 'U1' } })
    } finally {
      d.activeGateEntries.delete(turn.key)
      await h.close()
    }
  })
})
