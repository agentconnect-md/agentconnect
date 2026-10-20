import { hostname, release } from 'node:os'
import {
  computerLeaseHolderName,
  normalizeComputerKey as normalizeKey,
  type ComputerControlLease
} from '@agentconnect.md/protocol/computer'
import { currentCallContext, type AuditSink, type CallContext } from './audit.js'
import type { DesktopConfig } from './config.js'
import {
  DriverToolError,
  DriverUnavailableError,
  DriverUncertainError,
  type Driver,
  type DriverContent,
  type DriverResult
} from './driver/client.js'

export type ComputerErrorCode =
  | 'computer_busy'
  | 'human_in_control'
  | 'human_active'
  | 'denied'
  | 'invalid_argument'
  | 'driver_error'
  | 'driver_unavailable'
  | 'uncertain'
  | 'unavailable'

export class ComputerError extends Error {
  constructor(
    readonly code: ComputerErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'ComputerError'
  }
}

export interface ToolOutput {
  content: DriverContent[]
  isError?: boolean
}

interface Lease {
  holder: string
  acquiredAt: number
  lastUsedAt: number
  // Set when the lease was taken under the Control Plane's lease with this id.
  cpLeaseId?: string
}

interface Capture {
  generation: number
  width: number
  height: number
  screenWidth: number
  screenHeight: number
  scale: number
}

export interface ComputerDeps {
  driver: Driver
  config: DesktopConfig
  audit?: AuditSink
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
  // Fires when the visible state (online / busy by holder / paused) changes, for the local indicator.
  onStatus?: (status: string) => void
  // Decides which shortcuts count as OS-level; defaults to this process's platform.
  platform?: NodeJS.Platform
  // Why the Control Plane's authority is missing (revoked, or its channel key lapsed); undefined while it may act.
  refusal?: () => string | undefined
  // Stores the screenshots an agent session's call returned and marks them in its output (computer-use.md §9).
  screenshots?: ScreenshotStash
}

/** Takes the images of one call's output for storage; returns the output with their references, or undefined to leave it. */
export type ScreenshotStash = (
  output: ToolOutput,
  context: CallContext
) => { output: ToolOutput; ref?: string } | undefined

export type ComputerConfig = Pick<
  DesktopConfig,
  | 'maxImageDimension'
  | 'leaseIdleSeconds'
  | 'leaseMaxSeconds'
  | 'humanIdleSeconds'
  | 'actionScreenshot'
  | 'actionSettleMs'
  | 'allowSystemKeys'
>

const MODIFIERS = new Set(['ctrl', 'control', 'shift', 'alt', 'option', 'cmd', 'command', 'win', 'meta', 'super', 'fn'])
const WINDOWS_KEYS = new Set(['win', 'meta', 'super', 'cmd', 'command'])
const MAC_COMMAND_KEYS = new Set(['cmd', 'command', 'meta'])
const HUMAN_POLL_MS = 500
const MAX_TYPE_CHARS = 4096
const TYPE_REMAP_PAUSE_MS = 40

// One self-hosted Computer: a single control lease, emergency pause, human-input arbitration, and one action at a time.
export class Computer {
  private readonly driver: Driver
  private readonly config: ComputerConfig
  private readonly audit: AuditSink
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly log: (line: string) => void
  private readonly onStatus: (status: string) => void
  private readonly platform: NodeJS.Platform
  private readonly refusal: () => string | undefined
  private readonly screenshots: ScreenshotStash | undefined
  private lastStatus = ''
  private lease: Lease | undefined
  // The control lease the Control Plane last told about (computer-use.md §4.4); only its holder session may take control.
  private cpLease: ComputerControlLease | undefined
  // `by` is set when a remote human took over through the web viewer.
  private paused: { at: number; reason: string; by?: string } | undefined
  private capture: Capture | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private busy = false
  private actions = 0
  private cursorBaseline: { x: number; y: number } | undefined
  private lastHumanAt = 0
  private poller: NodeJS.Timeout | undefined

  constructor(deps: ComputerDeps) {
    this.driver = deps.driver
    this.config = deps.config
    this.audit = deps.audit ?? (() => undefined)
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.log = deps.log ?? (() => undefined)
    this.onStatus = deps.onStatus ?? (() => undefined)
    this.platform = deps.platform ?? process.platform
    this.refusal = deps.refusal ?? (() => undefined)
    this.screenshots = deps.screenshots
  }

