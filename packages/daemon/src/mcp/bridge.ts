import net from 'node:net'
import { inputRequired, inputResponse, Server, type ElicitRequestFormParams } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { decodeFrames, encodeFrame, isAskRequiredResult, type IpcListToolsResult, type IpcResponse } from './ipc.js'
import { askModes, type AskAnswer, type AskModes } from './ask.js'
import type { McpContentResult } from './ops.js'

type IpcCall =
  | { op: 'attach' }
  | { op: 'listTools' }
  | {
      op: 'callTool'
      name: string
      args: Record<string, unknown>
      ask?: AskModes
      askAnswers?: Record<string, AskAnswer>
    }

/** One question per tool call: round 1 asks, round 2 consumes the answer (#1965). */
const ASK_MAX_ROUNDS = 2

/** Human-paced, but well under the SDK's 600s default — an answer that lands after the daemon's turn is gone is refused by the turn gate, so a shorter leg fails faster and more honestly. */
const ASK_ROUND_TIMEOUT_MS = 120_000

/** IPC client half of the bridge: a persistent UDS connection to the daemon's control server, correlated by an incrementing id; an `ok:false` response rejects with the daemon's error message. */
class IpcClient {
  private socket: net.Socket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private buf = ''
  private ready: Promise<void>
  /** Installed once the bridge serves stdio; a closed control socket then ends the process. */
  onClose?: () => void

  constructor(
    endpoint: string,
    private token: string
  ) {
    this.socket = net.connect(endpoint)
    this.socket.setEncoding('utf8')
    this.ready = new Promise((resolve, reject) => {
      this.socket.once('connect', resolve)
      this.socket.once('error', reject)
    })
    this.socket.on('data', (chunk: string) => {
      this.buf += chunk
      const { messages, rest } = decodeFrames<IpcResponse>(this.buf)
      this.buf = rest
      for (const res of messages) {
        const p = this.pending.get(res.id)
        if (!p) continue
        this.pending.delete(res.id)
        if (res.ok) p.resolve(res.result)
        else p.reject(new Error(res.error ?? 'tool call failed'))
      }
    })
    this.socket.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('daemon connection closed'))
      this.pending.clear()
      this.onClose?.()
    })
  }

  async request(call: IpcCall): Promise<unknown> {
    await this.ready
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.write(encodeFrame({ id, token: this.token, ...call }))
    })
  }

  async attach(): Promise<void> {
    await this.request({ op: 'attach' })
  }
}

/** The host's elicitation answers for this round, via the SDK's own structural discriminator — a bare response object carries no `kind` of its own. */
function askAnswersOf(responses: Record<string, unknown> | undefined): Record<string, AskAnswer> | undefined {
  if (!responses) return undefined
  const answers: Record<string, AskAnswer> = {}
  for (const key of Object.keys(responses)) {
    const view = inputResponse(responses, key)
    if (view.kind !== 'elicit') continue
    answers[key] =
      view.action === 'accept' ? { action: 'accept', content: view.content ?? {} } : { action: view.action }
  }
  return Object.keys(answers).length > 0 ? answers : undefined
}

/** The stdio MCP server that relays `tools/list` and `tools/call` to the running daemon over its control socket; the harness spawns it per session and the daemon does the real work. Two entries reach it: the daemon's hidden `mcp-bridge` subcommand where the runtime shares this filesystem, and the runtime image's own bundle where it does not (src/shim/mcp-bridge.ts). */
export async function runBridge(opts: { lazyTools?: boolean; version?: string } = {}): Promise<void> {
  const endpoint = process.env.AC_MCP_ENDPOINT
  const token = process.env.AC_MCP_TOKEN
  if (!endpoint || !token) {
    process.stderr.write('mcp-bridge: AC_MCP_ENDPOINT and AC_MCP_TOKEN must be set\n')
    process.exit(2)
  }

  const ipc = new IpcClient(endpoint, token)
  let tools: IpcListToolsResult['tools'] | undefined
  if (opts.lazyTools) {
    try {
      // A private bridge is not an MCP server until this persistent UDS connection is bound to its active cell; attach makes no CP request and discovers no tools.
      await ipc.attach()
    } catch (err) {
      process.stderr.write(`mcp-bridge: private attach failed: ${(err as Error).message}\n`)
      process.exit(1)
    }
  } else {
    try {
      const res = (await ipc.request({ op: 'listTools' })) as IpcListToolsResult
      tools = res.tools
    } catch (err) {
      process.stderr.write(`mcp-bridge: could not reach daemon: ${(err as Error).message}\n`)
      process.exit(1)
    }
  }

  // Version stated by the entry, not read from a package.json: the in-sandbox bundle is copied into the runtime image alone, and a manifest beside it would change how node reads every .js there.
  // `capabilities` stays tools-only — elicitation is a CLIENT capability no server can declare; what we do instead is READ the client's declaration below.
  const server = new Server(
    { name: 'agentconnect', version: opts.version ?? '0.0.0' },
    { capabilities: { tools: {} }, inputRequired: { maxRounds: ASK_MAX_ROUNDS, roundTimeoutMs: ASK_ROUND_TIMEOUT_MS } }
  )
  server.setRequestHandler('tools/list', async () => {
    if (tools) return { tools }
    const res = (await ipc.request({ op: 'listTools' })) as IpcListToolsResult
    return { tools: res.tools }
  })
  server.setRequestHandler('tools/call', async (req, ctx) => {
    // Read per call, not once at connect: the declaration only exists after `initialize`.
    const ask = askModes(server.getClientCapabilities())
    const askAnswers = askAnswersOf(ctx.mcpReq.inputResponses)
    try {
      const result = await ipc.request({
        op: 'callTool',
        name: req.params.name,
        args: (req.params.arguments ?? {}) as Record<string, unknown>,
        ...(ask ? { ask } : {}),
        ...(askAnswers ? { askAnswers } : {})
      })
      // The tool asked a question instead of answering: hand it to the SDK, which runs the elicitation leg (server→client on this 2025-era connection) and re-calls us with the answer.
      if (isAskRequiredResult(result)) {
        const { key, message, requestedSchema } = result.mcpAsk
        // The SDK's wire type carries a catchall index signature; ours deliberately has exactly three root keys, because codex re-parses this with a deny-unknown-fields type.
        const schema = requestedSchema as ElicitRequestFormParams['requestedSchema']
        return inputRequired({ inputRequests: { [key]: inputRequired.elicit({ message, requestedSchema: schema }) } })
      }
      // A tool may return native MCP content (a viewable image from readSlackFile) via the `mcpContent` marker — pass it through verbatim.
      if (result && typeof result === 'object' && Array.isArray((result as { mcpContent?: unknown }).mcpContent)) {
        const native = result as McpContentResult
        return { content: native.mcpContent, ...(native.mcpIsError === true ? { isError: true } : {}) }
      }
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return { content: [{ type: 'text', text: (err as Error).message }], isError: true }
    }
  })

  // Nothing else settles a request queued after the socket died, so a call would hang forever.
  ipc.onClose = () => {
    process.stderr.write('mcp-bridge: daemon control socket closed, exiting\n')
    process.exit(1)
  }
  // stdin EOF means the harness is gone; the stdio transport never watches for it, so the live socket would strand us.
  const exitWhenHarnessGone = (): void => process.exit(0)
  process.stdin.on('end', exitWhenHarnessGone)
  process.stdin.on('close', exitWhenHarnessGone)

  await server.connect(new StdioServerTransport())
}
