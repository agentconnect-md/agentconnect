/**
 * The **loop-guard scope strategy** — a §7.4 adapter strategy (stage S2).
 *
 * A strategy, not a manifest field, and the distinction is the one the manifest
 * PR got wrong once already: core reads this with a normalized message in hand,
 * i.e. AFTER the dispatch target is known. D2 sends everything post-dispatch here.
 *
 * WHAT IT DECIDES. The loop guard is one durable circuit shared by every agent on
 * a physical bot, keyed by conversation coordinates. That keying works only if a
 * conversation's coordinates are STABLE across its messages — and on Slack they
 * are not. A Slack top-level post is normalized with `thread` set to its own
 * event ts, so every fresh root mints a brand-new scope. Two bots alternating
 * top-level posts would therefore each get a virgin guard forever and the circuit
 * would never trip. Slack answers that with a channel-wide COARSE circuit that
 * such roots collapse into.
 *
 * No other platform needs one: their thread roots are stable, so coordinates
 * alone key the circuit correctly. That asymmetry is exactly why this was three
 * `platform === 'slack'` literals rather than a shared rule — and why the default
 * strategy is "no coarse circuit", not "Slack's, disabled".
 *
 * TWO FACTS, ONE LOOKUP. Core asks two things about the same message and they are
 * always answered together:
 *
 *   - `coarse` — the channel-wide circuit this conversation ALSO belongs to.
 *     Checked alongside the coordinate scope (a trusted `!resume` anywhere in the
 *     channel must be able to reset it).
 *   - `isRoot` — this message IS a fresh root, so `coarse` REPLACES its
 *     coordinate-derived scope instead of merely sitting beside it.
 *
 * A platform with no coarse circuit returns `{ isRoot: false }`, and every call
 * site degrades to the pre-existing coordinate-only behavior.
 */

/** What a platform contributes to loop-guard keying for ONE message. */
export interface LoopGuardScopes {
  /** The channel-wide circuit, or undefined when coordinates alone suffice. */
  readonly coarse?: string
  /** True when `coarse` replaces this message's coordinate-derived scope. */
  readonly isRoot: boolean
}

/** The message fields a scope strategy may read. Deliberately the normalized
 *  coordinates only — a strategy sees what the platform delivered, never core
 *  turn machinery. `NormalizedMessage` satisfies it structurally. */
export interface LoopGuardMessage {
  platform: string
  channel: string
  thread?: string
  msgId: string
  isDm: boolean
}

/** No coarse circuit — coordinates key the guard on their own. */
const NONE: LoopGuardScopes = { isRoot: false }

function slackScopes(msg: LoopGuardMessage): LoopGuardScopes {
  // A DM has no channel-wide notion to collapse into, and its coordinates are
  // already channel-level (see loopGuardScopeFromCoords).
  if (msg.isDm) return NONE
  const coarse = `slack:${msg.channel}:top-level`
  // Slack normalizes a top-level event with thread = its own ts. Recover that ts
  // from the canonical msgId (`slack:<channel>:<ts>`) and compare: equal means
  // this message is a fresh root, not a reply inside an established thread.
  const prefix = `slack:${msg.channel}:`
  const eventTs = msg.msgId.startsWith(prefix) ? msg.msgId.slice(prefix.length) : undefined
  return { coarse, isRoot: eventTs !== undefined && msg.thread === eventTs }
}

const STRATEGIES = new Map<string, (msg: LoopGuardMessage) => LoopGuardScopes>([['slack', slackScopes]])

/** This message's loop-guard scopes. Total by construction: a platform with no
 *  registered strategy has no coarse circuit, which is the behavior every
 *  non-Slack platform already had. */
export function loopGuardScopesFor(msg: LoopGuardMessage): LoopGuardScopes {
  return STRATEGIES.get(msg.platform)?.(msg) ?? NONE
}
