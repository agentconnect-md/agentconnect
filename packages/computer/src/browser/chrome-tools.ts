// The chrome_* tools (computer-use.md §5.8): one Chrome DevTools MCP child per desktop, its lifetime, and each call through it.
import { mkdtempSync, lstatSync, readFileSync, realpathSync, rmdirSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, sep } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { computerBrowserTool } from '@agentconnect.md/protocol/computer-browser'
import { RELAY_COMPUTER_MAX_BODY_BYTES } from '@agentconnect.md/protocol'
import { currentCallContext, type AuditSink } from '../audit.js'
import { ComputerError, type ScreenshotStash, type ToolOutput } from '../computer.js'
import type { DriverContent } from '../driver/client.js'
import { COMPUTER_DAEMON_VERSION } from '../version.js'
import {
  CHROME_DEVTOOLS_MCP_VERSION,
  chromeAuditArgs,
  chromeChildArgs,
  chromeChildEnv,
  chromeDevtoolsMcpBin,
  upstreamArgs,
  upstreamName
} from './chrome-contract.js'
import { listedPages, PageIds, pageListText, withoutDevtoolsIds, type DevtoolsTarget } from './chrome-pages.js'
import { devtoolsTargets, type DevtoolsEndpoint } from './devtools-endpoint.js'

// A call that has not answered by then is abandoned and its child killed; within the relay's 120 s request timeout.
const DEADLINE_MS = 60_000
// A tab not in front draws no frame, so its screenshot waits out any deadline (measured); one in front took at most 1 s.
const SCREENSHOT_DEADLINE_MS = 15_000
// A tool's own `timeout` argument stays this far inside the deadline.
const TIMEOUT_MARGIN_MS = 5000
// How often a running call and every child check their browser's endpoint and idle time.
const WATCH_MS = 1000
const CONNECT_MS = 30_000
// Right after a browser restart the restored tabs reach the new child's list a moment later: a known id is looked up again.
const SYNC_ATTEMPTS = 6
const SYNC_RETRY_MS = 500
const MAX_SCREENSHOT_BYTES = 5_000_000
const MIME: Record<string, string> = {
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
}

export interface ChromeToolsOptions {
  // The checked endpoint of a desktop's browser; undefined while none runs or the tier is off.
  endpoint: (desktop: string) => DevtoolsEndpoint | undefined
  // `leaseIdleSeconds` (§4.4), read on every check so a policy change applies at once.
  idleMs: () => number
  maxImageDimension: () => number
  audit: AuditSink
  // Stores an agent session's screenshots as computer_screenshot's are (§9).
  screenshots?: ScreenshotStash
  // Why the Control Plane's authority is missing; calls are refused while it is.
  refusal?: () => string | undefined
  log: (line: string) => void
  // The child's command; default node and the pinned package's entry script.
  command?: string[]
  targets?: (endpoint: DevtoolsEndpoint) => Promise<DevtoolsTarget[]>
  now?: () => number
  deadlineMs?: number
  watchMs?: number
}

interface Child {
  client: Client
  transport: StdioClientTransport
  endpoint: DevtoolsEndpoint
  // Its HOME and TMPDIR, the only filesystem root it gets; removed with it.
  dir: string
  lastCall: number
  inflight: number
}

export interface ChromeCall {
  desktop: string | undefined
  client: string
  tool: string
  args: Record<string, unknown>
  signal?: AbortSignal
  refusal?: () => string | undefined
}

type RoutedCall = ChromeCall & { desktop: string }
type ChildResult = ToolOutput & { structuredContent?: Record<string, unknown> }

const sameEndpoint = (a: DevtoolsEndpoint | undefined, b: DevtoolsEndpoint): boolean =>
  a !== undefined && a.port === b.port && a.path === b.path

const failure = (error: unknown): ComputerError =>
  error instanceof ComputerError
    ? error
    : new ComputerError('unavailable', `the browser tools failed: ${(error as Error)?.message ?? String(error)}`, {
        reason: 'child_failed'
      })

/** Serves the chrome_* calls of every desktop; a child starts on a desktop's first call and stops on its own. */
export class ChromeTools {
  private readonly children = new Map<string, Child>()
  private readonly starting = new Map<string, Promise<Child>>()
  private readonly pages = new Map<string, PageIds>()
  private readonly now: () => number
  private readonly deadlineMs: number
  private readonly watchMs: number
  private timer: NodeJS.Timeout | undefined
  private stopped = false

