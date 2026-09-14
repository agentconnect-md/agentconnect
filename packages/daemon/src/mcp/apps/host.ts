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
  /** The tool's own human title (MCP `Tool.title`), when it declares one. The card's heading is
   *  shown to a READER, and `get-time` is an identifier where "Get Time" is a name. Absent ⇒ the
   *  card falls back to the tool name, which is all a server that declares no title gives us. */
  title?: string
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
  /** The reader-facing name of the tool that ran — its declared `title`, else its name. */
  title: string
  /**
   * Set when the tool DECLARED an interface that could not be produced — the template would not
   * read, was not one `text/html;profile=mcp-app` document, or exceeded the byte cap.
   *
   * Distinct from `card` merely being absent, and the distinction is what the reader hears: a tool
   * with no interface at all is the ordinary case and says nothing, while an interface that was
   * promised and then could not be shown is exactly the silence #1794 set out to end.
   */
  interfaceUnavailable?: true
  card?: {
    html: string
    csp?: McpAppCsp
    dimensions?: McpAppDimensions
    toolResult: { content?: unknown[]; structuredContent?: Record<string, unknown>; isError?: boolean }
  }
}

export interface McpAppsHostDeps {
  /**
   * The servers visible to ONE ORGANIZATION — daemon-local config overlaid with whatever the CP
   * pushed for that org — read through a function so a config reload or a CP push is picked up
   * without rebuilding the host. Only `ui` ones are ever dialed.
   *
   * Org-scoped rather than daemon-wide because a CP definition is: two organizations may each
   * have a server named `charts` pointing at different relay proxies under different grants, and a
   * single map keyed by name alone would let one org's connection answer the other's calls.
   * `undefined` is the daemon-local-only view, which is what a session with no CP org has.
   */
  defs: (orgId: string | undefined) => Record<string, McpServerDef>
  /**
   * Whether this org's view of `name` is that ORG'S OWN definition rather than daemon-local config.
   *
   * It decides what a connection is keyed by, and getting it wrong is invisible: a daemon-local
   * server is ONE server every organization shares, so keying it per org would dial it once per
   * org and — worse — leave a session that warmed it under one scope unable to find it under
   * another. A CP definition genuinely is per-org and must not be shared. Absent ⇒ everything is
   * treated as local, which is a daemon with no CP.
   */
  orgScoped?: (orgId: string | undefined, name: string) => boolean
  log?: Logger
  /** The host's own version, sent as client info. */
  version?: string
  /** Normalize a trusted stdio command the way runtime launches do (sandbox path rewriting). */
  resolveStdioCommand?: (command: string, env: McpServerDef['env']) => string
}

/** The key one connection is held under. `\0` cannot occur in either half, so the pair cannot be
 *  spelled two ways. The scope is the definition's OWNER — an org for a CP-pushed definition,
 *  nothing for a daemon-local one, which every organization shares. */
export function connKey(scope: string | undefined, server: string): string {
  return `${scope ?? ''}\u0000${server}`
}

/**
 * Which scope a connection for (org, name) belongs to — the decision the key above is built from,
 * exported because it is the whole of what separates "one server every org shares" from "that
 * org's own server", and getting it wrong is silent in both directions: key a local server per org
 * and a session that warmed it under one scope cannot find it under another; key a CP server
 * without one and two organizations share a connection authorized for only one of them.
 */
export function connScope(orgScoped: boolean, orgId: string | undefined): string | undefined {
  return orgScoped ? orgId : undefined
}

/**
 * What makes one live connection the RIGHT connection for a definition.
 *
 * A proxied definition's bearer is rotated by the CP: the name and the url stay put while the
 * grant behind them is replaced, so a connection cached by name alone keeps presenting a
 * credential the relay has already retired, and every later call fails — in new sessions too,
 * because the connection outlives them. Comparing the definition is what makes a rotation re-dial.
 */
export function connFingerprint(def: McpServerDef): string {
  return JSON.stringify([def.transport, def.command, def.args, def.env, def.url, def.headers])
}

/** One live upstream connection, or the reason there isn't one. */
interface Conn {
  client: Client
  /** The definition this connection was dialed for; a change means re-dial (see fingerprint). */
  fingerprint: string
  tools: Map<string, UpstreamTool>
  templates: Map<string, Template>
}

export class McpAppsHost {
  private readonly conns = new Map<string, Conn>()
  /** In-flight dials, each remembering WHICH definition it is dialing. A dial is only joinable by
   *  a caller wanting that same definition — see {@link connect}. */
  private readonly dialing = new Map<string, { fingerprint: string | undefined; promise: Promise<Conn | undefined> }>()

  constructor(private readonly deps: McpAppsHostDeps) {}

