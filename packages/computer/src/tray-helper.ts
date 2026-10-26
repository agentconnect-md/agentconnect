// A native tray helper process (the macOS menu bar) speaking one JSON object per line over stdio (#3403).
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { TrayState } from './linux/tray.js'

export interface HelperTrayOptions {
  onStop: () => void
  onResume: () => void
  // macOS asked the app to quit, as it does after a grant change; the daemon restarts to apply it.
  onRestart: () => void
  hotkeyLabel?: string
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

  update(state: TrayState): void {
    const line = `${JSON.stringify({ state: { ...state, hotkeyLabel: this.options.hotkeyLabel } })}\n`
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
    let action: unknown
    try {
      action = (JSON.parse(line) as { action?: unknown }).action
    } catch {
      return
    }
    if (action === 'stop') this.options.onStop()
    if (action === 'resume') this.options.onResume()
    if (action === 'restart') this.options.onRestart()
  }

  private gone(problem: string): void {
    if (this.closed || this.problem) return
    this.problem = problem
    this.options.log(`tray: ${problem}`)
  }
}
