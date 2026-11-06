// Closes a desktop's browser the way a person would, so Chromium flushes its cookies first (computer-use.md §3.10).
import { request, X11Connection } from '../linux/x11.js'
import { profileOwner } from './launcher.js'

const OP_QUERY_TREE = 15
const OP_INTERN_ATOM = 16
const OP_GET_PROPERTY = 20
const OP_SEND_EVENT = 25
const CLIENT_MESSAGE = 33

export type CloseOutcome = 'not-running' | 'closed' | 'terminated' | 'killed'

export interface CloseOptions {
  profile: string
  display: string
  xauthority?: string
  // How long the browser gets to exit after its windows were asked to close.
  timeoutMs?: number
  log?: (line: string) => void
}

/** Asks every window of the profile's browser to close (WM_DELETE_WINDOW); SIGTERM only when that does not end it. */
export async function closeBrowser(options: CloseOptions): Promise<CloseOutcome> {
  const log = options.log ?? (() => undefined)
  const pid = profileOwner(options.profile)
  if (pid === undefined) return 'not-running'
  try {
    const x = await X11Connection.connect({
      display: options.display,
      ...(options.xauthority ? { xauthority: options.xauthority } : {})
    })
    try {
      const windows = await windowsOf(x, pid)
      const protocols = await internAtom(x, 'WM_PROTOCOLS')
      const remove = await internAtom(x, 'WM_DELETE_WINDOW')
      for (const window of windows) await sendClientMessage(x, window, protocols, [remove, 0, 0, 0, 0])
      log(`asked ${windows.length} browser window(s) of ${options.profile} to close`)
    } finally {
      x.close()
    }
  } catch (error) {
    log(`could not ask the browser of ${options.profile} to close: ${(error as Error).message}`)
  }
  if (await exited(pid, options.timeoutMs ?? 15_000)) return 'closed'
  log(`browser ${pid} did not exit after its windows closed; sending SIGTERM (unflushed cookies may be lost)`)
  process.kill(pid, 'SIGTERM')
  if (await exited(pid, 5_000)) return 'terminated'
  process.kill(pid, 'SIGKILL')
  return 'killed'
}

/** Waits until a window manager runs on the display (it sets _NET_SUPPORTING_WM_CHECK on the root); false on timeout. */
export async function waitForWindowManager(display: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const x = await X11Connection.connect({ display })
      try {
        const check = await internAtom(x, '_NET_SUPPORTING_WM_CHECK')
        if ((await cardinal(x, x.setup.root, check, 33)) !== undefined) return true
      } finally {
        x.close()
      }
    } catch {
      // The display may still be coming up.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

async function exited(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

// Top-level windows whose _NET_WM_PID is the browser's: the root's children and, under a reparenting WM, theirs.
async function windowsOf(x: X11Connection, pid: number): Promise<number[]> {
  const pidAtom = await internAtom(x, '_NET_WM_PID')
  const found: number[] = []
  for (const frame of await queryTree(x, x.setup.root)) {
    for (const window of [frame, ...(await queryTree(x, frame))]) {
      const value = await cardinal(x, window, pidAtom)
      if (value === pid) found.push(window)
    }
  }
  return found
}

async function internAtom(x: X11Connection, name: string): Promise<number> {
  const bytes = Buffer.from(name, 'latin1')
  const body = Buffer.alloc(4 + bytes.length)
  body.writeUInt16LE(bytes.length, 0)
  bytes.copy(body, 4)
  return (await x.request(request(OP_INTERN_ATOM, 0, body))).readUInt32LE(8)
}

async function queryTree(x: X11Connection, window: number): Promise<number[]> {
  const body = Buffer.alloc(4)
  body.writeUInt32LE(window, 0)
  const reply = await x.request(request(OP_QUERY_TREE, 0, body)).catch(() => undefined)
  if (!reply) return []
  const count = reply.readUInt16LE(16)
  return Array.from({ length: count }, (_, i) => reply.readUInt32LE(32 + i * 4))
}

// The first 32-bit value of a window property of the given type (0 = any; 33 = WINDOW), or undefined when unset.
async function cardinal(x: X11Connection, window: number, property: number, type = 0): Promise<number | undefined> {
  const body = Buffer.alloc(20)
  body.writeUInt32LE(window, 0)
  body.writeUInt32LE(property, 4)
  body.writeUInt32LE(type, 8)
  body.writeUInt32LE(0, 12)
  body.writeUInt32LE(1, 16)
  const reply = await x.request(request(OP_GET_PROPERTY, 0, body)).catch(() => undefined)
  if (!reply || reply[1] !== 32 || reply.readUInt32LE(16) < 1) return undefined
  return reply.readUInt32LE(32)
}

async function sendClientMessage(x: X11Connection, window: number, type: number, data: number[]): Promise<void> {
  const event = Buffer.alloc(32)
  event[0] = CLIENT_MESSAGE
  event[1] = 32
  event.writeUInt32LE(window, 4)
  event.writeUInt32LE(type, 8)
  data.forEach((value, i) => event.writeUInt32LE(value >>> 0, 12 + i * 4))
  const body = Buffer.alloc(40)
  body.writeUInt32LE(window, 0)
  body.writeUInt32LE(0, 4)
  event.copy(body, 8)
  await x.checked(request(OP_SEND_EVENT, 0, body))
}
