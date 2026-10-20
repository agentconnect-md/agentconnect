import { spawn, type ChildProcess } from 'node:child_process'
import { createSocket, type Socket } from 'node:dgram'
import { once } from 'node:events'
import { captureInputs, encodeArgs, type StreamSettings } from './ffmpeg.js'

export interface ScreenStreamOptions extends StreamSettings {
  dataDir: string
  // Resolved per start, so a background ffmpeg download is picked up without a restart.
  ffmpeg: () => string
  log: (line: string) => void
}

// A capture input that dies this soon after start is treated as unsupported and the next one is tried.
const EARLY_EXIT_MS = 4000
const RESTART_DELAY_MS = 2000
// Pacing: send at most PACE_FACTOR x the encoder bitrate, in bursts no larger than BURST_MS of that rate.
const PACE_FACTOR = 1.5
const BURST_MS = 20
// Beyond this much queued video the link cannot keep up; old packets are dropped and the next keyframe repairs it.
const MAX_QUEUE_MS = 1000

// One ffmpeg capture shared by every viewer: starts with the first subscriber, stops with the last.
export class ScreenStream {
  private readonly listeners = new Set<(packet: Buffer) => void>()
  private socket: Socket | undefined
  private process: ChildProcess | undefined
  private restart: NodeJS.Timeout | undefined
  private inputIndex = 0
  private running = false
  private runs = 0
  private readonly children = new Set<ChildProcess>()
  private readonly queue: Buffer[] = []
  private queuedBytes = 0
  private credit = 0
  private lastRefill = 0
  private drainTimer: NodeJS.Timeout | undefined
  lastError: string | undefined

  constructor(private readonly options: ScreenStreamOptions) {
    // Last resort on daemon exit: a capture process must not outlive it.
    process.once('exit', () => {
      for (const child of this.children) child.kill('SIGKILL')
    })
  }

  subscribe(listener: (packet: Buffer) => void): () => void {
    this.listeners.add(listener)
    if (!this.running) void this.start()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stop()
    }
  }

  private async start(): Promise<void> {
    this.running = true
    const run = ++this.runs
    // A keyframe arrives as a burst of hundreds of packets; Windows' 64 KB default buffer drops part of it.
    const socket = createSocket({ type: 'udp4', recvBufferSize: 8 * 1024 * 1024 })
    socket.on('message', (packet) => {
      // The RTP muxer also emits RTCP sender reports on this socket (payload types 200-204).
      const type = packet[1]! & 0x7f
      if (type >= 72 && type <= 76) return
      this.enqueue(packet)
    })
    socket.bind(0, '127.0.0.1')
    await once(socket, 'listening')
    // Stopped (and maybe restarted) while binding: this socket belongs to a dead run.
    if (!this.running || run !== this.runs) return void socket.close()
    this.socket = socket
    this.spawn()
  }

  private spawn(): void {
    if (!this.running || !this.socket) return
    const inputs = captureInputs(this.options.fps, this.options.dataDir)
    const input = inputs[Math.min(this.inputIndex, inputs.length - 1)]!
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      ...input.args,
      ...encodeArgs(this.options, input.filters, this.socket.address().port)
    ]
    const startedAt = Date.now()
    const child = spawn(this.options.ffmpeg(), args, {
      stdio: [input.producer ? 'pipe' : 'ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    this.process = child
    this.children.add(child)
    let stderr = ''
    const collect = (chunk: Buffer): void => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000)
    }
    child.stderr!.on('data', collect)
    let producer: ChildProcess | undefined
    if (input.producer) {
      const feeder = spawn(input.producer.command, input.producer.args, { stdio: ['ignore', 'pipe', 'pipe'] })
      producer = feeder
      this.children.add(feeder)
      feeder.stdout!.pipe(child.stdin!)
      child.stdin!.on('error', () => undefined)
      feeder.stderr!.on('data', collect)
      feeder.once('error', (error) => collect(Buffer.from(`${input.producer!.command}: ${error.message}\n`)))
      // ffmpeg sees EOF and exits when the feeder dies, which drives the restart below.
      feeder.once('exit', () => this.children.delete(feeder))
    }
    this.options.log(`screen stream: ffmpeg started (${input.name}, ${this.options.fps} fps)`)
    child.once('error', (error) => {
      this.lastError = `ffmpeg could not start: ${error.message}`
      this.options.log(`screen stream: ${this.lastError}`)
    })
    child.once('exit', (code) => {
      this.children.delete(child)
      producer?.kill()
      if (this.process === child) this.process = undefined
      if (!this.running) return
      const detail = stderr.trim().split('\n').slice(-3).join(' | ')
      this.lastError = `ffmpeg (${input.name}) exited with ${code}: ${detail}`
      this.options.log(`screen stream: ${this.lastError}`)
      if (Date.now() - startedAt < EARLY_EXIT_MS && this.inputIndex < inputs.length - 1) this.inputIndex++
      this.restart = setTimeout(() => this.spawn(), RESTART_DELAY_MS)
    })
  }

  private get bytesPerMs(): number {
    return (this.options.bitrateKbps * PACE_FACTOR) / 8
  }

  // A keyframe leaves ffmpeg as one burst of packets; sent unpaced it overflows thin links and is lost whole.
  private enqueue(packet: Buffer): void {
    this.queue.push(packet)
    this.queuedBytes += packet.length
    while (this.queuedBytes > this.bytesPerMs * MAX_QUEUE_MS) this.queuedBytes -= this.queue.shift()!.length
    if (!this.drainTimer) this.drain()
  }

  private drain(): void {
    this.drainTimer = undefined
    const now = performance.now()
    // Never below a few packets, or a low bitrate could never afford one 1200-byte packet.
    const burst = Math.max(this.bytesPerMs * BURST_MS, 4000)
    this.credit = Math.min(burst, this.credit + (now - (this.lastRefill || now - BURST_MS)) * this.bytesPerMs)
    this.lastRefill = now
    while (this.queue.length > 0 && this.credit >= this.queue[0]!.length) {
      const packet = this.queue.shift()!
      this.queuedBytes -= packet.length
      this.credit -= packet.length
      for (const listener of this.listeners) listener(packet)
    }
    if (this.queue.length > 0) this.drainTimer = setTimeout(() => this.drain(), 2)
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    clearTimeout(this.drainTimer)
    this.drainTimer = undefined
    this.queue.length = 0
    this.queuedBytes = 0
    clearTimeout(this.restart)
    const child = this.process
    this.process = undefined
    child?.kill()
    // ffmpeg can ignore SIGTERM while its capture device blocks; never leave one behind.
    if (child)
      setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'), 2000).unref()
    this.socket?.close()
    this.socket = undefined
    this.options.log('screen stream: stopped (no viewers)')
  }
}
