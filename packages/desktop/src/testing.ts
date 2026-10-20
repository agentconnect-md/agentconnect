import { DesktopConfig } from './config.js'
import { DriverUncertainError, type Driver, type DriverResult, type DriverTool } from './driver/client.js'

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

export const testConfig = (overrides: Partial<DesktopConfig> = {}): DesktopConfig =>
  DesktopConfig.parse({ actionSettleMs: 0, ...overrides })
