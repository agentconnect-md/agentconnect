/**
 * Where an app card GOES — the one place that knows webchat renders frames and no other surface
 * does (webchat-mcp-apps.md §2/§6).
 *
 * This is deliberately not a platform facet and must not become one. `ElicitCardFacet` exists
 * because four surfaces each collect an answer differently; an app has exactly one renderer and
 * will keep having exactly one, so the seam that would let a second register is a seam with
 * nothing to put in it. What the other surfaces need is not a renderer but a SENTENCE, and the
 * sentence is the same on all of them.
 *
 * The turn is reached structurally, the way the elicitation-card facet reaches its own: this
 * module may see a live turn's webchat sink and its notice channel, and nothing else of core.
 */
import { randomUUID } from 'node:crypto'
import {
  MCP_APP_CARD_MAX_BYTES,
  type McpAppCard,
  type McpAppOutcome,
  type McpAppRpcResult,
  type WebchatEvent
} from '@agentconnect.md/protocol'
import type { Logger } from '../../log.js'
import type { WebchatSink } from '../../webchat/types.js'

/**
 * The reply stream one card was posted on, HELD by the card for as long as it is live.
 *
 * Held rather than re-looked-up, and that is the whole reason this type exists. A frame outlives
 * the turn that opened it — the reader is still looking at it, and its bridge must still answer —
 * while a `Pending` turn does not, so resolving the stream again at answer time would silently
 * stop serving every frame the moment its turn finished. The webchat elicitation card holds its
 * `wc` for exactly the same reason. The object is the turn's own, mutated in place, so `index`
 * keeps advancing on the one counter every other output on this stream takes from.
 */
export interface AppStream {
  conversationId: string
  turnId: string
  index: number
  /** The turn's whole sink, not just its `output` half. This module only ever emits events, but a
   *  `ui/message` starts a REAL turn on this same browser connection, and a turn needs the
   *  terminal half too — narrowing it here would only force the daemon to hold it twice. */
  sink: WebchatSink
}

/** The live turn an app card is posted onto, as this module sees it. Both arms are optional
 *  because both are genuinely absent somewhere: a chat turn has no stream, and a headless or
 *  postless turn has neither. */
export interface AppTurn {
  /** Webchat's reply stream. Present ⇒ the frame can be rendered. */
  webchat?: AppStream
  /** Say one line on a chat surface. Absent ⇒ this turn has nowhere visible to say anything,
   *  which is what a headless turn is, and the decline is then silent on purpose. */
  notice?: (text: string) => void
  /** This session in the console, when the daemon knows the URL — the one actionable thing a
   *  decline can offer a reader who is not in the console. */
  sessionUrl?: string
}

/** What the daemon must give this module to reach a turn. One method, because one is all a card
 *  needs: the logical session key is minted by core and every caller already holds it. */
export interface AppSurfaceHost {
  turnFor(sessionKey: string): AppTurn | undefined
  log(): Logger
}

/** The words a surface with no renderer says. It names the tool, says plainly that the interface
 *  needs the console, and points there when it can — the shape `buildElicitDeclinedNotice`
 *  settled for the same problem one layer down. Pure. */
export function buildAppDeclinedNotice(title: string, sessionUrl?: string): string {
  const tail = sessionUrl ? `\nOpen it in the session console: ${sessionUrl}` : ''
  return `🖼️ "${title}" came with an interactive interface, which only the web console can show.\nEverything it reported is in this conversation; the interface itself is not.${tail}`
}

/**
 * Make one card fit the frame it has to ride, or say it cannot.
 *
 * The template cap alone does not bound a card: a tool that answered with a megabyte of
 * `structuredContent` produces a perfectly legal template and an unencodable event, and a frame
 * that fails to encode is one the reader never sees for a reason nothing in the stream explains.
 *
 * The tool result is what gets dropped, and only in that order, because it is the one part the
 * reader has not lost: the MODEL already received the result, so the agent can still say what it
 * found, while dropping the template would leave a card with no interface in it at all. A card
 * still over budget with the result gone is declined, and the notice says so. Pure.
 */
export function fitAppCard(card: McpAppCard): McpAppCard | null {
  const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  if (bytes(card) <= MCP_APP_CARD_MAX_BYTES) return card
  const { toolResult: _dropped, ...lean } = card
  return bytes(lean) <= MCP_APP_CARD_MAX_BYTES ? lean : null
}

