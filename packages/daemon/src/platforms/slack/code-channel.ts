import { createHash } from 'node:crypto'
import type { SlackConnection } from '../../slack/connection.js'

/** The message a code channel is linked to: Slack copies it into the channel and invites its author. */
export interface CodeChannelOrigin {
  agentId: string
  channel: string
  ts: string
  isDm: boolean
}

/** What creation answered: Slack's response, the channel it names, and whether the origin already sat in a code channel, which is then reused. */
export interface CodeChannelCreated {
  response: unknown
  channelId?: string
  existing: boolean
}

/** The one creation path for a code channel (slack-code-channels.md "Agent tools"): linked to its origin, idempotent per origin, privacy left to Slack. */
export async function createCodeChannel(
  conn: Pick<SlackConnection, 'codeChannel' | 'codeChannelApi'>,
  origin: CodeChannelOrigin,
  name: string,
  judgeNew: () => Promise<unknown>
): Promise<CodeChannelCreated> {
  if (!origin.isDm && (await conn.codeChannel(origin.channel)).code)
    return {
      channelId: origin.channel,
      existing: true,
      response: { ok: true, channel_id: origin.channel, already_exists: true }
    }
  await judgeNew()
  // The origin's key keeps a retried creation on the channel the first one made.
  const sessionId = createHash('sha256').update(`${origin.agentId}:slack:${origin.channel}:${origin.ts}`).digest('hex')
  const response = await conn.codeChannelApi('create', {
    name,
    session_id: sessionId,
    origin_channel_id: origin.channel,
    origin_message_ts: origin.ts
  })
  const channelId = (response as { channel_id?: unknown } | undefined)?.channel_id
  return { response, ...(typeof channelId === 'string' && channelId !== '' ? { channelId } : {}), existing: false }
}
