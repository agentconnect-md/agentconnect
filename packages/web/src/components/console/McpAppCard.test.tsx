// @vitest-environment happy-dom

/**
 * The MCP App bridge (webchat-mcp-apps.md §7.3). What matters is the split: what the browser
 * answers on its own, what it forwards to the daemon, and what it refuses to do for a frame at
 * all — plus that a settled card stops being a frame rather than staying one nobody serves.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MCP_APPS_PROTOCOL_VERSION, MCP_APP_MESSAGE_MAX_CHARS } from '@agentconnect.md/protocol'
import { McpAppCard, appBlocksText, toDaemonRpc } from './McpAppCard'
import type { SessionStep } from '@/lib/data'

const APP: NonNullable<SessionStep['app']> = {
  appId: 'app-1',
  title: 'Deploy target',
  toolName: 'charts__pick_target',
  html: '<p>frame</p>',
  toolInput: { env: 'prod' },
  toolResult: { structuredContent: { targets: ['a', 'b'] } }
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

function render(node: React.ReactNode): void {
  act(() => root.render(node))
}

/** The frame's own window, as the card identifies its sender by. happy-dom gives a `srcdoc`
 *  iframe a real contentWindow, which is what the card's `event.source` check compares against. */
function frameWindow(): Window {
  const iframe = host.querySelector('iframe')
  if (!iframe?.contentWindow) throw new Error('no frame rendered')
  return iframe.contentWindow as unknown as Window
}

/** Deliver one view→host message as if the frame had posted it. */
function fromFrame(data: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source: frameWindow() as never }))
  })
}

describe('McpAppCard — what renders', () => {
  it('arms a frame for a live card and names the tool beside the title', () => {
    render(<McpAppCard step={{ app: APP }} onRpc={async () => ({ ok: true, result: {} })} />)
    const iframe = host.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts allow-forms')
    expect(iframe?.getAttribute('srcdoc')).toContain('Content-Security-Policy')
    expect(host.textContent).toContain('Deploy target')
    expect(host.textContent).toContain('charts__pick_target')
  })

  it('does NOT arm a frame with no way to answer it — a history view is a record, not a page', () => {
    render(<McpAppCard step={{ app: APP }} />)
    expect(host.querySelector('iframe')).toBeNull()
    expect(host.textContent).toContain('not replayed here')
  })

  it('renders a settled card inert, saying how it ended instead of showing a dead page', () => {
    render(
      <McpAppCard step={{ app: { ...APP, outcome: 'superseded' } }} onRpc={async () => ({ ok: true, result: {} })} />
    )
    expect(host.querySelector('iframe')).toBeNull()
    expect(host.textContent).toContain('Replaced by a newer interface')
  })

  it('offers no close control once the card is settled', () => {
    const onClose = vi.fn()
    render(
      <McpAppCard
        step={{ app: { ...APP, outcome: 'closed' } }}
        onRpc={async () => ({ ok: true, result: {} })}
        onClose={onClose}
      />
    )
    expect(host.querySelector('button[aria-label="Close interface"]')).toBeNull()
  })

  it('reports a close on the reader’s say-so', () => {
    const onClose = vi.fn()
    render(<McpAppCard step={{ app: APP }} onRpc={async () => ({ ok: true, result: {} })} onClose={onClose} />)
    act(() => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Close interface"]')?.click()
    })
    expect(onClose).toHaveBeenCalledWith('app-1')
  })
})

