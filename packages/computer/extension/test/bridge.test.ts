import { describe, expect, it, vi } from 'vitest'
import { FormFillBridge, type BrowserApi } from '../src/bridge.js'
import { DaemonConnection, loopbackEndpoint, type SocketLike } from '../src/connection.js'
import type { PageDiscovery, PageFillResult } from '../src/page.js'

const TOP = 'https://login.example.test'
const FRAME = 'https://idp.example.test'
const requestId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

type Listener = (details: { tabId: number; frameId: number }) => void

function fakeBrowser(frames: { frameId: number; documentId: string; result?: PageDiscovery }[]) {
  const navigation = new Set<Listener>()
  const documents = new Map(
    frames.map((frame) => [frame.frameId, { documentId: frame.documentId, url: `${frame.result?.origin ?? TOP}/x` }])
  )
  let fillResult: () => Promise<PageFillResult> = async () => ({ status: 'done', fields: [] })
  const fills: unknown[] = []
  const api: BrowserApi = {
    tabs: { query: async () => [{ id: 7, url: `${TOP}/signin?token=url-canary-91`, title: 'Sign in' }] },
    scripting: {
      executeScript: (async (injection: { target: { documentIds?: string[] }; args?: unknown[] }) => {
        if (injection.target.documentIds) {
          fills.push(injection.args?.[0])
          return [{ frameId: 0, documentId: injection.target.documentIds[0]!, result: await fillResult() }]
        }
        return frames
      }) as unknown as BrowserApi['scripting']['executeScript']
    },
    webNavigation: {
      getFrame: (async ({ frameId }: { frameId: number }) =>
        documents.get(frameId) ?? null) as BrowserApi['webNavigation']['getFrame'],
      onBeforeNavigate: {
        addListener: (l: Listener) => navigation.add(l),
        removeListener: (l: Listener) => navigation.delete(l)
      },
      onCommitted: {
        addListener: (l: Listener) => navigation.add(l),
        removeListener: (l: Listener) => navigation.delete(l)
      }
    } as unknown as BrowserApi['webNavigation']
  }
  return {
    api,
    fills,
    documents,
    navigate: (frameId: number) => navigation.forEach((listener) => listener({ tabId: 7, frameId })),
    onFill: (next: () => Promise<PageFillResult>) => (fillResult = next)
  }
}

const loginForm = (focused = false) => ({
  id: 'form1',
  kind: 'login' as const,
  focused,
  fields: [
    { id: 'f1', control: 'text', purpose: 'username' as const, required: true, secret: false, empty: true },
    { id: 'f2', control: 'password', purpose: 'current-password' as const, required: true, secret: true, empty: true }
  ]
})
const searchForm = {
  id: 'page',
  kind: 'other' as const,
  focused: false,
  fields: [{ id: 'f3', control: 'search', purpose: 'unknown' as const, required: false, secret: false, empty: true }]
}

const noSleep = { sleep: async () => undefined }

