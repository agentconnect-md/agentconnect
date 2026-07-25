import { spawn, type ChildProcess } from 'node:child_process'
import {
  deserializeMessage,
  serializeMessage,
  type JSONRPCMessage,
  type Transport,
  type TransportSendOptions
} from '@modelcontextprotocol/client'
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'

export class MemoryPluginStdioProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryPluginStdioProtocolError'
  }
}

export interface CappedStdioClientTransportOptions {
  command: string
  args?: string[]
  env?: Record<string, string>
  maxMessageBytes: number
}

/**
 * MCP stdio transport with an encoded per-message cap and silent stderr.
 *
 * The SDK's stock transport buffers until a newline without a size ceiling and
 * inherits stderr. A reviewed-but-buggy child could therefore exhaust daemon
 * memory or print record/credential content into operator logs before profile
 * validation runs. This transport preserves newline-delimited MCP semantics but
 * kills the child on an oversized/malformed line and never forwards stderr.
 */
export class CappedStdioClientTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: <T extends JSONRPCMessage>(message: T) => void

  private child?: ChildProcess
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private closing = false
  private fatalError?: MemoryPluginStdioProtocolError

  constructor(private readonly options: CappedStdioClientTransportOptions) {}

  get protocolError(): MemoryPluginStdioProtocolError | undefined {
    return this.fatalError
  }

  async start(): Promise<void> {
    if (this.child) throw new Error('stdio memory plugin transport is already started')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.command, this.options.args ?? [], {
        env: { ...getDefaultEnvironment(), ...(this.options.env ?? {}) },
        stdio: ['pipe', 'pipe', 'ignore'],
        shell: false,
        windowsHide: true
      })
      this.child = child
      let started = false
      child.once('spawn', () => {
        started = true
        resolve()
      })
      child.once('error', (error) => {
        if (!started) reject(error)
        this.onerror?.(error)
      })
      child.once('close', () => {
        if (this.child === child) this.child = undefined
        this.buffer = Buffer.alloc(0)
        this.onclose?.()
      })
      child.stdin?.on('error', (error) => this.onerror?.(error))
      child.stdout?.on('error', (error) => this.fail(error))
      child.stdout?.on('data', (chunk: Buffer | string) =>
        this.accept(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      )
    })
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const stdin = this.child?.stdin
    if (!stdin) throw new Error('stdio memory plugin transport is not connected')
    const encoded = Buffer.from(serializeMessage(message), 'utf8')
    if (encoded.byteLength > this.options.maxMessageBytes) {
      throw new MemoryPluginStdioProtocolError('stdio memory plugin request exceeds the transport limit')
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        stdin.off('error', onError)
        reject(error)
      }
      stdin.once('error', onError)
      stdin.write(encoded, (error) => {
        stdin.off('error', onError)
        if (error) reject(error)
        else resolve()
      })
    })
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const child = this.child
    if (!child) {
      this.buffer = Buffer.alloc(0)
      return
    }
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    child.stdin?.end()
    if (!(await this.waitFor(closed, 2_000))) child.kill('SIGTERM')
    if (!(await this.waitFor(closed, 2_000))) child.kill('SIGKILL')
    await this.waitFor(closed, 250)
    this.buffer = Buffer.alloc(0)
  }

  private accept(chunk: Buffer): void {
    if (this.closing) return
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    while (this.buffer.length) {
      const newline = this.buffer.indexOf(0x0a)
      if (newline < 0) {
        if (this.buffer.byteLength > this.options.maxMessageBytes) {
          this.fail(new MemoryPluginStdioProtocolError('stdio memory plugin response exceeds the transport limit'))
        }
        return
      }
      if (newline > this.options.maxMessageBytes) {
        this.fail(new MemoryPluginStdioProtocolError('stdio memory plugin response exceeds the transport limit'))
        return
      }
      const line = this.buffer.toString('utf8', 0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.subarray(newline + 1)
      try {
        this.onmessage?.(deserializeMessage(line))
      } catch {
        this.fail(new MemoryPluginStdioProtocolError('stdio memory plugin returned malformed JSON-RPC'))
        return
      }
    }
  }

  private fail(error: Error): void {
    if (this.closing) return
    if (error instanceof MemoryPluginStdioProtocolError) this.fatalError ??= error
    this.onerror?.(error)
    this.child?.kill('SIGTERM')
  }

  private async waitFor(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = await Promise.race([
      promise.then(() => false),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs)
        timer.unref?.()
      })
    ])
    if (timer) clearTimeout(timer)
    return !timedOut
  }
}
