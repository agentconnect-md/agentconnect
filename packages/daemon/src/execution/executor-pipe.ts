// The executor facet's one network surface (session-executors.md §6): a certificate-less TLS-PSK listener that, after the handshake, pipes bytes to a session's shim socket and parses nothing.
import { randomBytes } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import { connect as tlsConnect, createServer, type TLSSocket } from 'node:tls'
import type { Logger } from '../log.js'

/** Pinned on both ends, never negotiated: a callback-supplied key is bound to SHA-256, so a peer preferring another suite must fail rather than fall back. */
export const PIPE_TLS = { minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', ciphers: 'TLS_AES_128_GCM_SHA256' } as const

export const PIPE_KEY_BYTES = 32
/** What a peer that never finishes its handshake may hold a socket for; the dialer gives its own side of it the same ten seconds. */
const HANDSHAKE_TIMEOUT_MS = 10_000
// The facet parses nothing, so it cannot ping: the kernel's probes are what find a holder that vanished without a FIN.
const KEEPALIVE_IDLE_MS = 60_000
const REFUSAL_REPORT_MS = 60_000

/** What admits a dial for one identity right now. */
export interface PipeAdmission {
  /** Compared by reference once the handshake ends, so a rotation also fails a handshake already under way. */
  key: Buffer
  /** The session's shim socket; an admitted dial is piped to it byte for byte. */
  socketPath: string
}

export interface PipeListenerOptions {
  /** The live environment an identity names, asked per handshake; undefined for everything else. */
  admission: (identity: string) => PipeAdmission | undefined
  /** An identity's pipe opened or closed; a dial that replaces a pipe reports one open and no close. */
  onPipe: (identity: string, open: boolean) => void
  /** How many sockets may sit before a finished handshake at once; one past it is dropped unread. */
  maxPending: () => number
  log: Pick<Logger, 'warn'>
  /** Test seams: the bind address (every interface by default) and a shorter handshake budget. */
  host?: string
  handshakeTimeoutMs?: number
}

/**
 * The holder's end of one session's pipe: a TLS-PSK dial with the key that session's `prepare`
 * returned, under the identity its executor admits it by — the session leaf (§6).
 *
 * No certificate is exchanged, so nothing here checks one; what authenticates the far end is that
 * it holds a key only the executor that minted it has. The suite is the listener's, pinned.
 */
export function dialPipe(input: {
  host: string
  port: number
  /** The `prepare` reply's key, as it came over the wire. NEVER log this. */
  psk: string
  identity: string
  timeoutMs?: number
}): Promise<TLSSocket> {
  const key = Buffer.from(input.psk, 'base64url')
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host: input.host,
      port: input.port,
      ...PIPE_TLS,
      pskCallback: () => ({ psk: key, identity: input.identity })
    })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`the executor did not answer within ${input.timeoutMs ?? HANDSHAKE_TIMEOUT_MS}ms`))
    }, input.timeoutMs ?? HANDSHAKE_TIMEOUT_MS)
    const fail = (error: Error): void => {
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    socket.once('error', fail)
    // A refused handshake ends as a close with nothing secured, which no `error` follows on every platform.
    socket.once('close', () => fail(new Error('the executor refused the key this session was prepared with')))
    socket.once('secureConnect', () => {
      clearTimeout(timer)
      socket.removeAllListeners('error')
      socket.removeAllListeners('close')
      socket.setNoDelay(true)
      resolve(socket)
    })
  })
}

export interface PipeListener {
  port: number
  /** Whether the identity has an admitted pipe. */
  piped(identity: string): boolean
  pipeCount(): number
  /** Close the identity's admitted pipe, if any. */
  close(identity: string): void
  stop(): Promise<void>
}

export async function startPipeListener(options: PipeListenerOptions): Promise<PipeListener> {
  const claims = new WeakMap<TLSSocket, { identity: string; key: Buffer }>()
  const pipes = new Map<string, (replaced?: boolean) => void>()
  const sockets = new Set<Socket>()
  let admitted = 0
  let refused = 0
  let report: NodeJS.Timeout | undefined
  let stopping = false
  // A count and nothing else, once a minute: an unauthenticated peer chooses the identity and the address a line would name.
  const reportRefusals = (): void => {
    if (report) clearTimeout(report)
    report = undefined
    if (refused > 0) options.log.warn(`executor: refused ${refused} dial(s) that did not present a live session's key`)
    refused = 0
  }
  const refuse = (): void => {
    // The handshakes this listener cuts short by stopping are not refusals.
    if (stopping) return
    refused += 1
    report ??= setTimeout(reportRefusals, REFUSAL_REPORT_MS)
    report.unref()
  }

  const admit = (identity: string, socket: TLSSocket, socketPath: string): void => {
    // One pipe per environment: the one before goes first, so neither a half-dead socket nor a deposed holder sits in the shim's single slot.
    pipes.get(identity)?.(true)
    admitted += 1
    let open = true
    const upstream = connect(socketPath)
    const close = (replaced = false): void => {
      if (!open) return
      open = false
      admitted -= 1
      socket.destroy()
      upstream.destroy()
      if (pipes.get(identity) === close) pipes.delete(identity)
      // A replacement is not an idle moment: the dial that took over reports the pipe open.
      if (!replaced) options.onPipe(identity, false)
    }
    pipes.set(identity, close)
    for (const end of [socket, upstream]) end.on('error', () => close()).once('close', () => close())
    socket.setNoDelay(true)
    socket.setKeepAlive(true, KEEPALIVE_IDLE_MS)
    socket.pipe(upstream)
    upstream.pipe(socket)
    options.onPipe(identity, true)
  }

  const server = createServer({
    ...PIPE_TLS,
    handshakeTimeout: options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
    pskCallback: (socket, identity) => {
      const admission = options.admission(identity)
      // A key nobody holds: an unknown identity fails exactly as a wrong key does, so the listener is no oracle for which sessions live here.
      if (!admission) return randomBytes(PIPE_KEY_BYTES)
      claims.set(socket, { identity, key: admission.key })
      return admission.key
    }
  })
  server.on('connection', (raw: Socket) => {
    // Past the cap a socket is dropped unread; the handshake it never had is counted below, as every other refusal is.
    if (sockets.size - admitted >= options.maxPending()) {
      raw.destroy()
      return
    }
    sockets.add(raw)
    raw.once('close', () => sockets.delete(raw))
  })
  // A bare tls.Server only reports a failed or timed-out handshake; closing the socket is the listener's to do, or it waits forever.
  server.on('tlsClientError', (_error, socket: TLSSocket) => {
    refuse()
    socket.destroy()
  })
  server.on('secureConnection', (socket: TLSSocket) => {
    const claim = claims.get(socket)
    const admission = claim && options.admission(claim.identity)
    if (!claim || !admission || admission.key !== claim.key) {
      refuse()
      socket.destroy()
      return
    }
    admit(claim.identity, socket, admission.socketPath)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ port: 0, ...(options.host ? { host: options.host } : {}) }, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  // The bind-failure listener is gone by now, and a post-listen accept error is fatal unheard.
  server.on('error', (error) => options.log.warn(`executor: accept error (${error.message})`))

  return {
    port: (server.address() as { port: number }).port,
    piped: (identity) => pipes.has(identity),
    pipeCount: () => pipes.size,
    close: (identity) => pipes.get(identity)?.(),
    stop: async () => {
      stopping = true
      for (const raw of sockets) raw.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      reportRefusals()
    }
  }
}
