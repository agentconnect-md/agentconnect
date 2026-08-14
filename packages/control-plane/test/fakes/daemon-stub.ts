/**
 * `InMemoryDaemonStub` — the in-memory daemon (design §4.2, §5.4).
 *
 * Implements the `Transport` seam, so a `DaemonConnection` talks to it exactly
 * as it would a real socket — but every C→D frame is captured in `sent[]` and
 * every D→C frame is driven by `inject()`/`reply()`. This is the counterpart the
 * Phase 2–3 protocol tests use to exercise the connection FSM, dispatch, and
 * fencing with no real socket, port, or HTTP server.
 *
 * Orientation (from the CP connection's point of view):
 *   - `transport.send(text)`  → a **C→D** frame; decoded and pushed to `sent`.
 *   - `transport.onMessage`   → delivers **D→C** frames the stub injects.
 */
import { randomUUID } from 'node:crypto'
import { AnyFrame, type ControlExt, type FrameType } from '@agentconnect.md/protocol'
import type { Transport } from '../../src/ws/transport.js'

/**
 * A decoded C→D frame as captured from the connection. The base is the validated
 * `AnyFrame`; the optional `epoch`/`seq`/`agentId`/`launchId` mirror the spread
 * `ControlExt` block on the wire envelope (re-attached in `send`).
 */
export type CapturedFrame = AnyFrame & {
  epoch?: number
  seq?: number
  agentId?: string
  launchId?: string
}

export interface StubOpts {
  subprotocol?: string
  remoteAddr?: string
}

export class InMemoryDaemonStub implements Transport {
  /** Every C→D frame the connection has sent, in order (assert on these). */
  readonly sent: CapturedFrame[] = []
  /** The close `(code, reason)` if the connection closed the socket. */
  closed: { code: number; reason: string } | undefined

  readonly subprotocol: string
  readonly remoteAddr: string

  private messageCb: ((text: string) => void) | undefined
  private closeCb: ((code: number, reason: string) => void) | undefined
  /** Resolvers waiting on `expectFrame(type)`. */
  private waiters: Array<{ type: FrameType; resolve: (f: CapturedFrame) => void }> = []
  /** Auto-responders: REQ type → (reqFrame) → REP {type,payload}. */
  private responders = new Map<FrameType, (req: CapturedFrame) => { type: FrameType; payload: unknown }>()

  constructor(opts: StubOpts = {}) {
    this.subprotocol = opts.subprotocol ?? 'agentconnect.v1'
    this.remoteAddr = opts.remoteAddr ?? '127.0.0.1'
  }

  /**
   * Auto-reply to every C→D REQ of `type` with a correlated REP, as a real daemon
   * would. The responder maps the request frame to the reply payload. Lets a test
   * drive flows (e.g. rebalance) that block on an ack without hand-injecting each.
   */
  respondTo(type: FrameType, responder: (req: CapturedFrame) => { type: FrameType; payload: unknown }): void {
    this.responders.set(type, responder)
  }

  // ── Transport (consumed by DaemonConnection) ──────────────────────────────

  send(text: string): void {
    const raw = JSON.parse(text) as Record<string, unknown>
    const frame = AnyFrame.parse(raw) as CapturedFrame // validate the CP's output too
    // The discriminated union strips the spread `ControlExt` block (epoch/seq/
    // agentId/launchId); re-attach it so tests assert on the actual wire envelope.
    for (const k of ['epoch', 'seq', 'agentId', 'launchId'] as const) {
      if (raw[k] !== undefined) (frame as Record<string, unknown>)[k] = raw[k]
    }
    this.sent.push(frame)
    // settle any pending expectFrame waiter for this type (FIFO)
    const idx = this.waiters.findIndex((w) => w.type === frame.type)
    if (idx >= 0) {
      const [w] = this.waiters.splice(idx, 1)
      w!.resolve(frame)
    }
    // Auto-respond to a registered REQ type with a correlated REP (next tick, so
    // the issuing `request(...)` has returned its promise first).
    const responder = this.responders.get(frame.type)
    if (responder) {
      const { type, payload } = responder(frame)
      queueMicrotask(() => this.reply(frame.id, type, payload))
    }
  }

  onMessage(cb: (text: string) => void): void {
    this.messageCb = cb
  }

  onClose(cb: (code: number, reason: string) => void): void {
    this.closeCb = cb
  }

  close(code: number, reason: string): void {
    if (this.closed) return
    this.closed = { code, reason }
    this.closeCb?.(code, reason)
  }

  // ── Test driving surface (the daemon side) ────────────────────────────────

  /** Simulate a D→C frame: hand a raw JSON envelope to the connection. */
  injectRaw(text: string): void {
    if (!this.messageCb) throw new Error('connection has not started (no onMessage)')
    this.messageCb(text)
  }

  /**
   * Simulate a D→C frame from a built envelope. Returns the frame `id` so a test
   * can correlate the CP's reply (`auth/ok`/`register/ok`) back to it.
   *
   * `ext` spreads a `ControlExt` block (epoch/seq/agentId/launchId) onto the
   * envelope — the fencing fields the CP validates on inbound control frames
   * (protocol §4.2).
   */
  inject(
    type: FrameType,
    payload: unknown,
    opts: { id?: string; corr?: string; ts?: string; ext?: ControlExt; orgId?: string } = {}
  ): string {
    const id = opts.id ?? randomUUID()
    const env: Record<string, unknown> = {
      v: 1,
      id,
      ts: opts.ts ?? new Date().toISOString(),
      type,
      payload,
      ...(opts.corr ? { corr: opts.corr } : {}),
      ...(opts.orgId ? { orgId: opts.orgId } : {}),
      ...(opts.ext ?? {})
    }
    this.injectRaw(JSON.stringify(env))
    return id
  }

  /** Craft a correlated REP (D→C) to a CP-issued REQ with `id === toId`. */
  reply(toId: string, type: FrameType, payload: unknown): string {
    return this.inject(type, payload, { corr: toId })
  }

  /** Await the next outbound (C→D) frame of `type`. Resolves a recently-sent one immediately. */
  expectFrame(type: FrameType): Promise<CapturedFrame> {
    const already = this.sent.find((f) => f.type === type)
    if (already) return Promise.resolve(already)
    return new Promise((resolve) => this.waiters.push({ type, resolve }))
  }

  /** The most recent C→D frame of `type`, if any. */
  lastSent(type: FrameType): CapturedFrame | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i]!.type === type) return this.sent[i]
    }
    return undefined
  }
}
