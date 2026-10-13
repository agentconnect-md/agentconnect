// A platform call refused because the bot is not in that conversation (Slack's `not_in_channel`): core may ask a person before the bot joins it.

/** Tag a platform refusal as "the bot is not in `channel`", keeping the error itself as the platform raised it. */
export function markNotJoined<E>(err: E, channel: string): E {
  if (err !== null && typeof err === 'object') Object.assign(err, { notJoinedChannel: channel })
  return err
}

/** The conversation a tagged refusal names; undefined for any other error. */
export function notJoinedChannel(err: unknown): string | undefined {
  const channel = (err as { notJoinedChannel?: unknown } | null | undefined)?.notJoinedChannel
  return typeof channel === 'string' ? channel : undefined
}
