/**
 * **Layer 2 — the per-turn output surface** (integration-plugin-architecture.md
 * §7.3, stage S2).
 *
 * Layer 1 (contract.ts) is the connection: lifecycle, identity, reads. Layer 2 is
 * what a platform contributes to ONE TURN of output, and it is deliberately a
 * TRIO, not a renderer:
 *
 *  1. `createConverger` — the platform's own production rules: chunk ceilings
 *     (12,000 / 4,096 / 2,000 / 4,000 chars), parse mode, hint policy, pacing.
 *  2. `apply` — action → platform API calls.
 *  3. `initialTurnState` — the OPAQUE per-turn state slot.
 *
 * The trio is the whole point (§16 names splitting it as the way this refactor
 * fails): a converger alone leaves the streaming loop's per-turn state stranded
 * in core, and that state is exactly what used to accrete as platform-named
 * fields on the turn record — `feishuCard` / `feishuCardAttempted` /
 * `feishuStreamTimer` (Feishu CardKit handles), `tgReplyTo` (the Telegram
 * reply-chain anchor), `staleReplyFooters` (Slack footer edits awaiting retry).
 * Core owns turn sequencing, suppression re-checks, and idle-flush policy; a
 * platform owns everything shaped like its platform, and its state travels in
 * one slot core never reads.
 *
 * WHY THE BODIES DID NOT MOVE HERE. The seam is introduced first and the four
 * `apply*` implementations stay in `daemon.ts` behind bound method references,
 * because they still reach into core turn machinery (transcript recording,
 * status settling, suppression). Moving a body while ALSO changing what it can
 * reach is how a file move turns into a silent contract redesign — the exact
 * §16 risk. They move with their platform in the per-platform stages, against
 * this already-published shape.
 *
 * WEBCHAT / HOOK / DREAM are not platforms and get no surface: they render
 * through the core (Slack-shaped) converger and applier, which is where the
 * design leaves them (§12 — webchat is core end to end).
 */

/** A turn's INPUTS, as a platform sees them. Deliberately limited to the
 *  triggering event and the two rendering switches: a surface may read what its
 *  own platform delivered, never core turn machinery — that limit is what keeps
 *  the `apply` bodies honest when they move to their platform modules. */
export interface TurnOutputContext<TMessage> {
  /** Resolved output mode for this turn (`none` … `high`). */
  mode: string
  /** Whether the conversation is a direct message. Telegram's continue-the-topic
   *  hint earns its space only in a group, where the reply chain is the only way
   *  back into the session. */
  isDm: boolean
  /** Agent-level delivery-chrome switch — gates hints and footers. */
  showFooter: boolean
  /** The message that started the turn. A platform seeds its per-turn state from
   *  its own inbound event — Telegram's reply anchor is derived from it. */
  message: TMessage
  /** COMPOUND mention addresses this conversation can contain, which the platform's
   *  splitter must never cut in half (send-message-routing-rework.md §5.3). Today only
   *  Slack has any — a shared bot's `<@U_SHARED> reviewer`, where the bot user id names
   *  the app and the trailing slug selects the agent, so the two halves are one address
   *  even though only the first is self-delimiting. Surfaces with no such shape ignore it.
   *  Empty is always safe: it is exactly the behavior before the addresses existed. */
  protectedAddresses?: readonly string[]
}

/**
 * One platform's per-turn output surface.
 *
 * @typeParam TTurn   The core turn record. Generic so this module never imports
 *                    it: core owns the turn, a platform only borrows it in
 *                    `apply`, and the dependency stays one-directional.
 * @typeParam TAction The platform's renderer action union.
 * @typeParam TConv   The platform's converger.
 */
export interface TurnOutputSurface<TTurn, TAction, TConv, TMessage> {
  /** Diagnostic label; never parsed. */
  readonly platform: string
  /** Build this turn's converger. A fresh one per turn, so a config change
   *  applies from the next turn rather than mid-stream. */
  createConverger(ctx: TurnOutputContext<TMessage>): TConv
  /** Seed the opaque per-turn state slot. Core stores the result on the turn
   *  record and NEVER reads it — only this surface's `apply` does. */
  initialTurnState(ctx: TurnOutputContext<TMessage>): unknown
  /** Apply one renderer action to the platform. Core has already decided the
   *  action is allowed to publish (suppression re-check) and serialized it. */
  apply(turn: TTurn, action: TAction): Promise<void>
}

/**
 * The daemon's registry of turn-output surfaces — one entry per chat platform,
 * plus the core surface every non-platform origin (webchat / hook / dream) and
 * Slack itself render through.
 *
 * Lookup is total by construction: an origin with no surface of its own gets the
 * core one, which is the pre-existing behavior (the four-way `platform === …`
 * ternaries this replaces both ended in a Slack-shaped default arm).
 */
export class TurnOutputRegistry<TTurn, TAction, TConv, TMessage> {
  private readonly surfaces = new Map<string, TurnOutputSurface<TTurn, TAction, TConv, TMessage>>()

  constructor(private readonly core: TurnOutputSurface<TTurn, TAction, TConv, TMessage>) {
    this.register(core)
  }

  register(surface: TurnOutputSurface<TTurn, TAction, TConv, TMessage>): void {
    this.surfaces.set(surface.platform, surface)
  }

  /** The surface that renders `platform`'s turns — the core surface when the
   *  origin is not a chat platform with one of its own. */
  for(platform: string): TurnOutputSurface<TTurn, TAction, TConv, TMessage> {
    return this.surfaces.get(platform) ?? this.core
  }
}