  // ---- Control Plane authority (computer-use.md §8.2): checked before every screenshot, input and viewer frame ----

  private assertAuthorized(): void {
    const refusal = this.refusal()
    if (refusal) throw new ComputerError('unavailable', refusal)
  }

  // Authority was lost: drop the lease and any viewer takeover; later calls are refused until it returns.
  suspend(reason: string): void {
    if (this.lease) this.log(`lease of ${this.lease.holder} revoked: ${reason}`)
    this.lease = undefined
    if (this.paused?.by) this.paused = undefined
    this.stopPolling()
    this.notify()
  }

  // The Control Plane granted, moved or ended the control lease; a local lease it no longer backs is dropped.
  applyControlLease(lease: ComputerControlLease | null): void {
    this.cpLease = lease ?? undefined
    const local = this.lease
    if (!local) return
    const backed = lease ? local.holder === computerLeaseHolderName(lease.holder) : local.cpLeaseId === undefined
    if (backed) {
      if (lease) local.cpLeaseId = lease.leaseId
      return
    }
    this.log(`lease of ${local.holder} pre-empted by the Control Plane`)
    this.lease = undefined
    this.stopPolling()
    this.notify()
  }

  // The local lease's holder, time since its last input, and time held, for the Computer channel heartbeat.
  leaseActivity(): { holder: string; idleMs: number; heldMs: number } | undefined {
    this.expireLease()
    if (!this.lease) return undefined
    const now = this.now()
    return {
      holder: this.lease.holder,
      idleMs: Math.max(0, now - this.lease.lastUsedAt),
      heldMs: Math.max(0, now - this.lease.acquiredAt)
    }
  }

  // The status the Computer channel heartbeat reports.
  liveStatus(): 'online' | 'paused' | 'human_in_control' | 'busy' {
    this.expireLease()
    if (this.paused?.by) return 'human_in_control'
    if (this.paused) return 'paused'
    return this.lease ? 'busy' : 'online'
  }

  // Why agents are paused, if they are; the console Stop resumes only its own pause.
  pauseReason(): string | undefined {
    return this.paused?.reason
  }

  private notify(): void {
    const status = this.refusal()
      ? 'unavailable'
      : this.paused?.by
        ? `viewer ${this.paused.by} in control`
        : this.paused
          ? 'paused'
          : this.lease
            ? `controlled by ${this.lease.holder}`
            : 'online'
    if (status === this.lastStatus) return
    this.lastStatus = status
    this.log(`status: ${status}`)
    this.onStatus(status)
  }

  // ---- local owner controls (tray / CLI / console in the full design) ----

  pause(reason: string): void {
    this.paused = { at: this.now(), reason }
    if (this.lease) this.log(`lease of ${this.lease.holder} revoked: ${reason}`)
    this.lease = undefined
    this.stopPolling()
    this.notify()
  }

  resume(): void {
    this.paused = undefined
    this.notify()
  }

  // ---- remote human takeover (web viewer): blocks agents exactly like an owner pause ----

  takeOver(client: string): void {
    this.assertAuthorized()
    if (this.paused && this.paused.by !== client) {
      throw new ComputerError('human_in_control', this.paused.reason, { by: this.paused.by ?? 'owner' })
    }
    this.pause(`remote takeover by ${client}`)
    this.paused!.by = client
    this.notify()
  }

  handBack(client: string): boolean {
    if (this.paused?.by !== client) return false
    this.resume()
    return true
  }

  controlledBy(client: string): boolean {
    return this.paused?.by === client
  }

  private assertViewerControl(client: string): void {
    if (!this.controlledBy(client)) throw new ComputerError('human_in_control', 'take control in the viewer first')
  }

  // Raw PNG of the primary display at the configured size, for the viewer's frame loop; not audited.
  async frame(): Promise<{ png: Buffer; width: number; height: number }> {
    const output = await this.exclusive(() => this.captureScreen())
    const image = output.content.find((block) => block.type === 'image')!
    return { png: Buffer.from(image.data ?? '', 'base64'), width: this.capture!.width, height: this.capture!.height }
  }

