// A scheduled run makes a Slack code channel from its own anchor post, with people in it, through the daemon (slack-code-channels.md).
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CronDef } from '../src/agents/agent-schema.js'
import { Daemon } from '../src/daemon.js'
import { executeTool } from '../src/mcp/ops.js'
import type { SessionContext } from '../src/mcp/ops/context.js'
import { buildSyntheticMessage } from '../src/scheduler/scheduler.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const AGENT = 'bot-a'
const INT = 'int-bot-a'
const CHANNEL = 'C1'
const ANCHOR = '1700000100.000001'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-scheduled-channel-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const dir = join(root, 'agents', AGENT)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'agent.json'),
    JSON.stringify({
      id: AGENT,
      name: AGENT,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(dir, 'workspace') },
      integrations: [
        {
          id: INT,
          platform: 'slack',
          core: { bindRules: [{ match: { kind: 'mention' } }] },
          config: { botToken: 'xoxb', appToken: 'xapp', botUserId: 'U_FAKE_BOT' }
        }
      ],
      output: { mode: 'low' }
    })
  )
  return root
}

const cron: CronDef = {
  id: 'pick-up-tickets',
  schedule: '0 9 * * 1',
  trigger: 'pick up the next ticket',
  target: { platform: 'slack', channel: CHANNEL, integrationId: INT },
  enabled: true
}

