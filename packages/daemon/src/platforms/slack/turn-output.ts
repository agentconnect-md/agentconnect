/**
 * Slack's **turn-output surface** (integration-plugin-architecture.md §7.3,
 * stage S2).
 *
 * Slack is the hard one, and for a reason worth stating plainly: it was the
 * FIRST platform, so its output code never had to justify itself as
 * platform-specific. It simply was "how the daemon posts". The other three
 * extractions found a self-contained applier and lifted it; here the applier had
 * grown seven private helpers in `daemon.ts` that read like core utilities but
 * are Slack API shapes end to end — `chat.postMessage` option bags, block-edit
 * retries, a `chat.delete` for the status bar.
 *
 * WHAT MOVED, AND WHY IT MOVED WITH THE APPLIER. The helpers come along rather
 * than becoming host capabilities. Had they stayed, this platform's host port
 * would be eight functions wide against Telegram's two — and every one of those
 * eight would take or return a Slack type, which is a port in name only. Two
 * groups:
 *
 *  - Applier-private: `postSlackReply` (the born-with-its-footer post boundary),
 *    `updateSlackLiveReply`, `findExistingSlackStatusBarTs`.
 *  - Shared with core call sites: the four option builders and
 *    `clearStaleSlackReplyFooters`. These are PURE functions of the turn record,
 *    so they move as exported functions and core imports them back — the
 *    dependency points core → platform, which is the direction the design wants.
 *
 * WHAT DID NOT MOVE. `liveReplyTs` / `progressTs` / `statusBarTs` / `lastReply` /
 * `attribution` and their `*Attempted` flags stay on the core turn record — now
 * clustered there as `chrome` and `reply`. They LOOK like Slack state, and
 * eventually most of them belong in the opaque slot beside `staleReplyFooters` —
 * but core reads them today from suppression, re-anchoring, and human-input paths
 * (`attribution` alone has 30+ readers). The structural `SlackTurn` view below
 * names that surface exactly, which is what makes the follow-up a mechanical
 * field migration instead of an archaeology project. Moving them here in the same
 * change would be the §16 failure mode: relocating a body while silently
 * redefining what it may reach.
 *
 * WEBCHAT / HOOK / DREAM still render through this applier — it is the registry's
 * CORE surface, not merely Slack's (§12). The `platform !== 'slack'` guards in the
 * option builders are what make that safe: a non-Slack origin gets `undefined`
 * options and posts without Slack identity decoration.
 */
import type { SlackConnection, SlackPostOptions, SlackStatusOptions, SlackTurnStream } from '../../slack/connection.js'
import { splitIntoSections } from '../../slack/formatter.js'
import type { SlackAction } from '../../slack/render.js'

/** Slack's opaque per-turn state (§7.3) — the footer edits still owed, plus the turn's
 *  native tool-call chrome stream (slack-streaming-turn-output.md §3). */
export interface SlackTurnState {
  /** Older reply sections whose footer-removal update failed. Retried on the next
   *  body section and once more at finalization, so a transient Slack error cannot
   *  leave two footers standing. */
  staleReplyFooters?: { ts: string; text: string }[]
  /** The turn's chrome stream, until Slack confirms it is settled. Retired only on a definite
   *  answer, so a transient stop failure still has a handle for the settlement retry. */
  stream?: SlackTurnStream
  /** Coalescing timer for stream appends (§3.5), the Slack analogue of Feishu's. */
  streamTimer?: NodeJS.Timeout
  /** The stream never opened, so this turn's chrome renders as today's in-place `progress`
   *  message instead. One-way for the turn — no replacement stream is ever attempted. */
  streamDegraded?: boolean
  /** The stream is settled, by our stop or by the person's. Nothing more is appended to it,
   *  no second stop is issued, and no replacement message is ever posted for chrome. */
  streamDead?: boolean
  /** The human this turn's cards are addressed to (`recipient_user_id`, required outside a
   *  DM). Absent on a cron / hook / dream / agent-to-agent turn, where the bot names itself. */
  recipient?: string
}

/** The core turn, as Slack's applier sees it. `Pending` satisfies it structurally.
 *
 *  Wider than the other three surfaces because Slack's output anchors (live reply,
 *  progress/plan/reasoning rows, status bar, attribution footer) are still core
 *  fields — see the module header. Read this list as the inventory for that
 *  follow-up, not as the port Slack wants. */
