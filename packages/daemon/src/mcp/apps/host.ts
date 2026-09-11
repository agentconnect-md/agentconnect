/**
 * The daemon as MCP Apps HOST (webchat-mcp-apps.md §3).
 *
 * A server marked `ui: true` is not handed to the runtime. The daemon dials it itself, advertises
 * the `io.modelcontextprotocol/ui` extension — which is what makes the server register its
 * UI-enabled tools at all — and re-exposes its tools through the bridge the runtime already
 * mounts. The runtime calls them exactly as it calls a daemon-native tool; the daemon sits on the
 * call, sees `_meta.ui.resourceUri`, reads the template, and streams the card to webchat.
 *
 * WHY THE DAEMON AND NOT THE RUNTIME. Three independent reasons, and each alone decides it: no
 * ACP runtime advertises the extension, so a UI server would never register its UI tools; the
 * HTML is behind a `resources/read` a non-Apps host never issues; and ACP has no frame that means
 * "render this". The HTML cannot reach a browser down the runtime path at all — this is not a
 * preference between two workable seams.
 *
 * One connection per configured server, daemon-wide, because that is the scope its credentials
 * have. Connections are lazy and are not retried in a loop: a UI server that is down costs the
 * agent the tools of that one server, and says so, rather than stalling a turn.
 */
import { Client, StreamableHTTPClientTransport, type Transport } from '@modelcontextprotocol/client'
import { CappedStdioClientTransport } from '../../memory-plugin/stdio-transport.js'
import { MCP_APP_HTML_MAX_BYTES, type McpAppCsp, type McpAppDimensions } from '@agentconnect.md/protocol'
import type { McpServerDef } from '../../config/config-schema.js'
import type { Logger } from '../../log.js'
import type { ToolDescriptor } from '../../tool-schema/descriptor.js'
import {
  MCP_APP_UI_EXTENSION,
  MCP_APP_MIME,
  appCsp,
  appDimensions,
  appResultVisibleToModel,
  appTemplateText,
  appTemplateUri
} from './ui-meta.js'

const CONNECT_TIMEOUT_MS = 10_000
const CALL_TIMEOUT_MS = 60_000
const READ_TIMEOUT_MS = 10_000
const MAX_TOOLS_PER_SERVER = 128
// One upstream message may carry a whole template, so the cap clears the template cap with room
// for the JSON-RPC envelope and escaping — anything past that is a server misbehaving, not a
// large page.
const MAX_STDIO_MESSAGE_BYTES = 2 * MCP_APP_HTML_MAX_BYTES

/** The separator between a configured server name and one of its tools. Double underscore
 *  because a single one is ordinary inside a tool name and would make the split ambiguous; the
 *  namespace is what stops a UI server shadowing a daemon-native tool, so it must be exact. */
export const APP_TOOL_SEPARATOR = '__'

/** Split a bridge-visible tool name into its server and upstream halves, or undefined when the
 *  name is not namespaced at all (a daemon-native tool). */
export function splitAppToolName(name: string): { server: string; tool: string } | undefined {
  const at = name.indexOf(APP_TOOL_SEPARATOR)
  if (at <= 0) return undefined
  const server = name.slice(0, at)
  const tool = name.slice(at + APP_TOOL_SEPARATOR.length)
  return tool.length > 0 ? { server, tool } : undefined
}

/** One upstream tool, as the host holds it: the descriptor the runtime sees plus the two things
 *  only the host cares about — whether it has an interface, and who its result is for. */
interface UpstreamTool {
  descriptor: ToolDescriptor
  /** The `ui://` template this tool declares, if any. Its presence is what makes a call open a card. */
  templateUri?: string
  /** `_meta.ui.visibility` includes `model`. False ⇒ the body is the interface's, not the model's. */
  resultVisibleToModel: boolean
  /** The raw listed tool, kept so a card's dimensions can be re-read from the declaration. */
  raw: unknown
}

/** One template, once read. Cached for the life of the connection: the spec's whole reason for
 *  predeclaring a template is that a host may prefetch, cache and review it before anything runs. */
interface Template {
  html: string
  csp?: McpAppCsp
  dimensions?: McpAppDimensions
}

