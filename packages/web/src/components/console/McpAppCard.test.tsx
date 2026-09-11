// @vitest-environment happy-dom

/**
 * The MCP App bridge (webchat-mcp-apps.md §7.3). What matters is the split: what the browser
 * answers on its own, what it forwards to the daemon, and what it refuses to do for a frame at
 * all — plus that a settled card stops being a frame rather than staying one nobody serves.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpAppCard, toDaemonRpc } from './McpAppCard'
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
  it('answers ui/initialize itself, then hands the view the call it was opened for', () => {
    render(<McpAppCard step={{ app: APP }} onRpc={async () => ({ ok: true, result: {} })} />)
    const posted: Record<string, unknown>[] = []
    vi.spyOn(frameWindow(), 'postMessage').mockImplementation((message: unknown) => {
      posted.push(message as Record<string, unknown>)
    })
    fromFrame({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} })
    expect(posted[0]).toMatchObject({ id: 1 })
    expect(posted.map((m) => m.method)).toEqual([
      undefined,
      'ui/notifications/tool-input',
      'ui/notifications/tool-result'
    ])
    // The input the tool was called with, and the result it produced — the spec's order.
    expect(posted[1]).toMatchObject({ params: { env: 'prod' } })
    expect(posted[2]).toMatchObject({ params: { structuredContent: { targets: ['a', 'b'] } } })
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

describe('toDaemonRpc — narrowing a forwarded request onto the checked wire union', () => {
  it('takes each served method in either spelling the extension uses', () => {
    expect(toDaemonRpc('tools/call', { name: 'charts__render', arguments: { a: 1 } })).toEqual({
      method: 'tools/call',
      name: 'charts__render',
      args: { a: 1 }
    })
    expect(toDaemonRpc('tools/call', { name: 'charts__render' })).toEqual({
      method: 'tools/call',
      name: 'charts__render'
    })
    expect(toDaemonRpc('resources/read', { uri: 'ui://charts/tpl' })).toEqual({
      method: 'resources/read',
      uri: 'ui://charts/tpl'
    })
    expect(toDaemonRpc('ui/message', { content: 'hi' })).toEqual({ method: 'ui/message', text: 'hi' })
    expect(toDaemonRpc('ui/update-model-context', { context: '' })).toEqual({
      method: 'ui/update-model-context',
      context: ''
    })
  })

  it('refuses params the daemon would only have to refuse again', () => {
    expect(toDaemonRpc('tools/call', {})).toBeNull()
    expect(toDaemonRpc('tools/call', { name: '' })).toBeNull()
    // An args LIST is not a record of arguments; dropping it would silently call with none.
    expect(toDaemonRpc('tools/call', { name: 'x', arguments: [1, 2] })).toEqual({ method: 'tools/call', name: 'x' })
    expect(toDaemonRpc('resources/read', { uri: 42 })).toBeNull()
    expect(toDaemonRpc('ui/message', { text: '' })).toBeNull()
    expect(toDaemonRpc('ui/open-link', { url: 'https://example.test' })).toBeNull()
  })
})
