// A scripted WeCom long-connection server: each socket answers requests by req_id, and the test pushes callbacks and kicks.
import type { Logger } from '../../src/log.js'
import type { WeComSocket } from '../../src/platforms/wecom/client.js'

type Listener = (event: { data: unknown }) => void

export interface SentFrame {
  cmd: string
  headers: { req_id: string }
  body?: Record<string, unknown>
}

/** Per-command answers: an errcode, or `silent` to leave the request unanswered. */
export type FakeAnswer = number | 'silent'

export class FakeWeComSocket implements WeComSocket {
  readyState = 0
  readonly sent: SentFrame[] = []
  closedByClient = false
  private readonly listeners = new Map<string, Listener[]>()

  constructor(
    readonly url: string,
    private readonly server: FakeWeComServer
  ) {}

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(data: string): void {
    const frame = JSON.parse(data) as SentFrame
    this.sent.push(frame)
    const answer = this.server.answerFor(frame)
    if (answer === 'silent') return
    const body = answer === 0 ? this.server.bodyFor(frame) : undefined
    queueMicrotask(() =>
      this.reply({
        headers: { req_id: frame.headers.req_id },
        ...(body ? { body } : {}),
        errcode: answer,
        errmsg: answer === 0 ? 'ok' : 'refused'
      })
    )
  }

  close(): void {
    this.closedByClient = true
    this.serverClose()
  }

  open(): void {
    this.readyState = 1
    this.emit('open', undefined)
  }

  reply(frame: Record<string, unknown>): void {
    if (this.readyState !== 1) return
    this.emit('message', JSON.stringify(frame))
  }

  /** Push an `aibot_msg_callback` with `body` under `reqId`. */
  message(reqId: string, body: Record<string, unknown>): void {
    this.reply({ cmd: 'aibot_msg_callback', headers: { req_id: reqId }, body })
  }

  event(reqId: string, eventtype: string): void {
    this.reply({
      cmd: 'aibot_event_callback',
      headers: { req_id: reqId },
      body: {
        msgid: `event-${reqId}`,
        create_time: 1700000000,
        aibotid: 'aibot-example',
        msgtype: 'event',
        event: { eventtype }
      }
    })
  }

  /** A `template_card_event` tap on `taskId` by `userid`, nested as the doc's callback example nests it. */
  cardTap(
    reqId: string,
    tap: { taskId: string; key: string; userid?: string; msgid?: string; chatid?: string; selected?: unknown }
  ): void {
    this.reply({
      cmd: 'aibot_event_callback',
      headers: { req_id: reqId },
      body: {
        msgid: tap.msgid ?? `event-${reqId}`,
        create_time: 1700000000,
        aibotid: 'aibot-example',
        ...(tap.chatid ? { chatid: tap.chatid, chattype: 'group' } : { chattype: 'single' }),
        from: { userid: tap.userid ?? 'user-alice' },
        msgtype: 'event',
        event: {
          eventtype: 'template_card_event',
          template_card_event: {
            card_type: 'button_interaction',
            event_key: tap.key,
            task_id: tap.taskId,
            ...(tap.selected ? { selected_items: tap.selected } : {})
          }
        }
      }
    })
  }

  /** WeCom's takeover: `disconnected_event`, then the server closes the socket. */
  kick(): void {
    this.event(`kick-${this.sent.length}`, 'disconnected_event')
    this.serverClose()
  }

  serverClose(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close', undefined)
  }

  frames(cmd: string): SentFrame[] {
    return this.sent.filter((frame) => frame.cmd === cmd)
  }

  private emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }
}

export class FakeWeComServer {
  readonly sockets: FakeWeComSocket[] = []
  /** The answer each command gets, by command; unlisted commands succeed. */
  readonly answers = new Map<string, FakeAnswer>()
  autoOpen = true
  /** Open attempts refused before a socket opens, for reconnect tests. */
  refuseOpens = 0
  private uploads = 0

  /** A per-frame answer that wins over `answers`, such as refusing only `template_card` sends; undefined defers. */
  answerBy?: (frame: SentFrame) => FakeAnswer | undefined

  answerFor(frame: SentFrame): FakeAnswer {
    return this.answerBy?.(frame) ?? this.answers.get(frame.cmd) ?? 0
  }

  /** A successful answer's body: the media upload's `upload_id` and `media_id`, as WeCom returns them. */
  bodyFor(frame: SentFrame): Record<string, unknown> | undefined {
    if (frame.cmd === 'aibot_upload_media_init') return { upload_id: `upload-example-${++this.uploads}` }
    if (frame.cmd === 'aibot_upload_media_finish')
      return { type: 'file', media_id: `media-example-${String(frame.body?.upload_id)}`, created_at: 1700000000 }
    return undefined
  }

  createSocket = (url: string): FakeWeComSocket => {
    const socket = new FakeWeComSocket(url, this)
    this.sockets.push(socket)
    if (this.refuseOpens > 0) {
      this.refuseOpens--
      queueMicrotask(() => socket.serverClose())
    } else if (this.autoOpen) queueMicrotask(() => socket.open())
    return socket
  }

  get last(): FakeWeComSocket {
    const socket = this.sockets.at(-1)
    if (!socket) throw new Error('no socket yet')
    return socket
  }
}

export const quietLog: Logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