async function fire(
  during: (d: any, ctx: SessionContext) => Promise<unknown>,
  place: { external?: boolean; isPrivate?: boolean; room?: string } = {},
  turns = 1,
  after?: (d: any) => Promise<void>
) {
  let outcome: unknown
  let sessions = 0
  const prompts: string[] = []
  const promptSessions: string[] = []
  let anchor = ''
  const host = {
    __started: true,
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => `acp-${++sessions}`),
    prompt: vi.fn(async (session: string, blocks: unknown) => {
      prompts.push(JSON.stringify(blocks))
      promptSessions.push(session)
      // Only the schedule's own turn calls the tool; the turn the hand-off starts just ends.
      if (prompts.length > 1) return { stopReason: 'end_turn' }
      const scope: string = d.transportScopeForIntegrationIds([INT])
      // The schedule's turn is the only live one, and its thread is the anchor post.
      anchor = [...d.activeGateEntries.values()][0].msg.thread
      const ctx = {
        agentId: AGENT,
        platform: 'slack',
        integrationId: INT,
        channel: CHANNEL,
        thread: anchor,
        deliveryThread: anchor,
        transportScope: scope,
        isDm: false,
        tools: []
      } as SessionContext
      outcome = await during(d, ctx).catch((err: unknown) => err)
      return { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(async () => {}),
    stop: vi.fn()
  }
  const daemon = new Daemon({
    root: scaffold(),
    hostFactory: () => host as never,
    slackAppFactory: fakeSlackAppFactory()
  })
  await daemon.start()
  const d = daemon as any
  d.bindSessionSource = async () => 'unchanged'
  const create = vi.fn(async (_args: unknown) => ({ ok: true, channel_id: place.room ?? 'C2' }))
  vi.spyOn(d, 'anyConnForIntegration').mockReturnValue({
    botUserId: 'U_FAKE_BOT',
    codeChannel: async () => ({ code: false, owners: [] }),
    codeChannelApi: async (method: string, args: unknown) => (method === 'create' ? await create(args) : {}),
    inviteToCodeChannel: async (_channel: string, users: string[]) => users
  })
  vi.spyOn(d.mcp.deps, 'readLookups').mockReturnValue({
    member: async () => true,
    fullMember: async () => true,
    console: async () => ({ asker: 'unidentifiable' }),
    linked: async () => null
  })
  const postMessage = vi.fn(async (_channel: string, _text: string) => ANCHOR)
  vi.spyOn(d, 'replyConnFor').mockReturnValue({
    setStatus: vi.fn(async () => true),
    setTitle: vi.fn(async () => {}),
    getThreadReplies: vi.fn(async () => []),
    getChannelInfo: vi.fn(async (id: string) => ({ id, isIm: false, isMpim: false, isPrivate: place.isPrivate })),
    postMessage,
    postBlocks: vi.fn(async () => '1700000200.000001'),
    updateMessage: vi.fn(async () => true),
    updateBlocks: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
    postContext: vi.fn(async () => {}),
    updateCodeContext: vi.fn(async () => true)
  })
  const posted = vi.spyOn(d.gatewayForIntegration(INT), 'postMessage')
  // Slack reports the channel the run made as a code channel, which is one session keyed on itself.
  vi.spyOn(d.gatewayForIntegration(INT), 'roomThread').mockImplementation(async (channel: unknown) =>
    channel === (place.room ?? 'C2') ? (channel as string) : undefined
  )
  vi.spyOn(d, 'placeConfirmedInternal').mockResolvedValue(undefined)
  vi.spyOn(d.mcp.deps, 'targetExternal').mockResolvedValue(place.external ?? false)
  vi.spyOn(d.mcp.deps, 'placeSnapshot').mockReturnValue({ kind: 'channel', isPrivate: place.isPrivate ?? false })
  const { msg } = buildSyntheticMessage(AGENT, cron, 'trace-1', new Date('2026-11-10T17:00:00.000Z'))
  await d.onCronFire(AGENT, msg, cron)
  // The task's turn starts after the tool returns, so the daemon stops only once every expected turn has run.
  await vi.waitFor(() => expect(prompts).toHaveLength(turns))
  await vi.waitFor(() => expect(d.inflight.size).toBe(0))
  await after?.(d)
  await vi.waitFor(() => expect(d.inflight.size).toBe(0))
  await daemon.stop()
  return { outcome, create, posted, prompts, promptSessions, sessions, anchor }
}

const TASK = 'Pick up ticket 42 and open a pull request'
const createChannel = (
  d: any,
  ctx: SessionContext,
  args: Record<string, unknown> = { invite: ['U_ALICE'], task: TASK }
) => executeTool(ctx, 'createSlackCodeChannel', { name: 'pick-up-ticket', ...args }, d.mcp.deps)

describe('a scheduled run making a code channel, through the daemon', () => {
  it('links the channel to its anchor post, adds the people named and starts the task in it', async () => {
    const { outcome, create, posted, prompts, anchor } = await fire(createChannel, {}, 2)
    expect(create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ origin_channel_id: CHANNEL, origin_message_ts: anchor })
    )
    expect(outcome).toMatchObject({ channel_id: 'C2', invited: ['U_ALICE'], handedOff: true })
    // The daemon starts the task itself, as a fire starts: a post in the new channel and a turn of this agent's there.
    expect(posted.mock.calls.some(([channel, text]) => channel === 'C2' && String(text).includes(TASK))).toBe(true)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain(TASK)
  })

  it('starts the task in a private channel too, which is the run’s own', async () => {
    const { outcome, prompts } = await fire(createChannel, { isPrivate: true, room: 'C3' }, 2)
    expect(outcome).toMatchObject({ channel_id: 'C3', handedOff: true })
    expect(prompts).toHaveLength(2)
  })

  it('answers a reply in the channel in the session doing the task', async () => {
    const reply = {
      msgId: 'slack:C4:1700000400.000001',
      traceId: 'trace-reply',
      source: 'user',
      platform: 'slack',
      channel: 'C4',
      // Ingress keys every message in a code channel on the channel itself.
      thread: 'C4',
      sender: { id: 'U_ALICE', isBot: false },
      text: 'Also pick up ticket 43',
      mentionedBots: ['U_FAKE_BOT'],
      isDm: false
    }
    const { prompts, promptSessions, sessions } = await fire(createChannel, { room: 'C4' }, 2, async (d) => {
      await d.dispatch(AGENT, reply, INT)
      await vi.waitFor(() => expect(d.inflight.size).toBe(0))
    })
    expect(prompts).toHaveLength(3)
    expect(prompts[2]).toContain('Also pick up ticket 43')
    // One session for the schedule's own turn, one for the channel: the reply resumed the task's, and opened none.
    expect(promptSessions[2]).toBe(promptSessions[1])
    expect(sessions).toBe(2)
  })

  it('refuses a channel with nobody in it before anything is made', async () => {
    const { outcome, create } = await fire((d, ctx) => createChannel(d, ctx, { task: TASK }))
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toContain('at least one person')
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses once a person’s message has folded into the run', async () => {
    const { outcome, create } = await fire(async (d, ctx) => {
      d.activeGateEntries.get(d.sessionKeyOf(ctx)).foldedMessages = [{ msg: { source: 'user' } }]
      return await createChannel(d, ctx)
    })
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toContain('requires a live Slack message')
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses before creating anything when the channel is shared with another organization', async () => {
    const { outcome, create } = await fire(createChannel, { external: true })
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toContain('only from its own post in its own conversation')
    expect(create).not.toHaveBeenCalled()
  })
})