/** A fresh card id. Unguessable because it is the whole capability a view presents: holding one
 *  is what lets a frame call this card's server. */
export function newAppId(): string {
  return randomUUID()
}

export class AppSurface {
  constructor(private readonly host: AppSurfaceHost) {}

  /**
   * Post one card, or say why it could not be posted. `shown` ⇒ the browser has the frame and its
   * bridge should be served; `declined` ⇒ nothing renders, the reader was told, and the card must
   * never be recorded as live — a bridge answering for a frame nobody has is a bridge answering
   * nobody.
   */
  open(sessionKey: string, card: McpAppCard): { shown: true; stream: AppStream } | { shown: false } {
    const turn = this.host.turnFor(sessionKey)
    const wc = turn?.webchat
    if (!turn || !wc) {
      this.decline(turn, card.title)
      return { shown: false }
    }
    const fitted = fitAppCard(card)
    if (!fitted) {
      this.host.log().warn(`mcp apps: card for "${card.toolName}" exceeds the frame budget — declined`)
      this.decline(turn, card.title)
      return { shown: false }
    }
    if (fitted.toolResult === undefined && card.toolResult !== undefined) {
      this.host.log().debug(`mcp apps: dropped the tool result from "${card.toolName}"'s card to fit the frame budget`)
    }
    try {
      wc.sink.output({
        conversationId: wc.conversationId,
        turnId: wc.turnId,
        index: wc.index++,
        event: { kind: 'app', ...fitted }
      })
      return { shown: true, stream: wc }
    } catch (err) {
      // An undelivered card can never be opened, and this sink is the only thing that speaks to
      // this reader — a notice about it would go out through the very call that just threw. Same
      // reasoning the webchat elicitation card records for its own undelivered case.
      this.host.log().warn(`mcp apps: card not delivered for "${sessionKey}": ${(err as Error).message}`)
      return { shown: false }
    }
  }

  /** Tell the browser a card has stopped being live, so a frame is never left armed against a
   *  bridge that no longer answers. Best effort: the settlement in the registry is what decides. */
  settle(stream: AppStream, appId: string, outcome: McpAppOutcome): void {
    this.emit(stream, { kind: 'app_resolved', appId, outcome })
  }

  /** Answer one view RPC on the stream that carried its card. */
  answer(stream: AppStream, appId: string, callId: string, outcome: McpAppRpcResult): void {
    this.emit(stream, { kind: 'app_rpc_result', appId, callId, outcome })
  }

  private emit(stream: AppStream, event: WebchatEvent): void {
    try {
      stream.sink.output({
        conversationId: stream.conversationId,
        turnId: stream.turnId,
        index: stream.index++,
        event
      })
    } catch (err) {
      // A stream whose relay connection has gone takes every later event with it. That is a
      // frame the reader can no longer drive, not a fault to raise: the browser reconnects onto a
      // transcript, and a card it cannot reach renders settled.
      this.host.log().debug(`mcp apps: ${event.kind} not delivered: ${(err as Error).message}`)
    }
  }

  /**
   * The decline, on a surface that has somewhere to say it — the same two-armed split the
   * elicitation decline makes, and for the same reasons.
   *
   * A webchat turn gets a STANDING stream event: this surface has no channel to post a message
   * into, and a standing line is what the reader keeps rather than one that retires the moment
   * output resumes. It reaches here at all because a webchat card can still be declined — a
   * template past the frame budget is the case — and declining that in silence would be the one
   * outcome #1794 set out to end. Its notice carries no console link: the reader is already IN
   * the console, and it is this console's own surface that declined.
   *
   * A chat turn gets the in-channel line, with the link. A headless turn has neither and stays
   * silent rather than inventing a channel — exactly as a headless `shareFile` is refused rather
   * than rerouted.
   */
  private decline(turn: AppTurn | undefined, title: string): void {
    const wc = turn?.webchat
    if (wc) {
      this.emit(wc, { kind: 'notice', text: buildAppDeclinedNotice(title), standing: true })
      return
    }
    const notice = turn?.notice
    if (!notice) return
    try {
      notice(buildAppDeclinedNotice(title, turn?.sessionUrl))
    } catch (err) {
      this.host.log().warn(`mcp apps: decline notice failed: ${(err as Error).message}`)
    }
  }
}