/** What one proxied call produced. `card` is present only when the tool declares an interface AND
 *  its template could be read — a declared-but-unreadable interface degrades to a plain tool call
 *  with a warning, never to a failed one. */
export interface AppToolCall {
  /** The upstream result's content blocks, for the model. Empty when the result is app-only. */
  content: unknown[]
  isError: boolean
  card?: {
    html: string
    csp?: McpAppCsp
    dimensions?: McpAppDimensions
    toolResult: { content?: unknown[]; structuredContent?: Record<string, unknown>; isError?: boolean }
  }
}

export interface McpAppsHostDeps {
  /** The daemon's configured servers, already validated — read through a function so a config
   *  reload is picked up without rebuilding the host. Only `ui` ones are ever dialed.
   *
   *  DAEMON-LOCAL definitions only, in v1. A CP-pushed definition is org-scoped, so hosting one
   *  would mean a connection per organization and a credential boundary between them; until that
   *  exists, a `ui` server must be configured on the daemon that hosts it. */
  defs: () => Record<string, McpServerDef>
  log?: Logger
  /** The host's own version, sent as client info. */
  version?: string
  /** Normalize a trusted stdio command the way runtime launches do (sandbox path rewriting). */
  resolveStdioCommand?: (command: string, env: McpServerDef['env']) => string
}

/** One live upstream connection, or the reason there isn't one. */
interface Conn {
  client: Client
  tools: Map<string, UpstreamTool>
  templates: Map<string, Template>
}

export class McpAppsHost {
  private readonly conns = new Map<string, Conn>()
  private readonly dialing = new Map<string, Promise<Conn | undefined>>()

  constructor(private readonly deps: McpAppsHostDeps) {}

  /** The configured servers that are daemon-hosted rather than runtime-attached. */
  uiServers(): string[] {
    return Object.entries(this.deps.defs())
      .filter(([, def]) => def.ui === true)
      .map(([name]) => name)
  }

  /** Whether one configured name is a daemon-hosted UI server — what `resolveAgentMcpServers`
   *  asks so it never hands the same server to the runtime as well. */
  isUiServer(name: string): boolean {
    return this.deps.defs()[name]?.ui === true
  }

  /**
   * Dial every configured UI server, without waiting. Called once at startup, because tool
   * composition is synchronous and a session must not block on a third-party server's handshake:
   * {@link cachedToolsFor} answers from whatever has connected by then, and a server that comes up
   * late contributes its tools to the next session rather than delaying this one.
   */
  warm(): void {
    for (const name of this.uiServers()) void this.connect(name)
  }

  /**
   * The bridge-visible descriptors for the UI servers this agent enabled, from connections that
   * are ALREADY up — the synchronous answer tool composition needs. A server still dialing, or
   * one that is down, contributes nothing; the warn from {@link dial} is where the reason is said,
   * so this never fails a session for a third party being slow.
   */
  cachedToolsFor(enabled: readonly string[]): ToolDescriptor[] {
    const out: ToolDescriptor[] = []
    for (const name of enabled) {
      const conn = this.conns.get(name)
      if (!conn || !this.isUiServer(name)) continue
      for (const tool of conn.tools.values()) out.push(tool.descriptor)
    }
    return out
  }

  /**
   * The bridge-visible descriptors for the UI servers this agent enabled, dialing what is not up
   * yet. The awaiting peer of {@link cachedToolsFor}, for a caller that can afford to wait.
   */
  async toolsFor(enabled: readonly string[]): Promise<ToolDescriptor[]> {
    const out: ToolDescriptor[] = []
    for (const name of enabled) {
      if (!this.isUiServer(name)) continue
      const conn = await this.connect(name)
      if (!conn) continue
      for (const tool of conn.tools.values()) out.push(tool.descriptor)
    }
    return out
  }

