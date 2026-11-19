import { setTimeout as delay } from 'node:timers/promises'
import type { BrowserBarAction, BrowserViewerStatus } from '@agentconnect.md/protocol/computer-viewer'
import type { AuditSink } from '../audit.js'
import { ComputerError, type Computer, type ViewerInput } from '../computer.js'
import { PageIds, withoutDevtoolsIds, type DevtoolsTarget } from './chrome-pages.js'
import { DevtoolsClient, type DevtoolsEvent } from './devtools-client.js'
import { devtoolsTargets, type DevtoolsEndpoint } from './devtools-endpoint.js'

interface BrowserViewerOptions {
  computer: Computer
  enabled: () => boolean
  endpoint: () => DevtoolsEndpoint | undefined
  pages: PageIds
  audit: AuditSink
  targets?: typeof devtoolsTargets
  connect?: (endpoint: DevtoolsEndpoint, onEvent: (event: DevtoolsEvent) => void) => DevtoolsClient
}

interface Dialog {
  type: string
  message: string
  defaultPrompt: string
}

interface BrowserConnection {
  endpoint: DevtoolsEndpoint
  client: DevtoolsClient
  sessions: Map<string, Promise<string>>
  sessionsById: Map<string, string>
  dialogs: Map<string, Dialog>
  discovering?: Promise<unknown>
}

interface Front {
  connection: BrowserConnection
  target: DevtoolsTarget
  sessionId: string
}

interface Screencast {
  connection: BrowserConnection
  target: DevtoolsTarget
  sessionId: string
  queue: Promise<void>
  nextFrameAt: number
}

interface BrowserStream {
  maxWidth: number
  maxHeight: number
  viewers: Set<(jpeg: Buffer) => Promise<void>>
  cast?: Screencast
}

const noBrowser = () => new ComputerError('unavailable', 'Chrome is not running.')