  /** The scope a connection for (org, name) is held under — see {@link McpAppsHostDeps.orgScoped}. */
  private scopeOf(orgId: string | undefined, server: string): string | undefined {
    return connScope(this.deps.orgScoped?.(orgId, server) === true, orgId)
  }

  /**
   * What makes one live connection the RIGHT connection for a definition.
   *
   * A proxied definition's bearer is rotated by the CP: the name and the url stay put while the
   * grant behind them is replaced, so a connection cached by name alone keeps presenting a
   * credential the relay has already retired, and every later call fails — in new sessions too,
   * because the connection outlives them. Comparing the definition itself is what makes a rotation
   * re-dial instead.
   */
  private static fingerprint(def: McpServerDef): string {
    return connFingerprint(def)
  }

  /** The servers one organization has that are daemon-hosted rather than runtime-attached. */
  uiServers(orgId: string | undefined): string[] {
    return Object.entries(this.deps.defs(orgId))
      .filter(([, def]) => def.ui === true)
      .map(([name]) => name)
  }

  /** Whether one name is a daemon-hosted UI server FOR THIS ORG — what `resolveAgentMcpServers`
   *  asks so it never hands the same server to the runtime as well. The org matters: the same
   *  name can be an ordinary server in one organization and a hosted one in another. */
  isUiServer(orgId: string | undefined, name: string): boolean {
    return this.deps.defs(orgId)[name]?.ui === true
  }

  /**
   * Dial every configured UI server, without waiting. Called once at startup, because tool
   * composition is synchronous and a session must not block on a third-party server's handshake:
   * {@link cachedToolsFor} answers from whatever has connected by then, and a server that comes up
   * late contributes its tools to the next session rather than delaying this one.
   */
  warm(orgId: string | undefined): void {
    for (const name of this.uiServers(orgId)) void this.connect(orgId, name)
  }

  /**
   * The bridge-visible descriptors for the UI servers this agent enabled, from connections that
   * are ALREADY up — the synchronous answer tool composition needs. A server still dialing, or
   * one that is down, contributes nothing; the warn from {@link dial} is where the reason is said,
   * so this never fails a session for a third party being slow.
   */
  cachedToolsFor(orgId: string | undefined, enabled: readonly string[]): ToolDescriptor[] {
    const out: ToolDescriptor[] = []
    for (const name of enabled) {
      const conn = this.conns.get(connKey(this.scopeOf(orgId, name), name))
      if (!conn || !this.isUiServer(orgId, name)) continue
      for (const tool of conn.tools.values()) out.push(tool.descriptor)
    }
    return out
  }