export interface SlackTurn {
  conn?: unknown
  /** The turn's readonly decisions — its coordinates and identity. */
  plan: SlackTurnPlan
  /** The in-place message anchors this applier edits rather than re-posts. */
  chrome: {
    liveReplyTs?: string
    liveReplyText?: string
    liveReplyAttempted?: boolean
    liveReplyReanchor?: boolean
    progressTs?: string
    progressAttempted?: boolean
    planTs?: string
    planAttempted?: boolean
    reasoningTs?: string
    reasoningAttempted?: boolean
    statusBarTs?: string
    statusBarAttempted?: boolean
  }
  /** What the turn has posted so far, and the id of the logical response it belongs to. */
  reply: {
    /** The message currently owning the footer. */
    lastReply?: { ts: string; text: string; footerKey?: string }
    /** send-message-routing-rework.md §5.1: the ONE logical response this turn produces.
     *  Every physical message of a long answer carries it, so a peer deduplicates on
     *  (responseId, target agent) and activates exactly once. */
    responseId?: string
    /** The LAST agent-authored body posted this turn, with the text it currently shows —
     *  what finalization re-stamps as `delivery_state: 'final'` (§5.5). The text is carried
     *  because chat.update REPLACES content, so closing the response means re-sending what
     *  is already displayed. */
    lastResponse?: { ts: string; text: string }
    /** Routing facts of the COMPLETE response, resolved by the host before the final body
     *  flush (§5.5): the recipient set, the addressed-anyone bit, whether any peer agent
     *  shares this conversation at all, and whether one of them posts as the SAME bot —
     *  a shared-bot peer's ingress admits only the closing edit past its self-echo filter,
     *  so a born-final fresh post would never reach it. Lets a terminal section be BORN
     *  `final` when no peer shares the sending bot. */
    finalRouting?: {
      mentionedAgentIds: string[]
      addressedAnyone: boolean
      hasPeers: boolean
      peerSharesBot: boolean
    }
    /** ts of the body message that was born `final` — set only after Slack accepted a
     *  terminal post carrying the closing metadata, so finalization can skip its edit. */
    finalStamped?: string
  }
  /** The turn's finalized attribution footer, and a key identifying its content so
   *  a re-post can tell "same footer" from "footer changed". */
  attribution?: { blocks: unknown[]; key: string }
}

/** The planned facts Slack's applier reads. The option builders take this alone, so a
 *  non-turn caller (a failure notice) can supply the same four fields without a turn. */
export interface SlackTurnPlan {
  channel: string
  thread?: string
  statusThread: string
  transcriptChannel: string
  agentId: string
  agentName: string
  iconUrl?: string
  sessionKey: string
  platform: string
  isDm: boolean
  /** The author's own trusted turn depth (§4.1). A human/root turn is 0; each routing
   *  edge adds one. Read-only here — the model can neither set nor reset it. */
  sourceHopCount?: number
  /** Compound shared-bot addresses this conversation can contain, which a split must
   *  never cut in half (§5.3). */
  protectedAddresses?: readonly string[]
}

/** The host capabilities this applier needs.
 *
 *  Three groups, each a genuine core resource rather than a Slack shape: the two
 *  every surface needs (reply recording, transcript append), the SESSION-SCOPED
 *  status-bar anchor (Slack owns the post-once/edit-in-place/drop-dead-ts policy;
 *  core owns the store the anchor survives in), and the logger. */
export interface SlackTurnHost<TTurn> {
  recordReplySegment(turn: TTurn, text: string): void | Promise<void>
  appendTranscript(row: {
    channel: string
    thread: string
    ts: string
    sender: string
    kind: 'text'
    text: string
  }): void | Promise<void | string>
  /** Persisted anchor for the session's one interactive status line. Survives the
   *  turn, so it cannot live in the per-turn state slot. */
  getStatusBarTs(sessionKey: string): Promise<string | undefined>
  setStatusBarTs(sessionKey: string, ts: string): void | Promise<void>
  clearStatusBarTs(sessionKey: string): void | Promise<void>
  /** Monotonic transcript timestamp — core owns ordering across surfaces. */
  monotonicTs(): string
  debug(message: string): void
}

/** Conversational authorship for Slack rows: the agent's name and icon, applied
 *  only in channels. A DM is already a one-to-one surface, so overriding the
 *  author there would replace the bot's own identity for no gain. */
