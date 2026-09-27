// Linear's §7.4 relay-ingress strategy (linear-integration.md §4.5, §8, §10.1): prompt, receipt, and ≤10 s ack.
import type { RdMsgIm } from '@agentconnect.md/protocol'
import { formatErr } from '../../daemon/text.js'
import { stableMessageId, type NormalizedMessage } from '../../messages/normalized.js'
import { sessionKey } from '../../store/local-store.js'
import { monotonicTs } from '../../store/monotonic-ts.js'
import type { DaemonPlatformModule, RelayIngressStrategy } from '../contract.js'
import type { RelayIngressHost } from '../relay-ingress-host.js'
import type { LinearConnection } from './connection.js'
import {
  applyLinearMessageStrategy,
  isLinearIssuelessSurface,
  linearAckBody,
  linearChannelName,
  linearDeliveryReceiptId,
  linearTeamGlyph,
  linearTeamLink,
  readLinearExt,
  type LinearAdapterExt,
  LINEAR_UNSUPPORTED_SURFACE_BODY
} from './message-strategy.js'

/** How long a Linear delivery waits for the delegator's name before dispatching with the id. */
const LINEAR_ACTOR_LOOKUP_MS = 1500

/** The shared relay-ingress host port, read through Linear's own connection. */
export type LinearRelayIngressHost = RelayIngressHost<LinearConnection>

/** Linear's daemon platform module, bound to one daemon's host. */
export function linearPlatformModule(host: LinearRelayIngressHost): DaemonPlatformModule {
  return { platformId: 'linear', relayIngress: linearRelayIngress(host) }
}

