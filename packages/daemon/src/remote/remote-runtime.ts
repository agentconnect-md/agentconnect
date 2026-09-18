import type { SpawnRequest, SpawnedRuntime } from '../acp/spawn-driver.js'
import type { ClusterMetrics } from '../metrics/cluster-metrics.js'
import { ShimChannelLostError, ShimRequestTimeoutError } from '../shim/channels.js'
import type { ShimSession } from '../shim/session.js'

/** How long a re-sent write waits for the replacement channel a renewal is already binding. */
const REATTACH_GRACE_MS = 10_000
/** Graceful-stop deadline for a child whose stream is being ended by the failure path. */
const FAILED_STREAM_CLOSE_DEADLINE_MS = 5_000
/** Bytes per write frame: base64 of this, plus the envelope, stays under the 256 KiB a shim socket accepts. */
const MAX_WRITE_FRAME_BYTES = 128 * 1024

/**
 * Bridge a shim ACP stream to the byte-stream pair `AcpHost` consumes.
 *
 * The stream survives credential renewal because it talks to a {@link ShimSession} rather
 * than to one socket: a renewal re-attaches underneath, and only a lost session ends the
 * runtime. Writes await their acknowledgement, so a runtime that is not draining applies
 * backpressure instead of letting the daemon queue without bound.
 *
 * That acknowledgement is also the one place a renewal can still bite. The abort a renewal
 * performs rejects the write in flight, and a `WritableStream` that rejects a write is errored
 * for good — every later write rejects with the SAME stored error. A host kept warm on such a
 * stream answers every future turn with "shim channel renewed" while the sandbox sits there
 * healthy, so a lost write is either re-sent (safe only because the shim dedupes by `seq`) or
 * ends the runtime, which `reapTerminalHost` respawns on the next message. Never neither.
 */
