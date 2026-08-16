import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planChannelIntros, buildIntroMessage, introPrompt, INTRO_MAX_BURST } from '../src/agents/channel-intro.js'
import { Daemon } from '../src/daemon.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const state = (seeded: boolean, introduced: string[] = []) => ({ seeded, introduced: new Set(introduced) })

describe('planChannelIntros', () => {
  it('seeds the first snapshot silently (no intros), adopting every channel as baseline', () => {
    const plan = planChannelIntros(state(false), ['C1', 'C2', 'C3'])
    expect(plan.markSeeded).toBe(true)
    expect(plan.introduce).toEqual([])
    expect(plan.adoptSilently).toEqual(['C1', 'C2', 'C3'])
  })

  it('introduces only channels that appear AFTER the baseline', () => {
    const plan = planChannelIntros(state(true, ['C1', 'C2']), ['C1', 'C2', 'C3'])
    expect(plan.markSeeded).toBe(false)
    expect(plan.introduce).toEqual(['C3'])
    expect(plan.adoptSilently).toEqual([])
  })

  it('is a no-op when nothing new appeared', () => {
    const plan = planChannelIntros(state(true, ['C1', 'C2']), ['C1', 'C2'])
    expect(plan).toEqual({ markSeeded: false, introduce: [], adoptSilently: [] })
  })

  it('treats a channel dropping out (bot removed) as a no-op, not an intro', () => {
    const plan = planChannelIntros(state(true, ['C1', 'C2']), ['C1'])
    expect(plan.introduce).toEqual([])
    expect(plan.adoptSilently).toEqual([])
  })

  it('adopts a burst larger than the threshold silently instead of storming peers', () => {
    const fresh = Array.from({ length: INTRO_MAX_BURST + 1 }, (_, i) => `N${i}`)
    const plan = planChannelIntros(state(true, ['C1']), ['C1', ...fresh])
    expect(plan.introduce).toEqual([])
    expect(plan.adoptSilently).toEqual(fresh)
  })

  it('introduces up to the burst threshold', () => {
    const fresh = Array.from({ length: INTRO_MAX_BURST }, (_, i) => `N${i}`)
    const plan = planChannelIntros(state(true, []), fresh)
    // seeded=true so this is a genuine batch of joins at exactly the threshold
    expect(plan.introduce).toEqual(fresh)
    expect(plan.adoptSilently).toEqual([])
  })

  it('dedupes duplicate channel ids in the snapshot', () => {
    const plan = planChannelIntros(state(true, []), ['C1', 'C1'])
    expect(plan.introduce).toEqual(['C1'])
  })
})

describe('buildIntroMessage', () => {
  it('builds a headless root turn keyed to the REAL channel so peer defaults resolve', () => {
    const msg = buildIntroMessage('bot-a', 'slack', 'C1', 'trace-1')
    expect(msg.headless).toBe(true)
    expect(msg.source).toBe('cron')
    expect(msg.platform).toBe('slack')
    // keyed to the REAL channel (headless ⇒ no channel output; ctx.channel drives
    // sendMessage defaults and gives peers a real channel to inherit)
    expect(msg.channel).toBe('C1')
    // a distinct synthetic thread === transcriptTs (root) so no thread-history backfill runs
    expect(msg.thread).toBe(msg.transcriptTs)
    expect(msg.thread).toBe('intro:C1:trace-1')
    expect(msg.text).toContain('bot-a')
    expect(msg.text).toContain('listAgents')
    // Waking a peer is now a complete sendMessage agent-target call (a silent wake), not messageAgent.
    expect(msg.text).toContain('sendMessage')
    expect(msg.text).toContain('{"toAgent":"<their id>","message":"<short introduction>"}')
    expect(msg.text).not.toContain('messageAgent')
  })
})

describe('introPrompt', () => {
  it('bounds the turn to introducing only', () => {
    const p = introPrompt('C1', 'bot-a')
    expect(p).toContain('Introduce yourself ONLY')
    expect(p).toContain('do not post to the channel')
  })

  // `listAgents` now defaults to the whole ORG directory, so the discovery step MUST pin
  // the channel explicitly — otherwise one channel join fans an intro out to every agent
  // in the organization.
  it('pins discovery to THIS channel with an explicit filter (never the org-wide default)', () => {
    const p = introPrompt('C1', 'bot-a')
    expect(p).toContain('`listAgents`')
    expect(p).toContain('{"channel":"C1"}')
    expect(p).not.toContain('listChannelAgents')
    expect(p).not.toContain('defaults to this channel')
  })

  it('gives a complete sendMessage agent-target call (silent wake), not dotted pseudo-syntax', () => {
    const p = introPrompt('C1', 'bot-a')
    expect(p).toContain('sendMessage')
    expect(p).toContain('{"toAgent":"<their id>","message":"<short introduction>"}')
    expect(p).toContain('silent wake')
    expect(p).not.toContain('`toAgent`') // a complete call, never dotted pseudo-syntax
    expect(p).not.toContain('messageAgent')
  })
})

/**
 * The prompt above asks the model for a channel filter; this is the part that does not
 * depend on the model obeying. The dispatched intro turn carries `introChannel` on its
 * trusted CallMeta, which the daemon's `channelAgents` dep turns into a forced filter —
 * without it the org-wide default would wake every agent in the org on one channel join.
 */
describe('Daemon.maybeIntroduceOnJoin: the intro turn carries its own discovery bound', () => {
  function scaffold(): string {
    const root = mkdtempSync(join(tmpdir(), 'ac-daemon-intro-'))
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
        // No integration on disk: the in-memory record below stands in for one, so the
        // test never opens a real Slack socket.
        integrations: [],
        output: { mode: 'low' }
      })
    )
    return root
  }

  it('stamps the joined channel on the dispatched turn’s CallMeta', async () => {
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => ({}) as never
    })
    await daemon.start()
    const agent = (daemon as never as { agents: Map<string, Record<string, unknown>> }).agents.get('bot-a')!
    agent.integrations = [{ id: 'int-1', platform: 'slack' }]
    agent.introduceOnJoin = true
    const calls: { agentId: string; msg: { channel: string }; callMeta?: { introChannel?: string } }[] = []
    ;(daemon as never as { dispatch: unknown }).dispatch = async (
      agentId: string,
      msg: { channel: string },
      _integrationId?: string,
      _wc?: unknown,
      callMeta?: { introChannel?: string }
    ) => {
      calls.push({ agentId, msg, callMeta })
      return 'acp-1'
    }
    const introduce = (channels: string[]): void =>
      (
        daemon as never as { maybeIntroduceOnJoin: (p: string, i: string, c: { id: string }[]) => void }
      ).maybeIntroduceOnJoin(
        // The caller (Slack's authoritative-snapshot refresh) names its platform as data.
        'slack',
        'int-1',
        channels.map((id) => ({ id }))
      )
    // First snapshot seeds the baseline silently; only a LATER channel is a genuine join.
    introduce(['C_OLD'])
    expect(calls).toHaveLength(0)
    introduce(['C_OLD', 'C_JOINED'])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.msg.channel).toBe('C_JOINED')
    // THE bound: peer discovery in this turn is pinned to the joined channel in CODE.
    expect(calls[0]!.callMeta?.introChannel).toBe('C_JOINED')
    await daemon.stop()
  })
})
