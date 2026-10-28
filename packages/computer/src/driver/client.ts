import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

export interface DriverContent {
  type: string
  text?: string
  data?: string
  mimeType?: string
}

export interface DriverResult {
  content: DriverContent[]
  structuredContent?: Record<string, unknown>
}

export interface DriverTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface Driver {
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DriverResult>
  listTools(): Promise<DriverTool[]>
  // Bumps on every (re)start; driver-side capture state does not survive a restart.
  generation(): number
  close(): Promise<void>
}

// The driver ran the call and reported a failure, so the action is known not to have taken effect.
export class DriverToolError extends Error {
  constructor(
    readonly tool: string,
    readonly result: DriverResult
  ) {
    super(result.content.find((block) => block.type === 'text')?.text ?? `${tool} failed`)
    this.name = 'DriverToolError'
  }
}

// The driver could not be reached before the call was sent; nothing was delivered.
export class DriverUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DriverUnavailableError'
  }
}

// The call was sent but its outcome is unknown (timeout, crash, cancellation); never replay it.
export class DriverUncertainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DriverUncertainError'
  }
}

export interface CuaDriverOptions {
  command: string
  // Command prefix, e.g. systemd-run --scope so apps the driver launches outlive a service restart.
  wrapper?: string[]
  callTimeoutMs: number
  log?: (line: string) => void
}

const RESTART_BACKOFF_MS = 2000

// Owns one `cua-driver mcp --direct` child in this interactive session and reconnects lazily after a crash.
export class CuaDriver implements Driver {
  private client: Client | undefined
  private connecting: Promise<Client> | undefined
  private lastStartAt = 0
  private stderrTail: string[] = []
  private starts = 0
  version: string | undefined

  constructor(private readonly options: CuaDriverOptions) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client
    this.connecting ??= (async () => {
      const wait = this.lastStartAt + RESTART_BACKOFF_MS - Date.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      this.lastStartAt = Date.now()
      const transport = new StdioClientTransport({
        command: this.options.wrapper?.[0] ?? this.options.command,
        args: [
          ...(this.options.wrapper?.slice(1) ?? []),
          ...(this.options.wrapper ? [this.options.command] : []),
          'mcp',
          '--direct',
          // The agent-cursor overlay glides ~1 s before every desktop click and draws a second cursor beside the real one.
          '--no-overlay'
        ],
        env: {
          ...(process.env as Record<string, string>),
          CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
          CUA_DRIVER_RS_UPDATE_CHECK: '0',
          // Cua Driver's Wayland backend (GNOME helper extension + portal/libei input) is opt-in.
          ...(process.platform === 'linux' && process.env.WAYLAND_DISPLAY ? { CUA_DRIVER_RS_ENABLE_WAYLAND: '1' } : {})
        },
        stderr: 'pipe'
      })
      transport.stderr?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString('utf8').split(/\r?\n/)) {
          if (!line) continue
          this.stderrTail.push(line)
          if (this.stderrTail.length > 40) this.stderrTail.shift()
        }
      })
      const client = new Client({ name: 'agentconnect-computer', version: '0.0.0' })
      client.onclose = () => {
        if (this.client === client) this.client = undefined
        this.options.log?.(`cua-driver exited; last stderr: ${this.stderrTail.slice(-5).join(' | ') || '(none)'}`)
      }
      try {
        await client.connect(transport)
      } catch (error) {
        throw new DriverUnavailableError(`failed to start ${this.options.command}: ${(error as Error).message}`, {
          cause: error
        })
      }
      this.version = client.getServerVersion()?.version
      this.client = client
      this.starts++
      return client
    })().finally(() => {
      this.connecting = undefined
    })
    return this.connecting
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DriverResult> {
    const client = await this.connect()
    let result
    try {
      result = await client.callTool(
        { name, arguments: args },
        { timeout: this.options.callTimeoutMs, ...(signal ? { signal } : {}) }
      )
    } catch (error) {
      throw new DriverUncertainError(`${name}: ${(error as Error).message}`, { cause: error })
    }
    const normalized: DriverResult = {
      content: (result.content ?? []) as DriverContent[],
      ...(result.structuredContent ? { structuredContent: result.structuredContent as Record<string, unknown> } : {})
    }
    if (result.isError) throw new DriverToolError(name, normalized)
    return normalized
  }

  async listTools(): Promise<DriverTool[]> {
    const client = await this.connect()
    const tools: DriverTool[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : {})
      for (const tool of page.tools) {
        tools.push({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema as Record<string, unknown>
        })
      }
      cursor = page.nextCursor
    } while (cursor)
    return tools
  }

  generation(): number {
    return this.starts
  }

  async close(): Promise<void> {
    const client = this.client
    this.client = undefined
    await client?.close().catch(() => undefined)
  }
}
