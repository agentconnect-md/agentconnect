// A native tray helper process (the macOS menu bar) speaking one JSON object per line over stdio (#3403).
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface HelperTrayOptions {
  onClick: (id: string) => void
  // The menu is about to show, so its status is worth reading again.
  onMenuOpen: () => void
  // macOS asked the app to quit, as it does after a grant change; the daemon restarts to apply it.
  onRestart: () => void
  log: (line: string) => void
  spawnHelper?: (path: string) => ChildProcess
}

export class HelperTray {
  // Undefined while the helper shows the icon; otherwise why it cannot.
  problem: string | undefined
  private last = ''
  private closed = false

  private constructor(
    private readonly child: ChildProcess,
    private readonly options: HelperTrayOptions
  ) {}

  static start(path: string, options: HelperTrayOptions): HelperTray {
    const child = (options.spawnHelper ?? ((file) => spawn(file, [], { stdio: ['pipe', 'pipe', 'inherit'] })))(path)
    const tray = new HelperTray(child, options)
    child.stdin?.on('error', () => undefined)
    child.on('error', (error) => tray.gone(`cannot start the menu bar helper: ${error.message}`))
    child.on('exit', (code, signal) => tray.gone(`the menu bar helper exited (${signal ?? `code ${code}`})`))
    if (child.stdout) createInterface({ input: child.stdout }).on('line', (line) => tray.received(line))
    return tray
  }

  update(menu: object): void {
    const line = `${JSON.stringify({ menu })}\n`
    if (line === this.last || this.problem) return
    this.last = line
    this.child.stdin?.write(line)
  }

  close(): void {
    this.closed = true
    // The helper quits when its stdin closes.
    this.child.stdin?.end()
  }

  private received(line: string): void {
    let message: { action?: unknown; id?: unknown }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      return
    }
    if (message.action === 'click' && typeof message.id === 'string') this.options.onClick(message.id)
    if (message.action === 'menu-open') this.options.onMenuOpen()
    if (message.action === 'restart') this.options.onRestart()
  }

  private gone(problem: string): void {
    if (this.closed || this.problem) return
    this.problem = problem
    this.options.log(`tray: ${problem}`)
  }
}