  // Viewer input from the human who took over; system keys are allowed since a person is driving.
  async viewerInput(client: string, input: ViewerInput): Promise<void> {
    const started = this.now()
    const args = input as unknown as Record<string, unknown>
    try {
      this.assertViewerControl(client)
      await this.exclusive(async () => {
        // Pause or hand-back may have happened while this input waited in the queue or for the capture.
        this.assertViewerControl(client)
        if (!this.captureIsCurrent()) await this.captureScreen()
        // Viewer coordinates are fractions of the frame; the driver wants pixels of its last capture.
        const { width, height } = this.capture!
        const px = (point: { x: number; y: number }) => ({
          x: Math.round(Math.min(Math.max(point.x, 0), 1) * (width - 1)),
          y: Math.round(Math.min(Math.max(point.y, 0), 1) * (height - 1))
        })
        const call = viewerCall(input, px)
        this.assertViewerControl(client)
        await this.callDriver(call, () => {
          this.assertAuthorized()
          this.assertViewerControl(client)
        })
      })
      if (input.type !== 'move')
        this.audit({ client, tool: `viewer_${input.type}`, args, outcome: 'ok', ms: this.now() - started })
    } catch (error) {
      const failure = toComputerError(error)
      this.audit({
        client,
        tool: `viewer_${input.type}`,
        args,
        outcome: 'error',
        code: failure.code,
        ms: this.now() - started
      })
      throw failure
    }
  }

  info(): Record<string, unknown> {
    this.expireLease()
    return {
      name: hostname(),
      kind: 'self-hosted',
      os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
      osVersion: release(),
      status: this.paused ? 'paused' : this.lease ? 'busy' : 'online',
      paused: this.paused ?? null,
      // Set while the Control Plane's authority is missing: every tool and viewer call is refused.
      unavailable: this.refusal() ?? null,
      // The Control Plane's lease, when one stands: only its holder session may send input.
      controlLease: this.cpLease ?? null,
      lease: this.lease
        ? {
            holder: this.lease.holder,
            acquiredAt: new Date(this.lease.acquiredAt).toISOString(),
            idleExpiresInSeconds: Math.max(
              0,
              Math.round((this.lease.lastUsedAt + this.config.leaseIdleSeconds * 1000 - this.now()) / 1000)
            )
          }
        : null,
      display: this.capture
        ? {
            screenshotWidth: this.capture.width,
            screenshotHeight: this.capture.height,
            screenWidth: this.capture.screenWidth,
            screenHeight: this.capture.screenHeight,
            scale: this.capture.scale
          }
        : null,
      humanIdleSeconds: this.config.humanIdleSeconds
    }
  }

  // ---- lease ----

  acquire(holder: string): Lease {
    this.assertAuthorized()
    this.expireLease()
    if (this.paused) throw new ComputerError('human_in_control', 'the owner paused this computer', this.paused)
    const granted = this.cpLease
    if (granted && computerLeaseHolderName(granted.holder) !== holder) {
      const label = granted.holder.agentName ?? granted.holder.agentId
      throw new ComputerError('computer_busy', `computer is controlled by ${label}`, {
        holder: label,
        sessionId: granted.holder.sessionId,
        agentId: granted.holder.agentId
      })
    }
    if (this.lease && this.lease.holder !== holder) {
      throw new ComputerError('computer_busy', `computer is controlled by ${this.lease.holder}`, {
        holder: this.lease.holder
      })
    }
    const now = this.now()
    this.lease ??= { holder, acquiredAt: now, lastUsedAt: now, ...(granted ? { cpLeaseId: granted.leaseId } : {}) }
    this.lease.lastUsedAt = now
    this.startPolling()
    this.notify()
    return this.lease
  }

  release(holder: string): boolean {
    if (this.lease?.holder !== holder) return false
    this.lease = undefined
    this.stopPolling()
    this.notify()
    return true
  }

  private expireLease(): void {
    if (!this.lease) return
    const now = this.now()
    const idle = now - this.lease.lastUsedAt > this.config.leaseIdleSeconds * 1000
    const capped = now - this.lease.acquiredAt > this.config.leaseMaxSeconds * 1000
    if (idle || capped) {
      this.log(`lease of ${this.lease.holder} expired (${idle ? 'idle' : 'max duration'})`)
      this.lease = undefined
      this.stopPolling()
      this.notify()
    }
  }

  // ---- human input arbitration: cursor movement we did not cause marks the human as active ----

  private startPolling(): void {
    if (this.poller) return
    this.poller = setInterval(() => void this.pollCursor(), HUMAN_POLL_MS)
    this.poller.unref()
  }

  private stopPolling(): void {
    if (this.poller) clearInterval(this.poller)
    this.poller = undefined
    this.cursorBaseline = undefined
  }

