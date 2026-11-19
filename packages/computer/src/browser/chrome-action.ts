import { ComputerError } from '../computer.js'
import { currentCallContext } from '../audit.js'
import {
  computerBrowserAddressSchemes,
  computerBrowserNeedsShell,
  type ComputerBrowserTool
} from '@agentconnect.md/protocol/computer-browser'
import type { CommandLineAccess } from '../command-line.js'
import { DriverUncertainError } from '../driver/client.js'
import type { DevtoolsEndpoint } from './devtools-endpoint.js'

export function chromeActionGuard(
  tool: ComputerBrowserTool,
  args: Record<string, unknown>,
  commandLine: CommandLineAccess | undefined
): void {
  const schemes = computerBrowserAddressSchemes(args)
  if (schemes.includes('file:')) {
    throw new ComputerError('denied', 'Chrome tools cannot open local files.')
  }
  if (tool.requires === 'files' && (!commandLine || commandLine.files() === 'off')) {
    throw new ComputerError('denied', 'This computer does not allow file uploads.')
  }
  if (computerBrowserNeedsShell(tool, schemes)) {
    const mode = commandLine?.shell() ?? 'off'
    const approval = currentCallContext().approval
    if (mode === 'off') throw new ComputerError('denied', 'This computer does not allow browser scripts.')
    if (mode === 'ask' && approval !== 'allowed' && approval !== 'allowed_session')
      throw new ComputerError('approval_required', 'This computer asks for approval before running browser scripts.')
  }
}

/** Bring a verified browser's tab to the front immediately before the MCP child acts. */
export function activateChromePage(
  endpoint: DevtoolsEndpoint,
  targetId: string,
  fence: () => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}${endpoint.path}`)
    let sent = false
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', interrupted)
      if (socket.readyState < WebSocket.CLOSING) socket.close()
      if (error) reject(error)
      else resolve()
    }
    const interrupted = () =>
      finish(
        sent
          ? new DriverUncertainError('Chrome stopped answering while bringing the tab to the front')
          : new ComputerError('unavailable', 'Chrome could not be reached to bring the tab to the front')
      )
    const timer = setTimeout(interrupted, 5000)
    signal?.addEventListener('abort', interrupted, { once: true })
    socket.addEventListener('open', () => {
      try {
        fence()
        socket.send(JSON.stringify({ id: 1, method: 'Target.activateTarget', params: { targetId } }))
        sent = true
      } catch (error) {
        finish(error as Error)
      }
    })
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      try {
        const reply = JSON.parse(event.data) as { id?: number; error?: unknown }
        if (reply.id === 1)
          finish(reply.error ? new ComputerError('invalid_argument', 'Chrome could not select that tab.') : undefined)
      } catch {
        interrupted()
      }
    })
    socket.addEventListener('error', interrupted, { once: true })
    socket.addEventListener('close', interrupted, { once: true })
  })
}
