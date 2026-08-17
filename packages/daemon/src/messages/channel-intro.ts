import type { NormalizedMessage } from './normalized.js'

/**
 * Self-introduce-on-channel-join (issue #536).
 *
 * When an agent genuinely JOINS a channel, it proactively introduces itself to the
 * other agents already there (via `listAgents` FILTERED to that channel → a `sendMessage`
 * wake) so those peers can record it in their memory and know who to delegate to later.
 * The filter is load-bearing: `listAgents` is org-wide by default. This module
 * is the pure decision layer + the synthetic-turn builder; the daemon wires the
 * durable state and dispatch around it (see Daemon.maybeIntroduceOnJoin).
 *
 * The whole feature is opt-in per agent (`agent.introduceOnJoin`, default off).
 */

/** A batch this large in one snapshot is far more likely a re-list / bulk invite than
 *  genuine one-at-a-time joins — adopt it silently rather than message every peer. */
export const INTRO_MAX_BURST = 3

export interface ChannelIntroState {
  /**
   * Has this integration's channel membership already been baselined (seeded)?
   * The FIRST snapshot per integration seeds silently (no intros) so that enabling
   * the feature — or a daemon restart / socket reconnect that re-lists every channel
   * the bot is already in — never storms peers. Only channels that appear in a LATER
   * snapshot count as genuine joins.
   */
  seeded: boolean
  /** Channels (for this agent+platform) already introduced-in or adopted as baseline. */
  introduced: ReadonlySet<string>
}

export interface ChannelIntroPlan {
  /** Persist the per-integration seed marker after applying this plan. */
  markSeeded: boolean
  /** Channels the agent should post a self-introduction into (a genuine new join). */
  introduce: string[]
  /** Channels to mark introduced WITHOUT introducing — the initial baseline, or a
   *  burst larger than the threshold, adopted silently so it never fires again. */
  adoptSilently: string[]
}

/**
 * Decide what to do with one channel-membership snapshot. Pure — the caller supplies
 * the durable state (is the integration seeded, which channels are already known) and
 * applies the returned plan back to the store.
 */
export function planChannelIntros(
  state: ChannelIntroState,
  channels: readonly string[],
  opts: { maxBurst?: number } = {}
): ChannelIntroPlan {
  const maxBurst = opts.maxBurst ?? INTRO_MAX_BURST
  const fresh = [...new Set(channels)].filter((c) => !state.introduced.has(c))
  // First snapshot for this integration: adopt every current channel as the baseline
  // (no intros), so only channels joined AFTERWARD trigger one.
  if (!state.seeded) return { markSeeded: true, introduce: [], adoptSilently: fresh }
  if (fresh.length === 0) return { markSeeded: false, introduce: [], adoptSilently: [] }
  if (fresh.length > maxBurst) return { markSeeded: false, introduce: [], adoptSilently: fresh }
  return { markSeeded: false, introduce: fresh, adoptSilently: [] }
}

/** The one-shot instruction the joining agent runs. The turn is keyed to the REAL
 *  channel (but headless — no channel output) so `sendMessage` defaults to it, and the
 *  discovery step pins `listAgents` to that channel EXPLICITLY: `listAgents` now
 *  defaults to the whole ORG directory, and an unfiltered call would fan an
 *  introduction out to every agent in the organization on one channel join.
 *  BELT AND BRACES — the instruction is not the bound: the daemon FORCES this channel as
 *  the directory filter for an intro turn from the turn's trusted `CallMeta.introChannel`,
 *  so a model that ignores (or rewrites) the argument still discovers only these peers.
 *  Deliberately tightly bounded: introduce, then stop. */
export function introPrompt(channel: string, agentId: string): string {
  return [
    `You've just joined the channel \`${channel}\`. Introduce yourself to the OTHER agents ` +
      `there so they can note who you are and delegate work to you later.`,
    ``,
    `Do exactly this and nothing else:`,
    `1. Call \`listAgents\` with the exact shape \`{"channel":"${channel}"}\` — the channel filter is REQUIRED ` +
      `here, so you introduce yourself only to the agents in THIS channel — to see who else is here (ignore yourself).`,
    `2. For EACH other agent, call \`sendMessage\` with the exact shape ` +
      `\`{"toAgent":"<their id>","message":"<short introduction>"}\` (dm form — no \`channel\`, so it is a ` +
      `silent wake). The introduction should contain your name, one line on what you do, and that they can reach ` +
      `you with \`{"toAgent":"${agentId}","message":"..."}\` or an @mention. Ask them to note you in ` +
      `their memory and tell them no reply is needed.`,
    ``,
    `Introduce yourself ONLY — do not post to the channel, do not @mention or ping any human, and ` +
      `do not start any task or ask questions. If \`listAgents\` returns no other agents, do nothing.`
  ].join('\n')
}

/**
 * Build the HEADLESS turn that runs the introduction. It reuses the proven cron-style
 * trigger shape (`source:'cron'`) but is dispatched directly (never a real cron, so it
 * emits no cron/report). `headless` suppresses all channel output — the agent introduces
 * itself purely through `sendMessage` (silent `toAgent` dm-form wakes), and (via the caller turn's
 * `deliverHeadless` callMeta) the woken peers run headless too, recording it silently.
 *
 * The turn is keyed to the REAL `channel` so `ctx.channel` drives the `sendMessage`
 * defaults (and the `listAgents` channel filter the prompt passes explicitly) and peer
 * turns inherit a REAL channel (never a synthetic key that a peer would fail to post
 * to). A distinct synthetic `thread`, equal to
 * `transcriptTs`, keeps it a root message (no thread-history backfill) on its own session.
 */
export function buildIntroMessage(
  agentId: string,
  platform: NormalizedMessage['platform'],
  channel: string,
  traceId: string
): NormalizedMessage {
  const root = `intro:${channel}:${traceId}`
  return {
    msgId: root,
    transcriptTs: root,
    traceId,
    source: 'cron',
    platform,
    channel,
    thread: root,
    sender: { id: `intro:${agentId}`, isBot: false },
    text: introPrompt(channel, agentId),
    mentionedBots: [],
    isDm: false,
    trigger: 'auto',
    headless: true
  }
}
