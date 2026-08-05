/**
 * The **command chrome surface** — a §7.4 adapter strategy family (stage S2).
 *
 * In-conversation control commands (`/status`, `/models`, `!resume`, `!queue`, …)
 * are core policy end to end: routing, admission, session resolution, sticky
 * overrides. What is NOT core is the last inch — how a short control reply, a
 * status line, or a tappable select card is PRESENTED on each platform. That
 * inch was four inline forks inside `handleCommand`:
 *
 *  - the control reply: Telegram anchors a reply to the command message
 *    (reply-based threading); everyone else posts into the reply thread;
 *  - `/status`: Telegram renders HTML chrome with a tappable View link, Discord
 *    a markdown line with a real link BUTTON (Slack's `<url|text>` syntax
 *    renders literally there), Feishu a plain-text line with a `🔗 <url>` tail,
 *    Slack the compact status line with the pipe-link;
 *  - the select card: Telegram an inline keyboard, Discord a button grid with a
 *    25-button ceiling (fall back to the text list), Slack/Feishu no card at all;
 *  - and one COORDINATE fact, not a rendering: whether a command's thread
 *    identifies the session it acts on.
 *
 * The surface owns the first three. The fourth is a separate lookup with the
 * OPPOSITE default — see {@link CommandChromeRegistry.threadIdentifiesSession}.
 *
 * Like the turn-output registry, rendering lookup is total and falls back to the
 * core (Slack-shaped) surface, because every pre-existing fork ended in a
 * Slack-shaped `else` arm.
 */

/** The cross-platform select-control vocabulary (`/models` `/effort` `/permission`). */
export type SelectKind = 'model' | 'effort' | 'permission'

/** Where a command reply lands. Built once per command, after session resolution. */
export interface CommandChromeContext {
  channel: string
  /** The thread the reply posts into (Slack `thread_ts`; a Telegram topic id). */
  replyThread: string
  /** The RESOLVED session key the command acts on — surfaces whose card taps
   *  route back by key (Discord components) embed it. */
  sessionKey: string
}

/** A prepared select card: core owns the naming (header text, option ids); the
 *  surface owns the interaction shape (buttons, callback encoding, ceilings). */
export interface SelectCardSpec {
  kind: SelectKind
  /** Currently applied option id, if any — surfaces mark it (✅). */
  current?: string
  /** Raw option ids, in order. Index is the stable tap coordinate. */
  options: string[]
  /** Core-rendered header line ("Model — tap to switch …"). */
  header: string
}

/**
 * One platform's command presentation surface.
 *
 * `conn` is deliberately `unknown` — a surface casts to its own connection type
 * internally (the turn-output precedent): callers hold whatever connection the
 * reply path resolved, and duck-typed test fakes must keep working.
 */
export interface CommandChromeSurface<TMsg, TInfo> {
  /** Platform id this surface presents for; never parsed. */
  readonly platform: string
  /** Does a command's thread coordinate identify the session it acts on?
   *  Slack: yes — a command inside a session thread targets that session.
   *  Reply-threading platforms mint a fresh thread per command: no. */
  readonly threadIdentifiesSession: boolean
  /** Post a short control reply on the platform's own reply surface. */
  reply(conn: unknown, msg: TMsg, ctx: CommandChromeContext, text: string): void
  /** Render the `/status` line (+ session deep link when known). */
  status(conn: unknown, msg: TMsg, ctx: CommandChromeContext, info: TInfo, link?: string): void
  /** Render the tappable select card. `false` means the card cannot be rendered
   *  here (no options / over a button ceiling) and the caller must fall back to
   *  the shared numbered text list. Omitted entirely by platforms with no
   *  interactive cards. */
  selectCard?(conn: unknown, msg: TMsg, ctx: CommandChromeContext, card: SelectCardSpec): boolean
}

/**
 * The daemon's registry of command chrome surfaces.
 *
 * TWO lookups with two fail directions, on purpose:
 *
 *  - {@link for} (rendering) falls back to the CORE surface — an unknown origin
 *    posts Slack-shaped text, the pre-existing `else`-arm behavior.
 *  - {@link threadIdentifiesSession} defaults to FALSE — the pre-existing
 *    behavior was `platform === 'slack' ? msg.thread : undefined`, so an unknown
 *    platform must keep resolving through the latest-session fallback, not
 *    inherit Slack's coordinate trust.
 */
export class CommandChromeRegistry<TMsg, TInfo> {
  private readonly surfaces = new Map<string, CommandChromeSurface<TMsg, TInfo>>()

  constructor(private readonly core: CommandChromeSurface<TMsg, TInfo>) {
    this.register(core)
  }

  register(surface: CommandChromeSurface<TMsg, TInfo>): void {
    this.surfaces.set(surface.platform, surface)
  }

  /** The surface that presents `platform`'s command replies — core when the
   *  origin has no surface of its own. */
  for(platform: string): CommandChromeSurface<TMsg, TInfo> {
    return this.surfaces.get(platform) ?? this.core
  }

  /** Coordinate fact, NOT rendering: unknown platforms answer false (see class doc). */
  threadIdentifiesSession(platform: string): boolean {
    return this.surfaces.get(platform)?.threadIdentifiesSession ?? false
  }

  /** Every registered platform id, registration order. Exists so the daemon's
   *  platform set can be CHECKED against this registry rather than re-listed —
   *  see the capability-drift test. */
  ids(): string[] {
    return [...this.surfaces.keys()]
  }
}
