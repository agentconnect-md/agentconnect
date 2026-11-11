// A scheduled run makes a Slack code channel from its own anchor post, through the daemon (slack-code-channels.md).
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

async function fire(during: (d: any, ctx: SessionContext) => Promise<unknown>, external = false) {
  let outcome: unknown
  let sessions = 0
  const host = {
    __started: true,
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => `acp-${++sessions}`),
    prompt: vi.fn(async () => {
      const scope: string = d.transportScopeForIntegrationIds([INT])
      const ctx = {
        agentId: AGENT,
        platform: 'slack',
        integrationId: INT,
        channel: CHANNEL,
        thread: ANCHOR,
        deliveryThread: ANCHOR,
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
  const create = vi.fn(async (_args: unknown) => ({ ok: true, channel_id: 'C2' }))
  vi.spyOn(d, 'anyConnForIntegration').mockReturnValue({
    botUserId: 'U_FAKE_BOT',
    codeChannel: async () => ({ code: false, owners: [] }),
    codeChannelApi: async (method: string, args: unknown) => (method === 'create' ? await create(args) : {})
  })
  vi.spyOn(d, 'replyConnFor').mockReturnValue({
    setStatus: vi.fn(async () => true),
    setTitle: vi.fn(async () => {}),
    getThreadReplies: vi.fn(async () => []),
    getChannelInfo: vi.fn(async (id: string) => ({ id, isIm: false, isMpim: false, isPrivate: false })),
    postMessage: vi.fn(async () => ANCHOR),
    postBlocks: vi.fn(async () => '1700000200.000001'),
    updateMessage: vi.fn(async () => true),
    updateBlocks: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
    postContext: vi.fn(async () => {})
  })
  vi.spyOn(d, 'placeConfirmedInternal').mockResolvedValue(undefined)
  vi.spyOn(d.mcp.deps, 'targetExternal').mockResolvedValue(external)
  const { msg } = buildSyntheticMessage(AGENT, cron, 'trace-1', new Date('2026-11-10T17:00:00.000Z'))
  await d.onCronFire(AGENT, msg, cron)
  await daemon.stop()
  return { outcome, create }
}

const createChannel = (d: any, ctx: SessionContext) =>
  executeTool(ctx, 'createSlackCodeChannel', { name: 'pick-up-ticket' }, d.mcp.deps)

describe('a scheduled run making a code channel, through the daemon', () => {
  it('links the channel to the run’s own anchor post and tells the run how to hand over', async () => {
    const { outcome, create } = await fire(createChannel)
    expect(create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ origin_channel_id: CHANNEL, origin_message_ts: ANCHOR })
    )
    expect(outcome).toMatchObject({
      channel_id: 'C2',
      next: expect.stringContaining(`"toAgent":"${AGENT}","channel":"C2"`)
    })
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

  it('refuses a channel shared with another organization', async () => {
    const { outcome, create } = await fire(createChannel, true)
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toContain('no person started this run')
    expect(create).not.toHaveBeenCalled()
  })
})