  /**
   * Run one proxied tool call and, when the tool has an interface, assemble the card's payload.
   *
   * The ORDER here is the contract: the tool runs, its result is what it is, and the card is
   * built from what came back. An interface never gates the call — a template that cannot be read
   * leaves a perfectly good tool result, and a reader who is never shown a frame leaves an agent
   * that still has words to answer with (§6).
   */
  async call(server: string, tool: string, args: Record<string, unknown>): Promise<AppToolCall> {
    const conn = await this.connect(server)
    if (!conn) throw new Error(`MCP server "${server}" is not reachable`)
    const upstream = conn.tools.get(tool)
    if (!upstream) throw new Error(`MCP server "${server}" does not expose a tool named "${tool}"`)

    const raw = (await conn.client.callTool(
      { name: tool, arguments: args },
      { timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS }
    )) as {
      content?: unknown[]
      structuredContent?: Record<string, unknown>
      isError?: boolean
      _meta?: unknown
    }
    const content = Array.isArray(raw.content) ? raw.content : []
    const isError = raw.isError === true

    if (!upstream.templateUri || isError) return { content, isError }
    const template = await this.template(server, upstream.templateUri)
    if (!template) {
      this.deps.log?.warn(
        `mcp apps: tool "${server}${APP_TOOL_SEPARATOR}${tool}" declares ${upstream.templateUri} but its template could not be read — rendering nothing`
      )
      return { content, isError }
    }
    return {
      // An app-only result is withheld from the model on the tool's own say-so, and the card
      // carries it instead. The model is still told a call happened — the bridge substitutes a
      // one-line acknowledgement — so an agent never reads silence as a failure.
      content: upstream.resultVisibleToModel ? content : [],
      isError,
      card: {
        html: template.html,
        ...(template.csp ? { csp: template.csp } : {}),
        ...((appDimensions(raw, upstream.raw) ?? template.dimensions)
          ? { dimensions: appDimensions(raw, upstream.raw) ?? template.dimensions }
          : {}),
        toolResult: {
          ...(content.length > 0 ? { content } : {}),
          ...(raw.structuredContent ? { structuredContent: raw.structuredContent } : {}),
          ...(isError ? { isError: true } : {})
        }
      }
    }
  }

  /** Serve a view's `tools/call` — the same upstream path a runtime call takes, deliberately, so
   *  an app's call is a real tool call with a real transcript row and not a side channel. */
  async callForView(server: string, tool: string, args: Record<string, unknown>): Promise<AppToolCall> {
    return await this.call(server, tool, args)
  }

  /** Serve a view's `resources/read`, restricted to the card's own server. */
  async readResource(server: string, uri: string): Promise<unknown> {
    const conn = await this.connect(server)
    if (!conn) throw new Error(`MCP server "${server}" is not reachable`)
    return await conn.client.readResource({ uri }, { timeout: READ_TIMEOUT_MS, maxTotalTimeout: READ_TIMEOUT_MS })
  }

  /** Whether a tool of this server declares an interface — what the decline path asks before it
   *  bothers a reader with a notice about a frame they were never going to see. */
  async declaresInterface(server: string, tool: string): Promise<boolean> {
    const conn = await this.connect(server)
    return conn?.tools.get(tool)?.templateUri !== undefined
  }

  async close(): Promise<void> {
    for (const [name, conn] of this.conns) {
      await conn.client.close().catch((err: unknown) => {
        this.deps.log?.debug(`mcp apps: closing "${name}" failed: ${(err as Error).message}`)
      })
    }
    this.conns.clear()
  }

  /** Read one template, cached. Undefined when the read failed, returned something that is not a
   *  single `text/html;profile=mcp-app` document, or exceeded the byte cap — which is DECLINED
   *  rather than truncated, because half a document renders as a broken page (§7.4). */
  private async template(server: string, uri: string): Promise<Template | undefined> {
    const conn = await this.connect(server)
    if (!conn) return undefined
    const cached = conn.templates.get(uri)
    if (cached) return cached
    let read: unknown
    try {
      read = await conn.client.readResource({ uri }, { timeout: READ_TIMEOUT_MS, maxTotalTimeout: READ_TIMEOUT_MS })
    } catch (err) {
      this.deps.log?.warn(`mcp apps: reading ${uri} from "${server}" failed: ${(err as Error).message}`)
      return undefined
    }
    const html = appTemplateText(read)
    if (html === undefined) {
      this.deps.log?.warn(`mcp apps: ${uri} on "${server}" is not one ${MCP_APP_MIME} document`)
      return undefined
    }
    if (Buffer.byteLength(html, 'utf8') > MCP_APP_HTML_MAX_BYTES) {
      this.deps.log?.warn(`mcp apps: ${uri} on "${server}" exceeds the ${MCP_APP_HTML_MAX_BYTES}-byte template cap`)
      return undefined
    }
    const contents = (read as { contents: unknown[] }).contents[0]
    const template: Template = {
      html,
      ...(appCsp(contents) ? { csp: appCsp(contents)! } : {}),
      ...(appDimensions(contents) ? { dimensions: appDimensions(contents)! } : {})
    }
    conn.templates.set(uri, template)
    return template
  }

