import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CpCollabRoutes } from '../../src/cp/cp-collab-routes.js'
import { Daemon } from '../../src/daemon.js'
import { sessionKey } from '../../src/store/local-store.js'

/**
 * Org-scoped peer directory: `CpCollabRoutes.admits()` is THE agent-call authorization
 * predicate (channel membership is only a discovery filter), plus the daemon-side
 * `agent-directory-org-scope-v1` negotiation that keeps an older CP working.
 */

const ORG = 'org_a'
const OTHER_ORG = 'org_b'

const agent = (agentId: string, over: Record<string, unknown> = {}) => ({
  agentId,
  daemonId: 'd1',
  orgId: ORG,
  callPolicy: 'all' as const,
  allowedCallerAgentIds: [] as string[],
  outboundPolicy: 'all' as const,
  allowedTargetAgentIds: [] as string[],
  ...over
})

const routes = (agents: ReturnType<typeof agent>[], channels: unknown[] = []): CpCollabRoutes => {
  const r = new CpCollabRoutes()
  r.replace({ generation: 1, channels, agents } as never)
  return r
}

describe('CpCollabRoutes: org-scoped directory', () => {
  it('admits a pair whose policies are both "all", in either direction', () => {
    const r = routes([agent('a'), agent('b')])
    expect(r.admits('a', 'b')).toBe(true)
    expect(r.admits('b', 'a')).toBe(true)
    expect(r.orgForAgent('a')).toBe(ORG)
    expect(r.agent('b')?.daemonId).toBe('d1')
  })

  it('needs BOTH directions: the target inbound policy and the caller outbound policy', () => {
    const inbound = routes([agent('a'), agent('b', { callPolicy: 'selected', allowedCallerAgentIds: ['c'] })])
    expect(inbound.admits('a', 'b')).toBe(false)
    expect(
      routes([agent('a'), agent('b', { callPolicy: 'selected', allowedCallerAgentIds: ['a'] })]).admits('a', 'b')
    ).toBe(true)

    const outbound = routes([agent('a', { outboundPolicy: 'selected', allowedTargetAgentIds: ['c'] }), agent('b')])
    expect(outbound.admits('a', 'b')).toBe(false)
    expect(
      routes([agent('a', { outboundPolicy: 'selected', allowedTargetAgentIds: ['b'] }), agent('b')]).admits('a', 'b')
    ).toBe(true)
  })

  it('always resolves the caller ITSELF, even under a selected policy that omits it', () => {
    // An agent restricted in both directions does not list itself in its own allow-lists,
    // yet it must still appear in its own directory listing.
    const r = routes([
      agent('a', {
        callPolicy: 'selected',
        allowedCallerAgentIds: ['z'],
        outboundPolicy: 'selected',
        allowedTargetAgentIds: ['z']
      })
    ])
    expect(r.admits('a', 'a')).toBe(true)
  })

  it('never resolves across organizations, whatever the policies say', () => {
    const r = routes([agent('a'), agent('b', { orgId: OTHER_ORG })])
    expect(r.admits('a', 'b')).toBe(false)
    expect(r.admits('b', 'a')).toBe(false)
  })

  it('fails CLOSED when either agent is unknown, or the snapshot is empty', () => {
    const r = routes([agent('a')])
    expect(r.admits('a', 'ghost')).toBe(false)
    expect(r.admits('ghost', 'a')).toBe(false)
    expect(r.orgForAgent('ghost')).toBeUndefined()
    expect(new CpCollabRoutes().admits('a', 'b')).toBe(false)
  })

  it('OLD CP (no flat agents[]): derives the directory from the channel entries', () => {
    // Channel entries carry orgId + placements, so integration-backed agents stay callable —
    // even across two different channels, since membership is no longer a gate.
    const r = new CpCollabRoutes()
    r.replace({
      generation: 1,
      channels: [
        { orgId: ORG, platform: 'slack', channelId: 'C1', agents: [agent('a')] },
        { orgId: ORG, platform: 'slack', channelId: 'C2', agents: [agent('b')] },
        { orgId: OTHER_ORG, platform: 'slack', channelId: 'C9', agents: [agent('x', { orgId: OTHER_ORG })] }
      ]
    } as never)
    expect(r.admits('a', 'b')).toBe(true)
    expect(r.orgForAgent('b')).toBe(ORG)
    expect(r.admits('a', 'x')).toBe(false)
    // The channel-keyed lookups other call sites use keep working, so coordinate integrity
    // is enforced against an old CP's derived snapshot exactly as against a current one.
    expect(r.coordsDecision(ORG, 'slack', 'C1', 'a')).toEqual({ verdict: 'asserted' })
    expect(r.coordsDecision(ORG, 'slack', 'C1', 'b')).toEqual({ verdict: 'reject' })
  })

  it('coordsDecision: KNOWN coordinate ⇒ membership required, and it is used as asserted', () => {
    // Branch 1. An EMPTY row is not "known" — nobody in this org can reach it, so gating on
    // it would protect nothing (it falls through to the unknown-coordinate branches).
    const r = new CpCollabRoutes()
    r.replace({
      generation: 1,
      channels: [
        { orgId: ORG, platform: 'slack', channelId: 'C1', agents: [agent('a')] },
        { orgId: ORG, platform: 'slack', channelId: 'C_EMPTY', agents: [] }
      ],
      agents: [agent('a'), agent('b')]
    } as never)
    expect(r.coordsDecision(ORG, 'slack', 'C1', 'a')).toEqual({ verdict: 'asserted' })
    // 'b' is a callable directory-only peer, but it cannot ASSERT C1 as a coordinate.
    expect(r.coordsDecision(ORG, 'slack', 'C1', 'b')).toEqual({ verdict: 'reject' })
    // Org-scoped like every other lookup here: another org's row is not this org's coordinate,
    // so this is an UNKNOWN slack coordinate — which now fails closed rather than passing.
    expect(r.coordsDecision(OTHER_ORG, 'slack', 'C1', 'b')).toEqual({ verdict: 'reject' })
    // A directory-only agent (no channel row) is callable but reaches no channel coordinate.
    expect(r.resolve(ORG, 'slack', 'C1', 'b')).toBeUndefined()
  })

  it('coordsDecision: an UNKNOWN coordinate on a PERSISTED IM platform FAILS CLOSED', () => {
    // Branch 2 — the review finding. "Unknown ⇒ pass" admitted not only channel-free
    // coordinates but Slack DMs/group DMs and channels whose row has since disappeared, which
    // is exactly how a caller lands on an EXISTING platform session of the target and, with
    // `needsReply`, reads it back. An unrecorded IM coordinate is now refused on every one of
    // the four persisted platforms; a transient snapshot lag rejecting a genuine wake is the
    // correct direction, and the caller retries.
    const r = new CpCollabRoutes()
    r.replace({
      generation: 1,
      channels: [{ orgId: ORG, platform: 'slack', channelId: 'C1', agents: [agent('a')] }],
      agents: [agent('a'), agent('b')]
    } as never)
    for (const platform of ['slack', 'telegram', 'discord', 'feishu']) {
      expect(r.coordsDecision(ORG, platform, 'C_NEVER_SEEN', 'a')).toEqual({ verdict: 'reject' })
      expect(r.coordsDecision(ORG, platform, 'D0PPELGANGER', 'a')).toEqual({ verdict: 'reject' })
    }
  })

  it('coordsDecision: a DM row the caller owns is KNOWN, so DM-origin A2A keeps working', () => {
    // The over-block guard. A DM or group DM is an ORDINARY channel row wherever one exists —
    // `IntegrationChannel.kind` is `channel | im | mpim` and `channelPlacements` selects with
    // no `kind` filter — so branch 1 covers it and fail-closed does not strand a caller whose
    // session lives in a recorded DM. (Such a row is only written for a GATED integration's
    // not-yet-enabled conversations; an ungated integration's DM has none and takes branch 2,
    // which is what the channel-membership check this replaced did too — §2.7 item 5.) This
    // case therefore only goes red if that premise breaks, which is exactly what it guards.
    const r = new CpCollabRoutes()
    r.replace({
      generation: 1,
      channels: [
        { orgId: ORG, platform: 'slack', channelId: 'D01ALICE', agents: [agent('a')] }, // a "D…" DM row
        { orgId: ORG, platform: 'slack', channelId: 'G01TEAM', agents: [agent('a')] } // an mpim row
      ],
      agents: [agent('a'), agent('b')]
    } as never)
    expect(r.coordsDecision(ORG, 'slack', 'D01ALICE', 'a')).toEqual({ verdict: 'asserted' })
    expect(r.coordsDecision(ORG, 'slack', 'G01TEAM', 'a')).toEqual({ verdict: 'asserted' })
    // …and someone else's DM is still not assertable.
    expect(r.coordsDecision(ORG, 'slack', 'D01ALICE', 'b')).toEqual({ verdict: 'reject' })
  })

  it('coordsDecision: an UNKNOWN channel-free coordinate is admitted with a CALLER-derived channel', () => {
    // Branch 3 — the feature this rule exists to keep alive. A webchat/dream/hook session has
    // no channel row at all, so rejecting would kill channel-free collaboration; instead the
    // asserted channel never becomes the session coordinate. `a2a:<caller>` cannot collide
    // with a real conversation id (no platform channel id contains ':'), so two different
    // asserted channels from one caller collapse onto ONE pairwise session.
    const r = new CpCollabRoutes()
    r.replace({
      generation: 1,
      channels: [{ orgId: ORG, platform: 'slack', channelId: 'C1', agents: [agent('a')] }],
      agents: [agent('a'), agent('b')]
    } as never)
    expect(r.coordsDecision(ORG, 'webchat', 'wc-1', 'a')).toEqual({ verdict: 'synthetic', channel: 'a2a:a' })
    expect(r.coordsDecision(ORG, 'webchat', 'wc-2', 'a')).toEqual({ verdict: 'synthetic', channel: 'a2a:a' })
    expect(r.coordsDecision(ORG, 'dream', 'memory', 'a')).toEqual({ verdict: 'synthetic', channel: 'a2a:a' })
    expect(r.coordsDecision(ORG, 'hook', 'hook-id-1', 'a')).toEqual({ verdict: 'synthetic', channel: 'a2a:a' })
    // A KNOWN row still wins: relabelling a real channel as channel-free is not an escape —
    // branch 1 runs first and is platform-free.
    expect(r.coordsDecision(ORG, 'webchat', 'C1', 'b')).toEqual({ verdict: 'reject' })
  })

  it('coordsDecision ignores the coordinate PLATFORM when LOOKING UP the row', () => {
    // `Daemon.narrowPlatform` folds `feishu` (and any unrecognised value) into 'slack' when
    // computing the woken session key, while snapshot rows are keyed by the INTEGRATION
    // platform. A platform-keyed lookup therefore searched a different key space than the key
    // it protects, and "unknown coordinate passes" swallowed the mismatch in BOTH directions.
    const r = new CpCollabRoutes()
    r.replace({
      generation: 1,
      channels: [
        { orgId: ORG, platform: 'slack', channelId: 'C_EXECS', agents: [agent('b')] },
        { orgId: ORG, platform: 'feishu', channelId: 'oc_execs', agents: [agent('b')] }
      ],
      agents: [agent('a'), agent('b')]
    } as never)
    // (1) A Slack row asserted as 'feishu' coords — still that Slack channel's coordinate.
    expect(r.coordsDecision(ORG, 'feishu', 'C_EXECS', 'a')).toEqual({ verdict: 'reject' })
    expect(r.coordsDecision(ORG, 'feishu', 'C_EXECS', 'b')).toEqual({ verdict: 'asserted' })
    // (2) The mirror: a Feishu org, where an honest daemon narrows its own coords to 'slack'.
    expect(r.coordsDecision(ORG, 'slack', 'oc_execs', 'a')).toEqual({ verdict: 'reject' })
    expect(r.coordsDecision(ORG, 'slack', 'oc_execs', 'b')).toEqual({ verdict: 'asserted' })
    // (3) …and the channel-free label does not dodge either row.
    expect(r.coordsDecision(ORG, 'webchat', 'C_EXECS', 'a')).toEqual({ verdict: 'reject' })
    expect(r.coordsDecision(ORG, 'webchat', 'oc_execs', 'a')).toEqual({ verdict: 'reject' })
  })

  it('coordsDecision accepts membership in ANY platform row sharing one channel id', () => {
    // Two platforms colliding on one channel id inside one org is not a real configuration,
    // but the rule must stay a membership test rather than an accidental reject-all.
    const r = new CpCollabRoutes()
    r.replace({
      generation: 1,
      channels: [
        { orgId: ORG, platform: 'slack', channelId: 'SHARED', agents: [agent('a')] },
        { orgId: ORG, platform: 'telegram', channelId: 'SHARED', agents: [agent('b')] }
      ],
      agents: [agent('a'), agent('b')]
    } as never)
    expect(r.coordsDecision(ORG, 'slack', 'SHARED', 'a')).toEqual({ verdict: 'asserted' })
    expect(r.coordsDecision(ORG, 'slack', 'SHARED', 'b')).toEqual({ verdict: 'asserted' })
    expect(r.coordsDecision(ORG, 'slack', 'SHARED', 'c')).toEqual({ verdict: 'reject' })
  })

  it('FULL-REPLACE rebuilds the coordinate index too', () => {
    const r = new CpCollabRoutes()
    r.replace({
      generation: 1,
      channels: [{ orgId: ORG, platform: 'slack', channelId: 'C1', agents: [agent('a')] }],
      agents: [agent('a'), agent('b')]
    } as never)
    expect(r.coordsDecision(ORG, 'slack', 'C1', 'b')).toEqual({ verdict: 'reject' })
    // The channel is gone from the newer snapshot — the stale row must not linger. It becomes
    // an UNKNOWN slack coordinate, which fails closed for a different reason; the point is
    // that the index no longer holds the departed row.
    r.replace({ generation: 2, channels: [], agents: [agent('a'), agent('b')] } as never)
    expect(r.coordsDecision(ORG, 'slack', 'C1', 'b')).toEqual({ verdict: 'reject' })
    expect(r.coordsDecision(ORG, 'webchat', 'C1', 'b')).toEqual({ verdict: 'synthetic', channel: 'a2a:b' })
  })

  it('FULL-REPLACE applies to the flat index too — a later snapshot drops removed agents', () => {
    const r = routes([agent('a'), agent('b')])
    r.replace({ generation: 2, channels: [], agents: [agent('a')] } as never)
    expect(r.admits('a', 'b')).toBe(false)
    expect(r.orgForAgent('b')).toBeUndefined()
  })
})

