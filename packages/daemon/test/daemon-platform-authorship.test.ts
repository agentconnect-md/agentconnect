import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { manifestFor } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

/**
 * Behavioral pins for the bot-authorship cluster — the seven core branches that were
 * once Slack-only.
 *
 * The dangerous direction is admission: the bot-authorship cluster decides whether a
 * message a BOT posted may be trusted as an agent's own words and routed. Generalizing
 * `platform !== 'slack'` to the §5 manifest's `botSenderRouting` must not widen that by
 * one message, so every gate is exercised on all four platforms plus an id this build
 * has never heard of, and the third-party-bot case is pinned explicitly.
 */

const TEST_ORG = 'org_test0000000000000000000'
const OUR_APP = 'AAGENTCONNECT'

/** Every platform the daemon serves, with a config its own module schema accepts. */
const CONFIGS: Record<string, Record<string, unknown>> = {
  slack: { botToken: 'xoxb', appToken: 'xapp' },
  telegram: { botToken: '123:ABC' },
  discord: { botToken: 'disc' },
  feishu: { appId: 'cli_x', appSecret: 's' }
}
const PLATFORMS = Object.keys(CONFIGS)

const integrationEntry = (agentId: string, platform: string) => ({
  id: `int-${agentId}-${platform}`,
  platform,
  core: { mode: 'direct', bindRules: [{ match: { kind: 'auto' }, channel: 'C1' }], mutedChannels: [], gated: false },
  config: CONFIGS[platform]
})

/** Agents are scaffolded SLACK-ONLY on disk: `start()` opens a real connection per
 *  configured platform, and only Slack's failed handshake is cheap. Extra platforms are
 *  spliced in afterwards with {@link installIntegration}. */
function scaffold(agentIds: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-authorship-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  for (const id of agentIds) {
    const adir = join(root, 'agents', id)
    mkdirSync(adir, { recursive: true })
    writeFileSync(
      join(adir, 'agent.json'),
      JSON.stringify({
        id,
        name: id,
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
        integrations: [integrationEntry(id, 'slack')],
        output: { mode: 'low' }
      })
    )
  }
  return root
}

/** Add a live integration to a booted agent without opening its platform connection —
 *  enough for the routing-side lookups under test, which read `agent.integrations`. */
function installIntegration(daemon: Daemon, agentId: string, platform: string): void {
  ;(daemon as any).agents.get(agentId).integrations.push(integrationEntry(agentId, platform))
}

const fakeHost = () => ({
  __started: true,
  start: vi.fn(async () => {}),
  newSession: vi.fn(async () => 'acp-1'),
  prompt: vi.fn(async () => 'end_turn'),
  cancel: vi.fn(),
  stop: vi.fn()
})

/**
 * Boot with a collaboration snapshot that places both agents in channel `C1` on EVERY
 * platform under the same AgentConnect app id. That is deliberately generous: if any gate
 * were platform-blind, a non-Slack message would find a placement waiting for it and
 * verify. The gates are what keep it out, not a missing snapshot row.
 */
async function boot(agentIds: string[], over: { botShared?: boolean; platforms?: string[] } = {}) {
  const daemon = new Daemon({
    root: scaffold(agentIds),
    hostFactory: () => fakeHost() as any,
    slackAppFactory: fakeSlackAppFactory()
  })
  await daemon.start()
  const placements = agentIds.map((id) => ({
    agentId: id,
    daemonId: 'local-daemon',
    integrationId: `int-${id}-slack`,
    name: id,
    botAppId: OUR_APP,
    // `botShared` is RECOMPUTED by the snapshot from the identities actually present in
    // the conversation, so a shared bot is modeled the way it really is: one bot user id
    // backing several agents, told apart by the slug.
    botUserId: over.botShared ? 'USHARED' : `U${id.replace(/[^a-z0-9]/gi, '').toUpperCase()}`,
    callPolicy: 'all' as const,
    allowedCallerAgentIds: [],
    outboundPolicy: 'all' as const,
    allowedTargetAgentIds: []
  }))
  ;(daemon as any).cpCollab.replace({
    generation: 1,
    channels: (over.platforms ?? PLATFORMS).map((platform) => ({
      orgId: TEST_ORG,
      platform,
      channelId: 'C1',
      agents: placements
    })),
    agents: placements.map((p) => ({ ...p, orgId: TEST_ORG }))
  })
  return daemon
}