  /** Dial one configured UI server, at most once concurrently. */
  private async connect(server: string): Promise<Conn | undefined> {
    const existing = this.conns.get(server)
    if (existing) return existing
    const inflight = this.dialing.get(server)
    if (inflight) return await inflight
    const attempt = this.dial(server).finally(() => this.dialing.delete(server))
    this.dialing.set(server, attempt)
    return await attempt
  }

  private async dial(server: string): Promise<Conn | undefined> {
    const def = this.deps.defs()[server]
    if (!def || def.ui !== true) return undefined
    let client: Client | undefined
    try {
      const transport = this.transportFor(def)
      client = new Client(
        { name: 'agentconnect-apps-host', version: this.deps.version ?? '0.0.0' },
        {
          // The negotiation that makes this work at all: a server registers its UI-enabled tools
          // only once a client says it can render them (SEP-1865). Declaring the mime types we
          // actually render — one, today — is the honest form of that claim.
          capabilities: { extensions: { [MCP_APP_UI_EXTENSION]: { mimeTypes: [MCP_APP_MIME] } } }
        }
      )
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
      const { tools } = await client.listTools(undefined, {
        timeout: READ_TIMEOUT_MS,
        maxTotalTimeout: READ_TIMEOUT_MS
      })
      if (tools.length > MAX_TOOLS_PER_SERVER) {
        throw new Error(`exposes ${tools.length} tools, past the ${MAX_TOOLS_PER_SERVER} cap`)
      }
      const conn: Conn = { client, tools: new Map(), templates: new Map() }
      for (const tool of tools) {
        const templateUri = appTemplateUri(tool)
        conn.tools.set(tool.name, {
          descriptor: {
            name: `${server}${APP_TOOL_SEPARATOR}${tool.name}`,
            description: tool.description ?? '',
            // The upstream schema passes through VERBATIM. Narrowing it to this daemon's own
            // descriptor shape would be this host deciding what another server's arguments are,
            // and the server is the only authority on that; the runtime validates against what
            // it is given, so a faithful schema is also the one that lets a call succeed.
            inputSchema: tool.inputSchema as ToolDescriptor['inputSchema']
          },
          ...(templateUri ? { templateUri } : {}),
          resultVisibleToModel: appResultVisibleToModel(tool),
          raw: tool
        })
      }
      this.conns.set(server, conn)
      const withUi = [...conn.tools.values()].filter((t) => t.templateUri).length
      this.deps.log?.info(`mcp apps: hosting "${server}" — ${conn.tools.size} tools, ${withUi} with an interface`)
      return conn
    } catch (err) {
      await client?.close().catch(() => undefined)
      this.deps.log?.warn(`mcp apps: "${server}" is unavailable: ${(err as Error).message}`)
      return undefined
    }
  }

  private transportFor(def: McpServerDef): Transport {
    if (def.transport === 'stdio') {
      const command = this.deps.resolveStdioCommand?.(def.command!, def.env) ?? def.command!
      // The memory plugin's hardened transport rather than the SDK's stock one, for the two
      // reasons it was written: a third-party child's stderr is never forwarded into operator
      // logs, and an oversized or malformed line kills the child instead of buffering without a
      // ceiling. Both apply at least as much to a server whose job is to ship us a document.
      return new CappedStdioClientTransport({
        command,
        args: def.args,
        env: Object.fromEntries((def.env ?? []).map((e) => [e.name, e.value])),
        maxMessageBytes: MAX_STDIO_MESSAGE_BYTES
      })
    }
    return new StreamableHTTPClientTransport(new URL(def.url!), {
      requestInit: { headers: Object.fromEntries((def.headers ?? []).map((h) => [h.name, h.value])) }
    })
  }
}
