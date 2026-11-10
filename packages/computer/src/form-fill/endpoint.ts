// The loopback endpoint the browser extension dials (computer-form-fill-and-vault.md §8): one attributed link per desktop.
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  COMPUTER_FORM_FILL_PROTOCOL,
  COMPUTER_FORM_FILL_SUBPROTOCOL,
  FORM_FILL_CLOSE,
  FormFillHello,
  FormFillReply,
  type FormFillRequest
} from '@agentconnect.md/protocol/computer-form-fill'
import { WebSocket, WebSocketServer } from 'ws'
import type { Check } from '../setup.js'

/** A request that could not be answered; `sent` says whether it may have reached the browser. */
export class FormFillLinkError extends Error {
  constructor(
    message: string,
    readonly sent: boolean
  ) {
    super(message)
    this.name = 'FormFillLinkError'
  }
}

type RequestBody = FormFillRequest extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never

export interface FormFillEndpointOptions {
  port: number
  // Origins other than these extensions' are refused before attribution.
  extensionIds: readonly string[]
  buildId: string
  // The profile a socket was attributed to → its desktop ('main' or an agent desktop id); undefined refuses it.
  desktopFor: (profile: string) => string | undefined
  attribute: (clientPort: number, serverPort: number) => { pid: number; profile: string } | undefined
  log: (line: string) => void
  pingMs?: number
  helloTimeoutMs?: number
}

interface Pending {
  resolve: (reply: FormFillReply) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface Link {
  socket: WebSocket
  desktop: string
  version: string
  pid: number
  pending: Map<number, Pending>
  missedPings: number
}

const PING_MS = 20_000
const HELLO_TIMEOUT_MS = 5000

export class FormFillEndpoint {
  private server: WebSocketServer | undefined
  private readonly links = new Map<string, Link>()
  private nextId = 1
  private pinger: NodeJS.Timeout | undefined
  // The last build a desktop's browser was refused for: it still runs another extension until it restarts (§10).
  private readonly refused = new Map<string, { buildId: string; at: number }>()

  constructor(private readonly options: FormFillEndpointOptions) {}