describe('FormFillBridge discovery', () => {
  it('reports the tab by origin only and selects the sole form', async () => {
    const browser = fakeBrowser([
      { frameId: 0, documentId: 'D0', result: { origin: TOP, title: 'Sign in', forms: [loginForm()] } }
    ])
    const discovery = await new FormFillBridge(browser.api, noSleep).discover()
    expect(discovery.status).toBe('found')
    expect(discovery.tab).toEqual({ tabId: 7, topOrigin: TOP, title: 'Sign in' })
    expect(discovery.target).toEqual({
      tabId: 7,
      frameId: 0,
      documentId: 'D0',
      topOrigin: TOP,
      frameOrigin: TOP,
      formId: '0:form1'
    })
    expect(JSON.stringify(discovery)).not.toContain('url-canary-91')
  })

  it('prefers the focused form, asks for a choice between several, and finds one by id', async () => {
    const two = (focused: boolean) =>
      fakeBrowser([
        { frameId: 0, documentId: 'D0', result: { origin: TOP, title: '', forms: [searchForm] } },
        { frameId: 4, documentId: 'D4', result: { origin: FRAME, title: '', forms: [loginForm(focused)] } }
      ])
    const focused = await new FormFillBridge(two(true).api, noSleep).discover()
    expect(focused.status).toBe('found')
    expect(focused.target).toMatchObject({
      frameId: 4,
      documentId: 'D4',
      frameOrigin: FRAME,
      topOrigin: TOP,
      formId: '4:form1'
    })
    const ambiguous = await new FormFillBridge(two(false).api, noSleep).discover()
    expect(ambiguous.status).toBe('ambiguous')
    expect(ambiguous.target).toBeUndefined()
    expect(ambiguous.forms.map((form) => form.id)).toEqual(['0:page', '4:form1'])
    const named = await new FormFillBridge(two(false).api, noSleep).discover('4:form1')
    expect(named.status).toBe('found')
    expect((await new FormFillBridge(two(false).api, noSleep).discover('9:gone')).status).toBe('none')
  })

  it('skips opaque-origin frames and refuses non-web tabs', async () => {
    const sandboxed = fakeBrowser([
      { frameId: 2, documentId: 'D2', result: { origin: 'null', title: '', forms: [loginForm()] } }
    ])
    expect((await new FormFillBridge(sandboxed.api, noSleep).discover()).status).toBe('none')
    const settings = fakeBrowser([])
    settings.api.tabs.query = async () => [{ id: 1, url: 'chrome://settings' }]
    expect((await new FormFillBridge(settings.api, noSleep).discover()).status).toBe('unsupported')
  })
})

describe('FormFillBridge fill', () => {
  const target = { tabId: 7, frameId: 0, documentId: 'D0', topOrigin: TOP, frameOrigin: TOP, formId: '0:form1' }
  const values = [{ field: 'f1', value: 'ada' }]

  it('fills the discovered document and summarizes field outcomes', async () => {
    const browser = fakeBrowser([
      { frameId: 0, documentId: 'D0', result: { origin: TOP, title: '', forms: [loginForm()] } }
    ])
    browser.onFill(async () => ({
      status: 'done',
      fields: [
        { field: 'f1', status: 'filled' },
        { field: 'f2', status: 'not_found' }
      ]
    }))
    const result = await new FormFillBridge(browser.api, noSleep).fill(requestId(1), target, values)
    expect(result).toEqual({
      v: 1,
      requestId: requestId(1),
      status: 'partial',
      fields: [
        { field: 'f1', status: 'filled' },
        { field: 'f2', status: 'not_found' }
      ],
      navigated: false
    })
    expect(browser.fills).toEqual([{ formId: 'form1', frameOrigin: TOP, values }])
  })

  it('writes nothing when the document was replaced or the tab moved to another site', async () => {
    const browser = fakeBrowser([
      { frameId: 0, documentId: 'D0-reloaded', result: { origin: TOP, title: '', forms: [] } }
    ])
    const bridge = new FormFillBridge(browser.api, noSleep)
    expect((await bridge.fill(requestId(2), target, values)).status).toBe('target_changed')
    browser.documents.set(0, { documentId: 'D0', url: 'https://other.example.test/' })
    expect((await bridge.fill(requestId(3), target, values)).status).toBe('target_changed')
    expect(browser.fills).toEqual([])
  })

  it('never writes the same request twice', async () => {
    const browser = fakeBrowser([{ frameId: 0, documentId: 'D0', result: { origin: TOP, title: '', forms: [] } }])
    browser.onFill(async () => ({ status: 'done', fields: [{ field: 'f1', status: 'filled' }] }))
    const bridge = new FormFillBridge(browser.api, noSleep)
    expect((await bridge.fill(requestId(4), target, values)).status).toBe('filled')
    expect((await bridge.fill(requestId(4), target, values)).status).toBe('failed')
    expect(browser.fills).toHaveLength(1)
  })

  it('returns uncertain at the timeout and drops the late reply', async () => {
    vi.useFakeTimers()
    try {
      const browser = fakeBrowser([{ frameId: 0, documentId: 'D0', result: { origin: TOP, title: '', forms: [] } }])
      browser.onFill(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ status: 'done', fields: [{ field: 'f1', status: 'filled' }] }), 60_000)
          )
      )
      const pending = new FormFillBridge(browser.api, { timeoutMs: 15_000, ...noSleep }).fill(
        requestId(5),
        target,
        values
      )
      await vi.advanceTimersByTimeAsync(15_000)
      expect((await pending).status).toBe('uncertain')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a navigation the fill caused', async () => {
    const browser = fakeBrowser([{ frameId: 0, documentId: 'D0', result: { origin: TOP, title: '', forms: [] } }])
    browser.onFill(async () => {
      browser.navigate(0)
      return { status: 'done', fields: [{ field: 'f1', status: 'filled' }] }
    })
    const result = await new FormFillBridge(browser.api, noSleep).fill(requestId(6), target, values)
    expect(result).toMatchObject({ status: 'filled', navigated: true })
  })

  it('answers daemon requests and refuses unknown ones', async () => {
    const browser = fakeBrowser([])
    const bridge = new FormFillBridge(browser.api, noSleep)
    expect(await bridge.handle(JSON.stringify({ type: 'ping', id: 1 }))).toEqual({ type: 'reply', id: 1 })
    expect(await bridge.handle(JSON.stringify({ type: 'eval', id: 2, code: 'x' }))).toEqual({
      type: 'reply',
      id: 2,
      error: 'unsupported request'
    })
    expect(await bridge.handle('not json')).toBeUndefined()
  })
})

