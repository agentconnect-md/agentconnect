// A place of an assistant-mode agent turning external mid-turn (assistant-mode.md §5.3): only that place's turn is cut.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import type { AssistantDraft } from '../src/store/assistant-drafts.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

const INT = 'int-bot-a'
const PLACES = ['C_A', 'C_B', 'C_C']

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-downgrade-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: [] } }
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
            bindRules: PLACES.map((channel) => ({ match: { kind: 'auto' }, channel })),
            externalChannels: []
          },
          config: { botToken: 'xoxb', appToken: 'xapp' }
        }
      ],
      output: { mode: 'medium' },
      assistantMode: { enabled: true, responsibleUserId: 'usr-1' }
    })
  )
  return root
}

interface HeldPrompt {
  session: string
  /** The test messages the prompt carries, in order. */
  tags: string[]
  done: boolean
  release: () => void
}

/** One shared host whose prompts each wait to be released, answering for the last message they carry. */
function heldHost() {
  let onUpdate!: (sessionId: string, update: unknown) => void
  let sessions = 0
  let opened = false
  const cancelled = new Set<string>()
  const prompts: HeldPrompt[] = []
  const host = {
    __started: true,
    start: async () => {},
    stop: async () => {},
    loadSession: async () => true,
    hasSession: () => true,
    newSession: vi.fn(async () => `acp-${++sessions}`),
    cancel: vi.fn(async (sessionId: string) => void cancelled.add(sessionId)),
    prompt: vi.fn(async (sessionId: string, blocks: { text?: string }[]) => {
      const tags = [
        ...blocks
          .map((block) => block.text ?? '')
          .join('\n')
          .matchAll(/msg-[a-z]\d/g)
      ].map((m) => m[0])
      cancelled.delete(sessionId)
      let open!: () => void
      const held = new Promise<void>((resolve) => (open = resolve))
      const prompt: HeldPrompt = {
        session: sessionId,
        tags,
        done: false,
        release: () => {
          prompt.done = true
          open()
        }
      }
      prompts.push(prompt)
      if (opened) prompt.release()
      await held
      // A runtime may still flush a chunk while it unwinds from session/cancel.
      const text = `reply to ${tags.at(-1)}`
      onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
      return { stopReason: cancelled.has(sessionId) ? 'cancelled' : 'end_turn' }
    })
  }
  return {
    factory: (_agent: unknown, update: typeof onUpdate) => {
      onUpdate = update
      return host as never
    },
    host,
    prompts,
    /** The session of the first prompt that carried the message. */
    sessionOf: (tag: string) => prompts.find((p) => p.tags.includes(tag))?.session,
    /** Whether a prompt on the session carried the message. */
    reached: (session: string | undefined, tag: string) =>
      prompts.some((p) => p.session === session && p.tags.includes(tag)),
    /** Finish the waiting prompt that carries the message. */
    release: (tag: string) => {
      const prompt = prompts.find((p) => !p.done && p.tags.includes(tag))
      if (!prompt) throw new Error(`no prompt is waiting with ${tag}`)
      prompt.release()
    },
    /** Finish whatever waits on these sessions now. */
    releaseOn: (...sessions: (string | undefined)[]) => {
      for (const prompt of prompts) if (!prompt.done && sessions.includes(prompt.session)) prompt.release()
    },
    /** Let every waiting and later prompt finish, so the daemon can stop. */
    openAll: () => {
      opened = true
      for (const prompt of prompts) if (!prompt.done) prompt.release()
    }
  }
}