export function createRemoteRuntime(opts: {
  session: ShimSession
  request: SpawnRequest
  /** Where the runtime starts, in the sandbox's coordinates; absent leaves it in the shim's own directory. */
  cwd?: string
  log: { info: (m: string) => void; warn: (m: string) => void }
  metrics?: ClusterMetrics
  /** Reports how the ACP open resolved. A timeout is separated from a failure because the two
   *  mean different things: one is a slow cluster, the other a runtime that will not start. */
  onRuntimeOpen?: (outcome: 'ok' | 'timeout' | 'error') => void
}): SpawnedRuntime {
  const exitListeners: Array<() => void> = []
  let stopped = false
  let streamId: string | undefined
  /** Set from the open reply: whether this shim applies a re-sent `seq` at most once. */
  let resumableWrites = false
  /** Numbers the writes. Strictly increasing because `WritableStream` runs them one at a time. */
  let writeSeq = 0
  const inbound = new TransformStream<Uint8Array, Uint8Array>()
  const writer = inbound.writable.getWriter()

  let finished = false
  const finish = (): void => {
    finished = true
    void writer.close().catch(() => undefined)
    for (const listener of exitListeners.splice(0)) listener()
  }

  type StreamEvent = { streamId: string; event: { kind: string; data?: string } }
  // Held until the open reply names this stream: the session carries tunnel streams too, and one of their events read as ours would end the runtime.
  const early: StreamEvent[] = []
  const onEvent = (frame: StreamEvent): void => {
    if (!streamId) {
      early.push(frame)
      return
    }
    if (frame.streamId !== streamId) return
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
  // A lost session is a dead runtime, so AcpHost is told it exited; one that already ended is not news, since a session outlives its runtimes.
  opts.session.onLost((reason) => {
    if (finished) return
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
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.request.hints ? { hints: opts.request.hints } : {})
    })
    .then((payload) => {
      const reply = payload as { streamId?: string; resumableWrites?: boolean } | undefined
      streamId = reply?.streamId
      resumableWrites = reply?.resumableWrites === true
      if (!streamId) throw new Error('shim did not report a stream id for the ACP runtime')
      for (const frame of early.splice(0)) onEvent(frame)
    })

  /** Ask the shim to end the child behind this stream, once. Shared by teardown and the failure path. */
  const closeStream = async (deadlineMs: number): Promise<void> => {
    if (stopped) return
    stopped = true
    await opened.catch(() => undefined)
    if (!streamId) return
    // A close that does not land means the rollout cannot confirm this runtime went quiet —
    // invisible before, because the failure was swallowed to keep teardown best-effort.
    await opts.session.request('acp', { op: 'close', streamId, deadlineMs }).catch(() => {
      opts.metrics?.drainTimeout()
      opts.log.warn(`cluster: runtime for agent ${opts.session.agentId} did not confirm close within ${deadlineMs}ms`)
    })
  }

  /**
   * End the runtime deliberately: the stream cannot carry another byte, so say so once — but only
   * after asking the shim to stop the child. The exit published here clears `AcpHost`'s spawned
   * handle, so host teardown will not send this stream a `close` of its own; without this one the
   * adapter kept running in the pod and the next message launched a second beside it.
   */
  const failRuntime = async (reason: string): Promise<void> => {
    opts.log.warn(`cluster: ACP stream for agent ${opts.session.agentId} ended — ${reason}`)
    await closeStream(FAILED_STREAM_CLOSE_DEADLINE_MS)
    opts.session.offEvent(onEvent)
    finish()
  }

  // Send one numbered slice and await its ack, which is the backpressure: the shim answers once the runtime's stdin took the bytes.
  const writeFrame = async (bytes: Uint8Array): Promise<void> => {
    const frame = { op: 'chunk', streamId, data: Buffer.from(bytes).toString('base64'), seq: ++writeSeq }
    try {
      await opts.session.request('acp', frame)
    } catch (err) {
      if (!(err instanceof ShimChannelLostError)) throw err
      // A renewal lost the reply, not necessarily the bytes, so only a shim that dedupes by seq is asked again; otherwise the runtime ends.
      if (!resumableWrites) {
        await failRuntime(`its shim channel was renewed mid-write and this shim cannot resume writes (${err.message})`)
        throw err
      }
      await opts.session.waitForAttach(REATTACH_GRACE_MS).catch(async (waitErr: unknown) => {
        await failRuntime(`its shim channel was renewed and no replacement bound (${(waitErr as Error).message})`)
        throw err
      })
      try {
        await opts.session.request('acp', frame)
      } catch (retry) {
        await failRuntime(`its shim channel was renewed and the re-sent write failed (${(retry as Error).message})`)
        throw retry
      }
      opts.log.info(`cluster: re-sent one ACP write for agent ${opts.session.agentId} after a channel renewal`)
    }
  }

  const toAgent = new WritableStream<Uint8Array>({
    write: async (chunk) => {
      // AcpHost writes `initialize` the moment it has the stream, so a write waits for the open instead of being dropped.
      await opened
      if (!streamId) throw new Error('acp stream is not open')
      // One ND-JSON message can exceed a frame (a prompt with an inline image), and an oversized frame closes the socket.
      for (let offset = 0; offset < chunk.byteLength; offset += MAX_WRITE_FRAME_BYTES) {
        await writeFrame(chunk.subarray(offset, offset + MAX_WRITE_FRAME_BYTES))
      }
    }
  })

  void opened.then(
    () => opts.onRuntimeOpen?.('ok'),
    (err: unknown) => {
      opts.log.warn(`cluster: runtime failed to start in the sandbox (${(err as Error).message})`)
      opts.onRuntimeOpen?.(err instanceof ShimRequestTimeoutError ? 'timeout' : 'error')
      opts.session.offEvent(onEvent)
      finish()
    }
  )

  return {
    toAgent,
    fromAgent: inbound.readable,
    onExit: (listener) => exitListeners.push(listener),
    stop: async (deadlineMs) => {
      await closeStream(deadlineMs)
      opts.session.offEvent(onEvent)
    }
  }
}