/** Minimal daemon root — enough to boot and read the MCP deps bundle. */
function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-daemon-directory-'))
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
      integrations: [],
      output: { mode: 'low' }
    })
  )
  return root
}

describe("daemon channelAgents dep: 'agent-directory-org-scope-v1' negotiation", () => {
  async function bootWithCp(supports: boolean) {
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => ({}) as never })
    await daemon.start()
    const sent: unknown[] = []
    ;(daemon as never as { cpClient: unknown }).cpClient = {
      stop: vi.fn(async () => {}),
      supportsServerFeature: (feature: string) => supports && feature === 'agent-directory-org-scope-v1',
      channelAgents: async (payload: { channel?: string }) => {
        sent.push(payload)
        return {
          platform: 'slack',
          ...(payload.channel !== undefined ? { channel: payload.channel } : {}),
          agents: [{ agentId: 'peer-1', name: 'peer', displayName: 'Peer', status: 'active' as const }]
        }
      }
    }
    const dep = (daemon as never as { mcp: { deps: { channelAgents: (req: unknown) => Promise<unknown> } } }).mcp.deps
      .channelAgents
    return { daemon, sent, dep }
  }

  it('sends a channel-LESS request when the CP advertises the feature', async () => {
    const { daemon, sent, dep } = await bootWithCp(true)
    const ok = (await dep({
      platform: 'slack',
      currentChannel: 'C_CURRENT',
      requesterAgentId: 'bot-a'
    })) as { channel?: string }
    expect(sent).toEqual([{ platform: 'slack', requesterAgentId: 'bot-a' }])
    expect(ok.channel).toBeUndefined()
    // The peer's directory name is still cached for caller-framed delivery text.
    expect((daemon as never as { channelAgentNames: Map<string, unknown> }).channelAgentNames.get('peer-1')).toEqual({
      name: 'peer',
      displayName: 'Peer'
    })
    await daemon.stop()
  })

  it('substitutes the caller CURRENT channel against an old CP (never a payload it would reject)', async () => {
    const { daemon, sent, dep } = await bootWithCp(false)
    await dep({ platform: 'slack', currentChannel: 'C_CURRENT', requesterAgentId: 'bot-a' })
    expect(sent).toEqual([{ platform: 'slack', requesterAgentId: 'bot-a', channel: 'C_CURRENT' }])
    await daemon.stop()
  })

  it('passes an explicitly requested channel filter through to either CP', async () => {
    for (const supports of [true, false]) {
      const { daemon, sent, dep } = await bootWithCp(supports)
      await dep({ platform: 'slack', channel: 'C_OTHER', currentChannel: 'C_CURRENT', requesterAgentId: 'bot-a' })
      expect(sent).toEqual([{ platform: 'slack', channel: 'C_OTHER', requesterAgentId: 'bot-a' }])
      await daemon.stop()
    }
  })

  /**
   * #536 fan-out bound. `listAgents` defaults to the whole ORG, so a channel-intro turn
   * that discovered peers org-wide would wake every agent in the organization on one
   * channel join. The prompt asks for a channel filter, but the BOUND has to be in code:
   * the daemon forces the joined channel from the turn's trusted CallMeta.
   */
  describe('self-introduce turn: the joined channel is FORCED, not requested', () => {
    const INTRO_THREAD = 'intro:C_JOINED:trace-1'
    /** Install the active-turn CallMeta `dispatch` would have installed for an intro turn. */
    function markIntroTurn(daemon: unknown, channel: string, thread = INTRO_THREAD): void {
      ;(daemon as { activeTurnCallMeta: Map<string, unknown> }).activeTurnCallMeta.set(
        sessionKey('slack', channel, thread, 'bot-a'),
        { callFrom: 'bot-a', hopCount: 0, deliveryId: 'trace-1', deliverHeadless: true, introChannel: channel }
      )
    }

    it('forces the joined channel when the tool args are EMPTY (model non-compliance)', async () => {
      const { daemon, sent, dep } = await bootWithCp(true)
      markIntroTurn(daemon, 'C_JOINED')
      const ok = (await dep({
        platform: 'slack',
        currentChannel: 'C_JOINED',
        currentThread: INTRO_THREAD,
        requesterAgentId: 'bot-a'
      })) as { channel?: string }
      // NOT the org-wide listing this same request would get on any other turn.
      expect(sent).toEqual([{ platform: 'slack', channel: 'C_JOINED', requesterAgentId: 'bot-a' }])
      expect(ok.channel).toBe('C_JOINED')
      await daemon.stop()
    })

    it('overrides an intro turn that asks for a DIFFERENT channel', async () => {
      const { daemon, sent, dep } = await bootWithCp(true)
      markIntroTurn(daemon, 'C_JOINED')
      await dep({
        platform: 'slack',
        channel: 'C_SOMEWHERE_ELSE',
        currentChannel: 'C_JOINED',
        currentThread: INTRO_THREAD,
        requesterAgentId: 'bot-a'
      })
      expect(sent).toEqual([{ platform: 'slack', channel: 'C_JOINED', requesterAgentId: 'bot-a' }])
      await daemon.stop()
    })

    it('leaves an ORDINARY turn on the same coordinates org-wide', async () => {
      // The bound is per-turn (CallMeta), never per-channel: the agent's normal session in
      // the very same channel still gets the whole org directory.
      const { daemon, sent, dep } = await bootWithCp(true)
      markIntroTurn(daemon, 'C_JOINED')
      await dep({
        platform: 'slack',
        currentChannel: 'C_JOINED',
        currentThread: '900.1',
        requesterAgentId: 'bot-a'
      })
      expect(sent).toEqual([{ platform: 'slack', requesterAgentId: 'bot-a' }])
      await daemon.stop()
    })
  })

  /**
   * An OLD CP throws on a session-identity platform reaching persistence (`toDbPlatform`),
   * and `ws/connection.ts` turns that into close(1011) — the whole daemon↔CP control socket
   * plus every in-flight request. The daemon must never manufacture such a payload; where it
   * cannot ask, it answers locally.
   */
  describe('never sends a request the CP cannot answer', () => {
    it('old CP + webchat session: answers an empty roster LOCALLY, sending nothing', async () => {
      const { daemon, sent, dep } = await bootWithCp(false)
      const ok = (await dep({
        platform: 'webchat',
        currentChannel: 'wc-session-1',
        currentThread: 'wc-session-1',
        requesterAgentId: 'bot-a'
      })) as { platform: string; agents: unknown[] }
      expect(sent).toEqual([])
      expect(ok.platform).toBe('webchat')
      expect(ok.agents).toEqual([])
      await daemon.stop()
    })

    it('old CP + a session that does not know its channel: no channel-LESS request either', async () => {
      // A channel-less REQ is a BAD_PAYLOAD against an old CP, so "I have no channel to
      // narrow to" must not fall through to sending one anyway.
      const { daemon, sent, dep } = await bootWithCp(false)
      const ok = (await dep({ platform: 'slack', requesterAgentId: 'bot-a' })) as {
        platform: string
        channel?: string
        agents: unknown[]
      }
      expect(sent).toEqual([])
      expect(ok).toEqual({ platform: 'slack', agents: [] })
      await daemon.stop()
    })

    it('a channel-FILTERED webchat/dream ask short-circuits locally on ANY CP', async () => {
      // A current CP already answers this with an empty roster (its session-identity
      // short-circuit); deciding it locally makes the answer independent of CP version.
      for (const platform of ['webchat', 'dream']) {
        const { daemon, sent, dep } = await bootWithCp(true)
        const ok = (await dep({
          platform,
          channel: 'not-a-real-channel',
          currentChannel: 'not-a-real-channel',
          currentThread: 't',
          requesterAgentId: 'bot-a'
        })) as { platform: string; channel?: string; agents: unknown[] }
        expect(sent).toEqual([])
        expect(ok).toEqual({ platform, channel: 'not-a-real-channel', agents: [] })
        await daemon.stop()
      }
    })
  })

  /**
   * A hook turn's session platform is 'hook' but it lands on REAL Slack coordinates. Sending
   * `platform:'hook'` with a channel hits the CP's session-identity short-circuit, so the
   * agent is told nobody is there — while the identical call from a Slack-triggered session
   * works. Map the coordinate the way the removed local wake check did.
   */
  describe('hook session: the channel coordinate is a SLACK one', () => {
    it('sends platform slack for a channel-filtered ask, and echoes the session platform back', async () => {
      const { daemon, sent, dep } = await bootWithCp(true)
      const ok = (await dep({
        platform: 'hook',
        channel: 'C_SLACK',
        currentChannel: 'C_SLACK',
        currentThread: '900.1',
        requesterAgentId: 'bot-a'
      })) as { platform: string; channel?: string; agents: unknown[] }
      expect(sent).toEqual([{ platform: 'slack', channel: 'C_SLACK', requesterAgentId: 'bot-a' }])
      // NOT an empty roster: the CP was asked a question it can answer.
      expect(ok.agents).toHaveLength(1)
      // Everything else the agent sees about a hook turn calls it 'hook' — stay coherent.
      expect(ok.platform).toBe('hook')
      expect(ok.channel).toBe('C_SLACK')
      await daemon.stop()
    })

    it('keeps the session platform on the channel-LESS (org-wide) ask, which asserts no coordinate', async () => {
      const { daemon, sent, dep } = await bootWithCp(true)
      await dep({ platform: 'hook', currentChannel: 'C_SLACK', currentThread: '900.1', requesterAgentId: 'bot-a' })
      expect(sent).toEqual([{ platform: 'hook', requesterAgentId: 'bot-a' }])
      await daemon.stop()
    })

    it('old CP + hook session: narrows to the REAL slack channel instead of a fatal payload', async () => {
      const { daemon, sent, dep } = await bootWithCp(false)
      await dep({ platform: 'hook', currentChannel: 'C_SLACK', currentThread: '900.1', requesterAgentId: 'bot-a' })
      expect(sent).toEqual([{ platform: 'slack', channel: 'C_SLACK', requesterAgentId: 'bot-a' }])
      await daemon.stop()
    })
  })
})