async function boot() {
  const root = scaffold()
  const held = heldHost()
  const daemon: any = new Daemon({ root, slackAppFactory: fakeSlackAppFactory(), hostFactory: held.factory })
  await daemon.start()
  let posts = 0
  const conn = {
    workspaceId: () => 'T_FAKE_TEAM',
    workspaceUrl: 'https://example.slack.test',
    setStatus: vi.fn(async () => true),
    setTitle: vi.fn(async () => {}),
    react: vi.fn(async () => {}),
    postMessage: vi.fn(async () => `posted-${++posts}`),
    postContext: vi.fn(async () => {}),
    postBlocks: vi.fn(async () => `card-${++posts}`),
    updateBlocks: vi.fn(async () => true),
    updateMessage: vi.fn(async () => true),
    finalizeResponse: vi.fn(async () => true),
    openDirectMessage: vi.fn(async (user: string) => `D_${user}`),
    isFullMember: vi.fn(async () => true),
    getChannelInfo: vi.fn(async (id: string) => ({ id, isPrivate: false }))
  }
  daemon.connByIntegration.set(INT, conn)
  let seq = 0
  /** Dispatch a message into a place and resolve with its admission verdict; the turn runs on. */
  const send = (channel: string, thread: string, tag: string) =>
    new Promise<{ accepted: boolean; reason?: string }>((resolve, reject) => {
      const ts = `1700000000.${String(++seq).padStart(6, '0')}`
      daemon
        .dispatch(
          'bot-a',
          {
            msgId: `slack:${channel}:${ts}`,
            traceId: tag,
            source: 'user',
            platform: 'slack',
            channel,
            thread,
            sender: { id: 'U1', isBot: false },
            text: `please answer ${tag}`,
            mentionedBots: [],
            isDm: false
          },
          INT,
          undefined,
          undefined,
          { onAdmission: resolve }
        )
        .catch(reject)
    })
  /** The answers posted or edited into a channel. */
  const posted = (channel: string): string[] =>
    ([...conn.postMessage.mock.calls, ...conn.updateMessage.mock.calls] as unknown[][])
      .filter((call) => call[0] === channel)
      .flatMap((call) => call.filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('reply to')))
  const drafts = async (): Promise<AssistantDraft[]> => {
    const store = daemon.store
    const rows = (await store.assistantDrafts.db.query('SELECT id FROM assistant_draft', [])).rows as { id: string }[]
    return Promise.all(rows.map(async (row) => (await store.assistantDrafts.get(row.id)) as AssistantDraft))
  }
  return {
    daemon,
    held,
    conn,
    send,
    posted,
    drafts,
    async close() {
      held.openAll()
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

describe('a place turning external mid-turn', () => {
  it("leaves the agent's other places alone: their turns, queued messages and new arrivals run as before", async () => {
    const h = await boot()
    try {
      void h.send('C_A', 'TA', 'msg-a1')
      await vi.waitFor(() => expect(h.held.sessionOf('msg-a1')).toBeDefined(), WAIT)
      void h.send('C_B', 'TB', 'msg-b1')
      await vi.waitFor(() => expect(h.held.sessionOf('msg-b1')).toBeDefined(), WAIT)
      expect(await h.send('C_B', 'TB', 'msg-b2')).toMatchObject({ accepted: true, queued: true })
      const sessionA = h.held.sessionOf('msg-a1')
      const sessionB = h.held.sessionOf('msg-b1')

      h.daemon.placeTrust.detected([INT], 'C_A', 'guestMember')
      await vi.waitFor(() => expect(h.held.host.cancel).toHaveBeenCalledWith(sessionA), WAIT)

      // While the cut turn winds down, the other places still take messages: one busy, one idle.
      expect(await h.send('C_B', 'TB', 'msg-b3')).toMatchObject({ accepted: true })
      expect(await h.send('C_C', 'TC', 'msg-c1')).toMatchObject({ accepted: true })
      await vi.waitFor(() => expect(h.held.sessionOf('msg-c1')).toBeDefined(), WAIT)
      const sessionC = h.held.sessionOf('msg-c1')
      const pendingB = [...h.daemon.pending.values()].find((p: any) => p.acpSessionId === sessionB)
      expect(pendingB.outputSuppressed).toBeUndefined()

      await vi.waitFor(() => {
        h.held.releaseOn(sessionB, sessionC)
        expect(h.posted('C_B')).toContain('reply to msg-b3')
        expect(h.posted('C_C')).toContain('reply to msg-c1')
      }, WAIT)
      for (const tag of ['msg-b1', 'msg-b2', 'msg-b3']) expect(h.held.reached(sessionB, tag)).toBe(true)
      expect(h.held.host.cancel.mock.calls).toEqual([[sessionA]])
    } finally {
      await h.close()
    }
  })

  it('cuts every turn in the place without posting their late output, and keeps what arrives there to answer as drafts', async () => {
    const h = await boot()
    try {
      // Two conversations of the place are mid-turn: two threads of the channel.
      void h.send('C_A', 'TA', 'msg-a1')
      void h.send('C_A', 'TA2', 'msg-a2')
      await vi.waitFor(() => expect(h.held.sessionOf('msg-a2')).toBeDefined(), WAIT)
      await vi.waitFor(() => expect(h.held.sessionOf('msg-a1')).toBeDefined(), WAIT)
      const cut = [h.held.sessionOf('msg-a1'), h.held.sessionOf('msg-a2')]

      h.daemon.placeTrust.detected([INT], 'C_A', 'guestMember')
      await vi.waitFor(() => expect(h.held.host.cancel.mock.calls.map(([s]) => s).sort()).toEqual(cut.sort()), WAIT)

      // Arrivals in the place while the cut turns wind down: both conversations, and a new thread.
      expect(await h.send('C_A', 'TA', 'msg-a3')).toMatchObject({ accepted: true, queued: true })
      expect(await h.send('C_A', 'TA2', 'msg-a4')).toMatchObject({ accepted: true, queued: true })
      expect(await h.send('C_A', 'TA3', 'msg-a5')).toMatchObject({ accepted: true })

      // The cut turns flush a last chunk as they unwind.
      h.held.release('msg-a1')
      h.held.release('msg-a2')
      await vi.waitFor(async () => {
        h.held.releaseOn(...cut, h.held.sessionOf('msg-a5'))
        expect(await h.drafts()).toHaveLength(3)
      }, WAIT)

      const drafted = await h.drafts()
      expect(drafted.map((d) => [d.target.thread, d.text, d.targetExternal]).sort()).toEqual([
        ['TA', 'reply to msg-a3', true],
        ['TA2', 'reply to msg-a4', true],
        ['TA3', 'reply to msg-a5', true]
      ])
      // Nothing reaches the place unapproved, and the cut turns' output reaches no draft either.
      expect(h.posted('C_A')).toEqual([])
      expect(JSON.stringify(h.conn.postBlocks.mock.calls)).not.toMatch(/reply to msg-a[12]\b/)
    } finally {
      await h.close()
    }
  })

  it('leaves `!stop` as it was: the agent takes no new message anywhere until the stopped turn unwinds', async () => {
    const h = await boot()
    try {
      void h.send('C_A', 'TA', 'msg-a1')
      await vi.waitFor(() => expect(h.held.sessionOf('msg-a1')).toBeDefined(), WAIT)
      const sessionA = h.held.sessionOf('msg-a1')

      await h.daemon.onInboundOutcome(
        {
          msgId: 'slack:C_A:1700000001.000001',
          traceId: 'stop',
          source: 'user',
          platform: 'slack',
          channel: 'C_A',
          thread: 'TA',
          sender: { id: 'U1', isBot: false },
          text: '!stop',
          mentionedBots: [],
          isDm: false
        },
        [INT]
      )
      expect(h.held.host.cancel).toHaveBeenCalledWith(sessionA)
      expect(await h.send('C_B', 'TB', 'msg-b1')).toMatchObject({ accepted: false, reason: 'busy' })
      expect(await h.send('C_A', 'TA', 'msg-a2')).toMatchObject({ accepted: false, reason: 'busy' })

      h.held.release('msg-a1')
      await vi.waitFor(() => expect(h.daemon.safetyDrainingAgents.has('bot-a')).toBe(false), WAIT)
      expect(await h.send('C_B', 'TB', 'msg-b4')).toMatchObject({ accepted: true })
      expect(h.posted('C_A')).toEqual([])
    } finally {
      await h.close()
    }
  })
})
