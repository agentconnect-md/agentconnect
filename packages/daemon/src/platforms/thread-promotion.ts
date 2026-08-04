/**
 * The **thread-promotion strategy** (`openThreadForTopLevel` in §7.4, stage S2).
 *
 * Some platforms want a top-level channel @mention answered in a THREAD opened
 * off it, Slack-parity style, rather than in the channel body. Whether a
 * message asks for that, and how the thread is opened and the turn re-keyed
 * onto it, is the platform's to say:
 *
 *  - the WANT is a coordinate fact of the inbound message — the generic
 *    `promoteToThread` coordinate (§6.5), with the platform's legacy named
 *    field as the dual-shape fallback until the emission flip;
 *  - the PROMOTION is a platform API call (Discord `createThread`) plus the
 *    re-keying rules of that platform's conversation model.
 *
 * Only Discord registers one today. The default is "no promotion", which is
 * the pre-existing behavior for every other platform — their top-level posts
 * reply in place. Core decides WHEN to run it (before dispatch, owning the
 * admission handle); the strategy decides everything platform-shaped.
 */

/** What a promotion may ask of core. Deliberately narrow: recording the
 *  parent-channel scope and labeling the new thread are core bookkeeping the
 *  platform cannot reach on its own. */
export interface ThreadPromotionHost {
  /** Record the thread's parent channel NOW, while the message still names it —
   *  channel discovery then reports the one channel instead of a row per thread. */
  setChannelScope(channel: string, scope: { parentId: string }): void
  /** Ask the channel-name resolver to label the freshly opened thread. */
  noteChannel(conn: unknown, channel: string): void
  info(message: string): void
  debug(message: string): void
}

/** The message fields a promotion may read and re-key. `NormalizedMessage`
 *  satisfies it structurally; `promote` mutates the coordinate fields the same
 *  way inbound normalization would have, had the message arrived in-thread. */
export interface ThreadPromotionMessage {
  platform: string
  channel: string
  thread?: string
  parentChannel?: string
  msgId: string
  text: string
  promoteToThread?: boolean
}

export interface ThreadPromotion<TMsg extends ThreadPromotionMessage> {
  readonly platform: string
  /** Does this inbound message ask to be answered in a fresh thread? */
  wants(msg: TMsg): boolean
  /** Open the thread and re-key `msg` onto it (in place). Best-effort: on
   *  failure the message keeps its channel coordinates and the reply lands
   *  in-channel. */
  promote(host: ThreadPromotionHost, conn: unknown, msg: TMsg): Promise<void>
}

const PROMOTIONS = new Map<string, ThreadPromotion<ThreadPromotionMessage>>()

export function registerThreadPromotion(promotion: ThreadPromotion<ThreadPromotionMessage>): void {
  PROMOTIONS.set(promotion.platform, promotion)
}

/** The platform's promotion, or undefined — no registered promotion means
 *  top-level posts reply in place, every non-Discord platform's behavior. */
export function threadPromotionFor(platform: string): ThreadPromotion<ThreadPromotionMessage> | undefined {
  return PROMOTIONS.get(platform)
}