  async start(): Promise<number> {
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: this.options.port,
      maxPayload: 1024 * 1024,
      handleProtocols: (protocols) =>
        protocols.has(COMPUTER_FORM_FILL_SUBPROTOCOL) ? COMPUTER_FORM_FILL_SUBPROTOCOL : false,
      verifyClient: (info: { origin: string; req: IncomingMessage }, done: (ok: boolean, code?: number) => void) => {
        const allowed = this.options.extensionIds.some((id) => info.origin === `chrome-extension://${id}`)
        if (!allowed) this.options.log('form fill: refused a connection from an unknown origin')
        done(allowed, 403)
      }
    })
    this.server = server
    server.on('connection', (socket, req) => this.accept(socket, req))
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    server.on('error', (error) => this.options.log(`form fill endpoint: ${error.message}`))
    this.pinger = setInterval(() => this.ping(), this.options.pingMs ?? PING_MS)
    this.pinger.unref()
    return (server.address() as AddressInfo).port
  }

  async close(): Promise<void> {
    if (this.pinger) clearInterval(this.pinger)
    for (const link of this.links.values()) this.drop(link, 1001, 'daemon stopping')
    const server = this.server
    this.server = undefined
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  connected(desktop: string): boolean {
    return this.links.get(desktop)?.socket.readyState === WebSocket.OPEN
  }

  /** Why a desktop has no link, in words an agent or doctor can act on. */
  unavailableReason(desktop: string): string {
    const refused = this.refused.get(desktop)
    return refused
      ? `this desktop's browser runs another build of the form-fill extension (${refused.buildId}); restart the browser so it loads this one`
      : "this desktop's browser extension is not connected"
  }

  /** doctor's live view: which desktops' browsers are connected, and which run another build. */
  check(): Check {
    const connected = [...this.links.values()].filter((link) => link.socket.readyState === WebSocket.OPEN)
    const stale = [...this.refused.entries()].filter(([desktop]) => !this.connected(desktop))
    if (stale.length)
      return {
        name: 'form fill browsers',
        status: 'warn',
        detail: `another extension build on desktop ${stale.map(([desktop]) => desktop).join(', ')}`,
        fix: 'restart the browser there; if it persists, run form-fill install again'
      }
    return connected.length
      ? {
          name: 'form fill browsers',
          status: 'ok',
          detail: `extension ${connected[0]!.version} connected on desktop ${connected.map((link) => link.desktop).join(', ')}`
        }
      : { name: 'form fill browsers', status: 'info', detail: 'no browser has connected yet; open the browser' }
  }

  /** Sends one request to a desktop's extension; rejects with {@link FormFillLinkError} when it is not answered. */
  request(desktop: string, body: RequestBody, timeoutMs: number): Promise<FormFillReply> {
    const link = this.links.get(desktop)
    if (!link || link.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new FormFillLinkError(this.unavailableReason(desktop), false))
    const id = this.nextId++
    return new Promise<FormFillReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        link.pending.delete(id)
        reject(new FormFillLinkError('the browser extension did not answer in time', true))
      }, timeoutMs)
      link.pending.set(id, { resolve, reject, timer })
      link.socket.send(JSON.stringify({ ...body, id }), (error) => {
        if (!error) return
        clearTimeout(timer)
        link.pending.delete(id)
        reject(new FormFillLinkError(`the browser extension link failed: ${error.message}`, true))
      })
    })
  }

  private accept(socket: WebSocket, req: IncomingMessage): void {
    const serverPort = (this.server?.address() as AddressInfo | undefined)?.port ?? this.options.port
    let attributed: { pid: number; profile: string } | undefined
    try {
      attributed = this.options.attribute(req.socket.remotePort ?? 0, serverPort)
    } catch (error) {
      this.options.log(`form fill: attribution failed: ${(error as Error).message}`)
    }
    const desktop = attributed ? this.options.desktopFor(attributed.profile) : undefined
    if (!attributed || !desktop) {
      this.options.log('form fill: refused a connection not attributed to a desktop browser')
      socket.close(FORM_FILL_CLOSE.unattributed, 'not attributed to a desktop browser')
      return
    }
    const timer = setTimeout(
      () => socket.close(FORM_FILL_CLOSE.unsupported, 'no hello'),
      this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS
    )
    socket.once('message', (data) => {
      clearTimeout(timer)
      let hello: FormFillHello | undefined
      try {
        hello = FormFillHello.parse(JSON.parse(String(data)))
      } catch {
        hello = undefined
      }
      if (!hello || hello.protocol !== COMPUTER_FORM_FILL_PROTOCOL || hello.buildId !== this.options.buildId) {
        // A browser still running an older worker: unsupported until it restarts with the installed build (§10).
        this.options.log(
          `form fill: desktop ${desktop} runs another extension build (${hello?.buildId ?? 'no hello'}); restart its browser`
        )
        if (hello) this.refused.set(desktop, { buildId: hello.buildId, at: Date.now() })
        socket.close(FORM_FILL_CLOSE.unsupported, 'unsupported extension build')
        return
      }
      this.refused.delete(desktop)
      const previous = this.links.get(desktop)
      if (previous) this.drop(previous, FORM_FILL_CLOSE.superseded, 'superseded')
      const link: Link = {
        socket,
        desktop,
        version: hello.version,
        pid: attributed.pid,
        pending: new Map(),
        missedPings: 0
      }
      this.links.set(desktop, link)
      socket.on('message', (raw) => this.onReply(link, String(raw)))
      socket.send(JSON.stringify({ type: 'welcome', protocol: COMPUTER_FORM_FILL_PROTOCOL }))
      this.options.log(
        `form fill: extension ${hello.version} connected on desktop ${desktop} (browser pid ${attributed.pid})`
      )
    })
    socket.on('close', () => {
      clearTimeout(timer)
      const link = this.links.get(desktop)
      if (link?.socket === socket) this.drop(link, 1000, 'closed')
    })
    socket.on('error', () => undefined)
  }

  private onReply(link: Link, raw: string): void {
    let reply: FormFillReply
    try {
      reply = FormFillReply.parse(JSON.parse(raw))
    } catch {
      this.options.log(`form fill: ignored a malformed message from desktop ${link.desktop}`)
      return
    }
    link.missedPings = 0
    const pending = link.pending.get(reply.id)
    if (!pending) return
    link.pending.delete(reply.id)
    clearTimeout(pending.timer)
    pending.resolve(reply)
  }

  // Every request still waiting on a dropped link may have reached the browser.
  private drop(link: Link, code: number, reason: string): void {
    if (this.links.get(link.desktop) === link) this.links.delete(link.desktop)
    for (const pending of link.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new FormFillLinkError(`the browser extension link closed (${reason})`, true))
    }
    link.pending.clear()
    if (link.socket.readyState === WebSocket.OPEN || link.socket.readyState === WebSocket.CONNECTING)
      link.socket.close(code, reason)
  }

  // A ping every 20 s keeps the MV3 worker alive; two unanswered in a row end the link.
  private ping(): void {
    for (const link of [...this.links.values()]) {
      if (link.missedPings >= 2) {
        this.drop(link, 1001, 'no answer to ping')
        continue
      }
      link.missedPings++
      const id = this.nextId++
      if (link.socket.readyState === WebSocket.OPEN) link.socket.send(JSON.stringify({ type: 'ping', id }))
    }
  }
}
