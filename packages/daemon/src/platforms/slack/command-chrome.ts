/**
 * Slack's **command chrome surface** (§7.4) — and, as with turn output, the CORE
 * surface every origin without one of its own renders through. The pre-existing
 * forks all ended in a Slack-shaped `else` arm; this module IS that arm.
 */
import type { SlackConnection } from '../../slack/connection.js'
import { renderStatusBar, type StatusBarInfo } from '../../slack/render.js'
import type { CommandChromeContext, CommandChromeSurface } from '../command-chrome.js'

export const slackCommandChrome: CommandChromeSurface<unknown, StatusBarInfo> = {
  platform: 'slack',
  // A command inside a session's own thread targets that session — Slack thread
  // coordinates are stable, so the thread IS the session identity.
  threadIdentifiesSession: true,

  reply(conn: unknown, _msg: unknown, ctx: CommandChromeContext, text: string): void {
    // Cast rather than instanceof so duck-typed fakes (and the non-Slack origins
    // that render through this core surface) keep working — their postMessage is
    // structurally compatible.
    // Chrome-marked: a control reply is not conversation, so thread backfill skips it and
    // the transcript's one record of an interrupt is the row the daemon writes itself.
    void (conn as SlackConnection).postMessage(ctx.channel, text, ctx.replyThread, { chrome: true })
  },

  status(conn: unknown, msg: unknown, ctx: CommandChromeContext, info: StatusBarInfo, link?: string): void {
    // The compact status line, with Slack's pipe-link syntax when a deep link is
    // known. (Discord renders that syntax literally — which is why it has its own
    // surface.)
    const text = link ? `${renderStatusBar(info)}  ·  <${link}|View session>` : renderStatusBar(info)
    this.reply(conn, msg, ctx, text)
  }

  // No selectCard: Slack lists options as a numbered text reply (the shared
  // fallback). Its interactive selects live on the session status bar instead.
}