/** One finalized agent-authored message, as ingress sees it after normalization. */
const agentMessage = (platform: string, over: Record<string, unknown> = {}) => ({
  msgId: `${platform}:C1:1720000000.000200:final`,
  traceId: 't',
  source: 'user' as const,
  platform,
  channel: 'C1',
  thread: '1720000000.000100',
  sender: { id: 'UBOT', isBot: true, appId: OUR_APP },
  text: 'please verify the rollout',
  mentionedBots: [] as string[],
  isDm: false,
  agentAuthorship: {
    authorAgentId: 'bot-a',
    responseId: 'r-1',
    deliveryState: 'final' as const,
    hopCount: 0,
    mentionedAgentIds: ['bot-b']
  },
  ...over
})

describe('bot-authorship admission is a manifest read (audit F19, sites 1–4)', () => {
  it('admits a managed bot message only where the manifest admits bot senders', async () => {
    const daemon = await boot(['bot-a', 'bot-b'])
    for (const platform of [...PLATFORMS, 'some-future-platform']) {
      const admitted = (daemon as any).isAgentBotMessage(agentMessage(platform))
      // The gate and the manifest are the same fact, checked two ways so a manifest flip
      // and a code change cannot silently disagree.
      expect(admitted).toBe(manifestFor(platform).botSenderRouting)
      expect(admitted).toBe(platform === 'slack')
    }
    await daemon.stop()
  })

  it('verifies an author only where the manifest admits bot senders', async () => {
    const daemon = await boot(['bot-a', 'bot-b'])
    for (const platform of [...PLATFORMS, 'some-future-platform']) {
      const verified = (daemon as any).verifyAgentAuthor(agentMessage(platform))
      expect(verified === null).toBe(!manifestFor(platform).botSenderRouting)
    }
    expect((daemon as any).verifyAgentAuthor(agentMessage('slack'))).toMatchObject({
      authorAgentId: 'bot-a',
      orgId: TEST_ORG,
      sourceHopCount: 0
    })
    await daemon.stop()
  })

  it('still drops a THIRD-PARTY bot on the admitting platform', async () => {
    // The regression that a careless generalization would introduce. `botSenderRouting`
    // says "bot messages may be considered here", never "this bot is ours" — the app
    // identity check is what decides that, and it must still reject a foreign app.
    const daemon = await boot(['bot-a', 'bot-b'])
    const foreign = agentMessage('slack', { sender: { id: 'UOTHER', isBot: true, appId: 'ASOMEONEELSE' } })
    expect((daemon as any).isAgentBotMessage(foreign)).toBe(false)
    expect((daemon as any).verifyAgentAuthor(foreign)).toBeNull()
    // …and with no app id at all (a bot whose event carries none).
    const anonymous = agentMessage('slack', { sender: { id: 'UNOBODY', isBot: true } })
    expect((daemon as any).isAgentBotMessage(anonymous)).toBe(false)
    await daemon.stop()
  })

  it('consults the app-identity and placement indexes under the MESSAGE’s platform', async () => {
    // Sites 1 and 4 were literal `'slack'` directory keys. The collaboration snapshot is
    // keyed per (platform, channel), so a snapshot that knows this app on Telegram only
    // must not vouch for a Slack message — nor the reverse.
    const daemon = await boot(['bot-a', 'bot-b'], {
      platforms: ['telegram']
    })
    // Slack admits bot senders, but the app is indexed under Telegram, so nothing vouches
    // for the sender and the message is not ours.
    expect((daemon as any).isAgentBotMessage(agentMessage('slack'))).toBe(false)
    expect((daemon as any).verifyAgentAuthor(agentMessage('slack'))).toBeNull()
    // A hardcoded `'slack'` key would have read the wrong index here in both directions.
    expect((daemon as any).cpCollab.isAgentBotApp('telegram', 'C1', OUR_APP)).toBe(true)
    expect((daemon as any).cpCollab.isAgentBotApp('slack', 'C1', OUR_APP)).toBe(false)
    await daemon.stop()
  })
})

describe('compound mention addresses are a platform strategy (audit F19, site 5)', () => {
  it('reports a shared bot’s compound address on Slack and nothing elsewhere', async () => {
    const daemon = await boot(['bot-a', 'bot-b'], {
      botShared: true
    })
    const addresses = (platform: string): string[] =>
      (daemon as any).compoundMentionAddresses('bot-a', { platform, channel: 'C1' })
    expect(addresses('slack').sort()).toEqual(['<@USHARED> bot-a', '<@USHARED> bot-b'])
    for (const platform of ['telegram', 'discord', 'feishu', 'some-future-platform']) {
      // Every platform has the same directory row here — only Slack has an address
      // SHAPE that the splitter could cut, so only Slack reports one.
      expect(addresses(platform)).toEqual([])
    }
    await daemon.stop()
  })

  it('reports nothing for a dedicated bot, whose mention is already indivisible', async () => {
    const daemon = await boot(['bot-a', 'bot-b'])
    expect((daemon as any).compoundMentionAddresses('bot-a', { platform: 'slack', channel: 'C1' })).toEqual([])
    await daemon.stop()
  })
})

