import { loopGuardScopesFor } from '../platforms/loop-guard.js'
import type { NormalizedMessage } from '../messages/normalized.js'

// Last-resort feedback-loop protection. The lower automatic threshold catches
// agent/system/platform-echo chains; the higher all-turn threshold still stops a
// platform bug that accidentally labels its own events as ordinary human messages.
// The latch is durable and has no cooldown: only an explicit !resume resets it.
export const LOOP_GUARD_WINDOW_MS = 60_000
export const MAX_AUTOMATIC_TURNS_PER_WINDOW = 8
export const MAX_TOTAL_TURNS_PER_WINDOW = 60

/** One durable loop-guard scope shared by every agent on one physical bot.
 *  DMs are keyed at channel level because malformed platform wrappers may lose
 *  thread coordinates; threaded channel conversations retain their canonical
 *  thread. Platform coordinates can overlap across bot installations. */
export function loopGuardScopeFromCoords(
  platform: string,
  channel: string,
  thread: string,
  isDm: boolean,
  transportScope?: string
): string {
  const base = `${platform}:${channel}:${isDm ? 'dm' : thread}`
  return transportScope ? `${base}:${transportScope}` : base
}

export function loopGuardScope(msg: NormalizedMessage): string {
  // A platform whose top-level posts mint a fresh thread root per message needs
  // those roots to share one channel-level circuit — otherwise two bots can
  // alternate fresh roots forever and every message gets a virgin guard scope.
  // Which platforms those are, and how a root is recognized, is theirs to say.
  const { coarse, isRoot } = loopGuardScopesFor(msg)
  if (coarse && isRoot) return coarse
  return loopGuardScopeFromCoords(msg.platform, msg.channel, msg.thread ?? msg.msgId, msg.isDm, msg.transportScope)
}

export function isTrustedHumanTurn(msg: NormalizedMessage): boolean {
  return msg.source === 'user' && !msg.sender.isBot && msg.sender.id !== 'unknown'
}

/** The coarse rate circuit protects platform chat ingress. Agent calls have an exact
 *  trusted hop cap; cron/hooks are operator automation; webchat has a separate sync ACK
 *  contract and no in-band !resume surface. */
export function usesLoopGuard(msg: NormalizedMessage): boolean {
  return msg.source === 'user' && msg.platform !== 'webchat'
}