export function slackPostOptions(
  p: Pick<SlackTurnPlan, 'platform' | 'isDm' | 'agentName' | 'iconUrl'>
): SlackPostOptions | undefined {
  if (p.platform !== 'slack' || p.isDm) return undefined
  return { username: p.agentName, ...(p.iconUrl ? { icon_url: p.iconUrl } : {}) }
}

/** Visual identity for Slack rows owned by the selected agent. Kept separate from
 *  conversational authorship because status/chrome rows must retain their chrome
 *  metadata marker instead of masquerading as transcript messages. */
export function slackAgentIdentityOptions(
  p: Pick<SlackTurnPlan, 'platform' | 'agentName' | 'iconUrl'>
): SlackPostOptions | undefined {
  if (p.platform !== 'slack') return undefined
  return { username: p.agentName, ...(p.iconUrl ? { icon_url: p.iconUrl } : {}) }
}

/** Agent-authored conversation messages add a stable author id to Slack metadata.
 *  Peer daemons use it during thread backfill, so shared/custom bot ids never replace
 *  the Agent's name and icon in the Console transcript. */
export function slackAgentPostOptions(
  p: Pick<SlackTurnPlan, 'platform' | 'agentId' | 'agentName' | 'iconUrl'> &
    Partial<Pick<SlackTurnPlan, 'sourceHopCount'>> & { responseId?: string },
  /** §5.5: closing metadata for a TERMINAL section posted at finalization, when the
   *  complete response is already known — the post is born `final`, needing no re-stamp. */
  closure?: { mentionedAgentIds: string[]; addressedAnyone: boolean }
): SlackPostOptions | undefined {
  const identity = slackAgentIdentityOptions(p)
  if (!identity) return undefined
  return {
    ...identity,
    agentAuthorId: p.agentId,
    // send-message-routing-rework.md §5.4: every agent-authored body carries this turn's
    // STREAMING response block, so a peer can tell a finished answer from a prefix. The
    // recipient set stays empty until finalization resolves it from the COMPLETE response
    // — routing a prefix would prompt the target with a half-written message.
    //
    // No `responseId` ⇒ this post is not part of an agent's logical response at all (the
    // cron/hook trigger anchor takes this path): authorship for the transcript, but it
    // closes no response and must never be routed as one.
    ...(p.responseId
      ? {
          response: closure
            ? {
                responseId: p.responseId,
                deliveryState: 'final' as const,
                hopCount: p.sourceHopCount ?? 0,
                mentionedAgentIds: closure.mentionedAgentIds,
                ...(closure.addressedAnyone ? { addressedAnyone: true } : {})
              }
            : {
                responseId: p.responseId,
                deliveryState: 'streaming' as const,
                hopCount: p.sourceHopCount ?? 0,
                mentionedAgentIds: []
              }
        }
      : {})
  }
}

/**
 * The human this turn's chrome cards are addressed to (`recipient_user_id`, which Slack
 * requires outside a DM). A cron fire, a webhook, a dream, or an agent→agent delivery has no
 * human initiator, so the connection names the bot itself instead — no structural carve-out.
 *
 * Structural in its parameter so this module stays free of core message types.
 */
export function slackStreamRecipient(msg: {
  source: string
  headless?: boolean
  sender: { id: string; isBot?: boolean }
}): string | undefined {
  return msg.source === 'user' && !msg.headless && !msg.sender.isBot ? msg.sender.id : undefined
}

/** Keep the working indicator visually owned by the same agent as its reply. */
export function slackStatusOptions(
  platform: string,
  agentName: string,
  iconUrl?: string,
  /** Recorded by the connection as the slot's displayed owner — the turn a native Stop targets. */
  sessionKey?: string
): SlackStatusOptions | undefined {
  if (platform !== 'slack') return undefined
  return {
    username: agentName,
    ...(iconUrl ? { icon_url: iconUrl } : {}),
    ...(sessionKey ? { sessionKey } : {})
  }
}

/**
 * Close this turn's logical response (send-message-routing-rework.md §5.5): re-stamp the
 * last delivered message as the single `final` event, carrying the recipients resolved
 * from the COMPLETE response.
 *
 * Why the recipient set is computed at turn end rather than per post: a streamed answer
 * may put its `@mention` in section one and finish in section three. Reparsing only the
 * last physical message would lose the mention entirely; carrying the whole set on the
 * final event is what lets a peer be selected once, with complete context, wherever in
 * the answer it was addressed (§5.2/§5.7).
 *
 * Best-effort throughout. A turn with no conversational body has no response to close; a
 * failed edit leaves the message `streaming`, which means UNROUTED — the safe direction,
 * since the alternative is routing an answer never confirmed complete.
 */