  // Runs while a lease is held: expires idle leases and watches for human pointer movement.
  async pollCursor(): Promise<void> {
    this.expireLease()
    if (!this.lease || this.busy || this.config.humanIdleSeconds === 0) return
    const actionsBefore = this.actions
    const position = await this.readCursor().catch(() => undefined)
    // An action that ran during the read moved the pointer itself and already reset the baseline.
    if (!position || this.busy || this.actions !== actionsBefore) return
    const baseline = this.cursorBaseline
    if (baseline && (baseline.x !== position.x || baseline.y !== position.y)) this.lastHumanAt = this.now()
    this.cursorBaseline = position
  }

  private async readCursor(): Promise<{ x: number; y: number } | undefined> {
    const result = await this.driver.call('get_cursor_position', {})
    const x = result.structuredContent?.x
    const y = result.structuredContent?.y
    return typeof x === 'number' && typeof y === 'number' ? { x, y } : undefined
  }

  private assertHumanIdle(): void {
    const quietMs = this.config.humanIdleSeconds * 1000
    const since = this.now() - this.lastHumanAt
    if (quietMs > 0 && since < quietMs) {
      throw new ComputerError('human_active', 'someone is using this computer; retry after they stop', {
        retryAfterMs: quietMs - since
      })
    }
  }

  // ---- serialization ----

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      // A call queued before the authority went away must not run after it.
      this.assertAuthorized()
      this.busy = true
      this.actions++
      try {
        return await fn()
      } finally {
        this.busy = false
      }
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  // ---- observation ----

  screenshot(client: string, signal?: AbortSignal): Promise<ToolOutput> {
    return this.audited(client, 'computer_screenshot', {}, () => this.exclusive(() => this.captureScreen(signal)))
  }

  private async captureScreen(signal?: AbortSignal): Promise<ToolOutput> {
    // A capture started after the authority went away, such as a post-action screenshot, is refused too.
    this.assertAuthorized()
    const result = await this.driver.call(
      'get_desktop_state',
      { max_image_dimension: this.config.maxImageDimension },
      signal
    )
    const meta = result.structuredContent ?? {}
    const num = (key: string): number => (typeof meta[key] === 'number' ? (meta[key] as number) : 0)
    this.capture = {
      generation: this.driver.generation(),
      width: num('screenshot_width'),
      height: num('screenshot_height'),
      screenWidth: num('screen_width'),
      screenHeight: num('screen_height'),
      scale: num('scale_factor') || 1
    }
    const image = result.content.find((block) => block.type === 'image')
    if (!image) throw new ComputerError('driver_error', 'driver returned no screenshot image')
    return {
      content: [
        image,
        {
          type: 'text',
          text: JSON.stringify({
            width: this.capture.width,
            height: this.capture.height,
            coordinates: 'x/y for computer_* tools are pixels of this image, origin top-left'
          })
        }
      ]
    }
  }

  cursorPosition(client: string): Promise<ToolOutput> {
    return this.audited(client, 'computer_cursor_position', {}, () =>
      this.exclusive(async () => {
        if (!this.captureIsCurrent()) await this.captureScreen()
        const position = await this.readCursor()
        if (!position) throw new ComputerError('driver_error', 'driver returned no cursor position')
        const capture = this.capture!
        const ratio = capture.screenWidth > 0 ? capture.width / capture.screenWidth : 1
        const point = { x: Math.round(position.x * ratio), y: Math.round(position.y * ratio) }
        return { content: [{ type: 'text', text: JSON.stringify(point) }] }
      })
    )
  }

  // ---- input ----

  click(client: string, args: { x: number; y: number; button?: string; count?: number; modifiers?: string[] }) {
    return this.input(client, 'computer_click', args, () => {
      const modifiers = args.modifiers?.map(normalizeKey) ?? []
      this.assertKeysAllowed(modifiers)
      return {
        name: 'click',
        args: {
          scope: 'desktop',
          x: args.x,
          y: args.y,
          ...(args.button ? { button: args.button } : {}),
          ...(args.count ? { count: args.count } : {}),
          ...(modifiers.length ? { modifier: modifiers } : {})
        }
      }
    })
  }

  move(client: string, args: { x: number; y: number }) {
    return this.input(client, 'computer_move', args, () => ({
      name: 'move_cursor',
      args: { scope: 'desktop', x: args.x, y: args.y }
    }))
  }

