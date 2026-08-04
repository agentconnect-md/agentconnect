/**
 * Telegram's **command chrome surface** (§7.4), plus its select-card wire
 * encoding.
 *
 * Telegram threads commands by REPLY, not by thread ts: a control reply anchors
 * to the command message itself (`replyTo`), which also keeps it a non-numeric
 * `tg:`/`dm` thread so it never posts as a forum topic. `/status` renders as
 * HTML chrome with a tappable View link; the select controls render as an
 * inline-keyboard card.
 *
 * THE CALLBACK ENCODING LIVES HERE with its builder — `<kindCode>:<index>` is
 * Telegram's own wire format (its Bot API caps callback_data at 64 bytes, hence
 * the terse codes), parsed back by the callback handler. Encode and decode were
 * previously 350 lines apart in `daemon.ts`; a platform's wire format belongs in
 * one file, next to the buttons that carry it — mirroring Discord, whose
 * `ac_sel:<code>:<index>` custom-id scheme already lives in its own render
 * module.
 */
import type { NormalizedMessage } from '../../messages/normalized.js'
import { permissionModeDisplayLabel } from '../../acp/permission-modes.js'
import type { InlineButton, TelegramConnection } from '../../telegram/connection.js'
import { renderStatusReply, type TelegramStatusInfo } from '../../telegram/render.js'
import type { CommandChromeContext, CommandChromeSurface, SelectCardSpec, SelectKind } from '../command-chrome.js'
import { telegramReplyTarget } from './threading.js'

const SELECT_KIND_CODE: Record<SelectKind, string> = { model: 'm', effort: 'e', permission: 'p' }
const SELECT_CODE_KIND: Record<string, SelectKind> = { m: 'model', e: 'effort', p: 'permission' }

/** Decode a tapped inline-keyboard callback (`m:2` → model, index 2). Null for
 *  callback data this scheme did not mint. */
export function parseTelegramSelect(data: string): { kind: SelectKind; index: number } | null {
  const m = /^([mep]):(\d+)$/.exec(data)
  if (!m) return null
  const kind = SELECT_CODE_KIND[m[1] as string]
  return kind ? { kind, index: Number(m[2]) } : null
}

/** One tappable button per option, the current one marked ✅. Also used by the
 *  callback handler to re-render the card with the new current after a tap. */
export function telegramSelectButtons(
  kind: SelectKind,
  current: string | undefined,
  options: string[]
): InlineButton[][] {
  const code = SELECT_KIND_CODE[kind]
  return options.map((o, i) => [
    {
      text: `${o === current ? '✅ ' : ''}${kind === 'permission' ? permissionModeDisplayLabel(o) : o}`,
      callbackData: `${code}:${i}`
    }
  ])
}

export const telegramCommandChrome: CommandChromeSurface<NormalizedMessage, TelegramStatusInfo> = {
  platform: 'telegram',
  // A bare Telegram command keys to its own fresh reply thread — the thread
  // coordinate never identifies an existing session, so commands resolve through
  // the channel's latest session instead.
  threadIdentifiesSession: false,

  reply(conn: unknown, msg: NormalizedMessage, ctx: CommandChromeContext, text: string): void {
    void (conn as TelegramConnection).postMessage(ctx.channel, text, ctx.replyThread, {
      replyTo: telegramReplyTarget(msg)
    })
  },

  status(
    conn: unknown,
    msg: NormalizedMessage,
    ctx: CommandChromeContext,
    info: TelegramStatusInfo,
    link?: string
  ): void {
    // HTML chrome (not recorded) — the compact line + a tappable View link.
    void (conn as TelegramConnection).postChrome(ctx.channel, renderStatusReply(info, link), {
      parseMode: 'HTML',
      threadTs: ctx.replyThread,
      replyTo: telegramReplyTarget(msg)
    })
  },

  selectCard(conn: unknown, msg: NormalizedMessage, ctx: CommandChromeContext, card: SelectCardSpec): boolean {
    void (conn as TelegramConnection).postCard(
      ctx.channel,
      card.header,
      telegramSelectButtons(card.kind, card.current, card.options),
      { threadTs: ctx.replyThread, replyTo: telegramReplyTarget(msg) }
    )
    return true
  }
}
