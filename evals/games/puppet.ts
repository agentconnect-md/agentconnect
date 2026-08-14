/**
 * Driver side of the puppet ACP adapter (`puppet-acp-agent.mjs`): a local
 * socket server the adapter forwards every `session/new` binding and
 * `session/prompt` text to. The driver runs the deterministic brain — the
 * same `ScriptedBrain` the scripted CI variant runs in-process — and performs
 * the brain's tool calls against the daemon's MCP control socket with the
 * forwarded per-session binding, so every call still runs the production
 * trusted-session-context path attributed to the puppet agent's session.
 */
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DaemonMcpBinding } from './mcp-client.js'
import { executeBrainTurn, type ScriptedBrain } from './webchat-referee.js'

export interface PuppetPromptLogEntry {
  sessionId: string
  text: string
}

export class PuppetDriver {
  readonly endpoint: string
  /** Every prompt the puppet agent received, in order (incl. regenerations) —
   *  the real-subject replacement for the in-process prompt log. */
  readonly promptLog: PuppetPromptLogEntry[] = []
  private readonly server: net.Server
  private readonly bindings = new Map<string, DaemonMcpBinding | undefined>()
  private brain: ScriptedBrain | undefined
  private startedAt?: Promise<void>

  constructor() {
    this.endpoint = join(tmpdir(), `ac-puppet-${randomUUID().slice(0, 8)}.sock`)
    this.server = net.createServer((socket) => this.serve(socket))
  }

  /** Install the brain for this run (one brain, shared by every session the
   *  puppet agent opens — sessions are distinguished inside the prompt text). */
  useBrain(brain: ScriptedBrain): void {
    this.brain = brain
  }

  async start(): Promise<void> {
    this.startedAt ??= new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.endpoint, () => resolve())
    })
    await this.startedAt
  }

  private serve(socket: net.Socket): void {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim()) void this.handle(socket, line)
      }
    })
    socket.on('error', () => {})
  }

  private async handle(socket: net.Socket, line: string): Promise<void> {
    let message: { id?: number; op?: string; sessionId?: string; binding?: DaemonMcpBinding | null; text?: string }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    const answer = (payload: Record<string, unknown>) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify({ id: message.id, ...payload })}\n`)
    }
    if (message.op === 'new') {
      this.bindings.set(message.sessionId ?? '', message.binding ?? undefined)
      answer({})
      return
    }
    if (message.op === 'prompt') {
      const text = message.text ?? ''
      this.promptLog.push({ sessionId: message.sessionId ?? '', text })
      if (!this.brain) {
        answer({ reply: 'AC_NO_RESPONSE' })
        return
      }
      try {
        const { reply } = await executeBrainTurn(this.brain, this.bindings.get(message.sessionId ?? ''), text)
        answer({ reply })
      } catch (error) {
        answer({ reply: `puppet brain error: ${(error as Error).message}` })
      }
      return
    }
    answer({})
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}