  drag(client: string, args: { from: { x: number; y: number }; to: { x: number; y: number } }) {
    return this.input(client, 'computer_drag', args, () => ({
      name: 'drag',
      args: { scope: 'desktop', from_x: args.from.x, from_y: args.from.y, to_x: args.to.x, to_y: args.to.y }
    }))
  }

  scroll(client: string, args: { x: number; y: number; direction: string; amount?: number }) {
    return this.input(client, 'computer_scroll', args, () => ({
      name: 'scroll',
      args: {
        scope: 'desktop',
        x: args.x,
        y: args.y,
        direction: args.direction,
        ...(args.amount ? { amount: args.amount } : {})
      }
    }))
  }

  type(client: string, args: { text: string }) {
    return this.input(client, 'computer_type', args, () => {
      if (args.text.length > MAX_TYPE_CHARS) {
        throw new ComputerError('invalid_argument', `text is limited to ${MAX_TYPE_CHARS} characters per call`)
      }
      return { name: 'type_text', args: { scope: 'desktop', text: args.text } }
    })
  }

  key(client: string, args: { keys: string[] }) {
    return this.input(client, 'computer_key', args, () => {
      const keys = args.keys.map(normalizeKey)
      this.assertKeysAllowed(keys)
      const modifiers = keys.filter((key) => MODIFIERS.has(key))
      const others = keys.filter((key) => !MODIFIERS.has(key))
      if (others.length !== 1) {
        throw new ComputerError('invalid_argument', 'keys must hold modifiers plus exactly one non-modifier key')
      }
      return modifiers.length === 0
        ? { name: 'press_key', args: { scope: 'desktop', key: others[0] } }
        : { name: 'hotkey', args: { scope: 'desktop', keys: [...modifiers, others[0]] } }
    })
  }

  launch(client: string, args: { app: string }) {
    return this.input(
      client,
      'computer_launch',
      args,
      () => {
        const looksLikePath = /[\\/]/.test(args.app) || /\.exe$/i.test(args.app)
        return {
          name: 'launch_app',
          args: looksLikePath && process.platform === 'win32' ? { path: args.app } : { name: args.app }
        }
      },
      { coordinates: false }
    )
  }

  // Lease-gated pass-through for raw Cua Driver tools (window-scoped background input, AX tokens, ...).
  driverTool(client: string, name: string, args: Record<string, unknown>, readOnly: boolean, signal?: AbortSignal) {
    if (readOnly) {
      return this.audited(client, `cua_${name}`, args, () =>
        this.exclusive(async () => ({ content: (await this.driver.call(name, args, signal)).content }))
      )
    }
    return this.input(
      client,
      `cua_${name}`,
      args,
      () => {
        this.assertKeysAllowed(passthroughKeys(args))
        if (typeof args.text === 'string' && args.text.length > MAX_TYPE_CHARS) {
          throw new ComputerError('invalid_argument', `text is limited to ${MAX_TYPE_CHARS} characters per call`)
        }
        return { name, args }
      },
      {
        coordinates: false,
        screenshot: false,
        passthrough: true
      }
    )
  }

  private input(
    client: string,
    tool: string,
    publicArgs: object,
    prepare: () => { name: string; args: Record<string, unknown> },
    options: { coordinates?: boolean; screenshot?: boolean; passthrough?: boolean } = {}
  ): Promise<ToolOutput> {
    return this.audited(client, tool, publicArgs as Record<string, unknown>, async () => {
      const call = prepare()
      this.acquire(client)
      this.assertHumanIdle()
      return this.exclusive(async () => {
        // The driver maps desktop x/y from this session's last capture, so one must exist at the configured size.
        if (options.coordinates !== false && !this.captureIsCurrent()) await this.captureScreen()
        this.assertHumanIdle()
        // Pause, release or expiry may have happened while this call waited in the queue.
        this.acquire(client)
        let result: DriverResult
        try {
          result = await this.callDriver(call, () => this.assertStillHolds(client))
        } catch (error) {
          if (error instanceof DriverUncertainError) return this.uncertain(error)
          throw error
        }
        if (this.lease) this.lease.lastUsedAt = this.now()
        this.cursorBaseline = await this.readCursor().catch(() => undefined)
        const content = options.passthrough ? result.content : result.content.filter((block) => block.type === 'text')
        if (options.screenshot !== false && this.config.actionScreenshot) {
          await this.sleep(this.config.actionSettleMs)
          try {
            content.push(...(await this.captureScreen()).content)
          } catch (error) {
            content.push({ type: 'text', text: `post-action screenshot failed: ${(error as Error).message}` })
          }
        }
        return { content }
      })
    })
  }