  constructor(private readonly opts: ChromeToolsOptions) {
    this.now = opts.now ?? Date.now
    this.deadlineMs = opts.deadlineMs ?? DEADLINE_MS
    this.watchMs = opts.watchMs ?? WATCH_MS
  }

  /** The desktops whose child runs now, with its pid. */
  running(): { desktop: string; pid: number | null }[] {
    return [...this.children].map(([desktop, child]) => ({ desktop, pid: child.transport.pid }))
  }

  /** One chrome_* call: refused outside the contract, raced against the browser's exit and a deadline, audited. */
  async call(request: ChromeCall): Promise<ToolOutput> {
    const started = this.now()
    let output: ToolOutput
    let code: string | undefined
    try {
      output = await this.serve(request)
      if (output.isError) code = 'browser_error'
    } catch (error) {
      const refused = failure(error)
      code = refused.code
      output = {
        isError: true,
        content: [
          { type: 'text', text: JSON.stringify({ error: refused.code, message: refused.message, ...refused.details }) }
        ]
      }
    }
    const stored = output.isError ? undefined : this.stash(output)
    if (stored) output = stored.output
    this.opts.audit({
      client: request.client,
      tool: request.tool,
      args: chromeAuditArgs(request.args),
      outcome: output.isError ? 'error' : 'ok',
      ...(code ? { code } : {}),
      ms: this.now() - started,
      ...(stored?.ref ? { screenshotRef: stored.ref } : {}),
      ...(request.desktop && request.desktop !== 'main' ? { desktop: request.desktop } : {})
    })
    return output
  }

  /** Stops a desktop's child, as when the desktop stops; its page ids go with the desktop. */
  async stop(desktop: string, reason: string): Promise<void> {
    this.pages.delete(desktop)
    const starting = this.starting.get(desktop)
    this.starting.delete(desktop)
    await this.end(desktop, reason, false)
    await starting?.catch(() => undefined)
  }