function address(text: string): URL {
  const url = URL.parse(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  if (!url || !['https:', 'http:'].includes(url.protocol))
    throw new ComputerError('invalid_argument', 'Enter an HTTP or HTTPS address.')
  return url
}

/** The authenticated Browser viewer controls the same Chrome window as the Desktop view. */
export class BrowserViewer {
  private connection: BrowserConnection | undefined
  private readonly streams = new Map<string, BrowserStream>()
  private timer: NodeJS.Timeout | undefined
  private refreshing = false

  constructor(private readonly options: BrowserViewerOptions) {}

  close(): void {
    clearInterval(this.timer)
    this.timer = undefined
    this.streams.clear()
    this.closeConnection()
  }

  private closeConnection(): void {
    this.connection?.client.close()
    this.connection = undefined
  }

  subscribe(maxWidth: number, maxHeight: number, send: (jpeg: Buffer) => Promise<void>): () => void {
    const size = `${maxWidth}x${maxHeight}`
    const stream: BrowserStream = this.streams.get(size) ?? { maxWidth, maxHeight, viewers: new Set() }
    stream.viewers.add(send)
    this.streams.set(size, stream)
    this.timer ??= setInterval(() => void this.refreshStreams(), 350).unref()
    void this.refreshStreams()
    return () => {
      stream.viewers.delete(send)
      if (stream.viewers.size) return
      this.streams.delete(size)
      if (stream.cast) void this.stopCast(stream.cast)
      if (!this.streams.size) {
        clearInterval(this.timer)
        this.timer = undefined
      }
    }
  }

  private async refreshStreams(): Promise<void> {
    if (this.refreshing || !this.streams.size) return
    this.refreshing = true
    try {
      const info = await this.targets()
      const front = info && this.frontTarget(info.targets)
      if (!info || !front) return
      await Promise.allSettled(
        [...this.streams.values()].map(async (stream) => {
          const old = stream.cast
          if (old?.connection === info.connection && old.target.id === front.id) return
          delete stream.cast
          if (old) await this.stopCast(old)
          const { client } = info.connection
          const { sessionId } = await client.call<{ sessionId: string }>('Target.attachToTarget', {
            targetId: front.id,
            flatten: true
          })
          const cast: Screencast = {
            connection: info.connection,
            target: front,
            sessionId,
            queue: Promise.resolve(),
            nextFrameAt: 0
          }
          if (!stream.viewers.size || this.connection !== info.connection) return this.stopCast(cast)
          stream.cast = cast
          try {
            await client.call(
              'Page.startScreencast',
              {
                format: 'jpeg',
                quality: 72,
                maxWidth: stream.maxWidth,
                maxHeight: stream.maxHeight
              },
              sessionId
            )
          } catch (error) {
            if (stream.cast === cast) delete stream.cast
            await this.stopCast(cast)
            throw error
          }
        })
      )
    } catch {
      // A later poll picks up a browser that was restarting or had no live tab.
    } finally {
      this.refreshing = false
    }
  }

  private async stopCast(cast: Screencast): Promise<void> {
    const { client } = cast.connection
    await client.call('Page.stopScreencast', {}, cast.sessionId).catch(() => undefined)
    await client.call('Target.detachFromTarget', { sessionId: cast.sessionId }).catch(() => undefined)
  }

  private castFrame(sessionId: string, params: Record<string, unknown>): void {
    const stream = [...this.streams.values()].find((entry) => entry.cast?.sessionId === sessionId)
    const cast = stream?.cast
    const { data, sessionId: frameId } = params
    if (!stream || !cast || typeof data !== 'string' || typeof frameId !== 'number') return
    cast.queue = cast.queue
      .then(async () => {
        const wait = cast.nextFrameAt - Date.now()
        if (wait > 0) await delay(wait)
        if (stream.cast !== cast || this.connection !== cast.connection || !this.options.enabled()) return
        if (data.length <= 6 * 1024 * 1024) {
          const jpeg = Buffer.from(data, 'base64')
          await Promise.allSettled([...stream.viewers].map((send) => send(jpeg)))
        }
        cast.nextFrameAt = Date.now() + 50
        await cast.connection.client.call('Page.screencastFrameAck', { sessionId: frameId }, sessionId)
      })
      .catch(() => undefined)
  }

  async status(): Promise<BrowserViewerStatus> {
    const available = this.options.enabled()
    const info = await this.targets()
    if (!info) return { available, running: false, pages: [], frontPageId: null, dialog: null }
    const { connection, targets, ids } = info
    const front = this.frontTarget(targets)
    const secrets = this.options.pages.secrets()
    const dialog = front && connection.dialogs.get(front.id)
    return {
      available,
      running: true,
      pages: targets.map((target) => ({
        id: ids.get(target.id)!,
        title: withoutDevtoolsIds(target.title, secrets),
        url: withoutDevtoolsIds(target.url, secrets)
      })),
      frontPageId: front ? (ids.get(front.id) ?? null) : null,
      dialog: dialog
        ? {
            type: dialog.type,
            message: withoutDevtoolsIds(dialog.message, secrets),
            defaultPrompt: withoutDevtoolsIds(dialog.defaultPrompt, secrets)
          }
        : null
    }
  }

  async frame(): Promise<Buffer> {
    const { connection, sessionId } = await this.front()
    const result = await connection.client.call<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'jpeg', quality: 72, captureBeyondViewport: false },
      sessionId
    )
    return Buffer.from(result.data, 'base64')
  }

  async action(client: string, input: BrowserBarAction, authorize: () => void): Promise<void> {
    const started = Date.now()
    const url = 'url' in input ? address(input.url) : undefined
    const audit = (outcome: 'ok' | 'error') =>
      this.options.audit({
        client,
        tool: `browser_${input.action}`,
        args: { ...(url ? { origin: url.origin } : {}), ...('pageId' in input ? { pageId: input.pageId } : {}) },
        outcome,
        ms: Date.now() - started
      })
    try {
      if (!this.options.enabled()) throw new ComputerError('unavailable', 'Browser view is unavailable.')
      authorize()
      if (input.action === 'open') {
        const connection = await this.openBrowser(authorize)
        authorize()
        const { targetId } = await connection.client.call<{ targetId: string }>('Target.createTarget', {
          url: url!.href,
          background: false
        })
        authorize()
        await this.activate(connection, targetId)
      } else if (input.action === 'select' || input.action === 'close') {
        const info = await this.targets()
        const target = info?.targets.find((item) => info.ids.get(item.id) === input.pageId)
        if (!info || !target) throw new ComputerError('invalid_argument', 'That tab is no longer available.')
        authorize()
        if (input.action === 'select') await this.activate(info.connection, target.id)
        else await info.connection.client.call('Target.closeTarget', { targetId: target.id })
      } else {
        const { connection, sessionId, target } = await this.front()
        const send = <T>(method: string, params: Record<string, unknown> = {}) => {
          authorize()
          return connection.client.call<T>(method, params, sessionId)
        }
        if (input.action === 'navigate') {
          const result = await send<{ errorText?: string }>('Page.navigate', { url: url!.href })
          if (result.errorText) throw new ComputerError('unavailable', 'Chrome could not load that address.')
        } else if (input.action === 'reload') await send('Page.reload')
        else if (input.action === 'dialog') {
          if (!connection.dialogs.has(target.id)) throw new ComputerError('invalid_argument', 'No page dialog is open.')
          await send('Page.handleJavaScriptDialog', {
            accept: input.accept,
            ...(input.text !== undefined ? { promptText: input.text } : {})
          })
        } else {
          const history = await connection.client.call<{ currentIndex: number; entries: { id: number }[] }>(
            'Page.getNavigationHistory',
            {},
            sessionId
          )
          const entry = history.entries[history.currentIndex + (input.action === 'back' ? -1 : 1)]
          if (entry) await send('Page.navigateToHistoryEntry', { entryId: entry.id })
        }
      }
      audit('ok')
    } catch (error) {
      audit('error')
      throw error
    }
  }

  async input(input: ViewerInput, authorize: () => void): Promise<void> {
    const { connection, sessionId, target } = await this.front()
    const { cssVisualViewport: viewport } = await connection.client.call<{
      cssVisualViewport: { clientWidth: number; clientHeight: number; offsetX: number; offsetY: number }
    }>('Page.getLayoutMetrics', {}, sessionId)
    const point = ({ x, y }: { x: number; y: number }) => ({
      x: Math.min(x * viewport.clientWidth, viewport.clientWidth - 1) + viewport.offsetX,
      y: Math.min(y * viewport.clientHeight, viewport.clientHeight - 1) + viewport.offsetY
    })
    const send = (method: string, params: Record<string, unknown>) => {
      authorize()
      // Page dialogs can hold the reply to the very input that opened them.
      void connection.client.call(method, params, sessionId).catch(() => undefined)
    }
    const mouse = (type: string, position: { x: number; y: number }, extra: Record<string, unknown> = {}) =>
      send('Input.dispatchMouseEvent', { type, ...point(position), ...extra })
    if (input.type === 'click' || input.type === 'drag') {
      authorize()
      await this.activate(connection, target.id)
    }
    switch (input.type) {
      case 'move':
        mouse('mouseMoved', input)
        break
      case 'click': {
        const buttons = { button: input.button ?? 'left', modifiers: keyModifiers(input.modifiers ?? []) }
        for (let n = 1; n <= (input.count ?? 1); n++) {
          mouse('mousePressed', input, { ...buttons, clickCount: n })
          mouse('mouseReleased', input, { ...buttons, clickCount: n })
        }
        break
      }
      case 'drag':
        mouse('mousePressed', input.from, { button: 'left', buttons: 1, clickCount: 1 })
        mouse('mouseMoved', input.to, { button: 'left', buttons: 1 })
        mouse('mouseReleased', input.to, { button: 'left', clickCount: 1 })
        break
      case 'scroll': {
        const amount = (input.amount ?? 1) * 48
        const deltaX = input.direction === 'left' ? -amount : input.direction === 'right' ? amount : 0
        const deltaY = input.direction === 'up' ? -amount : input.direction === 'down' ? amount : 0
        mouse('mouseWheel', input, { deltaX, deltaY })
        break
      }
      case 'type':
        send('Input.insertText', { text: input.text })
        break
      case 'key': {
        const raw = input.keys.at(-1)!
        const key = KEY_NAMES[raw.toLowerCase()] ?? raw
        const modifiers = keyModifiers(input.keys.slice(0, -1))
        const text = key.length === 1 && !(modifiers & 7) ? key : undefined
        const code = key.length === 1 ? key.toUpperCase().charCodeAt(0) : (KEY_CODES[key] ?? 0)
        send('Input.dispatchKeyEvent', {
          type: text ? 'keyDown' : 'rawKeyDown',
          key,
          modifiers,
          windowsVirtualKeyCode: code,
          ...(text ? { text } : {})
        })
        send('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers, windowsVirtualKeyCode: code })
        break
      }
    }
  }

  private async openBrowser(authorize: () => void): Promise<BrowserConnection> {
    const current = this.current()
    if (current) return current
    await this.options.computer.launchBrowserForAction()
    for (let attempt = 0; attempt < 75; attempt++) {
      authorize()
      const connection = this.current()
      if (connection) return connection
      await delay(200)
    }
    throw noBrowser()
  }

  private current(): BrowserConnection | undefined {
    const endpoint = this.options.enabled() ? this.options.endpoint() : undefined
    const current = this.connection
    if (
      current &&
      endpoint?.path === current.endpoint.path &&
      endpoint.port === current.endpoint.port &&
      !current.client.closed
    )
      return current
    this.closeConnection()
    if (!endpoint) return undefined
    const connect = this.options.connect ?? ((target, onEvent) => new DevtoolsClient(target, onEvent))
    const client = connect(endpoint, (event) => this.event(client, event))
    const connection: BrowserConnection = {
      endpoint,
      client,
      sessions: new Map(),
      sessionsById: new Map(),
      dialogs: new Map()
    }
    this.connection = connection
    return connection
  }

  private async targets() {
    const connection = this.current()
    if (!connection) return undefined
    const targets = await (this.options.targets ?? devtoolsTargets)(connection.endpoint)
    if (this.current() !== connection) return undefined
    const ids = this.options.pages.observe(connection.endpoint.path, targets)
    const pages = targets.filter(({ type }) => type === 'page')
    connection.discovering ??= connection.client.call('Target.setDiscoverTargets', { discover: true }).catch(() => {
      delete connection.discovering
    })
    for (const page of pages) void this.attach(connection, page.id).catch(() => undefined)
    return { connection, ids, targets: pages }
  }

  private frontTarget(targets: DevtoolsTarget[]): DevtoolsTarget | undefined {
    const preferred = this.options.pages.recentActivation()
    return targets.find(({ id }) => id === preferred) ?? targets[0]
  }

  private async front(): Promise<Front> {
    const info = await this.targets()
    const target = info && this.frontTarget(info.targets)
    if (!info || !target) throw noBrowser()
    const sessionId = await this.attach(info.connection, target.id)
    return { connection: info.connection, target, sessionId }
  }

  private async activate(connection: BrowserConnection, target: string): Promise<void> {
    await connection.client.call('Target.activateTarget', { targetId: target })
    this.options.pages.activated(target)
  }

  private attach(connection: BrowserConnection, target: string): Promise<string> {
    const pending = connection.sessions.get(target)
    if (pending) return pending
    const attaching = (async () => {
      const { sessionId } = await connection.client.call<{ sessionId: string }>('Target.attachToTarget', {
        targetId: target,
        flatten: true
      })
      connection.sessionsById.set(sessionId, target)
      try {
        await connection.client.call('Page.enable', {}, sessionId)
      } catch (error) {
        connection.sessionsById.delete(sessionId)
        throw error
      }
      return sessionId
    })().catch((error: unknown) => {
      connection.sessions.delete(target)
      throw error
    })
    connection.sessions.set(target, attaching)
    return attaching
  }

  private event(client: DevtoolsClient, event: DevtoolsEvent): void {
    const connection = this.connection
    if (!connection || connection.client !== client) return
    const { method, params, sessionId } = event
    if (method === 'Target.targetCreated') {
      const target = params.targetInfo as { type?: string; targetId?: string } | undefined
      if (target?.type === 'page' && target.targetId)
        void this.attach(connection, target.targetId).catch(() => undefined)
    } else if (method === 'Target.targetDestroyed' && typeof params.targetId === 'string') {
      connection.sessions.delete(params.targetId)
      connection.dialogs.delete(params.targetId)
      for (const [id, target] of connection.sessionsById)
        if (target === params.targetId) connection.sessionsById.delete(id)
    } else if (sessionId) {
      if (method === 'Page.screencastFrame') return this.castFrame(sessionId, params)
      const target = connection.sessionsById.get(sessionId)
      if (!target) return
      if (method === 'Page.javascriptDialogOpening')
        connection.dialogs.set(target, {
          type: String(params.type ?? ''),
          message: String(params.message ?? ''),
          defaultPrompt: String(params.defaultPrompt ?? '')
        })
      if (method === 'Page.javascriptDialogClosed') connection.dialogs.delete(target)
    }
  }
}

const KEY_NAMES: Record<string, string> = {
  return: 'Enter',
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  space: ' ',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown'
}
const KEY_CODES: Record<string, number> = {
  Enter: 13,
  Escape: 27,
  Tab: 9,
  Backspace: 8,
  Delete: 46,
  ArrowLeft: 37,
  ArrowRight: 39,
  ArrowUp: 38,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34
}
const MODIFIERS: Record<string, number> = { alt: 1, ctrl: 2, control: 2, meta: 4, shift: 8 }
const keyModifiers = (keys: string[]) => keys.reduce((value, key) => value | (MODIFIERS[key.toLowerCase()] ?? 0), 0)