export async function finalizeSlackResponse(
  conn: SlackConnection,
  p: SlackTurn,
  /** Agents addressed by the complete response, already resolved against the
   *  conversation directory and with the author removed (§2.3: an author cannot activate
   *  itself, and stating that here is clearer than shipping a recipient to discard). */
  mentionedAgentIds: string[],
  /** Did the COMPLETE response mention anyone at all — humans and other apps included?
   *  The final event's own text cannot answer this once an answer has been split, and
   *  §2.3 makes any address binding, so it travels with the recipient set. */
  addressedAnyone: boolean,
  debug: (message: string) => void
): Promise<void> {
  const body = p.reply.lastResponse
  if (p.plan.platform !== 'slack' || !body || !p.reply.responseId) return
  // Born-final (§5.5): the terminal section already carried the closing metadata on its
  // own post, so the response is closed — a re-stamp would only re-mark it "(edited)".
  if (p.reply.finalStamped !== undefined && p.reply.finalStamped === body.ts) return
  // Duck-typed adaptor/test connections implement only the subset they need. Closing the
  // response is additive metadata, not delivery — a connection that cannot do it must not
  // fail the turn whose answer was already delivered.
  if (typeof conn.finalizeResponse !== 'function') return
  // Re-supply exactly what the message already shows: chat.update REPLACES content, and
  // the footer belongs to this message only while `lastReply` still points at it.
  const ownsFooter = p.reply.lastReply?.ts === body.ts && p.reply.lastReply.footerKey !== undefined
  const blocks = [{ type: 'markdown', text: body.text }, ...(ownsFooter && p.attribution ? p.attribution.blocks : [])]
  try {
    await conn.finalizeResponse(p.plan.channel, body.ts, blocks, body.text, p.plan.agentId, {
      responseId: p.reply.responseId,
      deliveryState: 'final',
      hopCount: p.plan.sourceHopCount ?? 0,
      mentionedAgentIds,
      ...(addressedAnyone ? { addressedAnyone } : {})
    })
  } catch (err) {
    // The real connection normalizes API failures to `false`; this guard covers a
    // throwing adaptor. Degrading to `streaming` means unrouted, never mis-routed.
    debug(`slack: response finalization failed (${(err as Error).message})`)
  }
}

/** Remove attribution blocks from older body sections. Slack edits are best-effort,
 *  so retain failed rows for the next body post and the finalization retry. Test fakes
 *  historically return void; only an explicit `false` means the update failed. */