describe('McpAppCard — the bridge', () => {
  it('answers ui/initialize with every field the SDK requires, then hands the view its call', () => {
    render(<McpAppCard step={{ app: APP }} onRpc={async () => ({ ok: true, result: {} })} />)
    const posted: Record<string, unknown>[] = []
    vi.spyOn(frameWindow(), 'postMessage').mockImplementation((message: unknown) => {
      posted.push(message as Record<string, unknown>)
    })
    fromFrame({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} })
    // `App.connect()` REJECTS a result missing any of these, so an SDK-built app would never
    // finish initializing. `hostCapabilities` is the spec's name — `capabilities` is a different
    // field and satisfies nothing.
    const result = posted[0]?.result as Record<string, unknown>
    expect(posted[0]).toMatchObject({ id: 1 })
    expect(result.protocolVersion).toBe(MCP_APPS_PROTOCOL_VERSION)
    expect(result.hostInfo).toMatchObject({ name: expect.any(String), version: expect.any(String) })
    expect(result.hostCapabilities).toBeTypeOf('object')
    expect(result.capabilities).toBeUndefined()
    expect(result.hostContext).toMatchObject({ theme: 'light' })

    expect(posted.map((m) => m.method)).toEqual([
      undefined,
      'ui/notifications/tool-input',
      'ui/notifications/tool-result'
    ])
    // The input rides UNDER `arguments`: a bare object parses to empty params and loses them.
    expect(posted[1]).toMatchObject({ params: { arguments: { env: 'prod' } } })
    // `content` is required on the result notification even for an app-only result.
    expect(posted[2]).toMatchObject({ params: { structuredContent: { targets: ['a', 'b'] }, content: [] } })
  })

  it('declares only the content modalities it actually decodes', () => {
    render(<McpAppCard step={{ app: APP }} onRpc={async () => ({ ok: true, result: {} })} />)
    const posted: Record<string, unknown>[] = []
    vi.spyOn(frameWindow(), 'postMessage').mockImplementation((message: unknown) => {
      posted.push(message as Record<string, unknown>)
    })
    fromFrame({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} })
    const caps = (posted[0]?.result as { hostCapabilities: Record<string, unknown> }).hostCapabilities
    expect(caps.message).toEqual({ text: {} })
    // Claiming image support would drop an app's image silently instead of visibly.
    expect((caps.message as Record<string, unknown>).image).toBeUndefined()
  })

  it('forwards a tools/call to the daemon and completes the view’s call with the verdict', async () => {
    const onRpc = vi.fn().mockResolvedValue({ ok: true, result: { content: [] } })
    render(<McpAppCard step={{ app: APP }} onRpc={onRpc} />)
    const posted: Record<string, unknown>[] = []
    vi.spyOn(frameWindow(), 'postMessage').mockImplementation((message: unknown) => {
      posted.push(message as Record<string, unknown>)
    })
    fromFrame({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'charts__render', arguments: { a: 1 } } })
    await act(async () => undefined)
    expect(onRpc).toHaveBeenCalledWith('app-1', { method: 'tools/call', name: 'charts__render', args: { a: 1 } })
    expect(posted.at(-1)).toMatchObject({ id: 7, result: { content: [] } })
  })

  it('turns a daemon refusal into a JSON-RPC error the frame can show, never into silence', async () => {
    const onRpc = vi.fn().mockResolvedValue({ ok: false, error: 'this interface is no longer active' })
    render(<McpAppCard step={{ app: APP }} onRpc={onRpc} />)
    const posted: Record<string, unknown>[] = []
    vi.spyOn(frameWindow(), 'postMessage').mockImplementation((message: unknown) => {
      posted.push(message as Record<string, unknown>)
    })
    fromFrame({ jsonrpc: '2.0', id: 9, method: 'ui/message', params: { text: 'ship it' } })
    await act(async () => undefined)
    expect(posted.at(-1)).toMatchObject({ id: 9, error: { message: 'this interface is no longer active' } })
  })

  it('answers an unknown method as unsupported rather than leaving the view waiting forever', () => {
    render(<McpAppCard step={{ app: APP }} onRpc={async () => ({ ok: true, result: {} })} />)
    const posted: Record<string, unknown>[] = []
    vi.spyOn(frameWindow(), 'postMessage').mockImplementation((message: unknown) => {
      posted.push(message as Record<string, unknown>)
    })
    fromFrame({ jsonrpc: '2.0', id: 3, method: 'ui/take-over-the-page', params: {} })
    expect(posted.at(-1)).toMatchObject({ id: 3, error: { code: -32601 } })
  })

  it('ignores a message that did not come from THIS card’s frame', () => {
    const onRpc = vi.fn().mockResolvedValue({ ok: true, result: {} })
    render(<McpAppCard step={{ app: APP }} onRpc={onRpc} />)
    act(() => {
      // Another window on the page — a second app's frame, or anything else — is not this bridge.
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'charts__render' } },
          source: window as never
        })
      )
    })
    expect(onRpc).not.toHaveBeenCalled()
  })

  it('opens a link for the frame only on a safe scheme, and never lets the frame navigate itself', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<McpAppCard step={{ app: APP }} onRpc={async () => ({ ok: true, result: {} })} />)
    fromFrame({ jsonrpc: '2.0', id: 1, method: 'ui/open-link', params: { url: 'https://example.test/docs' } })
    expect(open).toHaveBeenCalledWith('https://example.test/docs', '_blank', 'noopener,noreferrer')
    open.mockClear()
    fromFrame({ jsonrpc: '2.0', id: 2, method: 'ui/open-link', params: { url: 'javascript:alert(1)' } })
    expect(open).not.toHaveBeenCalled()
  })

  it('grows only on an axis the template declared flexible', () => {
    const fixed = { ...APP, dimensions: { height: 200 } }
    render(<McpAppCard step={{ app: fixed }} onRpc={async () => ({ ok: true, result: {} })} />)
    fromFrame({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 600 } })
    expect(host.querySelector('iframe')?.style.height).toBe('200px')

    act(() => root.unmount())
    root = createRoot(host)
    const flexible = { ...APP, dimensions: { height: 200, flexibleHeight: true } }
    render(<McpAppCard step={{ app: flexible }} onRpc={async () => ({ ok: true, result: {} })} />)
    fromFrame({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 600 } })
    expect(host.querySelector('iframe')?.style.height).toBe('600px')
  })
})