  /**
   * The bridge-visible descriptors for the UI servers this agent enabled, dialing what is not up
   * yet. The awaiting peer of {@link cachedToolsFor}, for a caller that can afford to wait.
   */
  async toolsFor(orgId: string | undefined, enabled: readonly string[]): Promise<ToolDescriptor[]> {
    const out: ToolDescriptor[] = []
    for (const name of enabled) {
      if (!this.isUiServer(orgId, name)) continue
      const conn = await this.connect(orgId, name)
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
  async call(
    orgId: string | undefined,
    server: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<AppToolCall> {
    const conn = await this.connect(orgId, server)
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

    const title = upstream.title ?? tool
    if (!upstream.templateUri || isError) return { content, isError, title }
    const template = await this.template(orgId, server, upstream.templateUri)
    if (!template) {
      this.deps.log?.warn(
        `mcp apps: tool "${server}${APP_TOOL_SEPARATOR}${tool}" declares ${upstream.templateUri} but its template could not be read — declining it`
      )
      return { content, isError, title, interfaceUnavailable: true }
    }
    return {
      // An app-only result is withheld from the model on the tool's own say-so, and the card
      // carries it instead. The model is still told a call happened — the bridge substitutes a
      // one-line acknowledgement — so an agent never reads silence as a failure.
      content: upstream.resultVisibleToModel ? content : [],
      isError,
      title,
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

  /**
   * The upstream tool name a VIEW's `tools/call` means, on this card's own server — or undefined
   * when that server exposes no such tool.
   *
   * A view knows its server's own names (`refresh`). It does not know, and must not need to know,
   * that an operator configured that server as `charts` and so the bridge calls the tool
   * `charts__refresh` — the namespace is AgentConnect's deployment detail. The bare name is
   * therefore tried first, and this server's own prefix is accepted too for a view that happens
   * to have seen the bridge name.
   *
   * The SERVER is never derived from the name: it comes from the card. That is what makes a
   * cross-server call impossible rather than merely detected — a name like `secrets__read` is
   * looked up on this card's server, does not exist there, and is refused.
   */
  async resolveViewTool(orgId: string | undefined, server: string, name: string): Promise<string | undefined> {
    const conn = await this.connect(orgId, server)
    if (!conn) return undefined
    if (conn.tools.has(name)) return name
    const prefix = `${server}${APP_TOOL_SEPARATOR}`
    const stripped = name.startsWith(prefix) ? name.slice(prefix.length) : undefined
    return stripped !== undefined && conn.tools.has(stripped) ? stripped : undefined
  }

  /**
   * Serve a view's `tools/call` — the same upstream path a runtime call takes, deliberately, so an
   * app's call is a real tool call and not a side channel, but with the RAW result rather than the
   * model's half of it.
   *
   * The distinction is the whole point of the separate method. {@link call} shapes a result for
   * the model, which drops `structuredContent` — and structured content is precisely what a view
   * asked for: a refresh or pagination tool answers with the rows, and handing the model's text
   * back instead leaves the interface with nothing to render.
   */
  async callForView(
    orgId: string | undefined,
    server: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<{ content: unknown[]; structuredContent?: Record<string, unknown>; isError: boolean }> {
    const conn = await this.connect(orgId, server)
    if (!conn) throw new Error(`MCP server "${server}" is not reachable`)
    if (!conn.tools.has(tool)) throw new Error(`MCP server "${server}" does not expose a tool named "${tool}"`)
    const raw = (await conn.client.callTool(
      { name: tool, arguments: args },
      { timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS }
    )) as { content?: unknown[]; structuredContent?: Record<string, unknown>; isError?: boolean }
    return {
      content: Array.isArray(raw.content) ? raw.content : [],
      ...(raw.structuredContent ? { structuredContent: raw.structuredContent } : {}),
      isError: raw.isError === true
    }
  }

  /** Serve a view's `resources/read`, restricted to the card's own server. */
  async readResource(orgId: string | undefined, server: string, uri: string): Promise<unknown> {
    const conn = await this.connect(orgId, server)
    if (!conn) throw new Error(`MCP server "${server}" is not reachable`)
    return await conn.client.readResource({ uri }, { timeout: READ_TIMEOUT_MS, maxTotalTimeout: READ_TIMEOUT_MS })
  }

  /** Whether a tool of this server declares an interface — what the decline path asks before it
   *  bothers a reader with a notice about a frame they were never going to see. */
  async declaresInterface(orgId: string | undefined, server: string, tool: string): Promise<boolean> {
    const conn = await this.connect(orgId, server)
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
  private async template(orgId: string | undefined, server: string, uri: string): Promise<Template | undefined> {
    const conn = await this.connect(orgId, server)
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
  private async connect(orgId: string | undefined, server: string): Promise<Conn | undefined> {
    const key = connKey(this.scopeOf(orgId, server), server)
    const def = this.deps.defs(orgId)[server]
    const wanted = def ? McpAppsHost.fingerprint(def) : undefined

    const existing = this.conns.get(key)
    if (existing) {
      if (wanted !== undefined && existing.fingerprint === wanted) return existing
      // The definition moved underneath it — a rotated grant, a changed url. Drop the connection
      // so the dial below presents what the CP is actually expecting now.
      this.conns.delete(key)
      void existing.client.close().catch(() => undefined)
    }

    // A dial already running may be dialing the OLD definition. Joining it would be wrong twice
    // over: its result carries a credential the CP has already replaced, and — the case that
    // actually strands a provider — if the retired grant is refused, the fresh definition never
    // gets a dial of its own and the server stays absent from every later session. So a running
    // attempt is joinable only by a caller wanting the very definition it is dialing.
    const inflight = this.dialing.get(key)
    if (inflight && inflight.fingerprint === wanted) return await inflight.promise

    const attempt: { fingerprint: string | undefined; promise: Promise<Conn | undefined> } = {
      fingerprint: wanted,
      promise: Promise.resolve(undefined)
    }
    attempt.promise = this.dial(orgId, server).then((conn) => {
      // Install only while this is still the current attempt. A superseded dial that succeeds
      // anyway must not overwrite the fresher connection — and must not be left open either.
      if (this.dialing.get(key) !== attempt) {
        if (conn) void conn.client.close().catch(() => undefined)
        return undefined
      }
      this.dialing.delete(key)
      if (conn) this.conns.set(key, conn)
      return conn
    })
    this.dialing.set(key, attempt)
    return await attempt.promise
  }

  private async dial(orgId: string | undefined, server: string): Promise<Conn | undefined> {
    const def = this.deps.defs(orgId)[server]
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
      const conn: Conn = { client, fingerprint: McpAppsHost.fingerprint(def), tools: new Map(), templates: new Map() }
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
          ...(typeof (tool as { title?: unknown }).title === 'string' && (tool as { title: string }).title.trim()
            ? { title: (tool as { title: string }).title }
            : {}),
          resultVisibleToModel: appResultVisibleToModel(tool),
          raw: tool
        })
      }
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