  private async uncertain(error: DriverUncertainError): Promise<ToolOutput> {
    const content: DriverContent[] = [
      {
        type: 'text',
        text: JSON.stringify({
          error: 'uncertain',
          message: `${error.message}. The action may or may not have happened and was NOT retried; check the screenshot before acting again.`
        })
      }
    ]
    try {
      content.push(...(await this.captureScreen()).content)
    } catch (captureError) {
      content.push({
        type: 'text',
        text: `screenshot after uncertain action failed: ${(captureError as Error).message}`
      })
    }
    return { content, isError: true }
  }

  // Between the driver calls of one action: authority, a pause and the lease are rechecked so a revoke stops what is left.
  private assertStillHolds(client: string): void {
    this.assertAuthorized()
    if (this.paused) throw new ComputerError('human_in_control', 'the owner paused this computer', this.paused)
    if (this.lease?.holder !== client) throw new ComputerError('unavailable', 'the control lease was revoked')
  }

  // Real Xorg typed "你好" as "好好": back to back, the next keymap remap lands before the app reads the previous key.
  private async callDriver(
    call: { name: string; args: Record<string, unknown> },
    fence: () => void
  ): Promise<DriverResult> {
    const text = call.args.text
    if (
      call.name !== 'type_text' ||
      this.platform !== 'linux' ||
      typeof text !== 'string' ||
      /^[\x20-\x7e\n\t]*$/.test(text)
    ) {
      return this.driver.call(call.name, call.args)
    }
    let result: DriverResult = { content: [] }
    let typed = 0
    for (const segment of typingSegments(text)) {
      if (typed > 0) {
        try {
          fence()
        } catch (error) {
          const failure = toComputerError(error)
          const progress = `stopped after typing ${typed} of ${[...text].length} characters`
          throw new ComputerError(failure.code, `${failure.message}; ${progress}`, failure.details)
        }
      }
      result = await this.driver.call(call.name, { ...call.args, text: segment })
      typed += [...segment].length
      if (segment.length === 1 && !/[\x20-\x7e\n\t]/.test(segment)) await this.sleep(TYPE_REMAP_PAUSE_MS)
    }
    return result
  }

  private captureIsCurrent(): boolean {
    return this.capture !== undefined && this.capture.generation === this.driver.generation()
  }

  private assertKeysAllowed(keys: string[]): void {
    if (this.config.allowSystemKeys) return
    const lowered = new Set(keys.map((key) => key.toLowerCase()))
    const has = (...names: string[]) => names.every((name) => lowered.has(name))
    if (this.platform === 'darwin') {
      // Cmd is the everyday macOS modifier; only lock screen, log out and force quit are refused.
      const command = [...lowered].some((key) => MAC_COMMAND_KEYS.has(key))
      if (command && (has('ctrl', 'q') || has('shift', 'q') || has('alt', 'escape'))) {
        throw new ComputerError(
          'denied',
          'OS-level shortcuts (lock screen, log out, force quit) are disabled on this computer'
        )
      }
      return
    }
    if ([...lowered].some((key) => WINDOWS_KEYS.has(key)) || has('ctrl', 'alt', 'delete')) {
      throw new ComputerError('denied', 'OS-level shortcuts (Win, Ctrl+Alt+Delete) are disabled on this computer')
    }
  }

  // A storage failure never fails the call: the screenshot is still returned, just not stored.
  private stash(output: ToolOutput): { output: ToolOutput; ref?: string } | undefined {
    if (!this.screenshots || !output.content.some((block) => block.type === 'image')) return undefined
    try {
      return this.screenshots(output, currentCallContext())
    } catch (error) {
      this.log(`screenshot storage skipped: ${(error as Error).message}`)
      return undefined
    }
  }