describe('verified-target integration lookup follows the message (audit F19, site 6)', () => {
  it('resolves the target’s integration on the message’s own platform', async () => {
    // The literal was `resolveCpAgent(targetAgentId, 'slack')`. `bot-b` is installed on
    // every platform, so a wrong key would still find AN integration — just the wrong
    // one, keying the activation rendezvous under a transport scope the internal wake
    // could never compute.
    const daemon = await boot(['bot-a', 'bot-b'])
    for (const platform of PLATFORMS.filter((p) => p !== 'slack')) installIntegration(daemon, 'bot-b', platform)
    for (const platform of PLATFORMS) {
      expect((daemon as any).resolveCpAgent('bot-b', platform)).toMatchObject({
        integrationId: `int-bot-b-${platform}`,
        platform
      })
    }
    await daemon.stop()
  })

  it('wakes the peer through its Slack integration for a Slack-authored mention', async () => {
    const daemon = await boot(['bot-a', 'bot-b'])
    // The peer bridges several platforms; the Slack-authored message must select its
    // SLACK integration, which is what `msg.platform` (not a literal) delivers.
    for (const platform of PLATFORMS.filter((p) => p !== 'slack')) installIntegration(daemon, 'bot-b', platform)
    const calls: { agentId: string; integrationId?: string }[] = []
    ;(daemon as any).dispatch = vi.fn(async (agentId: string, msg: any, integrationId?: string) => {
      calls.push({ agentId, integrationId })
      return 'acp-1'
    })
    const outcome = await (daemon as any).onInboundOutcome(agentMessage('slack'), ['int-bot-b-slack'])
    expect(outcome.kind).toBe('dispatched')
    expect(calls.map((c) => c.agentId)).toEqual(['bot-b'])
    await daemon.stop()
  })
})

