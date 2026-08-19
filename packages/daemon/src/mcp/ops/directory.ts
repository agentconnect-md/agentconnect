import { z } from 'zod'
import type { SessionContext } from './context.js'
import { optionalString, parseArgs } from './args.js'
import type { ChannelAgentsOk, ChannelAgentsReq, Platform } from '@agentconnect.md/protocol'

/** `listAgents` (and its `listChannelAgents` alias) arguments: `channel` is an optional filter. */
export const LIST_AGENTS_ARGS = z.object({ channel: optionalString('channel') })

/**
 * A peer-discovery request, i.e. `ChannelAgentsReq` plus the caller's own session
 * coordinates. `channel` is what the AGENT asked for (absent ⇒ the org-wide directory);
 * every `current*` field is the TRUSTED session context, never tool input, carried
 * separately for two daemon-side jobs:
 *  - substituting the current channel when the CP does not advertise
 *    `agent-directory-org-scope-v1` (an old CP rejects a channel-less payload), and
 *  - resolving the caller's LOGICAL sessionKey, so the daemon can recognize a turn whose
 *    discovery scope it FIXED itself (the self-introduce-on-join turn, whose fan-out must
 *    stay bounded to the joined channel however the model calls the tool).
 */
export interface ChannelAgentsRequest extends ChannelAgentsReq {
  currentChannel?: string
  currentThread?: string
  currentTransportScope?: string
}

/** The peer-discovery deps: the CP directory read plus the conversation-scoped address book. */
export interface DirectoryDeps {
  /** Ask the CP for the caller's callable peers (peer discovery). The daemon fills
   *  `requesterAgentId` from the trusted session context, never tool input. An absent
   *  `channel` asks for the ORG-WIDE directory; a present one narrows it to that
   *  channel. Rejects (throws) when the control plane isn't connected — discovery
   *  fails closed rather than returning a partial/empty roster. */
  channelAgents: (req: ChannelAgentsRequest) => Promise<ChannelAgentsOk>
  /** The exact platform-native `@mention` addressing `agentId` in one conversation
   *  (send-message-routing-rework.md §8.5), or undefined when it has none there. Shared with
   *  the send path so a listing names peers with the token INGRESS resolves back. */
  mentionAddressFor?: (req: { agentId: string; platform: string; channel: string }) => string | undefined
}

// Peer discovery is daemon→CP (not a platform gateway op) and org-level, so it is
// handled before the gateway gate — a memory-only agent can still discover peers.
// `channel` is now an OPTIONAL FILTER with NO default: omitted ⇒ the org-wide
// directory of peers the call policy admits, which is the only scope a session with
// no IM integration (webchat, hook, dream) can be listed in at all. `listChannelAgents`
// stays a working alias so sessions already warm with the old tool set keep working.
// SECURITY: requesterAgentId + platform come from the trusted session context, never
// from tool input; `channel` is the only agent-supplied field, and it can only narrow —
// and even that is overridden for a turn the daemon itself scoped (see the `current*`
// coords below / ChannelAgentsRequest).
export async function listAgents(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: DirectoryDeps
): Promise<unknown> {
  const { channel } = parseArgs(LIST_AGENTS_ARGS, args)
  const res = await deps.channelAgents({
    platform: ctx.platform as Platform,
    ...(channel !== undefined ? { channel } : {}),
    // Trusted coordinates, not a scope request — see ChannelAgentsRequest (they carry the
    // old-CP fallback channel and identify THIS turn for a daemon-fixed discovery scope).
    currentChannel: ctx.channel,
    currentThread: ctx.thread,
    ...(ctx.transportScope !== undefined ? { currentTransportScope: ctx.transportScope } : {}),
    requesterAgentId: ctx.agentId
  })
  // §8.5: a CHANNEL-FILTERED listing carries each peer's exact `mention` token, so the
  // model can address it in its ordinary reply (§2.1) instead of guessing an address
  // from a display name. An ORG-WIDE listing deliberately omits it — there is no single
  // conversation-specific address for an agent that may appear in many channels behind
  // different bots, and a wrong token would silently address nobody.
  const scopedChannel = res.channel
  const agents =
    scopedChannel !== undefined && deps.mentionAddressFor
      ? res.agents.map((agent) => {
          const mention = deps.mentionAddressFor?.({
            agentId: agent.agentId,
            platform: res.platform,
            channel: scopedChannel
          })
          return mention ? { ...agent, mention } : agent
        })
      : res.agents
  return {
    platform: res.platform,
    ...(res.channel !== undefined ? { channel: res.channel } : {}),
    agents
  }
}