describe('appBlocksText — reading an MCP Apps content-block list', () => {
  it('joins text blocks, ignores the modalities this host does not decode, and tolerates a string', () => {
    expect(appBlocksText([{ type: 'text', text: ' a ' }])).toBe('a')
    expect(
      appBlocksText([
        { type: 'text', text: 'a' },
        { type: 'resource', resource: {} },
        { type: 'text', text: 'b' }
      ])
    ).toBe('a\nb')
    expect(appBlocksText('plain')).toBe('plain')
    expect(appBlocksText(undefined)).toBe('')
    expect(appBlocksText([null, 7, { type: 'text' }])).toBe('')
  })
})

describe('toDaemonRpc — narrowing a forwarded request onto the checked wire union', () => {
  it('decodes the SPEC’s ui/message shape — content blocks, not a string field', () => {
    // `{ role: 'user', content: ContentBlock[] }` is what the SDK sends; reading a `text` string
    // would return null for every valid request.
    expect(toDaemonRpc('ui/message', { role: 'user', content: [{ type: 'text', text: 'ship it' }] })).toEqual({
      method: 'ui/message',
      text: 'ship it'
    })
    // Several text blocks join; a modality this host does not decode contributes nothing.
    expect(
      toDaemonRpc('ui/message', {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', data: 'AA==' },
          { type: 'text', text: 'b' }
        ]
      })
    ).toEqual({ method: 'ui/message', text: 'a\nb' })
    // A message with no decodable text is refused rather than delivered empty.
    expect(toDaemonRpc('ui/message', { role: 'user', content: [{ type: 'image', data: 'AA==' }] })).toBeNull()
  })

  it('decodes ui/update-model-context from content blocks and/or structuredContent', () => {
    expect(toDaemonRpc('ui/update-model-context', { content: [{ type: 'text', text: 'picked prod' }] })).toEqual({
      method: 'ui/update-model-context',
      context: 'picked prod'
    })
    expect(toDaemonRpc('ui/update-model-context', { structuredContent: { env: 'prod' } })).toEqual({
      method: 'ui/update-model-context',
      context: '{"env":"prod"}'
    })
    // Both halves are kept: an app that says something in words AND in state means both.
    expect(
      toDaemonRpc('ui/update-model-context', {
        content: [{ type: 'text', text: 'picked' }],
        structuredContent: { env: 'prod' }
      })
    ).toEqual({ method: 'ui/update-model-context', context: 'picked\n{"env":"prod"}' })
    // An EMPTY update is a real one — an app clearing what it had said.
    expect(toDaemonRpc('ui/update-model-context', {})).toEqual({ method: 'ui/update-model-context', context: '' })
  })

  it('clamps a decoded payload to the wire bound instead of being refused by it', () => {
    const long = toDaemonRpc('ui/message', { content: [{ type: 'text', text: 'x'.repeat(10_000) }] })
    expect(long).not.toBeNull()
    if (long?.method === 'ui/message') expect(long.text.length).toBe(MCP_APP_MESSAGE_MAX_CHARS)
  })

  it('takes each served method in either spelling the extension uses', () => {
    expect(toDaemonRpc('tools/call', { name: 'charts__render', arguments: { a: 1 } })).toEqual({
      method: 'tools/call',
      name: 'charts__render',
      args: { a: 1 }
    })
    // A view calls its tool by the name ITS SERVER gave it; the daemon resolves that against the
    // card's own server, so a bare name is forwarded unchanged rather than rejected here.
    expect(toDaemonRpc('tools/call', { name: 'refresh' })).toEqual({ method: 'tools/call', name: 'refresh' })
    expect(toDaemonRpc('tools/call', { name: 'charts__render' })).toEqual({
      method: 'tools/call',
      name: 'charts__render'
    })
    expect(toDaemonRpc('resources/read', { uri: 'ui://charts/tpl' })).toEqual({
      method: 'resources/read',
      uri: 'ui://charts/tpl'
    })
    // A hand-written page that never loaded the SDK may still send a plain string.
    expect(toDaemonRpc('ui/message', { content: 'hi' })).toEqual({ method: 'ui/message', text: 'hi' })
  })

  it('refuses params the daemon would only have to refuse again', () => {
    expect(toDaemonRpc('tools/call', {})).toBeNull()
    expect(toDaemonRpc('tools/call', { name: '' })).toBeNull()
    // An args LIST is not a record of arguments; dropping it would silently call with none.
    expect(toDaemonRpc('tools/call', { name: 'x', arguments: [1, 2] })).toEqual({ method: 'tools/call', name: 'x' })
    expect(toDaemonRpc('resources/read', { uri: 42 })).toBeNull()
    expect(toDaemonRpc('ui/message', { text: '' })).toBeNull()
    expect(toDaemonRpc('ui/message', { content: [] })).toBeNull()
    expect(toDaemonRpc('ui/open-link', { url: 'https://example.test' })).toBeNull()
  })
})
