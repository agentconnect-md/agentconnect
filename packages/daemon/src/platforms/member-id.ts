/**
 * The **member-id recognition strategy** (`mentionIdPattern` in §7.4, stage S2).
 *
 * WHAT IT PROTECTS. An agent-call's `toAgentId` is an AgentConnect id — from
 * `listAgents` or the trusted agent-call envelope — never a platform member id.
 * A model that copied the human-facing mention out of a transcript will hand over
 * a platform id instead, and accepting it publishes a visible `@U…` fallback into
 * the thread before the relay can reject the unknown target. So core fails before
 * publishing, and to do that it must be able to RECOGNIZE a platform's member id.
 * Only the platform can say what one looks like.
 *
 * WHY ONLY SLACK IS REGISTERED, AND WHY THAT IS NOT AN OVERSIGHT. Slack member
 * ids (`U…` / `W…`, plus the `<@U…>` mention wrapper) are the only ones core
 * rejects today. Registering Telegram's or Discord's numeric ids here would be a
 * BEHAVIOR CHANGE — ids that route fine today would start being refused — and a
 * risky one, since a numeric pattern cannot distinguish a Discord snowflake from
 * a legitimately numeric AgentConnect id. This strategy makes that extension
 * possible and reviewable, one platform at a time; it does not make it automatic.
 *
 * The default is therefore "not recognizable", which is exactly the pre-existing
 * behavior for every non-Slack platform.
 */

/** Slack member ids and their human-facing mention wrapper. */
const SLACK_MEMBER_ID = /^(?:[UW][A-Z0-9]+|<@[UW][A-Z0-9]+>)$/

const PATTERNS = new Map<string, RegExp>([['slack', SLACK_MEMBER_ID]])

/**
 * Does `candidate` look like one of `platform`'s member ids — i.e. a platform
 * identity handed in where an AgentConnect id belongs?
 *
 * Total by construction: a platform with no registered pattern answers `false`,
 * which is the behavior every non-Slack platform already had.
 */
export function isPlatformMemberId(platform: string, candidate: string): boolean {
  return PATTERNS.get(platform)?.test(candidate.trim()) ?? false
}
