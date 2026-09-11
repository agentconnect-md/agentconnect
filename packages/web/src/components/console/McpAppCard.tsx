'use client'

/**
 * An MCP App's interface, standing in the conversation (webchat-mcp-apps.md §7).
 *
 * The card is chrome the console owns — a head naming the tool, a settled state, a close — around
 * a frame the console deliberately owns NOTHING inside of. The document is agent-authored HTML on
 * an opaque origin, and every interaction with it goes through one `postMessage` bridge speaking
 * MCP's own JSON-RPC (SEP-1865).
 *
 * The bridge splits in exactly one place, and the split is the design's §7.3: what the browser can
 * answer truthfully, it answers here (the handshake, the theme, size, opening a link); what has an
 * authorization question attached — calling a tool, reading a resource, posting into the
 * conversation, keeping context for the next turn — is forwarded to the daemon, which resolves it
 * against its own record of the card rather than against anything the frame said.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { McpAppRpc } from '@agentconnect.md/protocol'
import {
  MCP_APPS_PROTOCOL_VERSION,
  MCP_APP_CONTEXT_MAX_CHARS,
  MCP_APP_MESSAGE_MAX_CHARS
} from '@agentconnect.md/protocol/mcp-app'
import { Icon } from '@/components/ui'
import type { SessionStep } from '@/lib/data'
import {
  MCP_APP_SANDBOX,
  buildMcpAppDocument,
  clampAppHeight,
  isOpenableAppLink,
  MCP_APP_DEFAULT_HEIGHT
} from '@/lib/mcp-app-frame'

/** How a settled frame reads once its bridge has stopped answering. */
const APP_OUTCOME: Record<string, { icon: string; color: string; label: string }> = {
  closed: { icon: 'x', color: 'var(--text-tertiary)', label: 'Interface closed' },
  superseded: { icon: 'refresh-cw', color: 'var(--text-tertiary)', label: 'Replaced by a newer interface' },
  expired: { icon: 'clock', color: 'var(--text-tertiary)', label: 'Interface expired with the session' }
}

export interface McpAppCardProps {
  step: Pick<SessionStep, 'app' | 'time'>
  /** Forward one view RPC to the daemon and resolve with its verdict. Absent ⇒ this card is
   *  read-only (a history view), and the frame is not armed at all. */
  onRpc?: (appId: string, rpc: McpAppRpc) => Promise<{ ok: true; result: unknown } | { ok: false; error: string }>
  /** Tell the daemon the reader closed the frame. Absent ⇒ no close control is offered. */
  onClose?: (appId: string) => void
}

/** The console's live theme, read off the `data-theme` attribute the shell maintains on `<html>`
 *  and re-read when it changes. Observed rather than threaded down as a prop: the attribute is
 *  already the single source of truth for every token in the page, and a second copy of it
 *  passed through the transcript could only ever disagree with the page the frame sits in. */
function useConsoleTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  useEffect(() => {
    const read = (): void => setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light')
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme
}

export function McpAppCard({ step, onRpc, onClose }: McpAppCardProps) {
  const theme = useConsoleTheme()
  const app = step.app
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [height, setHeight] = useState<number>(() => clampAppHeight(app?.dimensions?.height ?? MCP_APP_DEFAULT_HEIGHT))
  const [minimized, setMinimized] = useState(false)
  const settled = app?.outcome ? APP_OUTCOME[app.outcome] : undefined
  // A persisted card carries no template (§8), so history shows the header and the result and
  // never re-arms a frame against a session that has moved on.
  const live = !settled && !!app?.html && !!onRpc

  const doc = useMemo(() => (app?.html ? buildMcpAppDocument(app.html, app.csp) : ''), [app?.html, app?.csp])

  /** Send one host→view JSON-RPC message. Targeted at the frame's own window; the frame is on an
   *  opaque origin, so `'*'` is the only target origin that can reach it — which is safe in this
   *  direction precisely because the document is one we just handed it. */
  const post = useCallback((message: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage(message, '*')
  }, [])

  useEffect(() => {
    if (!live || !app) return
    // A forwarded call outliving this frame settles on its own promise and replies into a window
    // that is gone, which `postMessage` on a detached frame simply drops — so there is no queue
    // to drain here, only the listener to remove.
    const onMessage = (event: MessageEvent) => {
      // Identity by WINDOW, not by origin: a sandboxed frame's origin is the opaque `"null"`, so
      // an origin check would either admit every sandboxed frame on the page or nothing at all.
      // The window reference is the one thing that names exactly this card's frame.
      if (event.source !== frameRef.current?.contentWindow) return
      const msg = event.data as { id?: string | number; method?: string; params?: Record<string, unknown> } | undefined
      if (!msg || typeof msg !== 'object') return
      // An answer to something the host asked the view. Nothing is asked yet; ignored rather than
      // mistaken for a request, which is what an absent `method` would otherwise become.
      if (typeof msg.method !== 'string') return
      const reply = (body: Record<string, unknown>) => {
        if (msg.id !== undefined) post({ jsonrpc: '2.0', id: msg.id, ...body })
      }
      const params = msg.params ?? {}

      switch (msg.method) {
        // ── answered in the browser ───────────────────────────────────────────────────────────
        case 'ui/initialize':
          // Every field here is REQUIRED by `McpUiInitializeResult`, and the official SDK's
          // `App.connect()` rejects a result missing any of them — so an app built on the SDK
          // would never finish initializing. `hostCapabilities` (not `capabilities`) is the
          // spec's name, and what it declares is honest: the four host methods the daemon serves,
          // links, logging, and TEXT content in both directions, because text is all this host
          // decodes out of a content-block list.
          reply({
            result: {
              protocolVersion: MCP_APPS_PROTOCOL_VERSION,
              hostInfo: { name: 'agentconnect-console', version: MCP_APPS_PROTOCOL_VERSION },
              hostCapabilities: {
                serverTools: {},
                serverResources: {},
                openLinks: {},
                logging: {},
                message: { text: {} },
                updateModelContext: { text: {}, structuredContent: {} }
              },
              hostContext: { theme, displayMode: 'inline' }
            }
          })
          // The view is up; hand it the call it was opened for, in the order the spec sends them.
          // `tool-input` carries its arguments UNDER `arguments`: a bare object parses to empty
          // params against the notification schema, which loses them silently.
          if (app.toolInput) {
            post({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: app.toolInput } })
          }
          if (app.toolResult) {
            // `content` is required on the result notification, so an app-only result sends an
            // empty list rather than omitting the field.
            post({
              jsonrpc: '2.0',
              method: 'ui/notifications/tool-result',
              params: { ...app.toolResult, content: app.toolResult.content ?? [] }
            })
          }
          return
        case 'ui/notifications/initialized':
          return
        case 'ui/notifications/size-changed': {
          // Honored only on an axis the template declared FLEXIBLE. A fixed height is the
          // template's own statement about itself, and a view that reports past it is asking for
          // space it already said it did not need.
          if (app.dimensions?.flexibleHeight !== true) return
          const reported = (params as { height?: unknown }).height
          if (typeof reported === 'number') setHeight(clampAppHeight(reported))
          return
        }
        case 'ui/open-link': {
          const url = (params as { url?: unknown }).url
          // `noopener` and a scheme check, the same rule the URL-mode consent card applies: the
          // frame may ask to send the reader somewhere, and cannot send them itself.
          if (typeof url === 'string' && isOpenableAppLink(url)) window.open(url, '_blank', 'noopener,noreferrer')
          reply({ result: {} })
          return
        }
        case 'notifications/message':
          return

        // ── forwarded to the daemon ───────────────────────────────────────────────────────────
        case 'tools/call':
        case 'resources/read':
        case 'ui/message':
        case 'ui/update-model-context': {
          const rpc = toDaemonRpc(msg.method, params)
          if (!rpc) {
            reply({ error: { code: -32602, message: 'invalid params' } })
            return
          }
          void onRpc(app.appId, rpc).then((outcome) =>
            reply(outcome.ok ? { result: outcome.result } : { error: { code: -32000, message: outcome.error } })
          )
          return
        }
        default:
          // Unknown to this host. Answered as such rather than ignored: a view awaiting a reply
          // that never comes hangs, and a frame that hangs looks to the reader like one that broke.
          reply({ error: { code: -32601, message: `method not supported by this host: ${msg.method}` } })
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [live, app, onRpc, post, theme])

  // A theme change reaches a live view the way the spec says, rather than by rebuilding the frame
  // — reloading the document would throw away whatever the reader had already done in it.
  useEffect(() => {
    if (live) post({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme } })
  }, [theme, live, post])

  // A settled card's frame stops being driven; the view is told before it goes inert, so an app
  // that wants to say goodbye gets the chance the spec gives it.
  useEffect(() => {
    if (settled) post({ jsonrpc: '2.0', method: 'ui/resource-teardown', params: {} })
  }, [settled, post])

  if (!app) return null
  const edge = settled ? 'border-l-(--border-strong)' : 'border-l-(--brand)'
  return (
    <div
      className={`overflow-hidden rounded-md border border-l-2 border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs) ${edge}`}
    >
      <div className="flex min-w-0 items-center gap-[9px] px-[14px] py-[11px]">
        <span className="flex-none">
          <Icon name="layout-dashboard" size={14} color={settled ? 'var(--text-tertiary)' : 'var(--brand)'} />
        </span>
        <span className="min-w-0 truncate font-sans text-[13.5px] font-medium leading-normal text-(--text-primary)">
          {app.title}
        </span>
        <span className="min-w-0 flex-none truncate font-mono text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
          {app.toolName}
        </span>
        {step.time && (
          <span className="ml-auto flex-none font-mono text-[11.5px] font-normal leading-normal text-(--text-disabled)">
            {step.time}
          </span>
        )}
        <span className={`-my-[2px] -mr-[4px] flex flex-none items-center gap-[2px] ${step.time ? '' : 'ml-auto'}`}>
          {!settled && (
            <button
              type="button"
              className="iconbtn h-[22px] w-[22px]"
              aria-expanded={!minimized}
              aria-label={minimized ? 'Expand interface' : 'Minimize interface'}
              title={minimized ? 'Expand interface' : 'Minimize interface'}
              onClick={() => setMinimized((v) => !v)}
            >
              <Icon name={minimized ? 'chevron-right' : 'chevron-down'} size={12} color="var(--text-tertiary)" />
            </button>
          )}
          {!settled && onClose && (
            <button
              type="button"
              className="iconbtn h-[22px] w-[22px]"
              aria-label="Close interface"
              title="Close interface"
              onClick={() => onClose(app.appId)}
            >
              <Icon name="x" size={12} color="var(--text-tertiary)" />
            </button>
          )}
        </span>
      </div>
      {(!minimized || settled) && (
        <div className="min-w-0 border-t border-(--border-subtle)">
          {settled ? (
            <span className="flex min-w-0 items-center gap-[7px] px-[14px] py-[11px] font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)">
              <Icon name={settled.icon} size={13} color={settled.color} />
              <span className="min-w-0 truncate">{settled.label}</span>
            </span>
          ) : live ? (
            <iframe
              ref={frameRef}
              title={app.title}
              // Opaque origin, no storage, no console credentials — see lib/mcp-app-frame.ts.
              sandbox={MCP_APP_SANDBOX}
              srcDoc={doc}
              className="block w-full border-0 bg-(--surface-app)"
              style={{ height }}
            />
          ) : (
            // A card read back from history: the frame is not re-armed, and saying so is more
            // honest than showing a page whose buttons would do nothing.
            <span className="flex min-w-0 items-center gap-[7px] px-[14px] py-[11px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
              <Icon name="archive" size={13} color="var(--text-tertiary)" />
              <span className="min-w-0 truncate">This interface was shown live; its page is not replayed here.</span>
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/** Narrow one forwarded view request onto the checked union the wire carries. Null ⇒ the params
 *  are not what that method takes, and the view is told so rather than the daemon being asked. */
export function toDaemonRpc(method: string, params: Record<string, unknown>): McpAppRpc | null {
  if (method === 'tools/call') {
    const name = params.name
    const args = params.arguments ?? params.args
    if (typeof name !== 'string' || name.length === 0) return null
    return {
      method: 'tools/call',
      name,
      ...(args && typeof args === 'object' && !Array.isArray(args) ? { args: args as Record<string, unknown> } : {})
    }
  }
  if (method === 'resources/read') {
    return typeof params.uri === 'string' && params.uri.length > 0
      ? { method: 'resources/read', uri: params.uri }
      : null
  }
  if (method === 'ui/message') {
    // The spec sends `{ role: 'user', content: ContentBlock[] }`, not a string — a host reading a
    // string field gets nothing from a valid SDK request. A plain string is still tolerated, for
    // a hand-written page that never loaded the SDK.
    const text = appBlocksText(params.content ?? params.text)
    return text.length > 0 ? { method: 'ui/message', text: text.slice(0, MCP_APP_MESSAGE_MAX_CHARS) } : null
  }
  if (method === 'ui/update-model-context') {
    // `content` blocks and/or `structuredContent`, either of which may be absent. The structured
    // half is serialized rather than dropped: an app keeping its state there is saying precisely
    // what it wants the next turn to know.
    const text = appBlocksText(params.content ?? params.context)
    const structured = params.structuredContent
    const serialized =
      structured && typeof structured === 'object'
        ? safeJson(structured)
        : typeof structured === 'string'
          ? structured
          : ''
    const context = [text, serialized].filter((part) => part.length > 0).join('\n')
    // An EMPTY context is a real update — an app clearing what it had said — so it is forwarded.
    return { method: 'ui/update-model-context', context: context.slice(0, MCP_APP_CONTEXT_MAX_CHARS) }
  }
  return null
}

/**
 * The text an MCP Apps content-block list carries, joined.
 *
 * Only `text` blocks are read, which is exactly what `hostCapabilities` declares: an image or an
 * embedded resource in an app's message has nowhere to go in a daemon prompt, and claiming
 * support would drop it silently instead of visibly.
 */
export function appBlocksText(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks.trim()
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((block) => {
      const b = block as { type?: unknown; text?: unknown } | null
      return b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .filter((text) => text.length > 0)
    .join('\n')
    .trim()
}

/** Serialize an app's structured context, or nothing when it will not serialize (a cycle). */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}
