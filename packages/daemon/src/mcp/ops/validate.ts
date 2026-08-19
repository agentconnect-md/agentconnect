import type { GithubInlineReviewComment } from '../../github/review.js'

export const SEND_MESSAGE_TARGET_HELP =
  'Valid targets: agent {"toAgent":"<agent-id>","message":"..."}; ' +
  'user DM {"toUser":"<Slack-user-id>","message":"..."}; ' +
  'channel users {"toUser":["<id-1>","<id-2>"],"channel":"<channel-id>","message":"..."}; ' +
  'channel {"channel":"<channel-id>","message":"..."}; ' +
  'session {"sessionId":"<Parent session>","message":"..."}'

export function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || v.length === 0) throw new Error(`missing required string argument: ${key}`)
  return v
}

/** Like `requireString` but accepts '' — for `updateMemory`, where an empty string
 *  is a valid value (clear the memory). */
export function requireStringAllowEmpty(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string') throw new Error(`missing required string argument: ${key}`)
  return v
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new Error(`argument ${key} must be a string`)
  return v
}

/**
 * Normalize `toAgent`, which accepts either the bare agent id or
 * `{ agentId, needsReply }`. The bare-string form stays supported indefinitely: it is what
 * every published example and every warm ACP session's tool descriptor teaches, and the object
 * form only adds delivery options on top of it. `undefined` ⇒ this is not an agent target.
 */
export function parseAgentTarget(value: unknown): { toAgent?: string; needsReply?: boolean } {
  if (value === undefined || value === null) return {}
  if (typeof value === 'string') {
    if (value.length === 0) throw new Error('sendMessage: `toAgent` must be a non-empty agent id')
    return { toAgent: value }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('sendMessage: `toAgent` must be an agent id string or {"agentId":"…","needsReply":bool}')
  }
  const target = value as Record<string, unknown>
  assertOnlyKeys(target, ['agentId', 'needsReply'], 'agent target `toAgent`')
  const needsReply = target.needsReply
  if (needsReply !== undefined && needsReply !== null && typeof needsReply !== 'boolean') {
    throw new Error('sendMessage: `toAgent.needsReply` must be a boolean')
  }
  return { toAgent: requireString(target, 'agentId'), ...(needsReply === true ? { needsReply: true } : {}) }
}

/** Normalize `toUser`: one id works for every delivery form; a non-empty array is reserved
 * for one visible channel-root post that @-mentions every listed Slack member. */
export function parseUserTargets(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  const users = typeof value === 'string' ? [value] : value
  if (!Array.isArray(users)) {
    throw new Error('sendMessage: `toUser` must be a user id string or a non-empty array of user id strings')
  }
  if (users.length === 0 || users.some((user) => typeof user !== 'string' || user.trim().length === 0)) {
    throw new Error('sendMessage: `toUser` must be a user id string or a non-empty array of user id strings')
  }
  const ids = users as string[]
  const canonicalIds = ids.map((id) => /^<@([^>]+)>$/.exec(id)?.[1] ?? id)
  if (new Set(canonicalIds).size !== canonicalIds.length) {
    throw new Error('sendMessage: `toUser` must not contain duplicate user ids')
  }
  return ids
}

export function assertOnlyKeys(args: Record<string, unknown>, allowed: readonly string[], target: string): void {
  const allowedSet = new Set(allowed)
  const unexpected = Object.keys(args).filter((key) => !allowedSet.has(key))
  if (unexpected.length === 0) return
  throw new Error(
    `sendMessage: ${target} allows only ${allowed.map((key) => `\`${key}\``).join(', ')}; ` +
      `unexpected ${unexpected.map((key) => `\`${key}\``).join(', ')}. ${SEND_MESSAGE_TARGET_HELP}`
  )
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`argument ${key} must be a finite number`)
  return v
}

export function optionalBoundedInt(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number
): number | undefined {
  const value = optionalNumber(args, key)
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`argument ${key} must be an integer between ${min} and ${max}`)
  }
  return value
}

export function optionalObject(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`argument ${key} must be an object`)
  return value as Record<string, unknown>
}

export function requireEnum<T extends string>(args: Record<string, unknown>, key: string, values: readonly T[]): T {
  const value = args[key]
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`argument ${key} must be one of: ${values.join(', ')}`)
  }
  return value as T
}

export function requirePositiveInt(args: Record<string, unknown>, key: string): number {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`argument ${key} must be a positive integer`)
  }
  return value
}

export function parseReviewComments(value: unknown): GithubInlineReviewComment[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('argument comments must be an array')
  if (value.length > 100) throw new Error('argument comments may contain at most 100 entries')
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`comments[${index}] must be an object`)
    }
    const row = item as Record<string, unknown>
    const startLine = row.startLine === undefined ? undefined : requirePositiveInt(row, 'startLine')
    const startSide =
      row.startSide === undefined ? undefined : requireEnum(row, 'startSide', ['LEFT', 'RIGHT'] as const)
    return {
      path: requireString(row, 'path'),
      body: requireString(row, 'body'),
      line: requirePositiveInt(row, 'line'),
      side: requireEnum(row, 'side', ['LEFT', 'RIGHT'] as const),
      ...(startLine !== undefined ? { startLine } : {}),
      ...(startSide !== undefined ? { startSide } : {})
    }
  })
}

export function parseGithubReviewThreadReplies(value: unknown): Array<{ threadRootCommentId: string; body: string }> {
  if (!Array.isArray(value) || value.length === 0) throw new Error('argument replies must be a non-empty array')
  if (value.length > 25) throw new Error('argument replies may contain at most 25 entries')
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`replies[${index}] must be an object`)
    }
    const row = item as Record<string, unknown>
    const threadRootCommentId = requireString(row, 'threadRootCommentId')
    if (!/^[1-9]\d*$/.test(threadRootCommentId)) {
      throw new Error(`replies[${index}].threadRootCommentId must be a positive decimal string`)
    }
    const body = requireString(row, 'body')
    if (!body.trim()) throw new Error(`replies[${index}].body must be non-empty`)
    return { threadRootCommentId, body }
  })
}