function linearRelayIngress(host: LinearRelayIngressHost): RelayIngressStrategy {
  // `<integrationId>\u0000<teamId>` per team reported on the §9.2 fast path: one report per team per integration.
  const reportedTeams = new Set<string>()

  /** §8 prompt assembly plus the §4.5 unsupported-surface answer; a missing bag fails closed into a plain dispatch. */
  async function prepareLinearDelivery(
    msg: RdMsgIm,
    normalized: NormalizedMessage,
    trace: { stage: string }
  ): Promise<'dispatch' | 'settled' | 'refused'> {
    const ext = readLinearExt(normalized)
    if (!ext) {
      host.log().warn(`linear: delivery ${msg.msgId} carries no adapter bag — dispatching the raw text`)
      return 'dispatch'
    }
    trace.stage = 'linear:receipt'
    // §4.5: a served delivery drops here; core deletes its dispatch row at turn end, so only the receipt outlives it.
    if (await linearDeliveryServed(normalized)) {
      host.log().info(`linear: delivery ${msg.msgId} was already served — no turn, no activity`)
      return 'settled'
    }
    // §4.5: a bag with no issue is a surface v1 cannot serve — answer once, no turn, only after the receipt (§10.1).
    if (isLinearIssuelessSurface(ext)) {
      let minted: boolean
      try {
        minted = await mintLinearDeliveryReceipt(msg, normalized)
      } catch (err) {
        // Nothing ran and nothing was recorded: ask for the delivery again rather than answer an append-only feed.
        host.log().warn(`linear: unsupported-surface receipt failed for ${msg.msgId}: ${formatErr(err)}`)
        return 'refused'
      }
      // Lost the race: a sibling delivery owns the one answer this surface gets.
      if (!minted) return 'settled'
      const conn = host.connection(msg.integrationId)
      await conn
        ?.postActivity(ext.agentSessionId, { type: 'response', body: LINEAR_UNSUPPORTED_SURFACE_BODY })
        .catch((err: unknown) => host.log().warn(`linear: unsupported-surface reply failed: ${formatErr(err)}`))
      host.log().info(`linear: session ${ext.agentSessionId} has no issue — answered without starting a turn`)
      return 'settled'
    }
    const conn = host.connection(msg.integrationId)
    if (conn) {
      // Sender and mentions resolve off the hot path; the session list and its avatars read the cache this fills.
      host.noteMessage(conn, normalized)
      // The §8 header names the delegator; a `created` event carries only `creatorId`: a bounded lookup, cache first.
      if (!normalized.sender.name) {
        trace.stage = 'linear:actor-name'
        const name = await linearActorName(conn, normalized.sender.id)
        if (name) normalized.sender = { ...normalized.sender, name }
      }
    }
    // §8: the per-turn prompt plus the session-stable standing block, both off the bag — no read.
    applyLinearMessageStrategy(normalized)
    // §9.2 fast path for a team created after the install: the TEAM's label off the bag, never the issue's.
    noteLinearTeam(msg.integrationId, ext)
    return 'dispatch'
  }

  /** §9.2 fast path: a new team's first delivery reports its row off the bag, once per (integration, team). */
  function noteLinearTeam(integrationId: string, ext: LinearAdapterExt): void {
    const team = ext.team
    if (!team?.id) return
    const key = `${integrationId}\u0000${team.id}`
    if (reportedTeams.has(key)) return
    reportedTeams.add(key)
    // The connection carries the workspace name and team-link URL segment; without either the row is named by its team.
    const conn = host.connection(integrationId)
    const name = linearChannelName(team, conn)
    void host
      .observePlatformChat(
        'linear',
        {
          id: team.id,
          ...(name ? { name } : {}),
          ...linearTeamGlyph(team),
          ...linearTeamLink(team, conn),
          isPrivate: false
        },
        [integrationId]
      )
      .catch((err: unknown) => {
        reportedTeams.delete(key)
        host.log().warn(`linear: reporting team ${team.id} as an observed conversation failed: ${formatErr(err)}`)
      })
  }

  /** The delegator's name for the §8 header: the cache, else one lookup bounded by {@link LINEAR_ACTOR_LOOKUP_MS}. */
  async function linearActorName(conn: LinearConnection, senderId: string): Promise<string | undefined> {
    const cached = (await host.store().getDisplayNames([senderId])).get(senderId)
    if (cached) return cached
    // The full name first, as the resolver caches it — one spelling in the header and the session list.
    const lookup = conn
      .getUserProfile(senderId)
      .then((p) => p.realName || p.name || undefined)
      .catch(() => undefined)
    const deadline = new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), LINEAR_ACTOR_LOOKUP_MS)
      timer.unref?.()
    })
    return await Promise.race([lookup, deadline])
  }

  /** Was this delivery already served here? A read failure answers no: a re-run is recoverable, a drop is not. */
  async function linearDeliveryServed(normalized: NormalizedMessage): Promise<boolean> {
    try {
      return await host.store().hasInbox(linearDeliveryReceiptId(stableMessageId(normalized)))
    } catch (err) {
      host.log().warn(`linear: receipt read failed for ${normalized.msgId}: ${formatErr(err)}`)
      return false
    }
  }

  /** Mint the born-completed served receipt; `INSERT OR IGNORE` is the CAS (true for the winner); throws on failure. */
  async function mintLinearDeliveryReceipt(msg: RdMsgIm, normalized: NormalizedMessage): Promise<boolean> {
    const key = sessionKey(
      normalized.platform,
      normalized.channel,
      normalized.thread ?? normalized.msgId,
      msg.agentId,
      normalized.transportScope
    )
    return await host.store().appendInbox({
      id: linearDeliveryReceiptId(stableMessageId(normalized)),
      sessionKey: key,
      agentId: msg.agentId,
      msg: JSON.stringify(normalized),
      integrationId: msg.integrationId,
      completedAt: host.now(),
      loopGuardCounted: 1,
      enqueuedAt: monotonicTs()
    })
  }

  /** The ≤10 s ack (§10.1) plus the §10.2 auto-start; fire-and-forget, and reached only by the receipt CAS winner. */
  function onLinearAdmitted(msg: RdMsgIm, normalized: NormalizedMessage, busy: boolean, steered: boolean): void {
    const conn = host.connection(msg.integrationId)
    const ext = readLinearExt(normalized)
    if (!conn || !ext) return
    const agent = host.agent(msg.agentId)
    const agentName = agent?.displayName?.trim() || agent?.name || msg.agentId
    void (async () => {
      const key = sessionKey(
        normalized.platform,
        normalized.channel,
        normalized.thread ?? normalized.msgId,
        msg.agentId,
        normalized.transportScope
      )
      // `none` is truly silent (§5.2): no ack, no activities, no issue write — transcript only.
      const mode = (await host.store().getOutputModeOverride(key)) ?? agent?.output?.mode ?? 'low'
      if (mode === 'none') return
      await conn.postActivity(ext.agentSessionId, {
        type: 'thought',
        body: linearAckBody(agentName, ext, steered ? { steered: true } : { queued: busy }),
        ephemeral: true
      })
      // A session-opening delivery moves the issue to "started" only once the ack is out: both share one FIFO (§10.1).
      if (ext.event === 'created' && ext.issueId) {
        const issue = ext.issueIdentifier ?? ext.issueId
        conn
          .startIssue(ext.issueId)
          .then((result) => {
            if (result.outcome === 'moved')
              host.log().info(`linear: moved ${issue} from "${result.from}" to "${result.state}" on delegation`)
            else
              host
                .log()
                .debug(
                  `linear: left ${issue} alone on delegation (${result.outcome}: ${'reason' in result ? result.reason : result.state})`
                )
          })
          .catch((err: unknown) => host.log().warn(`linear: auto-start of ${issue} failed: ${formatErr(err)}`))
      }
    })().catch((err: unknown) => host.log().warn(`linear: acknowledgement failed: ${formatErr(err)}`))
  }

  return {
    prepare: async (msg, normalized, trace) => await prepareLinearDelivery(msg, normalized, trace),
    onAdmitted: async (msg, normalized, busy, steered) => onLinearAdmitted(msg, normalized, busy, steered),
    requireDurable: true,
    receiptId: (normalized) => linearDeliveryReceiptId(stableMessageId(normalized))
  }
}