export async function clearStaleSlackReplyFooters<TTurn extends SlackTurn>(
  host: Pick<SlackTurnHost<TTurn>, 'debug'>,
  conn: SlackConnection,
  p: TTurn,
  state: SlackTurnState,
  additional: { ts: string; text: string }[] = []
): Promise<void> {
  const pending = [...(state.staleReplyFooters ?? []), ...additional]
  if (pending.length === 0) return
  delete state.staleReplyFooters
  const failed: { ts: string; text: string }[] = []
  for (const reply of new Map(pending.map((item) => [item.ts, item])).values()) {
    try {
      const updated = await conn.updateBlocks(
        p.plan.channel,
        reply.ts,
        [{ type: 'markdown', text: reply.text }],
        undefined,
        false,
        p.plan.agentId
      )
      if (updated === false) failed.push(reply)
    } catch (err) {
      // Real SlackConnection normalizes API/queue failures to false. Keep this guard
      // for duck-typed test/adaptor connections so turn cleanup can never be stranded.
      failed.push(reply)
      host.debug(
        `slack: stale footer cleanup failed (${reply.ts}): ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  if (failed.length > 0) state.staleReplyFooters = failed
}

/** Does this row's text look like a rendered status bar? A Slack-shaped test: the
 *  bar's leading chart glyph, in either the `:shortcode:` or the literal-emoji form
 *  Slack may echo back. Also consulted by thread backfill, which must not replay a
 *  peer's status bar as conversation. */
export function isSlackStatusBarText(text: string): boolean {
  return text.startsWith(':bar_chart:') || text.startsWith('📊')
}

/** Best-effort adoption path for sessions that already have an older status bar in
 *  the thread but no persisted ts — re-anchor onto our own bar rather than posting a
 *  second one. Provenance-filtered: only a row this bot authored, marked as chrome,
 *  and owned by this agent qualifies. */
async function findExistingSlackStatusBarTs(conn: SlackConnection, p: SlackTurn): Promise<string | undefined> {
  const getThreadReplies = (conn as { getThreadReplies?: SlackConnection['getThreadReplies'] }).getThreadReplies
  if (!getThreadReplies) return undefined
  const own = new Set([conn.botId, conn.botUserId].filter(Boolean))
  if (own.size === 0) return undefined
  const replies = await getThreadReplies.call(conn, p.plan.channel, p.plan.statusThread)
  return replies.find(
    (m) =>
      m.isBot &&
      own.has(m.sender) &&
      m.chrome &&
      m.chromeOwnerAgentId === p.plan.agentId &&
      isSlackStatusBarText(m.text)
  )?.ts
}

/** Shared reply-message boundary for every output mode. The new message is born with
 *  the current footer; only after that post succeeds do we strip the footer from the
 *  previous reply owner and move the pointer. */
async function postSlackReply<TTurn extends SlackTurn>(
  host: SlackTurnHost<TTurn>,
  conn: SlackConnection,
  p: TTurn,
  state: SlackTurnState,
  text: string,
  trackReply = true,
  /** §5.5: this is the response's LAST section, posted at finalization — when the host
   *  has prepared the closing routing facts, stamp it `final` at birth so the response
   *  needs no closing chat.update (which would mark the reply "(edited)"). */
  terminal = false
): Promise<string | undefined> {
  const previous = trackReply ? p.reply.lastReply : undefined
  const attribution = trackReply ? p.attribution : undefined
  // A shared-bot peer sees fresh own-bot posts filtered as self-echo — only the closing
  // edit is admitted past that filter — so those conversations keep the re-stamp.
  const routing = terminal ? p.reply.finalRouting : undefined
  const closure = routing && !routing.peerSharesBot ? routing : undefined
  const agentPostOptions = slackAgentPostOptions({ ...p.plan, responseId: p.reply.responseId }, closure)
  const options = attribution ? { ...agentPostOptions, trailingBlocks: attribution.blocks } : agentPostOptions
  const ts = await conn.postMessage(p.plan.channel, text, p.plan.thread, options as SlackPostOptions | undefined)
  // Remember the newest conversational body so finalization knows which message closes
  // the response (§5.5). Tracked for every agent-authored body, including `attributed:
  // false` sections: "last posted" is a fact about ordering, not about footer ownership.
  if (ts) p.reply.lastResponse = { ts, text }
  // Record the born-final ts only when the closing metadata actually rode the post.
  if (ts && closure && agentPostOptions?.response) p.reply.finalStamped = ts
  if (ts && trackReply) {
    if (attribution)
      await clearStaleSlackReplyFooters(
        host,
        conn,
        p,
        state,
        previous?.footerKey ? [{ ts: previous.ts, text: previous.text }] : []
      )
    p.reply.lastReply = {
      ts,
      text,
      ...(attribution ? { footerKey: attribution.key } : {})
    }
  }
  return ts
}

/** The single in-place tool-activity message: post once, then edit. Shared by the legacy
 *  `progress` action and by a streaming turn whose stream never opened. If the first post
 *  rejects or returns no ts, mark it attempted and skip later edits rather than duplicating. */
async function applySlackProgress(
  conn: SlackConnection,
  p: SlackTurn,
  chromeOptions: SlackPostOptions,
  text: string
): Promise<void> {
  if (p.chrome.progressTs) await conn.updateMessage(p.plan.channel, p.chrome.progressTs, text, true)
  else if (!p.chrome.progressAttempted) {
    p.chrome.progressAttempted = true
    p.chrome.progressTs = await conn.postMessage(p.plan.channel, text, p.plan.thread, chromeOptions)
  }
}

/** Update minimal mode's live body without dropping its born-in footer. Only record a
 *  footer-key transition after Slack accepts the edit so finalization can retry a failed
 *  metadata refresh. */
async function updateSlackLiveReply(conn: SlackConnection, p: SlackTurn, text: string): Promise<void> {
  if (!p.chrome.liveReplyTs) return
  // minimal mode edits ONE message as the answer streams, so the text finalization must
  // re-send is the latest edit, not the text this message was born with (§5.5).
  if (p.reply.lastResponse?.ts === p.chrome.liveReplyTs) p.reply.lastResponse.text = text
  const attribution = p.attribution
  if (!attribution) {
    await conn.updateMessage(p.plan.channel, p.chrome.liveReplyTs, text, false, p.plan.agentId)
    if (p.reply.lastReply?.ts === p.chrome.liveReplyTs) {
      p.reply.lastReply.text = text
      delete p.reply.lastReply.footerKey
    }
    return
  }
  const updated = await conn.updateBlocks(
    p.plan.channel,
    p.chrome.liveReplyTs,
    [{ type: 'markdown', text }, ...attribution.blocks],
    text,
    false,
    p.plan.agentId
  )
  if (updated !== false && p.reply.lastReply?.ts === p.chrome.liveReplyTs) {
    p.reply.lastReply.text = text
    p.reply.lastReply.footerKey = attribution.key
  }
}

/** Apply one converger action against the turn's Slack connection.
 *
 *  Also the CORE surface: webchat / hook / dream turns arrive here with no
 *  connection (headless) or with Slack-shaped fakes, which is why the no-`conn`
 *  path still records the reply into the transcript. */
export async function applySlackAction<TTurn extends SlackTurn>(
  host: SlackTurnHost<TTurn>,
  p: TTurn,
  state: SlackTurnState,
  action: SlackAction
): Promise<void> {
  if (action.kind === 'post' && action.recordOnly) {
    await host.recordReplySegment(p, action.text)
    return
  }
  // enqueueApply routes here only for non-telegram platforms, so p.conn is a Slack
  // connection (or a test fake with the same shape) — cast rather than instanceof so
  // duck-typed fakes work. Headless (no conn) no-ops.
  const conn = p.conn as SlackConnection | undefined
  if (!conn) {
    // Headless fires have no platform-send boundary, but their agent reply should
    // still be readable in the session transcript.
    if (action.kind === 'post') {
      await host.appendTranscript({
        channel: p.plan.transcriptChannel,
        thread: p.plan.statusThread,
        ts: host.monotonicTs(),
        sender: p.plan.agentId,
        kind: 'text',
        text: action.text
      })
    }
    return
  }
  const postOptions = slackPostOptions(p.plan)
  const statusBarPostOptions = slackAgentIdentityOptions(p.plan)
  // Chrome variant of the post options: marks status/progress/plan/reasoning/notice/card
  // messages so a peer daemon's thread backfill skips them (they are not conversation).
  const chromeOptions: SlackPostOptions = { ...(postOptions ?? {}), chrome: true }
  switch (action.kind) {
    case 'set-status':
      if (p.plan.statusThread)
        await conn.setStatus(
          p.plan.channel,
          p.plan.statusThread,
          action.text,
          slackStatusOptions(p.plan.platform, p.plan.agentName, p.plan.iconUrl, p.plan.sessionKey)
        )
      return
    case 'set-title':
      if (p.plan.statusThread) await conn.setTitle(p.plan.channel, p.plan.statusThread, action.text)
      return
    case 'post': {
      const trackReply = action.attributed !== false
      // The latest reply is born with its linked context footer, so unfurls are
      // disabled at the supported chat.postMessage boundary. Once that succeeds,
      // strip the footer from this turn's previous section and move the pointer.
      const ts = await postSlackReply(host, conn, p, state, action.text, trackReply, action.terminal === true)
      await host.appendTranscript({
        channel: p.plan.transcriptChannel,
        thread: p.plan.statusThread,
        ts: ts ?? `local-${Date.now()}`,
        sender: p.plan.agentId,
        kind: 'text',
        text: action.text
      })
      return
    }
    case 'notice':
    case 'tool-output':
      // Both post to the thread but are NOT recorded into the transcript — notices are
      // system chrome, and tool output is captured independently by the recorder.
      await conn.postMessage(p.plan.channel, action.text, p.plan.thread, chromeOptions)
      return
    case 'attribution':
      // Final metadata normally matches the footer already included in the initial post.
      // Minimal mode also keeps that footer through its live updates, so finalization is
      // a no-op unless the runtime published different session metadata during prompt.
      p.attribution = { blocks: action.blocks, key: JSON.stringify(action.blocks) }
      if (action.standalone) {
        if (
          p.chrome.liveReplyTs &&
          p.chrome.liveReplyText !== undefined &&
          p.reply.lastReply?.ts === p.chrome.liveReplyTs &&
          p.reply.lastReply.footerKey !== p.attribution.key
        ) {
          const updated = await conn.updateBlocks(
            p.plan.channel,
            p.chrome.liveReplyTs,
            [{ type: 'markdown', text: p.chrome.liveReplyText }, ...action.blocks],
            p.chrome.liveReplyText,
            false,
            p.plan.agentId
          )
          if (updated !== false) {
            p.reply.lastReply.text = p.chrome.liveReplyText
            p.reply.lastReply.footerKey = p.attribution.key
          }
        }
      } else {
        await clearStaleSlackReplyFooters(host, conn, p, state)
      }
      return
    case 'progress':
      await applySlackProgress(conn, p, chromeOptions, action.text)
      return
    case 'stream-start': {
      if (state.stream || state.streamDead || state.streamDegraded) return
      if (p.plan.thread) {
        // Exactly the identity today's `progress` message carries: the agent's name and icon
        // in a channel, nothing in a DM, under the connection's customize cooldown.
        state.stream = await conn.startTurnStream(p.plan.channel, p.plan.thread, {
          isDm: p.plan.isDm,
          ...(state.recipient ? { recipientUserId: state.recipient } : {}),
          ...(postOptions ? { identity: postOptions } : {})
        })
        if (state.stream) return
      }
      // The stream could not open, so this turn's chrome falls back to today's in-place
      // message. Chrome degrades ALONE — the body never rode the stream, so nothing moves.
      state.streamDegraded = true
      return
    }
    case 'stream-append': {
      if (state.streamDead || action.chunks.length === 0) return
      if (state.streamDegraded || !state.stream) {
        // Task chunks are never rendered as prose: only the legacy rendering this batch
        // carries reaches the channel, and a thinking-only batch carries none.
        if (action.progressText) await applySlackProgress(conn, p, chromeOptions, action.progressText)
        return
      }
      const outcome = await conn.appendTurnStream(state.stream, action.chunks)
      // `refused` drops this card update and keeps the handle — chrome is lossy-tolerant, and
      // the settling stop still has a message to land on.
      if (outcome !== 'stopped') return
      state.streamDead = true
      state.stream = undefined
      return
    }
    case 'stream-stop': {
      if (state.streamDead) return
      if (!state.stream) {
        // Degraded before the stream ever opened: the terminal batch still owes the channel
        // its legacy rendering, exactly as a non-streaming turn's last `progress` edit would.
        if (state.streamDegraded && action.progressText)
          await applySlackProgress(conn, p, chromeOptions, action.progressText)
        return
      }
      const stream = state.stream
      // The handle is retired HERE, whatever Slack answers: the connection owns the settle+stop
      // from this point (it retries after the turn is gone), and the turn must not race it.
      state.stream = undefined
      state.streamDead = true
      await conn.settleAndStop(stream, action.settle, { chromeOwnerAgentId: p.plan.agentId })
      return
    }
    case 'plan':
      if (p.chrome.planTs) await conn.updateMessage(p.plan.channel, p.chrome.planTs, action.text, true)
      else if (!p.chrome.planAttempted) {
        p.chrome.planAttempted = true
        p.chrome.planTs = await conn.postMessage(p.plan.channel, action.text, p.plan.thread, chromeOptions)
      }
      return
    case 'reasoning':
      // The single in-place reasoning block (high mode): post once, then edit — same
      // post-once/edit-thereafter contract as `progress`. Not recorded into the
      // transcript; the TranscriptRecorder captures reasoning rows independently.
      if (p.chrome.reasoningTs) await conn.updateMessage(p.plan.channel, p.chrome.reasoningTs, action.text, true)
      else if (!p.chrome.reasoningAttempted) {
        p.chrome.reasoningAttempted = true
        p.chrome.reasoningTs = await conn.postMessage(p.plan.channel, action.text, p.plan.thread, chromeOptions)
      }
      return
    case 'live-reply': {
      // minimal mode's single agent reply: post once with its attribution footer, then
      // update body + footer together as the turn streams. Skip an update when the text
      // is unchanged; the paired `recordOnly` posts carry the transcript content.
      if (p.chrome.liveReplyReanchor) {
        // A human-input card was posted above this reply; start a FRESH reply below it so
        // the post-answer stream reads after the question (the old reply stays frozen above).
        p.chrome.liveReplyReanchor = false
        p.chrome.liveReplyTs = undefined
        p.chrome.liveReplyAttempted = false
        p.chrome.liveReplyText = undefined
      }
      if (p.chrome.liveReplyText === action.text) return
      p.chrome.liveReplyText = action.text
      if (p.chrome.liveReplyTs) await updateSlackLiveReply(conn, p, action.text)
      else if (!p.chrome.liveReplyAttempted) {
        p.chrome.liveReplyAttempted = true
        p.chrome.liveReplyTs = await postSlackReply(host, conn, p, state, action.text)
      }
      return
    }
    case 'final-live-reply': {
      // Slack caps one markdown block at 12k characters. Settle the existing live reply
      // with the first section, then post every overflow section as a continuation so
      // minimal mode never drops the tail of a long final answer. Every successful next
      // section is born with the footer before the prior section loses it, keeping the
      // footer anchored to the last delivered response throughout the handoff.
      const sections = splitIntoSections(action.text, undefined, p.plan.protectedAddresses)
      const [first, ...rest] = sections
      if (!first) return
      if (p.chrome.liveReplyReanchor) {
        p.chrome.liveReplyReanchor = false
        p.chrome.liveReplyTs = undefined
        p.chrome.liveReplyAttempted = false
        p.chrome.liveReplyText = undefined
      }
      if (p.chrome.liveReplyText !== first) {
        p.chrome.liveReplyText = first
        if (p.chrome.liveReplyTs) await updateSlackLiveReply(conn, p, first)
        else if (!p.chrome.liveReplyAttempted) {
          p.chrome.liveReplyAttempted = true
          // A single-section answer whose FIRST post happens here is the terminal
          // section: the complete response is known, so it is born `final` (§5.5).
          p.chrome.liveReplyTs = await postSlackReply(host, conn, p, state, first, true, rest.length === 0)
        }
      }
      for (const [index, section] of rest.entries()) {
        const ts = await postSlackReply(host, conn, p, state, section, true, index === rest.length - 1)
        if (ts) {
          p.chrome.liveReplyTs = ts
          p.chrome.liveReplyText = section
        }
      }
      return
    }
    case 'clear-status-bar': {
      const ts = p.chrome.statusBarTs ?? (await host.getStatusBarTs(p.plan.sessionKey))
      if (!ts) return
      p.chrome.statusBarTs = ts
      const deleted = await conn.deleteMessage(p.plan.channel, ts)
      // Duck-typed test connections historically return void; only an explicit false
      // means Slack rejected the cleanup and the persisted ts should be retried later.
      if (deleted !== false) {
        p.chrome.statusBarTs = undefined
        await host.clearStatusBarTs(p.plan.sessionKey)
      }
      return
    }
    case 'status-bar': {
      // Session-scoped interactive status line: the first post's ts is stored on the
      // session, and every later turn updates that topmost line in place. Serialized by
      // applyChain; not recorded into the transcript (live chrome).
      let ts = p.chrome.statusBarTs ?? (await host.getStatusBarTs(p.plan.sessionKey))
      if (!ts && !p.chrome.statusBarAttempted) {
        ts = await findExistingSlackStatusBarTs(conn, p)
        if (ts) {
          p.chrome.statusBarTs = ts
          await host.setStatusBarTs(p.plan.sessionKey, ts)
        }
      }
      if (ts) {
        p.chrome.statusBarTs = ts
        const updated = await conn.updateBlocks(
          p.plan.channel,
          ts,
          action.blocks,
          action.text,
          true,
          undefined,
          p.plan.agentId
        )
        // Duck-typed test connections historically return void; only an explicit
        // false means Slack rejected the edit — typically cant_update_message on a
        // bar another Slack app authored (a foreign ts persisted by the
        // pre-provenance adoption path). Drop the dead ts so the next status emit
        // re-resolves — provenance-filtered adoption or a fresh own post — instead
        // of hammering an uneditable message on every usage tick. A transient
        // failure costs at most one duplicate bar; a foreign ts never heals.
        if (updated === false) {
          p.chrome.statusBarTs = undefined
          await host.clearStatusBarTs(p.plan.sessionKey)
        }
      } else if (!p.chrome.statusBarAttempted) {
        p.chrome.statusBarAttempted = true
        // The session status line represents the selected agent, so keep its author
        // identity aligned with the native loading state and the eventual reply.
        const posted = await conn.postBlocks(p.plan.channel, action.blocks, action.text, p.plan.thread, {
          ...(statusBarPostOptions ?? {}),
          chrome: true,
          chromeOwnerAgentId: p.plan.agentId
        })
        if (posted) {
          p.chrome.statusBarTs = posted
          await host.setStatusBarTs(p.plan.sessionKey, posted)
        }
      }
      return
    }
  }
}
