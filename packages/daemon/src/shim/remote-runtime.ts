import type { SpawnRequest, SpawnedRuntime } from '../acp/spawn-driver.js'
import type { ClusterMetrics } from '../metrics/cluster-metrics.js'
import { ShimRequestTimeoutError } from '../shim/channels.js'
import type { ShimSession } from '../shim/session.js'

/**
 * Bridge a shim ACP stream to the byte-stream pair `AcpHost` consumes.
 *
 * The stream survives credential renewal because it talks to a {@link ShimSession} rather
 * than to one socket: a renewal re-attaches underneath, and only a lost session ends the
 * runtime. Writes await their acknowledgement, so a runtime that is not draining applies
 * backpressure instead of letting the daemon queue without bound.
 */
export function createRemoteRuntime(opts: {
  session: ShimSession
  request: SpawnRequest
  log: { info: (m: string) => void; warn: (m: string) => void }
  metrics?: ClusterMetrics
  /** Reports how the ACP open resolved. A timeout is separated from a failure because the two
   *  mean different things: one is a slow cluster, the other a runtime that will not start. */
  onRuntimeOpen?: (outcome: 'ok' | 'timeout' | 'error') => void
}): SpawnedRuntime {
  const exitListeners: Array<() => void> = []
  let stopped = false
  let streamId: string | undefined
  const inbound = new TransformStream<Uint8Array, Uint8Array>()
  const writer = inbound.writable.getWriter()

  const finish = (): void => {
    void writer.close().catch(() => undefined)
    for (const listener of exitListeners.splice(0)) listener()
  }

  const onEvent = (frame: { streamId: string; event: { kind: string; data?: string } }): void => {
    if (streamId && frame.streamId !== streamId) return
    if (frame.event.kind === 'chunk' && frame.event.data) {
      void writer.write(Buffer.from(frame.event.data, 'base64'))
      return
    }
    if (frame.event.kind === 'exit') {
      opts.session.offEvent(onEvent)
      finish()
    }
  }
  opts.session.onEvent(onEvent)
  // A lost session is a dead runtime: report terminal exit rather than leaving AcpHost
  // waiting on a stream that can never produce another byte.
  opts.session.onLost((reason) => {
    opts.log.warn(`cluster: shim channel lost for agent ${opts.session.agentId} (${reason})`)
    opts.session.offEvent(onEvent)
    finish()
  })

  const opened = opts.session
    .request('acp', {
      op: 'open',
      command: opts.request.command,
      args: opts.request.args,
      env: opts.request.env,
      ...(opts.request.hints ? { hints: opts.request.hints } : {})
    })
    .then((payload) => {
      streamId = (payload as { streamId?: string } | undefined)?.streamId
      if (!streamId) throw new Error('shim did not report a stream id for the ACP runtime')
    })

  const toAgent = new WritableStream<Uint8Array>({
    write: async (chunk) => {
      // AcpHost writes `initialize` the moment it has the stream, which can be before the
      // open round trip returns. Awaiting it here queues the write instead of dropping it.
      await opened
      if (!streamId) throw new Error('acp stream is not open')
      // Awaiting the ack is the backpressure: the shim only answers once the runtime's stdin
      // accepted the bytes.
      await opts.session.request('acp', {
        op: 'chunk',
        streamId,
        data: Buffer.from(chunk).toString('base64')
      })
    }
  })

  void opened.then(
    () => opts.onRuntimeOpen?.('ok'),
    (err: unknown) => {
      opts.log.warn(`cluster: runtime failed to start in the sandbox (${(err as Error).message})`)
      opts.onRuntimeOpen?.(err instanceof ShimRequestTimeoutError ? 'timeout' : 'error')
      finish()
    }
  )

  return {
    toAgent,
    fromAgent: inbound.readable,
    onExit: (listener) => exitListeners.push(listener),
    stop: async (deadlineMs) => {
      if (stopped) return
      stopped = true
      await opened.catch(() => undefined)
      if (streamId) {
        // A close that does not land means the rollout cannot confirm this runtime went quiet —
        // invisible before, because the failure was swallowed to keep teardown best-effort.
        await opts.session.request('acp', { op: 'close', streamId, deadlineMs }).catch(() => {
          opts.metrics?.drainTimeout()
          opts.log.warn(
            `cluster: runtime for agent ${opts.session.agentId} did not confirm close within ${deadlineMs}ms`
          )
        })
      }
      opts.session.offEvent(onEvent)
    }
  }
}