  private async audited(
    client: string,
    tool: string,
    args: Record<string, unknown>,
    fn: () => Promise<ToolOutput>
  ): Promise<ToolOutput> {
    const started = this.now()
    try {
      this.assertAuthorized()
      let output = await fn()
      const stored = this.stash(output)
      if (stored) output = stored.output
      this.audit({
        client,
        tool,
        args,
        outcome: output.isError ? 'error' : 'ok',
        ...(output.isError ? { code: 'uncertain' } : {}),
        ms: this.now() - started,
        ...(stored?.ref ? { screenshotRef: stored.ref } : {})
      })
      return output
    } catch (error) {
      const failure = toComputerError(error)
      this.audit({ client, tool, args, outcome: 'error', code: failure.code, ms: this.now() - started })
      return {
        isError: true,
        content: [
          { type: 'text', text: JSON.stringify({ error: failure.code, message: failure.message, ...failure.details }) }
        ]
      }
    }
  }
}

// Viewer x/y are fractions (0..1) of the displayed frame.
export type ViewerInput =
  | { type: 'move'; x: number; y: number }
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle'; count?: number; modifiers?: string[] }
  | { type: 'drag'; from: { x: number; y: number }; to: { x: number; y: number } }
  | { type: 'scroll'; x: number; y: number; direction: 'up' | 'down' | 'left' | 'right'; amount?: number }
  | { type: 'type'; text: string }
  | { type: 'key'; keys: string[] }

type Point = { x: number; y: number }

function viewerCall(input: ViewerInput, px: (point: Point) => Point): { name: string; args: Record<string, unknown> } {
  switch (input.type) {
    case 'move':
      return { name: 'move_cursor', args: { scope: 'desktop', ...px(input) } }
    case 'click': {
      const modifiers = input.modifiers?.map(normalizeKey) ?? []
      return {
        name: 'click',
        args: {
          scope: 'desktop',
          ...px(input),
          ...(input.button ? { button: input.button } : {}),
          ...(input.count ? { count: input.count } : {}),
          ...(modifiers.length ? { modifier: modifiers } : {})
        }
      }
    }
    case 'drag': {
      const [from, to] = [px(input.from), px(input.to)]
      return { name: 'drag', args: { scope: 'desktop', from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y } }
    }
    case 'scroll':
      return {
        name: 'scroll',
        args: { scope: 'desktop', ...px(input), direction: input.direction, amount: input.amount ?? 3 }
      }
    case 'type':
      if (input.text.length > MAX_TYPE_CHARS) {
        throw new ComputerError('invalid_argument', `text is limited to ${MAX_TYPE_CHARS} characters per call`)
      }
      return { name: 'type_text', args: { scope: 'desktop', text: input.text } }
    case 'key': {
      const keys = input.keys.map(normalizeKey)
      const modifiers = keys.filter((key) => MODIFIERS.has(key))
      const others = keys.filter((key) => !MODIFIERS.has(key))
      // A lone modifier (the viewer's Win button) is a plain key press.
      if (others.length === 0 && modifiers.length === 1) {
        return { name: 'press_key', args: { scope: 'desktop', key: modifiers[0] } }
      }
      if (others.length !== 1) {
        throw new ComputerError('invalid_argument', 'keys must hold modifiers plus exactly one non-modifier key')
      }
      return modifiers.length === 0
        ? { name: 'press_key', args: { scope: 'desktop', key: others[0] } }
        : { name: 'hotkey', args: { scope: 'desktop', keys: [...modifiers, others[0]] } }
    }
  }
}

// Splits text into ASCII runs and single other characters, which X11 types through a per-character keymap remap.
export function typingSegments(text: string): string[] {
  return text.match(/[\x20-\x7e\n\t]+|[^\x20-\x7e\n\t]/gu) ?? []
}

// Collects every key a raw driver call would press (keys, key, modifier, modifiers), splitting "win+r" style strings.
function passthroughKeys(args: Record<string, unknown>): string[] {
  const values = [args.keys, args.key, args.modifier, args.modifiers].flatMap((value) =>
    Array.isArray(value) ? value : [value]
  )
  return values
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) => (value.length > 1 ? value.split('+') : [value]))
    .filter((key) => key.trim() !== '')
    .map(normalizeKey)
}

function toComputerError(error: unknown): ComputerError {
  if (error instanceof ComputerError) return error
  if (error instanceof DriverToolError) {
    return new ComputerError('driver_error', error.message, error.result.structuredContent ?? {})
  }
  if (error instanceof DriverUnavailableError) return new ComputerError('driver_unavailable', error.message)
  if (error instanceof DriverUncertainError) return new ComputerError('uncertain', error.message)
  return new ComputerError('driver_error', (error as Error)?.message ?? String(error))
}