describe('response closure is a turn-output surface member (audit F19, site 7)', () => {
  it('is registered for Slack only, and never inherited by a core-rendered origin', async () => {
    const daemon = await boot(['bot-a'])
    const surfaces = (daemon as any).turnSurfaces
    expect(typeof surfaces.exact('slack')?.closeResponse).toBe('function')
    for (const platform of ['telegram', 'discord', 'feishu']) {
      expect(surfaces.exact(platform)?.closeResponse).toBeUndefined()
    }
    // webchat / hook / dream render through the CORE surface (which is Slack's) but
    // must not inherit its closure — `exact` is what enforces that.
    for (const origin of ['webchat', 'hook', 'dream', 'github', 'some-future-platform']) {
      expect(surfaces.exact(origin)).toBeUndefined()
    }
    await daemon.stop()
  })

  it('re-stamps the delivered Slack answer as final, with the resolved recipients', async () => {
    const daemon = await boot(['bot-a', 'bot-b'])
    const finalizeResponse = vi.fn(async () => true)
    const turn = {
      plan: { platform: 'slack', agentId: 'bot-a', channel: 'C1', sourceHopCount: 1 },
      reply: {
        text: 'done <@UBOTB>',
        responseId: 'r-1',
        lastResponse: { ts: '1720000000.000300', text: 'done <@UBOTB>' }
      },
      conn: { finalizeResponse }
    }
    await (daemon as any).turnSurfaces.exact('slack').closeResponse(turn)
    expect(finalizeResponse).toHaveBeenCalledOnce()
    const [channel, ts, , , agentId, response] = finalizeResponse.mock.calls[0] as unknown as any[]
    expect({ channel, ts, agentId }).toEqual({ channel: 'C1', ts: '1720000000.000300', agentId: 'bot-a' })
    expect(response).toMatchObject({
      responseId: 'r-1',
      deliveryState: 'final',
      hopCount: 1,
      // Resolved from the COMPLETE reply text against the conversation directory, with
      // the author removed.
      mentionedAgentIds: ['bot-b'],
      addressedAnyone: true
    })
    await daemon.stop()
  })

  it('is a no-op for a turn with no live connection', async () => {
    const daemon = await boot(['bot-a'])
    await expect(
      (daemon as any).turnSurfaces.exact('slack').closeResponse({ platform: 'slack', agentId: 'bot-a', channel: 'C1' })
    ).resolves.toBeUndefined()
    await daemon.stop()
  })

  it('prepares the closing routing facts from the complete reply and the directory', async () => {
    const daemon = await boot(['bot-a', 'bot-b'])
    const turn = {
      plan: { platform: 'slack', agentId: 'bot-a', channel: 'C1' },
      reply: { text: 'done <@UBOTB>', responseId: 'r-1' },
      conn: {}
    }
    ;(daemon as any).turnSurfaces.exact('slack').prepareResponseClosure(turn)
    expect((turn.reply as any).finalRouting).toEqual({
      mentionedAgentIds: ['bot-b'],
      addressedAnyone: true,
      hasPeers: true,
      peerSharesBot: false
    })
    await daemon.stop()
  })

  it('marks the peer as sharing the bot when both agents post under one identity', async () => {
    // A shared-bot peer's ingress admits only the closing edit past its self-echo
    // filter, so this flag is what keeps the re-stamp for those conversations.
    const daemon = await boot(['bot-a', 'bot-b'], { botShared: true })
    const turn = {
      plan: { platform: 'slack', agentId: 'bot-a', channel: 'C1' },
      reply: { text: 'done', responseId: 'r-1' },
      conn: {}
    }
    ;(daemon as any).turnSurfaces.exact('slack').prepareResponseClosure(turn)
    expect((turn.reply as any).finalRouting).toMatchObject({ hasPeers: true, peerSharesBot: true })
    await daemon.stop()
  })

  it('skips the closing edit entirely when no peer agent shares the conversation', async () => {
    // The single-agent conversation is the common case, and the final event has no
    // consumer there — re-stamping would only mark the visible reply "(edited)".
    const daemon = await boot(['bot-a'])
    const finalizeResponse = vi.fn(async () => true)
    const turn = {
      plan: { platform: 'slack', agentId: 'bot-a', channel: 'C1' },
      reply: { text: 'done', responseId: 'r-1', lastResponse: { ts: '1720000000.000300', text: 'done' } },
      conn: { finalizeResponse }
    }
    const surface = (daemon as any).turnSurfaces.exact('slack')
    surface.prepareResponseClosure(turn)
    expect((turn.reply as any).finalRouting).toMatchObject({ hasPeers: false })
    await surface.closeResponse(turn)
    expect(finalizeResponse).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('closes with the PREPARED routing facts rather than re-resolving them', async () => {
    const daemon = await boot(['bot-a', 'bot-b'])
    const finalizeResponse = vi.fn(async () => true)
    const turn = {
      plan: { platform: 'slack', agentId: 'bot-a', channel: 'C1', sourceHopCount: 0 },
      reply: {
        text: 'done',
        responseId: 'r-1',
        lastResponse: { ts: '1720000000.000300', text: 'done' },
        // Deliberately different from what the text would resolve to, so the assertion
        // proves the prepared set wins over a recompute. `peerSharesBot` also pins that
        // a shared-bot conversation still closes through the edit.
        finalRouting: { mentionedAgentIds: ['bot-b'], addressedAnyone: true, hasPeers: true, peerSharesBot: true }
      },
      conn: { finalizeResponse }
    }
    await (daemon as any).turnSurfaces.exact('slack').closeResponse(turn)
    const [, , , , , response] = finalizeResponse.mock.calls[0] as unknown as any[]
    expect(response).toMatchObject({ mentionedAgentIds: ['bot-b'], addressedAnyone: true })
    await daemon.stop()
  })

  it('does not re-edit an answer whose terminal section was born final', async () => {
    const daemon = await boot(['bot-a', 'bot-b'])
    const finalizeResponse = vi.fn(async () => true)
    const turn = {
      plan: { platform: 'slack', agentId: 'bot-a', channel: 'C1' },
      reply: {
        text: 'done',
        responseId: 'r-1',
        lastResponse: { ts: '1720000000.000300', text: 'done' },
        finalStamped: '1720000000.000300',
        finalRouting: { mentionedAgentIds: [], addressedAnyone: false, hasPeers: true, peerSharesBot: false }
      },
      conn: { finalizeResponse }
    }
    await (daemon as any).turnSurfaces.exact('slack').closeResponse(turn)
    expect(finalizeResponse).not.toHaveBeenCalled()
    await daemon.stop()
  })
})
