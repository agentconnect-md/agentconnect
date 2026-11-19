import { DaemonConfig } from './config.js'
import { DriverUncertainError, type Driver, type DriverResult, type DriverTool } from './driver/client.js'
import type { ProcFs } from './form-fill/attribution.js'

export type FakeHandler = (args: Record<string, unknown>) => DriverResult | Promise<DriverResult>

// In-memory stand-in for `cua-driver mcp` that records every call.
export class FakeDriver implements Driver {
  calls: { name: string; args: Record<string, unknown> }[] = []
  cursor = { x: 100, y: 100 }
  starts = 1
  handlers: Record<string, FakeHandler> = {
    get_desktop_state: () => ({
      content: [
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        { type: 'text', text: 'desktop screenshot' }
      ],
      structuredContent: {
        screenshot_width: 1280,
        screenshot_height: 720,
        screen_width: 2560,
        screen_height: 1440,
        scale_factor: 1
      }
    }),
    get_cursor_position: () => ({ content: [{ type: 'text', text: 'cursor' }], structuredContent: { ...this.cursor } }),
    get_screen_size: () => ({
      content: [{ type: 'text', text: 'size' }],
      structuredContent: { width: 2560, height: 1440 }
    })
  }

  async call(name: string, args: Record<string, unknown>): Promise<DriverResult> {
    this.calls.push({ name, args })
    const handler = this.handlers[name]
    return handler ? handler(args) : { content: [{ type: 'text', text: `${name} ok` }] }
  }

  async listTools(): Promise<DriverTool[]> {
    return [
      { name: 'get_window_state', inputSchema: { type: 'object', properties: { pid: { type: 'integer' } } } },
      { name: 'click', inputSchema: { type: 'object', properties: { pid: { type: 'integer' } } } },
      { name: 'run_script', inputSchema: { type: 'object', properties: {} } }
    ]
  }

  generation(): number {
    return this.starts
  }

  async close(): Promise<void> {}

  failNextWithUncertain(name: string): void {
    const previous = this.handlers[name]
    this.handlers[name] = () => {
      if (previous) this.handlers[name] = previous
      else delete this.handlers[name]
      throw new DriverUncertainError(`${name}: Request timed out`)
    }
  }

  inputCalls(): string[] {
    return this.calls.map((call) => call.name).filter((name) => name !== 'get_cursor_position')
  }
}

export const testConfig = (overrides: Partial<DaemonConfig> = {}): DaemonConfig =>
  DaemonConfig.parse({ actionSettleMs: 0, ...overrides })

export interface FakeProcess {
  exe: string
  // Chromium rewrites every process title into one space-joined string.
  title: string
  ppid: number
  fds: Record<string, string>
}

const TCP_HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'

/** A fake /proc: loopback listeners by socket inode, and the processes holding them; both may change between reads. */
export function fakeProc(
  listeners: Record<string, number>,
  processes: Record<number, FakeProcess>,
  options: { unreadable?: boolean } = {}
): ProcFs {
  const pid = (path: string) => Number(/^\/proc\/(\d+)\//.exec(path)?.[1])
  const fail = (path: string): never => {
    throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' })
  }
  const row = (inode: string, port: number) =>
    `   0: 0100007F:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`
  return {
    read: (path) => {
      if (path === '/proc/net/tcp' || path === '/proc/net/tcp6') {
        if (options.unreadable) return fail(path)
        const rows = path.endsWith('6') ? [] : Object.entries(listeners).map(([inode, port]) => row(inode, port))
        return [TCP_HEADER, ...rows].join('\n')
      }
      const process = processes[pid(path)]
      if (process && path.endsWith('/cmdline')) return `${process.title}\0`
      if (process && path.endsWith('/stat')) return `${pid(path)} (some (odd) name) S ${process.ppid} 1 1 0`
      return fail(path)
    },
    list: (path) => {
      if (path === '/proc') return [...Object.keys(processes), 'self', 'net']
      const process = processes[pid(path)]
      return process && path.endsWith('/fd') ? Object.keys(process.fds) : fail(path)
    },
    link: (path) => {
      const process = processes[pid(path)]
      if (process && path.endsWith('/exe')) return process.exe
      const fd = /\/fd\/(\d+)$/.exec(path)?.[1]
      return (process && fd && process.fds[fd]) || fail(path)
    }
  }
}
