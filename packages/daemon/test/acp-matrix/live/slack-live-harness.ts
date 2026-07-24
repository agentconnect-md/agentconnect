// Live Slack integration harness — credentials + a thin Slack thread poster.
//
// The live suite (slack-live.test.ts) launches every ACP agent actually installed on
// this host over real ACP (real binaries, real LLM turns) and REPORTS the run into a
// real Slack thread: a driver-user message opens the thread and the bot posts each
// agent's real observations (reply, model list, permission modes, switch results) plus
// a summary table. So the only Slack I/O is a handful of Web-API posts, gated on creds.
//
//   AC_LIVE_SLACK_BOT_TOKEN    xoxb-…  the bot that posts the per-agent replies + table
//   AC_LIVE_SLACK_APP_TOKEN    xapp-…  (accepted for symmetry; unused by this suite)
//   AC_LIVE_SLACK_USER_TOKEN   xoxp-…  the driver user that opens the thread
//   AC_LIVE_SLACK_CHANNEL      C…      a channel the bot is a member of
import { WebClient } from '@slack/web-api'

export interface SlackCreds {
  botToken: string
  userToken: string
  channel: string
}

/** Read live Slack creds from env; null (→ skip the suite) if any required var is absent. */
export function liveSlackCreds(): SlackCreds | null {
  const botToken = process.env.AC_LIVE_SLACK_BOT_TOKEN
  const userToken = process.env.AC_LIVE_SLACK_USER_TOKEN
  const channel = process.env.AC_LIVE_SLACK_CHANNEL
  if (!botToken || !userToken || !channel) return null
  return { botToken, userToken, channel }
}

/** A Slack thread the test narrates into: the driver user opens it, the bot replies. */
export class SlackThread {
  private user: WebClient
  private bot: WebClient
  private threadTs?: string

  constructor(private creds: SlackCreds) {
    this.user = new WebClient(creds.userToken)
    this.bot = new WebClient(creds.botToken)
  }

  /** Open the thread with the driver user's intro message; returns the thread ts. */
  async open(text: string): Promise<string> {
    const res = (await this.user.chat.postMessage({ channel: this.creds.channel, text })) as { ts: string }
    this.threadTs = res.ts
    return res.ts
  }

  /** Post a bot reply into the open thread. */
  async reply(text: string): Promise<void> {
    if (!this.threadTs) throw new Error('SlackThread.reply before open()')
    await this.bot.chat.postMessage({ channel: this.creds.channel, thread_ts: this.threadTs, text })
  }

  /** Post a Block Kit reply into the open thread (`text` is the notification fallback). */
  async replyBlocks(text: string, blocks: unknown[]): Promise<void> {
    if (!this.threadTs) throw new Error('SlackThread.replyBlocks before open()')
    await this.bot.chat.postMessage({
      channel: this.creds.channel,
      thread_ts: this.threadTs,
      text,
      blocks: blocks as any
    })
  }
}