class FakeSocket implements SocketLike {
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(
    readonly url: string,
    readonly protocol: string
  ) {}
  send(data: string) {
    this.sent.push(data)
  }
  close(code = 1000) {
    this.readyState = 3
    this.onclose?.({ code })
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
}

describe('DaemonConnection', () => {
  it('dials only a loopback ws endpoint', () => {
    expect(loopbackEndpoint('ws://127.0.0.1:7682/')).toBe('ws://127.0.0.1:7682/')
    expect(loopbackEndpoint('ws://localhost:7682')).toBe('ws://localhost:7682/')
    expect(loopbackEndpoint('ws://example.test:7682/')).toBeUndefined()
    expect(loopbackEndpoint('wss://127.0.0.1:7682/')).toBeUndefined()
    expect(loopbackEndpoint('ws://127.0.0.1:7682/?token=x')).toBeUndefined()
    expect(loopbackEndpoint(42)).toBeUndefined()
  })

  it('says hello with its build id, serves requests only after the welcome, and redials after a close', async () => {
    const sockets: FakeSocket[] = []
    const timers: (() => void)[] = []
    const handle = vi.fn(async (raw: string) => ({
      type: 'reply' as const,
      id: (JSON.parse(raw) as { id: number }).id
    }))
    const connection = new DaemonConnection({
      bridge: { handle },
      endpoint: async () => 'ws://127.0.0.1:7682/',
      open: (url, protocol) => {
        const socket = new FakeSocket(url, protocol)
        sockets.push(socket)
        return socket
      },
      buildId: 'build-1',
      version: '2.0.0',
      setTimeout: (fn) => timers.push(fn),
      clearTimeout: () => undefined
    })
    await connection.ensure()
    const socket = sockets[0]!
    expect(socket.protocol).toBe('agentconnect.form-fill.v1')
    socket.open()
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: 'hello', protocol: 1, buildId: 'build-1', version: '2.0.0' })
    socket.onmessage?.({ data: JSON.stringify({ type: 'ping', id: 1 }) })
    expect(handle).not.toHaveBeenCalled()
    socket.onmessage?.({ data: JSON.stringify({ type: 'welcome', protocol: 1 }) })
    expect(connection.connected()).toBe(true)
    socket.onmessage?.({ data: JSON.stringify({ type: 'ping', id: 2 }) })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    expect(JSON.parse(socket.sent[1]!)).toEqual({ type: 'reply', id: 2 })
    socket.close(4426)
    expect(connection.connected()).toBe(false)
    expect(timers).toHaveLength(1)
    timers[0]!()
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
  })
})