  async stopAll(reason: string): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    const desktops = new Set([...this.children.keys(), ...this.starting.keys()])
    await Promise.allSettled([...desktops].map((desktop) => this.stop(desktop, reason)))
  }

  private async serve(request: ChromeCall): Promise<ToolOutput> {
    const contract = computerBrowserTool(request.tool)
    // Only the contract's tools that take no lease exist here yet; anything else is refused before a child starts.
    if (!contract || contract.lease)
      throw new ComputerError('denied', `${request.tool} is not offered on this computer`)
    const denied = request.refusal?.()
    if (denied) throw new ComputerError('denied', denied)
    const refusal = this.opts.refusal?.()
    if (refusal) throw new ComputerError('unavailable', refusal)
    if (this.stopped) throw new ComputerError('unavailable', 'The computer is stopping.')
    const desktop = request.desktop
    const endpoint = desktop === undefined ? undefined : this.opts.endpoint(desktop)
    if (desktop === undefined || !endpoint)
      throw new ComputerError('unavailable', "this desktop's browser is not running", { reason: 'browser_not_running' })
    const child = await this.child(desktop, endpoint)
    child.inflight++
    child.lastCall = this.now()
    try {
      const output = await this.run(
        { ...request, desktop },
        child,
        contract.inputSchema.properties.pageId !== undefined
      )
      if (Buffer.byteLength(JSON.stringify(output)) > RELAY_COMPUTER_MAX_BODY_BYTES - 1024)
        throw new ComputerError('unavailable', 'The browser returned too much data for one call.', {
          reason: 'result_too_large'
        })
      return output
    } finally {
      child.inflight--
      child.lastCall = this.now()
    }
  }

  private async run(request: RoutedCall, child: Child, paged: boolean): Promise<ToolOutput> {
    const { desktop } = request
    const name = upstreamName(request.tool)
    const args = upstreamArgs(request.args)
    const pages = this.pageIds(desktop)
    if (paged) {
      const id = typeof args.pageId === 'string' ? args.pageId : ''
      let number = pages.numberFor(child, id)
      for (let attempt = 0; number === undefined && pages.known(id) && attempt < SYNC_ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, SYNC_RETRY_MS))
        await this.syncPages(request, child)
        number = pages.numberFor(child, id)
      }
      if (number === undefined)
        throw new ComputerError('invalid_argument', `unknown page id ${JSON.stringify(id)}; call chrome_list_pages`)
      args.pageId = number
    }
    const limit = Math.max(1, this.deadlineMs - TIMEOUT_MARGIN_MS)
    if (typeof args.timeout === 'number' && args.timeout > limit) args.timeout = limit
    const result = await this.raced(request, child, name, args)
    if (name === 'list_pages' && !result.isError) {
      const listed = await this.syncResult(request.desktop, pages, child, result)
      const text = pageListText(listed, (number) => pages.idFor(child, number))
      return { content: [{ type: 'text', text: withoutDevtoolsIds(text, pages.secrets()) }] }
    }
    return this.inline(child, pages, name, result)
  }

  // The child's own list and the browser's targets, bound again: after a child or browser restart, or a new tab.
  private async syncPages(request: RoutedCall, child: Child): Promise<void> {
    const listed = await this.raced(request, child, 'list_pages', {})
    if (listed.isError) return
    await this.syncResult(request.desktop, this.pageIds(request.desktop), child, listed)
  }

  private async syncResult(desktop: string, pages: PageIds, child: Child, result: ChildResult) {
    const listed = listedPages(result.structuredContent?.pages)
    const targets = await this.targets(child.endpoint, listed.length)
    if (this.children.get(desktop) !== child || !sameEndpoint(this.opts.endpoint(desktop), child.endpoint))
      throw new ComputerError('unavailable', 'the browser exited during the call', { reason: 'browser_exited' })
    pages.sync(child, child.endpoint.path, listed, targets)
    return listed
  }

  // A browser that just started answered `/json/list` with no pages while the child listed some (measured): asked again.
  private async targets(endpoint: DevtoolsEndpoint, listed: number): Promise<DevtoolsTarget[]> {
    const read = this.opts.targets ?? devtoolsTargets
    let targets: DevtoolsTarget[] = []
    for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, SYNC_RETRY_MS))
      targets = await read(endpoint).catch(() => [])
      if (listed === 0 || targets.some((target) => target.type === 'page')) break
    }
    return targets
  }

  private pageIds(desktop: string): PageIds {
    let ids = this.pages.get(desktop)
    if (!ids) this.pages.set(desktop, (ids = new PageIds()))
    return ids
  }

  // Raced against the browser's exit and the deadline: either kills the child, whose calls would hang or fail from then on.
  private async raced(
    request: RoutedCall,
    child: Child,
    name: string,
    args: Record<string, unknown>
  ): Promise<ChildResult> {
    let deadline: NodeJS.Timeout | undefined
    let watch: NodeJS.Timeout | undefined
    const screenshot = name === 'take_screenshot'
    const ms = screenshot ? Math.min(this.deadlineMs, SCREENSHOT_DEADLINE_MS) : this.deadlineMs
    const late = screenshot
      ? 'the browser drew no frame in time: a tab that is not in front draws none (chrome_take_snapshot reads it)'
      : 'the browser did not answer in time'
    const lost = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new ComputerError('unavailable', late, { reason: 'timeout' })), ms)
      watch = setInterval(() => {
        if (!sameEndpoint(this.opts.endpoint(request.desktop), child.endpoint))
          reject(new ComputerError('unavailable', 'the browser exited during the call', { reason: 'browser_exited' }))
      }, this.watchMs)
    })
    try {
      const work = child.client.callTool(
        { name, arguments: args },
        { timeout: ms + 1000, ...(request.signal ? { signal: request.signal } : {}) }
      )
      const result = (await Promise.race([work, lost])) as {
        content?: DriverContent[]
        isError?: boolean
        structuredContent?: Record<string, unknown>
      }
      return { ...result, content: result.content ?? [] }
    } catch (caught) {
      let error = caught
      // The watch may have killed the child before this call's own check ran: the browser's exit is still the cause.
      if (!(error instanceof ComputerError) && !sameEndpoint(this.opts.endpoint(request.desktop), child.endpoint))
        error = new ComputerError('unavailable', 'the browser exited during the call', { reason: 'browser_exited' })
      const reason = error instanceof ComputerError ? error.details.reason : undefined
      if (reason === 'timeout' || reason === 'browser_exited') {
        await this.end(request.desktop, reason === 'timeout' ? 'a call timed out' : 'its browser exited', true, child)
        throw error
      }
      if (request.signal?.aborted)
        throw new ComputerError('unavailable', 'the call was cancelled', { reason: 'cancelled' })
      // The child went away under the call: the next call starts a new one.
      if (!this.alive(child)) await this.end(request.desktop, 'it failed', true, child)
      throw new ComputerError(
        'unavailable',
        withoutDevtoolsIds(failure(error).message, [
          ...this.pageIds(request.desktop).secrets(),
          child.dir,
          child.endpoint.path
        ]),
        { reason: 'child_failed' }
      )
    } finally {
      clearTimeout(deadline)
      clearInterval(watch)
    }
  }

  // The screenshot tool alone can return a file in place of an inline image.
  private inline(child: Child, pages: PageIds, name: string, result: ToolOutput): ToolOutput {
    const secrets = [...pages.secrets(), child.dir, child.endpoint.path]
    const content: DriverContent[] = []
    for (const block of result.content) {
      if (
        name === 'take_screenshot' &&
        block.type === 'image' &&
        block.data &&
        block.mimeType &&
        /^image\/(png|jpeg|webp)$/.test(block.mimeType)
      ) {
        if (Buffer.byteLength(block.data, 'base64') > MAX_SCREENSHOT_BYTES) throw screenshotTooLarge()
        content.push({ type: 'image', data: block.data, mimeType: block.mimeType })
        continue
      }
      if (block.type !== 'text' || typeof block.text !== 'string') continue
      let text = block.text
      const saved = name === 'take_screenshot' && !result.isError ? /^Saved screenshot to (.+)\.$/m.exec(text) : null
      if (saved) {
        text = text.replace(saved[0], '').replace(/\n{2,}$/, '\n')
        const image = this.savedScreenshot(child, saved[1]!)
        content.push({ type: 'text', text: withoutDevtoolsIds(text, secrets) }, image)
      } else {
        content.push({ type: 'text', text: withoutDevtoolsIds(text, secrets) })
      }
    }
    return { content, ...(result.isError ? { isError: true } : {}) }
  }

  // Only the pinned child's temporary screenshot path is read, and its file and directory are removed.
  private savedScreenshot(child: Child, path: string): DriverContent {
    try {
      const root = realpathSync(child.dir)
      const real = realpathSync(path)
      const parts = relative(child.dir, path).split(sep)
      if (
        parts.length !== 2 ||
        !/^chrome-devtools-mcp-[a-z0-9]{6}$/i.test(parts[0]!) ||
        !/^screenshot\.(jpeg|png|webp)$/.test(parts[1]!) ||
        real !== join(root, ...parts)
      )
        throw new Error()
      const file = lstatSync(real)
      if (!file.isFile()) throw new Error()
      try {
        if (file.size > MAX_SCREENSHOT_BYTES) throw screenshotTooLarge()
        return { type: 'image', data: readFileSync(real).toString('base64'), mimeType: MIME[extname(real)]! }
      } finally {
        unlinkSync(real)
        rmdirSync(dirname(real))
      }
    } catch (error) {
      if (error instanceof ComputerError) throw error
      throw new ComputerError('unavailable', 'The browser did not return a readable screenshot.', {
        reason: 'screenshot_unavailable'
      })
    }
  }

  private stash(output: ToolOutput): { output: ToolOutput; ref?: string } | undefined {
    if (!this.opts.screenshots || !output.content.some((block) => block.type === 'image')) return undefined
    try {
      return this.opts.screenshots(output, currentCallContext())
    } catch (error) {
      this.opts.log(`screenshot storage skipped: ${(error as Error).message}`)
      return undefined
    }
  }

  // The desktop's child for this endpoint: a child of an earlier endpoint (its browser restarted) is killed first.
  private async child(desktop: string, endpoint: DevtoolsEndpoint): Promise<Child> {
    const current = this.children.get(desktop)
    if (current && sameEndpoint(endpoint, current.endpoint) && this.alive(current)) return current
    if (current) await this.end(desktop, 'its browser restarted', true, current)
    let pending = this.starting.get(desktop)
    if (!pending) {
      const current = this.start(desktop, endpoint)
        .then(async (started) => {
          if (this.starting.get(desktop) !== current || !sameEndpoint(this.opts.endpoint(desktop), endpoint)) {
            await this.kill(started)
            throw new ComputerError('unavailable', 'the browser exited during the call', { reason: 'browser_exited' })
          }
          this.children.set(desktop, started)
          this.opts.log(`chrome devtools: child started for desktop ${desktop} (pid ${started.transport.pid ?? '?'})`)
          this.watch()
          return started
        })
        .finally(() => {
          if (this.starting.get(desktop) === current) this.starting.delete(desktop)
        })
      pending = current
      this.starting.set(desktop, pending)
    }
    return pending
  }

  private async start(desktop: string, endpoint: DevtoolsEndpoint): Promise<Child> {
    const command = this.opts.command ?? chromeChildCommand()
    if (!command)
      throw new ComputerError('unavailable', 'Chrome DevTools MCP is not installed here', { reason: 'child_failed' })
    const dir = mkdtempSync(join(tmpdir(), 'agentconnect-chrome-'))
    const transport = new StdioClientTransport({
      command: command[0]!,
      args: [
        ...command.slice(1),
        ...chromeChildArgs({ endpoint, dir, maxImageDimension: this.opts.maxImageDimension() })
      ],
      env: chromeChildEnv(dir),
      cwd: dir,
      stderr: 'ignore'
    })
    const client = new Client({ name: 'agentconnect-computer', version: COMPUTER_DAEMON_VERSION })
    const child: Child = { client, transport, endpoint, dir, lastCall: this.now(), inflight: 0 }
    client.onclose = () => {
      if (this.children.get(desktop) === child) this.children.delete(desktop)
      rmSync(dir, { recursive: true, force: true })
    }
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('it did not start in time')), CONNECT_MS)
        })
      ])
    } catch (error) {
      await this.kill(child)
      throw new ComputerError('unavailable', `Chrome DevTools MCP did not start: ${(error as Error).message}`, {
        reason: 'child_failed'
      })
    } finally {
      clearTimeout(timer)
    }
    const version = client.getServerVersion()?.version
    if (version !== CHROME_DEVTOOLS_MCP_VERSION && !this.opts.command) {
      await this.kill(child)
      this.opts.log(`chrome devtools: child reports version ${version ?? '?'}, expected ${CHROME_DEVTOOLS_MCP_VERSION}`)
      throw new ComputerError('unavailable', 'The installed browser tools have an unexpected version.', {
        reason: 'child_failed'
      })
    }
    return child
  }

  private alive(child: Child): boolean {
    return child.transport.pid !== null
  }

  // Ends a desktop's child (or this one): killed when it may be stuck, closed otherwise; its directory goes with it.
  private async end(desktop: string, reason: string, kill: boolean, which?: Child): Promise<void> {
    const child = which ?? this.children.get(desktop)
    if (!child) return
    if (this.children.get(desktop) === child) this.children.delete(desktop)
    this.opts.log(`chrome devtools: child for desktop ${desktop} ${kill ? 'killed' : 'stopped'}: ${reason}`)
    if (kill) await this.kill(child)
    else await child.client.close().catch(() => undefined)
    rmSync(child.dir, { recursive: true, force: true })
  }

  private async kill(child: Child): Promise<void> {
    const pid = child.transport.pid
    if (pid !== null) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    await child.client.close().catch(() => undefined)
    rmSync(child.dir, { recursive: true, force: true })
  }

  // Stops a child idle for `leaseIdleSeconds`, and kills one whose browser exited or restarted.
  private watch(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      for (const [desktop, child] of [...this.children]) {
        if (!sameEndpoint(this.opts.endpoint(desktop), child.endpoint)) {
          void this.end(desktop, 'its browser exited or restarted', true, child)
        } else if (child.inflight === 0 && this.now() - child.lastCall >= this.opts.idleMs()) {
          void this.end(desktop, `no chrome_* call for ${Math.round(this.opts.idleMs() / 1000)} s`, false, child)
        }
      }
      if (this.children.size === 0 && this.starting.size === 0) {
        clearInterval(this.timer)
        this.timer = undefined
      }
    }, this.watchMs)
    this.timer.unref()
  }
}

/** Node and the pinned child's entry script, where it is installed. */
export function chromeChildCommand(): string[] | undefined {
  const bin = chromeDevtoolsMcpBin()
  return bin ? [process.execPath, bin] : undefined
}

const screenshotTooLarge = (): ComputerError =>
  new ComputerError('unavailable', 'The screenshot is too large. Try JPEG or capture the viewport.', {
    reason: 'result_too_large'
  })
