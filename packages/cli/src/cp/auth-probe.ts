/**
 * `probeAuth` — a one-shot CP auth check used by `agentconnect login`. It dials
 * the CP, sends ONLY the `auth` frame (no `register`), and resolves with the
 * authoritative daemonId from `auth/ok`, or a human-readable failure reason on
 * a `4401` close, a correlated `error`, a dial failure, or a timeout. It always
 * closes the socket and never leaves a connection open.
 */
import { buildEnvelope, CP_SUBPROTOCOL, CP_WS_PATH, decodeEnvelope, encode, isFrame } from '@agentconnect.md/protocol'
import { ClientTransport, type Transport } from '@agentconnect.md/connection'

export interface ProbeResult {
  ok: boolean
  daemonId?: string
  reason?: string
}

export interface ProbeOpts {
  url: string
  token: string
  daemonId?: string
  agentVersion?: string
  timeoutMs?: number
  /** Injectable for tests; defaults to dialing the real WebSocket. */
  connect?: () => Promise<Transport>
}

export async function probeAuth(opts: ProbeOpts): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const dial = opts.connect ?? (() => ClientTransport.dial(opts.url, { subprotocol: CP_SUBPROTOCOL, path: CP_WS_PATH }))

  let transport: Transport
  try {
    transport = await dial()
  } catch (err) {
    return { ok: false, reason: `cannot reach ${opts.url}: ${(err as Error).message}` }
  }

  const authPayload: Record<string, unknown> = {
    apiKey: opts.token,
    agentVersion: opts.agentVersion ?? 'probe'
  }
  if (opts.daemonId) authPayload.daemonId = opts.daemonId
  const frame = buildEnvelope('auth', authPayload)

  return await new Promise<ProbeResult>((resolve) => {
    let settled = false
    const done = (r: ProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        transport.close(1000, 'probe done')
      } catch {
        // socket may already be closed
      }
      resolve(r)
    }

    const timer = setTimeout(
      () => done({ ok: false, reason: `timed out after ${timeoutMs}ms waiting for auth/ok` }),
      timeoutMs
    )

    transport.onMessage((text) => {
      const decoded = decodeEnvelope(text)
      if (!decoded.ok) return
      const f = decoded.frame
      if (f.corr !== frame.id) return
      if (f.type === 'error') {
        const e = f.payload as { code: string; message: string }
        done({ ok: false, reason: `${e.code}: ${e.message}` })
        return
      }
      if (isFrame('auth/ok')(f)) {
        const ok = f.payload as { daemonId: string }
        done({ ok: true, daemonId: ok.daemonId })
      }
    })

    transport.onClose((code) => {
      if (code === 4401) done({ ok: false, reason: 'authentication failed (4401) — check the daemon token' })
      else done({ ok: false, reason: `connection closed (${code}) before auth/ok` })
    })

    transport.send(encode(frame))
  })
}
