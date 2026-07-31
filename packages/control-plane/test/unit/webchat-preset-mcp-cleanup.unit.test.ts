import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as stackHarness from '../harness/webchat-preset-mcp-stack.js'

type CleanupApi = {
  closeWebSocket?: (socket: unknown, timeoutMs: number) => Promise<void>
  closeWebSocketServer?: (server: unknown, timeoutMs: number) => Promise<void>
  createSharedBestEffortDisposer?: (
    steps: Array<() => Promise<void> | void>,
    finalize: () => Promise<void> | void
  ) => () => Promise<void>
  attachCleanupError?: (setupError: unknown, cleanupError: unknown) => unknown
}

const cleanup = stackHarness as CleanupApi

class StalledSocket extends EventEmitter {
  readyState = 1
  closeCalls = 0
  terminateCalls = 0

  close(): void {
    this.closeCalls += 1
  }

  terminate(): void {
    this.terminateCalls += 1
    this.readyState = 3
    queueMicrotask(() => this.emit('close'))
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('preset webchat MCP harness cleanup', () => {
  it('bounds graceful WebSocket close and terminates a stalled peer', async () => {
    expect(cleanup.closeWebSocket).toBeTypeOf('function')
    if (!cleanup.closeWebSocket) return

    vi.useFakeTimers()
    const socket = new StalledSocket()
    const closed = cleanup.closeWebSocket(socket, 100)

    await vi.advanceTimersByTimeAsync(100)
    await closed

    expect(socket.closeCalls).toBe(1)
    expect(socket.terminateCalls).toBe(1)
  })

  it('rejects instead of hanging on a stalled WebSocketServer close callback', async () => {
    expect(cleanup.closeWebSocketServer).toBeTypeOf('function')
    if (!cleanup.closeWebSocketServer) return

    vi.useFakeTimers()
    const server = {
      clients: new Set(),
      close: vi.fn((_callback: (error?: Error) => void) => {})
    }
    const closed = cleanup.closeWebSocketServer(server, 100)
    const rejection = closed.catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(200)

    await expect(rejection).resolves.toEqual(expect.objectContaining({ message: 'WebSocket server close timed out' }))
    expect(server.close).toHaveBeenCalledOnce()
  })

  it('terminates a client that appears while the WebSocketServer is closing', async () => {
    expect(cleanup.closeWebSocketServer).toBeTypeOf('function')
    if (!cleanup.closeWebSocketServer) return

    vi.useFakeTimers()
    const lateClient = new StalledSocket()
    const clients = new Set<StalledSocket>()
    const server = {
      clients,
      close: vi.fn((callback: (error?: Error) => void) => {
        setTimeout(() => {
          clients.add(lateClient)
          lateClient.once('close', () => {
            clients.delete(lateClient)
            callback()
          })
        }, 50)
      })
    }
    const closed = cleanup.closeWebSocketServer(server, 100)
    const outcome = closed.then(
      () => undefined,
      (error: unknown) => error
    )

    await vi.advanceTimersByTimeAsync(100)

    await expect(outcome).resolves.toBeUndefined()
    expect(lateClient.terminateCalls).toBe(1)
    expect(server.close).toHaveBeenCalledOnce()
  })

  it('shares one disposal promise and attempts every cleanup step before aggregating failures', async () => {
    expect(cleanup.createSharedBestEffortDisposer).toBeTypeOf('function')
    if (!cleanup.createSharedBestEffortDisposer) return

    const order: string[] = []
    let releaseFirst!: () => void
    const firstStep = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const firstError = new Error('first cleanup failed')
    const finalError = new Error('final cleanup failed')
    const dispose = cleanup.createSharedBestEffortDisposer(
      [
        async () => {
          order.push('first')
          await firstStep
          throw firstError
        },
        () => {
          order.push('second')
        }
      ],
      () => {
        order.push('finalize')
        throw finalError
      }
    )

    const first = dispose()
    const retry = dispose()
    expect(retry).toBe(first)
    releaseFirst()

    const error = await first.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([firstError, finalError])
    expect(order).toEqual(['first', 'second', 'finalize'])
  })

  it('keeps the setup error primary when rollback also fails', () => {
    expect(cleanup.attachCleanupError).toBeTypeOf('function')
    if (!cleanup.attachCleanupError) return

    const setupError = new Error('setup failed')
    const cleanupError = new Error('cleanup failed')

    expect(cleanup.attachCleanupError(setupError, cleanupError)).toBe(setupError)
    expect((setupError as Error & { cleanupError?: unknown }).cleanupError).toBe(cleanupError)
  })
})
